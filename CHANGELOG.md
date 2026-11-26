# Changelog

## 0.1.0

First release. Implements the sender side of `agent-hint-protocol` v1.0
(L1 + L2, L3 not claimed) for OpenClaw.

- `protocol`: header name, 4 KB budget, six states, priority fold to `{1, 3}`,
  full shape validation (four top-level blocks only).
- `encoder`: base64url without padding, padded input accepted on decode.
- `state`: `start`/`append` derivation, `call_index`, `epoch`, fingerprint-based
  retry reuse, adaptive TTL, wire `msg_offset`, prefix heuristic that treats
  absent text as `null`, out-of-band `system` counted only for the cache floor.
- `manage`: fixed placeholder body, `offload`/`prefetch`/`evict` mapping,
  superseded epoch on `compact`, `resume` using `call_index + 1`.
- `adapter`: `HintAdapter.factsFromBody` for Anthropic and OpenAI-compatible
  bodies, fail-open header generation.
- `plugin`: `createAgentHintsPlugin()` with `before_model_request` and
  `model_call_ended` handlers; CLI runtimes and auxiliary request kinds are
  skipped.
- `patches/0001-model-request-headers.patch`: optional `headers` on the
  `before_model_request` result, merged into `StreamOptions.headers` with `x-`
  only sanitisation (3 files, 89 diff lines, `git apply --check` verified).
- `examples/wire_capture.js`: real `node:http` capture of eight requests.
