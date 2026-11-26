import assert from "node:assert/strict";
import test from "node:test";

import { ManageClient } from "../src/manage.js";
import { decode } from "../src/encoder.js";
import {
  HintSession,
  SessionIsolatedError,
  deriveTurnOpening,
  estimatePrefixTokens,
  estimateTextTokens,
} from "../src/state.js";

const config = { cacheMinPrefixTokens: 0 };

function makeSession(overrides = {}) {
  return new HintSession({ sessionId: "ah-test", config: { ...config, ...overrides } });
}

function request(messages) {
  return {
    messages,
    model: "claude-sonnet-4",
    tools: ["Read", "Bash"],
  };
}

const user = (text) => ({ role: "user", text });
const assistant = (text) => ({ role: "assistant", text });

test("first call is start, then append", () => {
  const session = makeSession();
  const first = session.build(request([user("hi")]));
  assert.equal(first.session.state, "start");
  assert.equal(first.session.call_index, 1);
  assert.equal(first.session.epoch, 0);

  session.noteAccepted();
  const second = session.build(request([user("hi"), assistant("hello")]));
  assert.equal(second.session.state, "append");
  assert.equal(second.session.call_index, 2);
});

test("a tool continuation is append and critical_path", () => {
  const session = makeSession();
  session.noteAccepted();
  const hint = session.build(
    request([
      user("read the file"),
      { role: "assistant", text: "", hasToolCall: true },
      { role: "tool", text: "file contents", hasToolResult: true },
    ]),
  );
  assert.equal(hint.session.state, "append");
  assert.deepEqual(hint.priority_control.priority, { level: 1, reason: "critical_path" });
});

test("a retry reuses the exact hint until accepted", () => {
  const session = makeSession();
  const req = request([user("hi")]);
  const first = session.build(req);
  const retry = session.build(req);
  assert.deepEqual(first, retry);
  assert.equal(retry.session.call_index, 1);

  session.noteAccepted();
  const next = session.build(req);
  assert.equal(next.session.call_index, 2);
  assert.notEqual(first.session.state, next.session.state);
});

test("auxiliary requests never carry a hint and do not consume a call index", () => {
  const session = makeSession();
  const req = { ...request([user("summarise")]), auxiliary: true };
  assert.equal(session.build(req), null);
  assert.equal(session.snapshot().callIndex, 0);
});

test("cache_control reports the wire message count", () => {
  const session = makeSession();
  const hint = session.build(request([user("a"), assistant("b"), user("c")]));
  assert.equal(hint.cache_control.msg_offset, 3);
  assert.equal(hint.cache_control.type, "ephemeral");
  assert.equal(hint.cache_control.ttl_s, 600);
});

test("a short prefix suppresses cache_control", () => {
  const session = new HintSession({ sessionId: "ah-test" });
  const hint = session.build(request([user("hi")]));
  assert.equal(hint.cache_control, undefined);
});

test("out-of-band system text counts toward the cache floor but not msg_offset", () => {
  const plain = new HintSession({
    sessionId: "ah-test",
    config: { cacheMinPrefixTokens: 10 },
  });
  assert.equal(plain.build(request([user("hi")])).cache_control, undefined);

  const withSystem = new HintSession({
    sessionId: "ah-test",
    config: { cacheMinPrefixTokens: 10 },
  });
  const hint = withSystem.build({
    ...request([user("hi")]),
    systemText: "You are Claw Code, a terminal coding agent that edits files.",
  });
  assert.equal(hint.cache_control.msg_offset, 1);
});

test("a rewrite bumps the epoch and suppresses the first cache block", () => {
  const session = makeSession();
  session.build(request([user("hi")]));
  session.noteAccepted();

  const superseded = session.noteRewrite();
  assert.equal(superseded, 0);
  const hint = session.build(request([user("hi"), assistant("x")]));
  assert.equal(hint.session.epoch, 1);
  assert.equal(hint.cache_control, undefined);

  session.noteAccepted();
  const next = session.build(request([user("hi"), assistant("x"), user("y")]));
  assert.notEqual(next.cache_control, undefined);
});

test("manage requests follow the call_index convention", () => {
  const session = makeSession();
  session.build(request([user("hi")]));
  session.noteAccepted();
  session.build(request([user("hi"), assistant("x")]));

  const pause = session.buildManage("pause");
  assert.equal(pause.session.call_index, 2);
  assert.deepEqual(pause.context_management.edits, [{ type: "offload", target: "session" }]);

  const resume = session.buildManage("resume");
  assert.equal(resume.session.call_index, 3);

  const compact = session.buildManage("compact");
  assert.equal(compact.session.call_index, 2);
  assert.equal(pause.priority_control, undefined);
  assert.equal(pause.cache_control, undefined);
});

test("an unresolved manage request isolates the session", () => {
  const session = makeSession();
  session.isolate();
  assert.throws(() => session.build(request([user("hi")])), SessionIsolatedError);
  session.clearIsolation();
  assert.notEqual(session.build(request([user("hi")])), null);
});

test("snapshots round-trip", () => {
  const session = makeSession();
  session.build(request([user("hi")]));
  session.noteAccepted();
  session.noteRewrite();
  session.noteResponseEnd(12.5);
  const snapshot = session.snapshot();

  const restored = makeSession();
  restored.restore(snapshot);
  assert.deepEqual(restored.snapshot(), snapshot);
});

test("turn opening walks back over empty assistant placeholders", () => {
  assert.equal(deriveTurnOpening([user("hi"), assistant("")]), true);
  assert.equal(deriveTurnOpening([user("hi"), assistant("partial")]), false);
  assert.equal(
    deriveTurnOpening([user("hi"), { role: "assistant", text: "", hasToolCall: true }]),
    false,
  );
  assert.equal(deriveTurnOpening([]), false);
});

test("prefix tokens are null without text", () => {
  assert.equal(estimatePrefixTokens([]), null);
  assert.equal(estimatePrefixTokens([{ role: "user", text: "" }]), null);
  assert.equal(estimatePrefixTokens([{ role: "user", text: "abcd" }]), 1);
  assert.equal(estimatePrefixTokens([{ role: "user", text: "中文" }]), 2);
  assert.equal(estimateTextTokens("abcd"), 1);
});

test("invalid config is rejected early", () => {
  assert.throws(
    () => new HintSession({ sessionId: "ah-test", config: { ttlMinS: 10 } }),
    /TTL bounds/,
  );
  assert.throws(
    () =>
      new HintSession({
        sessionId: "ah-test",
        config: { priorityLevel: 3, priorityReason: "critical_path" },
      }),
    /must pair/,
  );
});

test("manage client materialises a placeholder request", () => {
  const session = makeSession();
  session.build(request([user("hi")]));
  session.noteAccepted();
  const client = new ManageClient({ baseUrl: "https://gateway.example/", model: "m" });
  const manage = session.buildManage("pause");
  const wire = client.build(manage);

  assert.equal(wire.method, "POST");
  assert.equal(wire.url, "https://gateway.example/v1/messages");
  assert.equal(wire.body, '{"model":"m","messages":[],"stream":false}');
  const header = wire.headers.find(([name]) => name === "X-Agent-Hint");
  assert.deepEqual(decode(header[1]), manage);
});
