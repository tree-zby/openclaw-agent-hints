import assert from "node:assert/strict";
import test from "node:test";

import { decode, encode } from "../src/encoder.js";
import {
  HEADER_NAME,
  editForState,
  foldPriority,
  isManageHint,
  isOrdinaryState,
  isPriorityPairValid,
  validate,
} from "../src/protocol.js";

function startHint() {
  return {
    session: { session_id: "ah-test", call_index: 1, epoch: 0, state: "start" },
    priority_control: { priority: { level: 3, reason: "user_waiting" } },
    cache_control: { type: "ephemeral", ttl_s: 600, msg_offset: 1 },
  };
}

test("encodes without padding and round-trips", () => {
  const hint = startHint();
  const encoded = encode(hint);
  assert.equal(encoded.includes("="), false);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decode(encoded), hint);
});

test("tolerates padded input on decode", () => {
  const hint = startHint();
  assert.deepEqual(decode(`${encode(hint)}==`), hint);
});

test("rejects non-object payloads", () => {
  assert.throws(() => decode("WzEsMiwzXQ"), /must be a JSON object/);
  assert.throws(() => decode("   "), /empty/);
});

test("header name matches the contract", () => {
  assert.equal(HEADER_NAME, "X-Agent-Hint");
});

test("accepts a minimal start hint", () => {
  assert.deepEqual(validate(startHint()), []);
});

test("accepts compact and detects it as a manage request", () => {
  const hint = {
    session: { session_id: "ah-test", call_index: 7, epoch: 2, state: "compact" },
    context_management: {
      manage_request: true,
      edits: [{ type: "evict", target: "session" }],
    },
  };
  assert.deepEqual(validate(hint), []);
  assert.equal(isManageHint(hint), true);
  assert.equal(isOrdinaryState("compact"), false);
  assert.equal(editForState("compact"), "evict");
});

test("rejects context_management on an ordinary request", () => {
  const hint = startHint();
  hint.context_management = {
    manage_request: true,
    edits: [{ type: "evict", target: "session" }],
  };
  assert.ok(validate(hint).some((error) => error.includes("MUST NOT appear")));
});

test("rejects priority or cache blocks on a manage request", () => {
  const hint = {
    session: { session_id: "ah-test", call_index: 7, epoch: 2, state: "pause" },
    context_management: {
      manage_request: true,
      edits: [{ type: "offload", target: "session" }],
    },
    priority_control: { priority: { level: 1, reason: "critical_path" } },
  };
  assert.ok(validate(hint).some((error) => error.includes("priority_control")));
});

test("rejects the wrong edit for the state", () => {
  const hint = {
    session: { session_id: "ah-test", call_index: 7, epoch: 2, state: "resume" },
    context_management: {
      manage_request: true,
      edits: [{ type: "offload", target: "session" }],
    },
  };
  assert.ok(validate(hint).some((error) => error.includes("prefetch")));
});

test("rejects a mismatched priority pair and bad cache values", () => {
  const hint = startHint();
  hint.priority_control = { priority: { level: 3, reason: "critical_path" } };
  hint.cache_control = { type: "ephemeral", ttl_s: 30, msg_offset: 0 };
  const errors = validate(hint);
  assert.ok(errors.some((error) => error.includes("must pair")));
  assert.ok(errors.some((error) => error.includes("ttl_s")));
  assert.ok(errors.some((error) => error.includes("msg_offset")));
});

test("rejects unknown top-level and session keys", () => {
  const hint = startHint();
  hint.extra = true;
  hint.session.note = "nope";
  const errors = validate(hint);
  assert.ok(errors.some((error) => error.includes("top-level")));
  assert.ok(errors.some((error) => error.includes("session key")));
});

test("priority folds to the two allowed levels", () => {
  assert.deepEqual(foldPriority(1), { level: 1, reason: "critical_path" });
  assert.deepEqual(foldPriority(2), { level: 1, reason: "critical_path" });
  assert.deepEqual(foldPriority(3), { level: 3, reason: "user_waiting" });
  assert.deepEqual(foldPriority(9), { level: 3, reason: "user_waiting" });
  assert.equal(foldPriority(0), null);
  assert.equal(isPriorityPairValid({ level: 3, reason: "user_waiting" }), true);
  assert.equal(isPriorityPairValid({ level: 3, reason: "critical_path" }), false);
});
