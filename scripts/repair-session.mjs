#!/usr/bin/env node
/**
 * Repair session logs that dsh-verify-gate 0.1.0 made unloadable.
 *
 * 0.1.0 injected its reminder as a \`system\`-role \`agent/pre-step\` message. DSH
 * records every non-\`runtime-context\` pre-step message as a \`user/message\`
 * session event *whatever the role is*, so the stored row was
 * \`type: "user/message", data.role: "system"\`. The loader rejects that
 * (\`session event at seq N message must have role "user"\`) and the whole
 * session stops opening.
 *
 * What this does, per affected row:
 *   - rewrites it to the canonical \`system/message\` event DSH itself writes,
 *     with \`turn\`/\`step\` taken from the \`step/start\` immediately before it;
 *   - recompresses only the Zstandard frame that held the row, byte-for-byte
 *     identical everywhere else;
 *   - verifies the rebuilt log (every row parses, sequence stays dense, no
 *     role/type mismatch remains) before anything is written;
 *   - keeps the original next to it as \`.orig-<timestamp>\`;
 *   - moves the session's projection-cache document aside so it rebuilds.
 *
 * Usage:
 *   node scripts/repair-session.mjs                 # dry run, all sessions
 *   node scripts/repair-session.mjs --apply         # write the repairs
 *   node scripts/repair-session.mjs --apply <id>...  # only these sessions
 *   node scripts/repair-session.mjs --sessions-dir <dir>
 *   node scripts/repair-session.mjs --no-projcache   # leave the cache alone
 *
 * Requires Node.js >= 22.15 (zlib zstd support). Exit code 0 = nothing left to
 * repair or every repair verified; 1 = something needed attention.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { zstdCompressSync, zstdDecompressSync, constants as zlibConstants } from 'node:zlib';

const ZSTD_MAGIC = 0xfd2fb528;
const ROLE_BY_TYPE = {
  'system/message': 'system',
  'developer/message': 'developer',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
};

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const noProjcache = args.includes('--no-projcache');
const dirFlag = args.indexOf('--sessions-dir');
const sessionsDir = dirFlag >= 0 ? args[dirFlag + 1] : join(homedir(), '.dsh', 'sessions');
const onlyIds = args.filter((a) => !a.startsWith('--') && a !== sessionsDir);
const projcacheDir = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** Walk a directory tree for session log artifacts. */
function findLogs(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) findLogs(path, out);
    else if (/^session.*\.jsonl(\.zstd)?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Split a Zstandard container into complete frame ranges without decompressing. */
function scanFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) throw new Error('torn frame magic at byte ' + offset);
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('invalid frame magic at byte ' + offset);
    offset += 4;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error('reserved frame-header bit at byte ' + (offset - 1));
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    for (;;) {
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error('reserved block type at byte ' + (offset - 3));
      offset += blockType === 1 ? 1 : blockSize;
      if (lastBlock) break;
    }
    if (checksum) offset += 4;
    frames.push({ start, end: offset });
  }
  return frames;
}

