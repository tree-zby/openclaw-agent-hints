# Protocol compliance — `openclaw-agent-hints`

Target: **`agent-hint-protocol` v1.0**, level **L1 + L2** (L3 not claimed).

Harness: [OpenClaw](https://github.com/openclaw/openclaw), workspace HEAD at the
time of writing (`before_model_request` with `requestKind`, `StreamOptions.headers`).

## 1. L1 checklist

### Transport (W)

| ID | Requirement | Status | Where |
|---|---|---|---|
| W-01 | Hint only in `X-Agent-Hint`, matched case-insensitively | ✅ | `protocol.js`, `tests/protocol.test.js` |
| W-02 | Request body carries no hint field | ✅ | `examples/wire_capture.js` asserts `body_has_no_hint_fields = true` |
| W-03 | base64url, no padding, UTF-8 JSON | ✅ | `encoder.js` |
| W-04 | Single header value, ≤ 4 KB | ✅ | `encode()` rejects payloads over `MAX_HEADER_BYTES` |
| W-05 | Auxiliary requests carry no hint | ✅ | `isAuxiliaryKind`; compaction and side questions return `undefined` |
| W-06 | No session identity → no hint | ✅ | `HintSession` always owns an id; `HintAdapter` never emits without one |
| W-07 | Retry reuses the same hint, `call_index` unchanged | ✅ | fingerprint reuse in `HintSession.build`; `tests/plugin.test.js` |

### Shape

| ID | Requirement | Status |
|---|---|---|
| S-01 | Top level contains only the four blocks | ✅ `validate()` |
| S-02 | Ordinary request: `session.state ∈ {start, append}` | ✅ |
| S-03 | Ordinary request never carries `context_management` | ✅ |
| S-04 | Manage request: `manage_request` is boolean `true` and exactly one edit | ✅ |
| S-05 | `edits[0].target == "session"`, type matches the verb | ✅ `editForState` |
| S-06 | `priority.level` ∈ {1,3}, paired with the matching reason | ✅ `foldPriority` |
| S-07 | `cache_control` uses only `type` / `ttl_s` / `msg_offset` | ✅ |

### Values

| ID | Requirement | Status |
|---|---|---|
| V-01 | `call_index` starts at 1 and is monotonic (retries excluded) | ✅ |
| V-02 | `msg_offset` is the **wire** message count, not a token offset | ✅ `request.messages.length` |
| V-03 | `ttl_s` within [60, 3600] | ✅ clamped |
| V-04 | No `cache_control` on the first request after a rewrite | ✅ `afterRewrite` |
| V-05 | No static prefix claim on a cold signature | ✅ `lastSignature` check |

## 2. L2 checklist

| ID | Requirement | Status |
|---|---|---|
| M-01 | `pause` → `offload`, `resume` → `prefetch`, `stop`/`compact` → `evict` | ✅ |
| M-02 | Manage body is the fixed placeholder `{model, messages: [], stream: false}` | ✅ `ManageClient.build` |
| M-03 | Manage requests carry no `priority_control` / `cache_control` | ✅ |
| M-04 | `compact` carries the **superseded** epoch; the next ordinary request uses `epoch + 1` | ✅ `ManageClient.compact` |
| M-05 | `resume` uses `call_index + 1`, other verbs `max(1, call_index)` | ✅ |
| M-06 | An unresolved manage result isolates the session | ✅ `HintSession.isolate` / `assertReady` |
| M-07 | HTTP 2xx is not treated as KV completion | ✅ state is not advanced by transport |

## 3. L3 — not claimed

OpenClaw exposes no draft/prefetch signal and no archive/delete event for a live
session. `pause` and `stop` are host-driven manage requests, not observations.

## 4. §7.5 Trigger source register

| state | Trigger in this harness | Required | Degradation when missing |
|---|---|---|---|
| `start` / `append` | `before_model_request` on an embedded `turn`; `start` only when `call_index == 1`, no history, not adopted | yes | none |
| `pause` | no idle/away event; host calls `adapter.lifecycleRequest(client, "pause")` | level-dependent | not sent |
| `resume` | host call before re-entering a paused session | level-dependent | session just continues with `append` |
| `stop` | host session teardown | level-dependent | only sent when the host destroys the session |
| `compact` | committed history rewrite; host calls `adapter.compactRequest(client)` | level-dependent | no `compact` sent; KV is not evicted |

## 5. §12.4 Degradation profile

| Missing capability | Degradation used here | Impact |
|---|---|---|
| No header channel upstream | `patches/0001-model-request-headers.patch` | Requires a patched OpenClaw; without it the plugin runs but headers are dropped |
| No persistent event log | In-process counters | `call_index` resets on restart; `epoch` is never fabricated; `snapshot()`/`restore()` available |
| No per-request acceptance callback | `model_call_ended.outcome === "completed"` | A completed auxiliary call also counts as accepted; only affects reuse of byte-identical requests |
| No user-input boundary | Backwards walk over `messages[]` | An adopted session without a trailing user message is prioritised as 1 |
| No interval observation | `now` from `Date.now()` per call | Adaptive TTL uses the gap since the last completed call |
| No draft signal | `resume` only immediately before the request | No prefetch lead time |
| No archive event | `stop` only on session teardown | Archived sessions keep KV until deleted |
| `system` is out of band | Counted via `systemText` for the cache floor only | Never inflates `msg_offset` |

## 6. Harness-specific facts

1. **`requestKind` is authoritative.** `compaction` and `side_question` are
   auxiliary and never carry a hint. OpenClaw says new kinds may appear and
   should be treated like `turn`; this plugin does exactly that.
2. **CLI runtimes are skipped.** Their `payload` is prompt text, not a provider
   body, and they own the wire request, so the patch cannot add headers there.
   Emitting a hint would advance counters without ever sending it.
3. **`system` is out of band.** Anthropic-style bodies carry it at the top level.
   It counts toward `cacheMinPrefixTokens` but never toward `msg_offset`.
4. **Content blocks are understood.** Anthropic `tool_use` / `tool_result` blocks
   are recognised alongside OpenAI `tool_calls` / `role: "tool"`.
5. **Header names are constrained.** The patch accepts only `x-` names, so this
   sender cannot override auth, content-type or length.
6. **Hard-refresh caveat.** The merge relies on the stream options' `headers`
   object being shared by reference across the runner's `{...options}` spread;
   the patch seeds that object before the spread for exactly this reason.
