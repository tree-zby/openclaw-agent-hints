/**
 * Wire-level capture for the OpenClaw plugin.
 *
 * The harness is emulated at the seam the patch creates: `before_model_request`
 * returns `{ payload, headers }`, the runner merges `headers` into the stream
 * options, and the transport sends them. A real `node:http` server records the
 * bytes, and the captured header is decoded with the same codec a gateway uses.
 *
 * Run with `npm run evidence`; the result lands in `e2e/evidence/openclaw.json`.
 */

import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decode, validate } from "../src/index.js";
import { HintAdapter } from "../src/adapter.js";
import { ManageClient } from "../src/manage.js";
import { createAgentHintsPlugin } from "../src/plugin.js";
import { HEADER_NAME } from "../src/protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const evidencePath = join(here, "..", "e2e", "evidence", "openclaw.json");

const captured = [];
const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    captured.push({
      requestLine: `${request.method} ${request.url} HTTP/${request.httpVersion}`,
      headers: request.headers,
      body,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
});

/** The exact merge the patch performs: `Object.assign(options.headers, result.headers)`. */
function mergedHeaders(base, result) {
  const headers = { ...base };
  Object.assign(headers, result?.headers ?? {});
  return headers;
}

async function post(origin, headers, body) {
  const response = await fetch(`${origin}/v1/messages`, {
    method: "POST",
    headers,
    body,
  });
  await response.text();
}

const adapter = new HintAdapter({
  sessionId: "ah-openclaw-capture",
  config: { cacheMinPrefixTokens: 0 },
});
const plugin = createAgentHintsPlugin({ adapter });

const systemPrompt = "You are OpenClaw, a terminal coding agent.";

function turnBody(messages) {
  return { model: "claude-sonnet-4", system: systemPrompt, messages, tools: [{ name: "Read" }] };
}

const sent = [];

async function sendEmbedded({ requestKind, payload, label }) {
  const result = await plugin.hooks.before_model_request({
    runtime: "embedded",
    requestKind,
    payload,
    provider: "anthropic",
    model: "claude-sonnet-4",
  });
  const headers = mergedHeaders({ "content-type": "application/json" }, result);
  await post(origin, headers, JSON.stringify(payload));
  sent.push({ label, hintSent: headers[HEADER_NAME] ?? null, payload });
}

async function sendManage(client, state, label) {
  const request = client.lifecycle(adapter.session, state);
  const headers = Object.fromEntries(request.headers);
  await post(origin, headers, request.body);
  sent.push({ label, hintSent: headers[HEADER_NAME] ?? null, payload: request.body });
}

let origin = "";

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
  const client = new ManageClient({ baseUrl: origin, model: "claude-sonnet-4" });

  // 1. First main-line call.
  await sendEmbedded({
    requestKind: "turn",
    label: "turn:start",
    payload: turnBody([{ role: "user", content: "Summarise the repository layout." }]),
  });
  await plugin.hooks.model_call_ended({ outcome: "completed" });

  // 2. Tool continuation: append + critical_path.
  await sendEmbedded({
    requestKind: "turn",
    label: "turn:tool-continuation",
    payload: turnBody([
      { role: "user", content: "Summarise the repository layout." },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "crates/api/src/lib.rs" }],
      },
    ]),
  });
  await plugin.hooks.model_call_ended({ outcome: "completed" });

  // 3. Auxiliary compaction request: no hint at all.
  await sendEmbedded({
    requestKind: "compaction",
    label: "auxiliary:compaction",
    payload: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Summarise this conversation." }],
    },
  });

  // 4. compact manage request: placeholder body, superseded epoch.
  const compact = client.compact(adapter.session);
  await post(origin, Object.fromEntries(compact.headers), compact.body);
  sent.push({
    label: "manage:compact",
    hintSent: compact.headers.find(([name]) => name === HEADER_NAME)?.[1] ?? null,
    payload: compact.body,
  });

  // 5. First turn after the rewrite: epoch 1, no cache_control yet.
  await sendEmbedded({
    requestKind: "turn",
    label: "turn:after-compact",
    payload: turnBody([
      { role: "user", content: "Summarise the repository layout." },
      { role: "assistant", content: "Here is the layout." },
      { role: "user", content: "Now list the crates." },
    ]),
  });
  await plugin.hooks.model_call_ended({ outcome: "completed" });

  // 6. Lifecycle verbs.
  for (const state of ["pause", "resume", "stop"]) {
    await sendManage(client, state, state);
  }

  await new Promise((resolve) => server.close(resolve));

  const requests = sent.map((entry, index) => {
    const observed = captured[index];
    const headerValue = observed?.headers?.[HEADER_NAME.toLowerCase()] ?? null;
    const hint = headerValue ? decode(headerValue) : null;
    return {
      index: index + 1,
      stage: entry.label,
      request_line: observed?.requestLine ?? null,
      hint_header_present: Boolean(headerValue),
      hint,
      body_has_hint_fields:
        (observed?.body ?? "").includes("X-Agent-Hint") ||
        (observed?.body ?? "").includes('"session"'),
      sent_header_matches_capture: (entry.hintSent ?? null) === headerValue,
      captured_request_body: observed?.body ?? null,
    };
  });

  const hints = requests.filter((entry) => entry.hint !== null).map((entry) => entry.hint);
  const evidence = {
    harness: "openclaw",
    harness_version: "2026.11 (workspace HEAD)",
    protocol: "agent-hint-protocol v1.0",
    capture: "raw HTTP/1.1 over 127.0.0.1, server-side byte capture",
    seam: "before_model_request -> headers merged into StreamOptions.headers",
    generated_at_unix: Math.floor(Date.now() / 1000),
    requests,
    checks: {
      every_hint_valid: hints.every((hint) => validate(hint).length === 0),
      body_has_no_hint_fields: requests.every((entry) => entry.body_has_hint_fields === false),
      auxiliary_request_has_no_hint:
        requests.find((entry) => entry.stage === "auxiliary:compaction")?.hint_header_present ===
        false,
      sent_header_matches_capture: requests.every((entry) => entry.sent_header_matches_capture),
      states: hints.map((hint) => hint.session.state),
      epochs: hints.map((hint) => hint.session.epoch),
      cache_msg_offsets: hints
        .filter((hint) => hint.cache_control)
        .map((hint) => hint.cache_control.msg_offset),
    },
  };

  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(evidence, null, 2));
}

await main();