/** Decode one whole container into its JSONL text. */
function decodeLog(buffer) {
  const frames = scanFrames(buffer);
  const parts = frames.map((frame) => zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
  return { frames, text: Buffer.concat(parts).toString('utf8') };
}

/** Parse JSONL text into rows; a trailing empty line is not a row. */
function parseRows(text) {
  return text.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

/** The message carried by a surface event, mirroring the loader's own rule. */
function messageOf(row) {
  if (!(row.type in ROLE_BY_TYPE)) return undefined;
  return row.type === 'user/message' ? row.data : row.data?.message;
}

/** Turn/step of the step that contains seq, from the nearest preceding boundary. */
function positionOf(bySeq, seq) {
  for (let s = seq - 1; s >= 0; s -= 1) {
    const row = bySeq.get(s);
    if (row?.type === 'step/start') return { turn: row.data.turn, step: row.data.step };
    if (row?.type === 'turn/start') return { turn: row.data.turn, step: 1 };
  }
  return undefined;
}

/**
 * Rewrite one corrupt row into the canonical system-message event.
 * @returns the repaired row, or undefined when the row is not this defect.
 */
function repairRow(row, bySeq) {
  if (row.type !== 'user/message') return undefined;
  const message = row.data;
  if (message?.role !== 'system' || message?.source?.kind !== 'system-prompt') return undefined;
  const position = positionOf(bySeq, row.seq);
  if (position === undefined) return undefined;
  return {
    type: 'system/message',
    seq: row.seq,
    time: row.time,
    data: {
      turn: position.turn,
      step: position.step,
      message: { id: message.id, role: message.role, content: message.content, source: message.source },
    },
    surfaceOp: row.surfaceOp ?? 'append',
  };
}

/** Rebuild the container with only the affected frames recompressed. */
function rebuild(buffer, frames, replacements) {
  const pieces = [];
  let cursor = 0;
  for (const frame of frames) {
    const text = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8');
    const lines = text.split('\n');
    let changed = false;
    const rebuilt = lines.map((line) => {
      if (line.length === 0) return line;
      const row = JSON.parse(line);
      const replacement = replacements.get(row.seq);
      if (replacement === undefined) return line;
      changed = true;
      return JSON.stringify(replacement);
    });
    if (!changed) continue;
    pieces.push(buffer.subarray(cursor, frame.start));
    pieces.push(zstdCompressSync(Buffer.from(rebuilt.join('\n'), 'utf8'), { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }));
    cursor = frame.end;
  }
  pieces.push(buffer.subarray(cursor));
  return Buffer.concat(pieces);
}

/** Verify a rebuilt container: dense seqs, parsable rows, no role/type mismatch. */
function verify(candidate) {
  const { text } = decodeLog(candidate);
  const rows = parseRows(text);
  if (rows.length < 2) throw new Error('rebuilt log has no events');
  const events = rows.slice(1);
  events.forEach((row, index) => {
    if (row.seq !== index) throw new Error('event ' + index + ' is not dense (seq ' + row.seq + ')');
    const message = messageOf(row);
    if (message !== undefined && message.role !== ROLE_BY_TYPE[row.type]) {
      throw new Error('seq ' + row.seq + ' still mismatches: ' + row.type + ' / ' + message.role);
    }
  });
  return events.length;
}

const logs = findLogs(sessionsDir).filter((path) => path.endsWith('.zstd'));
if (logs.length === 0) {
  console.log('no compressed session logs under ' + sessionsDir);
  process.exit(0);
}

let repairedFiles = 0;
let repairedRows = 0;
let cleanFiles = 0;
let failed = 0;

for (const path of logs) {
  const id = basename(dirname(path));
  if (onlyIds.length > 0 && !onlyIds.some((needle) => id.includes(needle))) continue;
  let buffer;
  try { buffer = readFileSync(path); } catch (error) {
    console.log('SKIP  ' + id + '  (' + error.message + ')');
    continue;
  }
  let frames;
  let rows;
  try {
    const decoded = decodeLog(buffer);
    frames = decoded.frames;
    rows = parseRows(decoded.text);
  } catch (error) {
console.log('FAIL  ' + id + '  (' + error.message + ')');
    failed += 1;
    continue;
  }
  const bySeq = new Map();
  for (const row of rows) if (typeof row.seq === 'number') bySeq.set(row.seq, row);
  const replacements = new Map();
  for (const row of rows) {
    const replacement = repairRow(row, bySeq);
    if (replacement !== undefined) replacements.set(row.seq, replacement);
  }
  if (replacements.size === 0) { cleanFiles += 1; continue; }

  const seqs = [...replacements.keys()].sort((a, b) => a - b);
  if (!apply) {
    console.log('WOULD REPAIR  ' + id + '  seq ' + seqs.join(', '));
    repairedFiles += 1;
    repairedRows += seqs.length;
    continue;
  }

  try {
    const candidate = rebuild(buffer, frames, replacements);
    const count = verify(candidate);
    const backup = path + '.orig-' + stamp;
    copyFileSync(path, backup);
    const staged = path + '.repair-staged';
    writeFileSync(staged, candidate);
    renameSync(staged, path);
    let cacheNote = '';
    const cacheDoc = join(projcacheDir, id + '.json');
    if (!noProjcache && existsSync(cacheDoc)) {
      const cacheBackup = join(projcacheDir, id + '.json.orig-' + stamp);
      copyFileSync(cacheDoc, cacheBackup);
      rmSync(cacheDoc);
      cacheNote = '  projection cache moved aside';
    }
    console.log('REPAIRED  ' + id + '  seq ' + seqs.join(', ') + '  (' + count + ' events verified)' + cacheNote);
    console.log('          backup: ' + basename(backup));
    repairedFiles += 1;
    repairedRows += seqs.length;
  } catch (error) {
console.log('FAIL  ' + id + '  (' + error.message + ')');
    failed += 1;
  }
}

console.log('');
console.log(
  (apply ? 'repaired ' : 'would repair ') + repairedFiles + ' session(s), ' +
  repairedRows + ' event(s); ' + cleanFiles + ' already clean; ' + failed + ' failed',
);
if (!apply && repairedFiles > 0) console.log('dry run only — re-run with --apply to write the repairs');
process.exit(failed > 0 ? 1 : 0);
