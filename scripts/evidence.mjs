/**
 * 复现"改完代码不验证"比例的脚本。
 *
 * 用 session.v4.jsonl.zstd 的多帧 zstd 日志统计：东一个 turn 改过代码文件、
 * 却没有任何一次测试/类型检查的证据。
 *
 * 用法：node scripts/evidence.mjs [sessionsDir]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const ROOT = process.argv[2] ?? (process.env.DSH_HOME ?? process.env.USERPROFILE + '\\.dsh') + '\\sessions';
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const EDIT_TOOLS = new Set(['write', 'edit', 'multiedit', 'apply_patch', 'str_replace_editor']);
const CODE_RE = /[.](?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|kt|c|cc|cpp|h|hpp|cs|rb|php|sh|ps1|swift|lua)\b/i;
const VERIFY_RE = /(?:pytest|py\.test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|node\s+--test|vitest|jest|cargo\s+(?:test|check)|go\s+(?:test|vet|build)|tsc|eslint|ruff|mypy|node\s+--check)/i;

function decode(file) {
  const raw = fs.readFileSync(file);
  const idxs = [];
  for (let i = 0; i + 4 <= raw.length; i++) if (raw.compare(MAGIC, 0, 4, i, i + 4) === 0) idxs.push(i);
  const parts = [];
  for (let k = 0; k < idxs.length; k++) {
    const s = idxs[k], e = k + 1 < idxs.length ? idxs[k + 1] : raw.length;
    try { parts.push(zlib.zstdDecompressSync(raw.subarray(s, e)).toString('utf8')); } catch { /* 跳过坏帧 */ }
  }
  return parts.join('');
}

const logs = [];
(function walk(d, depth = 0) {
  if (depth > 4) return;
  let ents = [];
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = d + '\\' + e.name;
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.name.endsWith('.jsonl.zstd')) logs.push(p);
  }
})(ROOT);

let turns = 0, codeEditTurns = 0, unverified = 0;
for (const p of logs) {
  let text = '';
  try { text = decode(p); } catch { continue; }
  if (!text) continue;
  const edit = new Set(), verify = new Set();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.type === 'turn/end') { turns++; continue; }
    if (r.type !== 'tool/call') continue;
    const name = r.data?.name, args = String(r.data?.arguments ?? ''), t = r.data?.turn;
    if (EDIT_TOOLS.has(name) && CODE_RE.test(args)) edit.add(t);
    if (name === 'run_tests') verify.add(t);
    else if (/^(pwsh|ops_bash|bash|run_code)$/.test(name) && VERIFY_RE.test(args)) verify.add(t);
  }
  for (const t of edit) { if (typeof t !== 'number') continue; codeEditTurns++; if (!verify.has(t)) unverified++; }
}

const pct = codeEditTurns ? (unverified / codeEditTurns * 100).toFixed(1) : '0.0';
console.log('sessions dir :', ROOT);
console.log('log files    :', logs.length);
console.log('turns        :', turns);
console.log('code-edit turns        :', codeEditTurns);
console.log('  …never verified      :', unverified, '(' + pct + '%)');
console.log('  …verified            :', codeEditTurns - unverified);
