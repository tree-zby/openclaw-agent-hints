# openclaw-agent-hints

[Agent Hint protocol](https://github.com/tree-zby/agent-hint-research) (`X-Agent-Hint`, v1.0) sender for
[OpenClaw](https://github.com/openclaw/openclaw).

The plugin adds one HTTP header to outbound model requests so a hint-aware
inference gateway can tell **which session a call belongs to**, where it sits in
the session's lifecycle, how urgent it is, and how much of the prefix is still
cacheable. The request body is never modified.

```
POST /v1/messages
x-agent-hint: eyJzZXNzaW9uIjp7InNlc3Npb25faWQiOiJhaC0...
```

## What it sends

| Block | Content |
|---|---|
| `session` | `session_id`, `call_index`, `epoch`, `state` (`start` / `append`) |
| `priority_control` | `level` 3 + `user_waiting` while the user waits; 1 + `critical_path` otherwise |
| `cache_control` | `ephemeral`, adaptive `ttl_s`, `msg_offset` = **wire** message count |
| `context_management` | only on manage requests: `manage_request: true` + one explicit `edits[]` |

Lifecycle verbs (`pause` / `resume` / `stop` / `compact`) are **separate HTTP
requests** with a placeholder body — never flags on a normal call.

## Why a patch

OpenClaw has no outbound-header channel: `before_model_request` can only replace
the payload, and `models.providers.<id>.headers` is static configuration. This
repository therefore ships one small patch (89 diff lines, 3 files) that lets
`before_model_request` return `headers` and merges them into
`StreamOptions.headers` — the documented "merged with provider defaults" field.

```bash
git clone https://github.com/openclaw/openclaw
cd openclaw
git apply /path/to/openclaw-agent-hints/patches/0001-model-request-headers.patch
```

The patch:

1. adds `headers?: Record<string, string>` to `PluginHookBeforeModelRequestResult`;
2. seeds a stable `headers` object on the stream options so the merge survives
   the later `{...options}` spread;
3. merges what the hook returned, sanitising names to the `x-` namespace and
   rejecting control characters. Anything else is dropped.

Without the patch the plugin still runs; OpenClaw just ignores the returned
`headers`.

## Install

```bash
npm install github:tree-zby/openclaw-agent-hints
```

Then register it like any plugin:

```js
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createAgentHintsPlugin } from "openclaw-agent-hints";

export default definePluginEntry(createAgentHintsPlugin());
```

`createAgentHintsPlugin()` returns a plain object (`id`, `name`, `hooks`) with no
runtime dependency on OpenClaw, so it can be unit-tested without the host.

## What it maps

| OpenClaw fact | Hint decision |
|---|---|
| `requestKind: "turn"` | ordinary request (`start` / `append`) |
| `requestKind: "compaction"` / `"side_question"` | no hint at all |
| unknown `requestKind` | treated like `turn`, per OpenClaw's own guidance |
| `runtime: "cli"` | skipped — the CLI owns its wire request |
| `AssistantMessage.content[].type === "tool_use"` | tool continuation → `critical_path` |
| `system` (string or text blocks) | counted for the cache floor, never for `msg_offset` |
| `model_call_ended.outcome === "completed"` | `note_accepted()` + response-end time |

## Verified behaviour

`e2e/evidence/openclaw.json` is a raw HTTP/1.1 capture over `127.0.0.1` against
a real `node:http` server. The harness is emulated at the seam the patch creates:
`before_model_request` returns `{ payload, headers }`, the runner merges them,
and the bytes are decoded with the same codec a gateway uses.

| # | Stage | Header | state | call_index | epoch | cache offset | priority |
|---|---|---|---|---|---|---|---|
| 1 | first turn | yes | `start` | 1 | 0 | 1 | 3 |
| 2 | tool continuation | yes | `append` | 2 | 0 | 3 | 1 |
| 3 | compaction | **no** | — | — | — | — | — |
| 4 | `compact` manage | yes | `compact` | 2 | **0** (superseded) | — | — |
| 5 | next turn | yes | `append` | 3 | **1** | **suppressed** | 3 |
| 6–8 | `pause` / `resume` / `stop` | yes | verb | 3 / 4 / 3 | 1 | — | — |

Checks in the capture: `every_hint_valid`, `body_has_no_hint_fields`,
`auxiliary_request_has_no_hint`, `sent_header_matches_capture` — all `true`.

The patch itself is validated with `git apply --check` against a clean upstream
checkout plus a TypeScript parse of the three touched files. OpenClaw's full
workspace is not built here, so this is **seam-level** evidence, not a framework
end-to-end run. See `docs/protocol-compliance.md`.

## Compliance

- **L1** (core wire): complete — ordinary requests only, exact four-block shape.
- **L2** (lifecycle): complete — four verbs, explicit `edits`, placeholder body.
- **L3**: not claimed. OpenClaw exposes no draft/prefetch signal and no archive
  event.
- Full checklist, degradation profile (§12.4) and trigger table (§7.5):
  [`docs/protocol-compliance.md`](docs/protocol-compliance.md).

## Compatibility

| | |
|---|---|
| Protocol | `agent-hint-protocol` v1.0 |
| OpenClaw | workspace HEAD at the time of writing (`before_model_request` with `requestKind`) |
| Node | 20+ (tests use `node --test`; no build step, no runtime dependencies) |
| Patch | 3 files, 89 diff lines |

## Privacy

No prompt text, tool output or user content is sent. The header carries an opaque
session id, counters and cache offsets only. The hook sees the provider body
in-process to count messages and detect tool blocks; nothing is persisted or
forwarded. See [PRIVACY.md](PRIVACY.md).

## License

Apache-2.0.
