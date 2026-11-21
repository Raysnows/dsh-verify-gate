/**
 * The verification ledger: per-turn bookkeeping of "what changed" vs "what was checked".
 *
 * Pure data + pure functions. No harness, no timers, no I/O. Everything here is unit
 * tested, because a gate that cry-wolfs is worse than no gate at all.
 */

/** Files whose modification can break behaviour. Everything else is prose/config. */
const CODE_EXT = /[.](?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|kt|c|cc|cpp|h|hpp|cs|rb|php|sh|ps1|swift|lua)$/i;

/** Commands that count as "I actually checked this". */
const VERIFY_CMD = /(?:^|[\s;&|])(?:pytest|py\.test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|node\s+--test|vitest|jest|cargo\s+(?:test|check|clippy)|go\s+(?:test|vet|build)|tsc|tsc\s+--noEmit|eslint|ruff|mypy|black\s+--check|node\s+--check|npx\s+tsc)/i;

/** Tools that write to disk. */
const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'apply_patch', 'str_replace_editor']);

export function isCodePath(p) {
  return typeof p === 'string' && CODE_EXT.test(p.trim());
}

/** Which file does this tool call touch? Best effort across tool shapes. */
export function targetPath(name, args) {
  if (!args || typeof args !== 'object') return '';
  const a = args;
  return String(
    a.path ?? a.file_path ?? a.filePath ?? a.target ?? a.filename ?? '',
  );
}

/** Does this call prove that something was verified? */
export function isVerification(name, args, resultText) {
  if (name === 'run_tests') return true;
  const a = args && typeof args === 'object' ? args : {};
  const cmd = String(a.command ?? a.cmd ?? a.script ?? '');
  if (cmd && VERIFY_CMD.test(cmd)) return true;
  // run_code / shell wrappers carry their program in another field
  const body = String(a.code ?? '');
  if (body && VERIFY_CMD.test(body)) return true;
  // A test runner that itself failed still counts as "verified": we only care that
  // the agent looked at reality. Silence is the failure we are hunting.
  if (typeof resultText === 'string' && /\b(?:passed|PASS|ok\b|\d+\s+passing)/.test(resultText)) return true;
  return false;
}

/**
 * One turn's ledger.
 *
 *   edits      — code files touched this turn
 *   verified   — did anything in this turn actually check the result
 *   declared   — the agent explicitly said "this needs no verification" and why
 */
export function createLedger() {
  return { edits: new Map(), verified: false, verifyTool: null, declared: null, calls: 0 };
}

export function recordWrite(ledger, name, args) {
  if (!WRITE_TOOLS.has(name)) return null;
  const p = targetPath(name, args);
  if (!isCodePath(p)) return null;
  ledger.calls += 1;
  const prev = ledger.edits.get(p) ?? 0;
  ledger.edits.set(p, prev + 1);
  return p;
}

export function recordVerification(ledger, name, args, resultText) {
  if (!isVerification(name, args, resultText)) return false;
  ledger.verified = true;
  ledger.verifyTool = name;
  return true;
}

export const DECLARE_TOOL = 'verify_exemption';

export function recordDeclaration(ledger, reason) {
  const r = String(reason ?? '').trim();
  if (r.length < 12) return false;
  ledger.declared = r;
  return true;
}

/**
 * The verdict at turn end.
 *
 * Returns { action: 'pass' | 'warn', code, reason, files }.
 * 'warn' never blocks: it feeds one sentence back so the next request carries it.
 */
export function verdict(ledger) {
  if (ledger.edits.size === 0) return { action: 'pass', code: 'NO_EDITS', files: [] };
  const files = [...ledger.edits.keys()];
  if (ledger.verified) return { action: 'pass', code: 'VERIFIED', via: ledger.verifyTool, files };
  if (ledger.declared) return { action: 'pass', code: 'DECLARED', reason: ledger.declared, files };
  return {
    action: 'warn',
    code: 'UNVERIFIED_EDITS',
    files,
    reason:
      'This turn changed ' + files.length + ' code file(s) but nothing was run to check them. ' +
      'Run the project tests (or a type check) before calling the task done, ' +
      'or call verify_exemption with a concrete reason why no check applies.',
  };
}

export function resetLedger(ledger) {
  ledger.edits.clear();
  ledger.verified = false;
  ledger.verifyTool = null;
  ledger.declared = null;
  ledger.calls = 0;
}
