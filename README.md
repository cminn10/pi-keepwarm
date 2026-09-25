# pi-keepwarm

A [pi](https://pi.dev) extension that keeps a long session's prompt cache warm **while you're idle**, so the first message after a 20–60 minute break reads the cache instead of paying for a full cache rewrite.

By default you switch it on per session with `/keepwarm` and off when you're done. With `autoStart` in the config file it turns on in every session.

## Why

Provider prompt caches expire quickly when nothing touches them:

| Provider | Default cache lifetime |
|---|---|
| Anthropic (Claude) | 5 min (a hit resets the timer; optional 1h tier writes at 2× base input) |
| OpenAI, GPT-5.6+ | ≥ 30 min |
| OpenAI, earlier models | `in_memory`: ~5–10 min; `24h` retention where supported |

In a 150k-token Claude session, stepping away for 10 minutes means the next message rewrites the whole prefix at 1.25× input price. Refreshing the cache before it expires only costs a cache read of the prefix (0.1× input, 0.05× on Opus 5.5).

Pi's built-in `cacheWarming` setting refreshes during runs, or for at most 30 minutes after a run with `"idle"`. keepwarm is for longer breaks: you turn it on yourself, and it keeps refreshing until you turn it off or a time or cost limit is reached.

## Install

```bash
pi install npm:pi-keepwarm
```

or from git:

```bash
pi install git:github.com/cminn10/pi-keepwarm
```

## Usage

| Command | Effect |
|---|---|
| `/keepwarm` | Toggle; turning on uses the defaults from the config file |
| `/keepwarm on 5h $20` | Turn on; given limits override the configured defaults |
| `/keepwarm on forever` | No time limit (the configured cost cap still applies) |
| `/keepwarm on 5h` *(while on)* | Change only the time limit (counted from now) |
| `/keepwarm on $30` *(while on)* | Change only the cost cap; `nocap` removes it |
| `/keepwarm status` | Show state, TTL, next refresh, refreshes, cost, failures |
| `/keepwarm config` | Show the config file path and effective defaults |
| `/keepwarm off` | Stop |

The cost cap counts all keepwarm spend in the session, including before an off/on.

## Configuration

On first session start keepwarm creates `~/.pi/agent/keepwarm.json` (or the equivalent under `PI_CODING_AGENT_DIR`) with the defaults:

```json
{
  "autoStart": false,
  "duration": "2h",
  "maxCost": null,
  "maxRetries": 2
}
```

| Key | Meaning |
|---|---|
| `autoStart` | `true` turns keepwarm on automatically in every session |
| `duration` | Default time limit: `"90m"`, `"2h"`, `"forever"` |
| `maxCost` | Default cost cap in USD for keepwarm spend per session, or `null` for no cap |
| `maxRetries` | Stop after this many consecutive failed refreshes (errors or cache misses) |

Example: always on, no time limit, at most $10 per session:

```json
{ "autoStart": true, "duration": "forever", "maxCost": 10, "maxRetries": 2 }
```

The file is re-read on every session start and every `/keepwarm` / `/keepwarm on`, so edits apply without reloading. Invalid values fall back to the built-in default and are reported. Keys starting with `_` (like the generated `_help`) are ignored.

Status bar:

```
🔥 keepwarm · ⏳ active · 3× $0.09/$20.00          agent is running, refreshes paused
🔥 keepwarm · next 10:52 PM · 4× $0.12/$20.00      idle, next refresh time
```

## How it works

- Every real provider request in the session is captured in `before_provider_request`.
- While the agent is **idle**, just before the cache would expire, the last captured request is re-sent byte-for-byte with the smallest output cap (`max_tokens: 1` on Anthropic, `max_output_tokens: 16` on OpenAI Responses). An identical prefix means the provider serves it from cache and resets the cache lifetime. Nothing is added to the conversation.
- The next refresh is scheduled at 90% of the TTL, and at least 15s before expiry, measured from the **start** of the last request that touched the cache. Provider TTLs run from request start.
- **No refreshes during a run.** keepwarm pauses on `agent_start` and resumes on `agent_settled`. Long tool calls inside a run are covered by pi's built-in `cacheWarming: "streaming"` (the default). While idle, keepwarm tells the built-in warmer to stand down so the two don't double-refresh.
- TTL is detected from the payload: `cache_control.ttl: "1h"` on Anthropic, `prompt_cache_retention` / `prompt_cache_options` on OpenAI. A model's `promptCache` lifetimes in `models.json` take precedence.
- Warming pauses until the next real message on model switch, compaction, `/tree` navigation, or if the refresh timer fires after the cache has already expired (for example after the machine slept). A refresh at that point would be a full-price write.
- Each refresh is recorded as a `keepwarm` custom entry in the session file with its provider usage and cost.
- A failed refresh is retried after 15s while the cache is still alive. After `maxRetries` consecutive failures keepwarm turns itself off. A refresh that reports a cache write instead of a read counts as a failure, since the replay no longer matches. A successful refresh or a new real request resets the count.

### Cost example (Claude Opus 5.5, 150k-token context)

| | Cost |
|---|---|
| One refresh (cache read) | ~$0.03 |
| One hour idle with keepwarm (13 refreshes) | ~$0.40 |
| One cold rewrite of the prefix | ~$0.78 |

## Supported APIs

`anthropic-messages`, `openai-responses`, `azure-openai-responses`, `openai-codex-responses`, `openai-completions`.

## Notes and limits

- Runtime state (on/off, spend, captured request) is per session and in memory. After `/reload` or reopening a session, keepwarm starts fresh: auto-started if `autoStart` is set, otherwise run `/keepwarm` again. It arms on the next message.
- If another extension rewrites the provider payload after keepwarm captures it, the replay won't match and will be a cache write. keepwarm warns when a refresh reports no cache read ("cache was already cold").
- Refresh cost is recorded in the session file but not included in pi's own session cost totals.
- Tested with pi 0.87.1.

### Testing overrides

`PI_KEEPWARM_EVERY_SEC` forces the refresh interval. `PI_KEEPWARM_TTL_SEC` forces the assumed TTL. `PI_KEEPWARM_TEST_FAIL=1` makes refreshes fail (invalid `max_tokens`) to exercise retry handling.

## License

MIT
