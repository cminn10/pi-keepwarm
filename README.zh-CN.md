# pi-keepwarm

[English](README.md) | 中文

一个 [pi](https://pi.dev) 扩展：在你**空闲时**替长 session 保持 prompt cache 不过期。离开 20–60 分钟后发的第一条消息仍然能直接读缓存，不用全价重写。

默认按 session 手动开关：需要时执行 `/keepwarm`，用完再关。在配置文件里设 `autoStart` 后，每个 session 都会自动开启。

## 为什么需要它

没有请求访问时，各家的 prompt cache 很快就会过期：

| Provider | 默认缓存时长 |
|---|---|
| Anthropic (Claude) | 5 分钟（每次命中重新计时；可选 1h 档，写入价为基础输入价的 2×） |
| OpenAI GPT-5.6 及以后 | ≥ 30 分钟 |
| OpenAI 更早的模型 | `in_memory` 约 5–10 分钟；部分模型支持 `24h` 保留 |

在一个 15 万 token 的 Claude session 里，离开 10 分钟后发的下一条消息要把整个前缀按基础输入价的 1.25× 重写一遍。而在过期前刷新一次缓存，只需付一次读缓存的费用：大多数 Claude 模型是基础输入价的 0.1×，部分模型更低。

pi 内置的 `cacheWarming` 只在对话进行中保温，设成 `"idle"` 后也最多再保温 30 分钟。keepwarm 针对的是更长的空闲：由你手动开启，一直保温到你关闭，或者达到时间、花费上限为止。

## 安装

```bash
pi install npm:pi-keepwarm
```

或从 git 安装：

```bash
pi install git:github.com/cminn10/pi-keepwarm
```

## 用法

| 命令 | 作用 |
|---|---|
| `/keepwarm` | 开关切换；开启时使用配置文件里的默认值 |
| `/keepwarm on 5h $20` | 开启；命令里给出的参数会覆盖配置文件里的默认值 |
| `/keepwarm on forever` | 不限时长（配置文件里的花费上限仍然有效） |
| 开启状态下 `/keepwarm on 5h` | 只改时限（从现在起算） |
| 开启状态下 `/keepwarm on $30` | 只改花费上限；`nocap` 表示去掉上限 |
| `/keepwarm status` | 查看状态、TTL、下次刷新时间、刷新次数、花费、失败次数 |
| `/keepwarm config` | 查看配置文件路径和当前生效的默认值 |
| `/keepwarm off` | 关闭 |

花费上限按本 session 里 keepwarm 的累计花费计算，关掉再开也继续累加。

## 配置

第一次启动 session 时，keepwarm 会生成 `~/.pi/agent/keepwarm.json`（设了 `PI_CODING_AGENT_DIR` 时放在对应目录下），内容是默认配置：

```json
{
  "autoStart": false,
  "duration": "2h",
  "maxCost": null,
  "maxRetries": 2
}
```

| 字段 | 含义 |
|---|---|
| `autoStart` | `true` 表示每个 session 启动时自动开启 |
| `duration` | 默认时限：`"90m"`、`"2h"`、`"forever"` |
| `maxCost` | 每个 session 的 keepwarm 默认花费上限（美元），`null` 表示不设上限 |
| `maxRetries` | 连续失败多少次后自动关闭（请求出错或没读到缓存都算失败） |

示例：总是自动开启，不限时长，每个 session 最多花 $10：

```json
{ "autoStart": true, "duration": "forever", "maxCost": 10, "maxRetries": 2 }
```

每次 session 启动、每次执行 `/keepwarm` 或 `/keepwarm on` 时都会重新读取这个文件，改完不用重新加载 pi。非法的值会退回默认值并提示。以 `_` 开头的字段（比如自动生成的 `_help`）会被忽略。

状态栏：

```
🔥 keepwarm · ⏳ active · 3× $0.09/$20.00          对话进行中，暂停刷新
🔥 keepwarm · next 10:52 PM · 4× $0.12/$20.00      空闲中，显示下次刷新时间
```

## 工作原理

- 在 `before_provider_request` 里抓取 session 中每一次真实请求。
- 在 agent **空闲**期间、缓存快过期时，把最后一次真实请求一字不差地重发一遍，只把输出上限改成最小（Anthropic 用 `max_tokens: 1`，OpenAI Responses 用 `max_output_tokens: 16`）。前缀完全一样，provider 就会直接读缓存并重新计时。这些请求不会进入对话上下文。
- 下次刷新安排在 TTL 的 90%，且至少提前 15 秒，从最后一次访问缓存的请求**开始**的时间算起，因为 provider 的缓存寿命是从请求发出时开始计算的。
- **对话进行中不刷新。** 在 `agent_start` 时暂停，在 `agent_settled` 时恢复。对话中跑得很久的工具调用，由 pi 内置的 `cacheWarming: "streaming"`（默认开启）负责保温。空闲期间 keepwarm 会让内置保温停手，避免重复刷新。
- TTL 从请求内容里识别：Anthropic 看 `cache_control.ttl: "1h"`，OpenAI 看 `prompt_cache_retention` / `prompt_cache_options`。如果 `models.json` 里给模型声明了 `promptCache`，以它为准。
- 以下情况会暂停保温，等下一条真实消息后再开始：切换模型、compaction、`/tree` 跳转，或者定时器触发时缓存已经过期（比如电脑休眠过）。这时再刷新就是一次全价写入。
- 每次刷新都会在 session 文件里写一条 `keepwarm` 记录，包含 provider 返回的用量和花费。
- 刷新失败时，只要缓存还没过期，就在 15 秒后重试。连续失败 `maxRetries` 次后 keepwarm 自动关闭。如果刷新返回的是写缓存而不是读缓存，说明重放的内容和真实请求对不上了，也算一次失败。一次成功的刷新或一次新的真实请求会把失败计数清零。

### 什么时候划算

设上下文有 *P* 个 token，基础输入价为 *B*，使用 Anthropic 的 5 分钟缓存（每 4.5 分钟刷新一次）：

| | 费用 |
|---|---|
| 一次刷新（读缓存） | *P* × *B* × 读缓存倍率（大多数 Claude 模型为 0.1×） |
| 开着 keepwarm 空闲 *T* 分钟 | 约 *T* / 4.5 次刷新 |
| 缓存过期后重写一次 | *P* × *B* × 1.25 |

空闲时间不超过约 **4.5 × 1.25 / 读缓存倍率** 分钟时，保温比过期后重写一次便宜：读缓存倍率为 0.1× 时约 55 分钟，0.05× 时约 110 分钟。超过这个时间，直接让缓存过期反而更省。可以根据自己通常离开多久来设置 `duration` / `maxCost`。

## 支持的 API

`anthropic-messages`、`openai-responses`、`azure-openai-responses`、`openai-codex-responses`、`openai-completions`。

## 注意事项与限制

- 运行状态（开关、花费、抓取到的请求）按 session 保存在内存里。`/reload` 或重新打开 session 后会从头开始：如果设了 `autoStart` 就自动开启，否则需要再执行一次 `/keepwarm`。之后从下一条消息开始保温。
- 如果有别的扩展在 keepwarm 抓取之后又修改了请求内容，重放就对不上，变成一次写缓存。keepwarm 会把这类刷新报告为 cache miss，并计入 `maxRetries`。
- 刷新的花费记录在 session 文件里，但不计入 pi 自己统计的 session 总花费。
- 在 pi 0.87.1 上测试过。

### 测试用的环境变量

`PI_KEEPWARM_EVERY_SEC` 强制指定刷新间隔。`PI_KEEPWARM_TTL_SEC` 强制指定 TTL。`PI_KEEPWARM_TEST_FAIL=1` 让刷新请求失败（非法的 `max_tokens`），用来测试重试逻辑。

## 许可证

MIT
