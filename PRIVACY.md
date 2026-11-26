# Privacy

`openclaw-agent-hints` adds one HTTP header to model requests that OpenClaw
already sends. It does not proxy, duplicate or store those requests.

## What leaves the process

Only the `X-Agent-Hint` header value:

- an opaque `session_id` generated locally (for example `ah-3f9a…`), never a user
  id, email, hostname or file path;
- integer counters: `call_index`, `epoch`;
- a lifecycle state word (`start`, `append`, `pause`, `resume`, `stop`, `compact`);
- a priority level and reason;
- cache metadata: `type`, `ttl_s`, `msg_offset` (a message count, not text).

The header goes to the same endpoint the model request already targets. No
telemetry, analytics, crash reporting or "phone home" endpoint is used.

## What never leaves the process

- Prompt text, tool arguments, tool output, file contents and images.
- Credentials. The plugin never reads API keys and does not touch the
  authorization headers OpenClaw builds.
- The provider body. `before_model_request` hands the already-built body to the
  plugin in-process; the plugin reads `messages[].role`, content-block types,
  `tools[].name` and `system`, and returns the payload untouched
  (`result.payload === event.payload`).

## Header hygiene

The patch that ships with this repository accepts only `x-` header names and
rejects control characters, so a plugin cannot override `authorization`,
`content-type` or `content-length`.

## Local state

`HintSession` keeps counters in memory. `snapshot()` / `restore()` exist for
hosts that want to persist them; nothing is written to disk by this package
except the evidence file produced by `npm run evidence`.

## Opt-out

`createAgentHintsPlugin({ config: { enabled: false } })` returns no headers, and
removing the plugin is equivalent.
