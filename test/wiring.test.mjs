import assert from 'node:assert/strict';
import { apply } from '../index.js';
import { createFakeCtx } from './fake-ctx.mjs';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const exec = (name, args) => ({ name, arguments: args, agent: { id: 'a1' } });

test('插件加载后注册了豁免工具，并挂上三个接缝', () => {
  const ctx = createFakeCtx();
  apply(ctx, {});
  assert.equal(ctx.__registered.length, 1);
  assert.equal(ctx.__registered[0].name, 'verify_exemption');
  assert.equal(ctx.__listeners('tools/execute'), 1);
  assert.equal(ctx.__listeners('agent/pre-step'), 1);
  assert.equal(ctx.__listeners('agent/turn-stopping'), 1);
});

test('改了代码不验证 -> 下一个 pre-step 注入一条 system 消息', async () => {
  const ctx = createFakeCtx();
  apply(ctx, {});
  await ctx.__emitWaterfall('tools/execute', exec('edit', { file_path: 'src/a.ts' }));
  const decision = await ctx.__emitWaterfall('agent/pre-step', { turn: 1, step: 2 });
  assert.equal(decision.kind, 'enter');
  const injected = decision.messages.at(-1);
  assert.equal(injected.role, 'system');
  assert.match(injected.content[0].text, /changed 1 code file\(s\)/);
  assert.ok(injected.id);
});

test('同一 turn 只提醒一次', async () => {
  const ctx = createFakeCtx();
  apply(ctx, {});
  await ctx.__emitWaterfall('tools/execute', exec('edit', { file_path: 'src/a.ts' }));
  const d1 = await ctx.__emitWaterfall('agent/pre-step', { turn: 1, step: 2 });
  const d2 = await ctx.__emitWaterfall('agent/pre-step', { turn: 1, step: 3 });
  assert.equal(d1.messages.length, 2);
  assert.equal(d2.messages.length, 1);
});

test('跑了测试 -> 不注入', async () => {
  const ctx = createFakeCtx();
  apply(ctx, {});
  await ctx.__emitWaterfall('tools/execute', exec('edit', { file_path: 'src/a.ts' }));
  await ctx.__emitWaterfall('tools/execute', exec('pwsh', { command: 'node --test' }));
  const d = await ctx.__emitWaterfall('agent/pre-step', { turn: 1, step: 3 });
  assert.equal(d.messages.length, 1);
});

test('申报豁免 -> 不注入，且工具返回 accepted', async () => {
  const ctx = createFakeCtx();
  apply(ctx, {});
  await ctx.__emitWaterfall('tools/execute', exec('write', { file_path: 'src/a.ts' }));
  const tool = ctx.__registered[0];
  const res = await tool.execute({ reason: '这是生成产物，测试在上游仓库' }, { agent: { id: 'a1' } });
  assert.equal(res.accepted, true);
  const d = await ctx.__emitWaterfall('agent/pre-step', { turn: 1, step: 3 });
  assert.equal(d.messages.length, 1);
});

test('理由太短 -> 拒绝，仍然注入', async () => {
  const ctx = createFakeCtx();
  apply(ctx, {});
  await ctx.__emitWaterfall('tools/execute', exec('write', { file_path: 'src/a.ts' }));
  const tool = ctx.__registered[0];
  const res = await tool.execute({ reason: '短' }, { agent: { id: 'a1' } });
  assert.equal(res.accepted, false);
  const d = await ctx.__emitWaterfall('agent/pre-step', { turn: 1, step: 2 });
  assert.equal(d.messages.length, 2);
});

test('turn-stopping 结账后账本清空，下一轮不再提醒', async () => {
  const ctx = createFakeCtx();
  apply(ctx, {});
  await ctx.__emitWaterfall('tools/execute', exec('edit', { file_path: 'src/a.ts' }));
  await ctx.__emit('agent/turn-stopping', { turn: 1 });
  const d = await ctx.__emitWaterfall('agent/pre-step', { turn: 2, step: 1 });
  assert.equal(d.messages.length, 1);
});

test('工具抛错时账本不影响异常传递', async () => {
  const ctx = createFakeCtx();
  apply(ctx, {});
  const failing = { name: 'edit', arguments: { file_path: 'src/a.ts' }, agent: { id: 'a1' } };
  // 直接给一个会抛错的 next：用一个会 throw 的监听器模拟工具失败
  const boom = ctx.on;
  let threw = false;
  try {
    const listeners = [];
    const fake = { ...ctx, on: (e, f) => { if (e === 'tools/execute') listeners.push(f); return () => {}; } };
    apply(fake, {});
    const fn = listeners[0];
    await fn(failing, async () => { throw new Error('tool failed'); }).catch(() => { threw = true; });
  } catch { threw = true; }
  assert.equal(threw, true);
});

let pass = 0, fail = 0;
for (const [name, fn] of cases) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed, ' + cases.length + ' total');
process.exit(fail ? 1 : 0);
