/**
 * 在会话日志里找出闸门注入的提醒。
 *
 * 只在 type === 'system/message' 的记录里找，避免把"我自己写源码把这段文字写进
 * 工具参数"误判成注入。
 *
 * 用法：node scripts/scan-nudge.mjs [minutes]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const MIN = Number(process.argv[2] ?? 15);
const ROOT = (process.env.DSH_HOME ?? process.env.USERPROFILE + '\\.dsh') + '\\sessions';
const NEEDLE = 'Run the project tests (or a type check) before calling the task done';
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decode(file) {
  const raw = fs.readFileSync(file);
  const idxs = [];
  for (let i = 0; i + 4 <= raw.length; i++) if (raw.compare(MAGIC, 0, 4, i, i + 4) === 0) idxs.push(i);
  const parts = [];
  for (let k = 0; k < idxs.length; k++) {
    const s = idxs[k], e = k + 1 < idxs.length ? idxs[k + 1] : raw.length;
    try { parts.push(zlib.zstdDecompressSync(raw.subarray(s, e)).toString('utf8')); } catch {}
  }
  return parts.join('');
}

const cutoff = Date.now() - MIN * 60 * 1000;
const hits = [];
(function walk(d, depth = 0) {
  if (depth > 4) return;
  let ents = [];
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = d + '\\' + e.name;
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.name.endsWith('.jsonl.zstd')) {
      const st = fs.statSync(p);
      if (st.mtimeMs < cutoff) continue;
      let text = '';
      try { text = decode(p); } catch { continue; }
      if (!text.includes(NEEDLE)) continue;
      let injected = 0, samples = [];
      for (const line of text.split('\n')) {
        if (!line.includes(NEEDLE)) continue;
        let r; try { r = JSON.parse(line); } catch { continue; }
        const isSystemish = (r.type === 'system/message') || (r.type === 'user/message' && r.data?.role === 'system');
        if (!isSystemish) continue;
        injected++;
        const s = JSON.stringify(r);
        const i = s.indexOf('This turn changed');
        if (i >= 0 && samples.length < 2) samples.push(s.slice(i, i + 220));
      }
      if (injected) hits.push({
        session: p.split('\\').slice(-2)[0],
        mtime: new Date(st.mtimeMs).toISOString(),
        injectedSystemMessages: injected,
        sample: samples[0],
      });
    }
  }
})(ROOT);

console.log('scanned sessions modified in last ' + MIN + ' min');
if (!hits.length) console.log('NO INJECTION FOUND');
else for (const h of hits) console.log(JSON.stringify(h, null, 1));
