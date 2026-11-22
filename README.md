# dsh-verify-gate · 完成闸门

**让 AI 改完代码，别急着说「好了」。**

一个 turn 里改过代码文件、却从头到尾没跑过任何测试或类型检查时，
这个插件会在模型收工前提醒它一次：要么真去跑一下，要么用一句具体理由申报豁免。

[English](README.en.md) · 简体中文

---

## 它到底干什么

AI 写代码有个通病：**写完、读一遍、觉得没问题、宣布完成** —— 但从头到尾没跑过任何东西。
你看到的「已完成」，可能根本没人验证过。

`dsh-verify-gate` 就守在这一步上。每个 turn 它只问两个问题：

1. 模型这轮**改过代码文件**吗？（`.js` / `.ts` / `.py` / `.go` / `.rs` …）
2. 改完之后**跑过任何检查吗**？（测试、类型检查、`node --check`、`tsc`、`pytest` …）

第一个「是」、第二个「没有」，它就在模型**下一步的上下文里**塞一条提醒：去跑一下，或者说明为什么不用跑。

**提醒的是模型，不是弹窗提醒你。** 拦在模型说「完成了」之前，比事后你翻日志有用得多。

## 为什么需要它

在一台真实机器上实测，49 个会话 / 937 个 turn：

| 指标 | 数值 |
|---|---:|
| 改过**代码文件**的 turn | 394 |
| 其中一次测试/类型检查都没跑 | **355（90.1%）** |

这正是 Can Bölük《The Harness Problem》列的头号失败模式。
DSH 自带安全审阅（`dsh-experimental-auto-review`）和循环提示，但**完成边界**上没有任何守卫。
这个插件补的就是这一块。

## 它不会做什么

- **不阻断。** 只提醒，不拦任务。拦一次可能省下一个 bug，但会让每条任务都变慢；
  提醒只花一行 token。会乱叫的闸门只有一个下场：被卸载。
- **不管文档。** 改 `.md` / `.json` 不算，否则每次提交文档都刷警告。
- **不判对错。** 测试跑挂了也算验证过 —— 它关心的是模型有没有抬头看现实，不是现实一定说好。
- **不假装隔离。** `agent/pre-step` 的 payload 不带 agent 身份，所以并发多代理共享一份保守账本，
  而不是编一个假的「按 agent 分账」。

## 装上就生效

不需要配置，不需要重启宿主。装上之后：

| 模型的行为 | 结果 |
|---|---|
| 改 `.js`，什么都不跑，说「完成」 | **提醒 1 次** |
| 改 `.js`，跑了 `node --check` | 不提醒 |
| 改 `.mjs`，调 `verify_exemption("只改了类型定义，无运行路径")` | 不提醒 |

豁免工具有闸：理由少于 12 个字符直接拒，防止模型写「n/a」糊弄过去。

## 工作方式（给想读源码的人）

三个接缝，全部取自 DSH `0.2.2-rc.5` 的 `atdeepseek-ai/dsh-agent-loop/lib/index.js` 源码，不是猜的：

| 接缝 | 类型 | 作用 |
|---|---|---|
| `tools/execute` | waterfall `(exec, next)` | 观察调用；`exec.name` 与 `exec.arguments` |
| `agent/pre-step` | waterfall `(payload, next)` | **注入**提醒到 `decision.messages` |
| `agent/turn-stopping` | serial | 收尾结账、清空账本 |

> `turn/start` 与 `turn/end` 是 **session 记录**（`session.append(...)`），不是上下文事件。
> 监听它们永远不会触发 —— 第一版探针就踩了这个坑。

> 注入的消息必须是 `user` 角色：`agent/pre-step` 里除 `runtime-context` 以外的消息，
> 宿主一律记成 `user/message` 会话事件，角色是 `system` 时写出来的日志在加载校验时会被拒
> （`... message must have role "user"`），整个会话从此打不开。提醒文本包在
> `<system-reminder>` 里，模型读到的仍是宿主提醒，不是用户发言。

## 修复已被 0.1.0 写坏的会话

0.1.0 可能在某条会话日志里留下一行无法加载的记录。升到 0.1.1+ 只止血，**不会修复已经坏掉的日志**：
在那一行被改写之前，该会话会一直打不开。包里带了修复脚本：

```sh
node node_modules/dsh-verify-gate/scripts/repair-session.mjs           # 预演，扫全部会话
node node_modules/dsh-verify-gate/scripts/repair-session.mjs --apply   # 真正改写，自动备份
```

它找出 `user/message` 里装着 `system` 消息的行，改写成宿主自己会写的标准 `system/message`
事件（`turn`/`step` 取自前面最近的 `step/start`），只重压命中行所在的那一帧 zstd，改写前先
自检整份日志，原文件原地留一份 `session.v4.jsonl.zstd.orig-<时间戳>`，并把该会话的投影缓存
挪开让它重建。

**请在关闭 DSH 时运行** —— 它直接改盘上的会话文件。`--sessions-dir` 可指定别的根目录，
`--no-projcache` 表示不动缓存。

## 已知限制

- **PTC 里直接 `fs` 写盘绕过工具派发**，看不到。只观察 `tools.write` / `tools.edit` 的内层调用。
- **单账本。** 见上文「不假装隔离」。
- **「验证」靠命令正则。** 项目自定义检查脚本可能漏判 —— 方向是多提醒一次，绝不误放过。

## 安装

```sh
dsh plugin --profile web add dsh-verify-gate    # 从 npm 安装
```

## 测试与复现

```sh
node test/run.mjs            # 11 项账本逻辑
node test/wiring.test.mjs    # 11 项接线（伪宿主上下文）
node scripts/evidence.mjs    # 复现 90.1% 那份统计
```

## 许可

MIT
