import assert from "node:assert/strict";
import test from "node:test";

import { decode } from "../src/encoder.js";
import { HEADER_NAME, validate } from "../src/protocol.js";
import { HintAdapter, isAuxiliaryKind } from "../src/adapter.js";
import { createAgentHintsPlugin } from "../src/plugin.js";

function body(messages, extra = {}) {
  return {
    model: "claude-sonnet-4",
    system: "You are a coding agent.",
    messages,
    tools: [{ name: "Read" }, { name: "Bash" }],
    ...extra,
  };
}

function makePlugin(options = {}) {
  const adapter = new HintAdapter({
    sessionId: "ah-plugin",
    config: { cacheMinPrefixTokens: 0 },
  });
  return { plugin: createAgentHintsPlugin({ adapter, ...options }), adapter };
}

test("an embedded turn returns a valid hint header", async () => {
  const { plugin } = makePlugin();
  const result = await plugin.hooks.before_model_request({
    runtime: "embedded",
    requestKind: "turn",
    payload: body([{ role: "user", content: "list the crates" }]),
    provider: "anthropic",
    model: "claude-sonnet-4",
  });
  assert.ok(result);
  assert.ok(result.headers[HEADER_NAME]);
  const hint = decode(result.headers[HEADER_NAME]);
  assert.deepEqual(validate(hint), []);
  assert.equal(hint.session.state, "start");
  assert.equal(hint.cache_control.msg_offset, 1);
  assert.deepEqual(hint.priority_control.priority, { level: 3, reason: "user_waiting" });
});

test("the payload is passed through untouched", async () => {
  const { plugin } = makePlugin();
  const payload = body([{ role: "user", content: "hi" }]);
  const result = await plugin.hooks.before_model_request({
    runtime: "embedded",
    requestKind: "turn",
    payload,
    provider: "anthropic",
    model: "claude-sonnet-4",
  });
  assert.equal(result.payload, payload);
});

test("compaction and side questions are hint-free and do not advance counters", async () => {
  const { plugin, adapter } = makePlugin();
  for (const requestKind of ["compaction", "side_question"]) {
    const result = await plugin.hooks.before_model_request({
      runtime: "embedded",
      requestKind,
      payload: body([{ role: "user", content: "summarise" }]),
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
    assert.equal(result, undefined);
  }
  assert.equal(adapter.snapshot().callIndex, 0);
});

test("CLI runtimes are skipped", async () => {
  const { plugin, adapter } = makePlugin();
  const result = await plugin.hooks.before_model_request({
    runtime: "cli",
    requestKind: "turn",
    payload: { prompt: "hi" },
    provider: "anthropic",
    model: "claude-sonnet-4",
  });
  assert.equal(result, undefined);
  assert.equal(adapter.snapshot().callIndex, 0);
});

test("a completed call advances the session", async () => {
  const { plugin, adapter } = makePlugin();
  await plugin.hooks.before_model_request({
    runtime: "embedded",
    requestKind: "turn",
    payload: body([{ role: "user", content: "hi" }]),
    provider: "anthropic",
    model: "claude-sonnet-4",
  });
  assert.equal(adapter.snapshot().callIndex, 1);

  await plugin.hooks.model_call_ended({ outcome: "completed" });
  const second = await plugin.hooks.before_model_request({
    runtime: "embedded",
    requestKind: "turn",
    payload: body([{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }]),
    provider: "anthropic",
    model: "claude-sonnet-4",
  });
  const hint = decode(second.headers[HEADER_NAME]);
  assert.equal(hint.session.state, "append");
  assert.equal(hint.session.call_index, 2);
});

test("a failed call does not mark the hint accepted", async () => {
  const { plugin, adapter } = makePlugin();
  await plugin.hooks.before_model_request({
    runtime: "embedded",
    requestKind: "turn",
    payload: body([{ role: "user", content: "hi" }]),
    provider: "anthropic",
    model: "claude-sonnet-4",
  });
  await plugin.hooks.model_call_ended({ outcome: "error" });
  const hint = adapter.snapshot();
  assert.equal(hint.firstAccepted, false);
});

test("a retried byte-identical request reuses the same hint", async () => {
  const { plugin } = makePlugin();
  const event = {
    runtime: "embedded",
    requestKind: "turn",
    payload: body([{ role: "user", content: "hi" }]),
    provider: "anthropic",
    model: "claude-sonnet-4",
  };
  const first = await plugin.hooks.before_model_request(event);
  const retry = await plugin.hooks.before_model_request(event);
  assert.deepEqual(first.headers, retry.headers);
});

test("unknown request kinds are treated like a turn", () => {
  assert.equal(isAuxiliaryKind(undefined), false);
  assert.equal(isAuxiliaryKind("turn"), false);
  assert.equal(isAuxiliaryKind("compaction"), true);
  assert.equal(isAuxiliaryKind("side_question"), true);
});

test("facts prefer Anthropic content blocks", () => {
  const facts = HintAdapter.factsFromBody({
    provider: "anthropic",
    model: "claude-sonnet-4",
    body: body([
      { role: "user", content: [{ type: "text", text: "list the crates" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "api, runtime" }],
      },
    ]),
  });
  assert.equal(facts.messages.length, 3);
  assert.equal(facts.messages[1].hasToolCall, true);
  assert.equal(facts.messages[2].hasToolResult, true);
  assert.deepEqual(facts.tools, ["Bash", "Read"]);
  assert.equal(facts.systemText, "You are a coding agent.");
});
