# dsh-verify-gate

**DeepSeek Harness（DSH）的完成闸门。**
一个 turn 里改过代码文件、却从头到尾没跑过任何检查时，它会在下一步提醒一次；
确实不需要检查时，可以申报豁免。

[English](README.md) · 简体中文

---

## 为什么有这个东西

在一台真实机器上实测，49 个会话 / 937 个 turn：

| 指标 | 数值 |
|---|---:|
| 改过**代码文件**的 turn | 394 |
| 其中一次测试/类型检查都没跑 | **355（90.1%）** |

这正是 Can Bölük《The Harness Problem》列的头号失败模式：
模型写完、读一遍、觉得没问题、收工。

DSH 自带安全审阅（`dsh-experimental-auto-review`）和循环提示，
但**完成边界**上没有任何守卫。这个插件补的就是这一块。

## 工作方式

三个接缝，全部取自 DSH `0.2.2-rc.5` 的 `@deepseek-ai/dsh-agent-loop/lib/index.js` 源码：

| 接缝 | 类型 | 作用 |
|---|---|---|
| `tools/execute` | waterfall `(exec, next)` | 观察调用；`exec.name` 与 `exec.arguments` |
| `agent/pre-step` | waterfall `(payload, next)` | **注入**提醒到 `decision.messages` |
| `agent/turn-stopping` | serial | 收尾结账、清空账本 |

> `turn/start` 与 `turn/end` 是 **session 记录**（`session.append(...)`），不是上下文事件。
> 监听它们永远不会触发——第一版探针就踩了这个坑。

## 设计取舍

- **只警告，不阻断。** 阻断让每条任务都变慢；提醒只花一行。
- **只认代码后缀。** 改 `.md` / `.json` 不算，否则文档提交天天刷警告。
- **验证失败也算验证过。** 在乎的是模型抬头看了现实，不是现实一定说好。
- **留了豁免出口。** `verify_exemption(reason)`，理由少于 12 字符直接拒。
  会乱叫的闸门只有一个下场：被卸载。

## 实测（DSH 0.2.2-rc.5）

| 组 | 行为 | 提醒次数 |
|---|---|---:|
| A | `write` 一个 `.js`，不做任何验证 | **1** |
| B | `write` 一个 `.js`，然后 `node --check` | 0 |
| C | `write` 一个 `.mjs`，然后调 `verify_exemption` | 0 |

插件**无需重启宿主**即被加载。

## 已知限制

- **PTC 里直接 `fs` 写盘绕过工具派发**，看不到。只观察 `tools.write` / `tools.edit` 的内层调用。
- **单账本。** `agent/pre-step` 的 payload 不含 agent 身份，并发代理共享一次保守判断，
  而不是假装做了隔离。
- **“验证”靠命令正则。** 项目自定义检查脚本可能漏判——方向是多提醒一次，绝不误放过。

## 安装

```sh
dsh plugin --profile web add dsh-verify-gate
```

## 测试与复现

```sh
node test/run.mjs            # 11 项账本逻辑
node test/wiring.test.mjs    # 8 项接线（伪宿主上下文）
node scripts/evidence.mjs    # 复现 90.1% 那份统计
```

## 许可

MIT
