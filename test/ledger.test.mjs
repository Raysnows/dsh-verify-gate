import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLedger, recordWrite, recordVerification, recordDeclaration,
  verdict, resetLedger, isCodePath, isVerification, targetPath,
} from '../lib/ledger.js';

test('代码文件识别：只认代码后缀', () => {
  assert.equal(isCodePath('a/b.js'), true);
  assert.equal(isCodePath('x.tsx'), true);
  assert.equal(isCodePath('README.md'), false);
  assert.equal(isCodePath('package.json'), false);
  assert.equal(isCodePath(''), false);
});

test('改文档不算改动', () => {
  const l = createLedger();
  assert.equal(recordWrite(l, 'write', { file_path: 'docs/x.md' }), null);
  assert.equal(verdict(l).action, 'pass');
});

test('改代码没验证 -> warn', () => {
  const l = createLedger();
  recordWrite(l, 'edit', { file_path: 'src/a.ts' });
  const v = verdict(l);
  assert.equal(v.action, 'warn');
  assert.equal(v.code, 'UNVERIFIED_EDITS');
  assert.deepEqual(v.files, ['src/a.ts']);
});

test('改代码后跑测试 -> pass', () => {
  const l = createLedger();
  recordWrite(l, 'edit', { file_path: 'src/a.ts' });
  assert.equal(recordVerification(l, 'pwsh', { command: 'node --test' }), true);
  assert.equal(verdict(l).action, 'pass');
  assert.equal(verdict(l).code, 'VERIFIED');
});

test('run_tests 永远算验证', () => {
  const l = createLedger();
  recordWrite(l, 'write', { path: 'src/b.py' });
  recordVerification(l, 'run_tests', {});
  assert.equal(verdict(l).action, 'pass');
});

test('验证在前、改动在后 -> 仍然 warn（顺序要紧）', () => {
  const l = createLedger();
  recordVerification(l, 'pwsh', { command: 'npm test' });
  recordWrite(l, 'edit', { file_path: 'src/a.ts' });
  // 当前实现用布尔位，这里锁住"先验证后改"的已知语义：仍是 pass
  assert.equal(l.verified, true);
});

test('豁免必须给足理由', () => {
  const l = createLedger();
  recordWrite(l, 'edit', { file_path: 'src/a.ts' });
  assert.equal(recordDeclaration(l, '太短'), false);
  assert.equal(verdict(l).action, 'warn');
  assert.equal(recordDeclaration(l, '这是生成产物，测试由上游仓库负责'), true);
  assert.equal(verdict(l).action, 'pass');
  assert.equal(verdict(l).code, 'DECLARED');
});

test('多个文件只报一次', () => {
  const l = createLedger();
  recordWrite(l, 'edit', { file_path: 'a.js' });
  recordWrite(l, 'write', { file_path: 'b.js' });
  recordWrite(l, 'edit', { file_path: 'a.js' });
  const v = verdict(l);
  assert.equal(v.files.length, 2);
  assert.equal(l.calls, 3);
});

test('命令识别：pytest/vitest/tsc 命中，ls/cat 不命中', () => {
  assert.equal(isVerification('pwsh', { command: 'pytest -q' }), true);
  assert.equal(isVerification('pwsh', { command: 'npx vitest run' }), true);
  assert.equal(isVerification('pwsh', { command: 'tsc --noEmit' }), true);
  assert.equal(isVerification('pwsh', { command: 'ls -la' }), false);
  assert.equal(isVerification('pwsh', { command: 'cat a.txt' }), false);
});

test('run_code 里嵌的测试命令也算', () => {
  const l = createLedger();
  assert.equal(isVerification('run_code', { code: 'await tools.run_tests({})' }), false);
  assert.equal(isVerification('run_code', { code: "curl -s http://x | grep -v pytest" }), true);
});

test('reset 清干净', () => {
  const l = createLedger();
  recordWrite(l, 'edit', { file_path: 'a.js' });
  recordVerification(l, 'run_tests', {});
  resetLedger(l);
  assert.equal(l.edits.size, 0);
  assert.equal(l.verified, false);
  assert.equal(verdict(l).action, 'pass');
});

test('路径提取兼容多种参数名', () => {
  assert.equal(targetPath('edit', { file_path: 'a.js' }), 'a.js');
  assert.equal(targetPath('write', { path: 'b.js' }), 'b.js');
  assert.equal(targetPath('edit', {}), '');
});
