/**
 * dsh-verify-gate — 完成闸门（Host 半边）
 *
 * 背景（本机实测 49 个会话 / 937 个 turn）：改过代码文件的 394 个 turn 里，
 * 355 个（90.1%）从头到尾没跑过任何测试或类型检查。
 *
 * 接缝取自 dsh 0.2.2-rc.5 的真实源码（@deepseek-ai/dsh-agent-loop/lib/index.js）：
 *   - tools/execute        waterfall (exec, next)；exec.name / exec.arguments
 *   - agent/pre-step       waterfall (payload, next)；可改写 decision.messages
 *   - agent/turn-stopping  serial (payload)
 *
 * 注意：turn/start、turn/end 是 session 记录（session.append），不是 ctx 事件。
 *
 * 单账本说明：agent/pre-step 的 payload 不含 agent 身份（源码里只有 turn / step /
 * signal / modelSelection），如果记账侧按 agent 分账、读取侧只能读到一份，
 * 那写出来的"隔离"是假的。这里如实使用单账本，并发多代理时会保守地合并判断。
 */

import { randomUUID } from 'node:crypto';
import {
  createLedger, recordWrite, recordVerification, recordDeclaration,
  verdict, resetLedger, DECLARE_TOOL,
} from './lib/ledger.js';

export const inject = ['tools'];

const DECLARE_HINT =
  'Run the project tests (or a type check) before calling the task done, ' +
  'or call verify_exemption with a concrete reason why no check applies.';

export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false;
  const stats = { nudged: 0, clean: 0, exempted: 0 };
  const book = { ledger: createLedger(), nudgedTurn: -1 };

  // ---- 1. 观察：工具执行后记账 ----
  ctx.effect(() => {
    const dispose = ctx.on('tools/execute', async (exec, next) => {
      if (!enabled) return next();
      const name = String(exec?.name ?? exec?.tool?.name ?? '');
      const args = exec?.arguments ?? exec?.args ?? {};
      const result = await next();
      try {
        if (name === DECLARE_TOOL) recordDeclaration(book.ledger, args?.reason);
        else recordWrite(book.ledger, name, args);
        const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
        recordVerification(book.ledger, name, args, text);
      } catch {
        // 账本自身出错绝不影响工具结果
      }
      return result;
    });
    return () => dispose?.();
  }, 'verify-gate: tool observer');

  // ---- 2. 下一步之前：把提醒送进模型上下文 ----
  ctx.effect(() => {
    const dispose = ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      if (!enabled || !decision || decision.kind !== 'enter') return decision;
      try {
        const v = verdict(book.ledger);
        if (v.action !== 'warn') return decision;
        const turn = Number(payload?.turn ?? -1);
        if (book.nudgedTurn === turn) return decision; // 一个 turn 最多提醒一次
        book.nudgedTurn = turn;
        stats.nudged += 1;
        return {
          ...decision,
          messages: [...decision.messages, {
            id: randomUUID(),
            role: 'system',
            content: [{ type: 'text', text: (v.reason ?? '') + ' ' + DECLARE_HINT }],
            source: { kind: 'system-prompt' },
          }],
        };
      } catch {
        return decision; // 注入失败一律放行，绝不打断正常流程
      }
    });
    return () => dispose?.();
  }, 'verify-gate: pre-step nudge');

  // ---- 3. 收工结账 ----
  ctx.effect(() => {
    const dispose = ctx.on('agent/turn-stopping', () => {
      try {
        const v = verdict(book.ledger);
        if (v.code === 'DECLARED') stats.exempted += 1;
        else if (v.code === 'VERIFIED') stats.clean += 1;
        resetLedger(book.ledger);
        book.nudgedTurn = -1;
      } catch { /* 结账出错不影响收工 */ }
    });
    return () => dispose?.();
  }, 'verify-gate: turn settlement');

  // ---- 4. 豁免工具 ----
  if (config.exemptionTool !== false) {
    ctx.effect(() => ctx.tools.register({
      name: DECLARE_TOOL,
      description:
        "Declare that this turn's code changes need no automated check, with a concrete reason. " +
        'Use only when no test, type check or runnable path applies (generated files, docs-only code, ' +
        'or the check lives in another repository). A vague reason is rejected.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'Why no verification applies, concretely.' } },
        required: ['reason'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { accepted: { type: 'boolean' }, code: { type: 'string' } } },
        render: (_a, v) => [{ type: 'text', text: v.accepted ? 'Exemption recorded.' : 'Exemption rejected: reason too vague (need >= 12 chars).' }],
      },
      async execute(args) {
        const accepted = recordDeclaration(book.ledger, args?.reason);
        return { accepted, code: accepted ? 'DECLARED' : 'REASON_TOO_VAGUE' };
      },
    }), 'verify-gate: exemption tool');
  }
}
