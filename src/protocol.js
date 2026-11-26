/**
 * Wire schema and validation for `agent-hint-protocol` v1.0.
 *
 * Validation exists to keep the sender honest; a receiver MUST NOT reject a
 * model request because a hint is malformed.
 */

/** HTTP header that carries the base64url-encoded hint. */
export const HEADER_NAME = "X-Agent-Hint";

/** Sender budget from protocol section 3.3. */
export const MAX_HEADER_BYTES = 4096;

/** Ordinary-request states. Every other state is a manage request. */
export const ORDINARY_STATES = Object.freeze(["start", "append"]);

/** All six lifecycle values. */
export const STATES = Object.freeze([
  "start",
  "append",
  "pause",
  "resume",
  "stop",
  "compact",
]);

const EDITS = Object.freeze({
  pause: "offload",
  resume: "prefetch",
  stop: "evict",
  compact: "evict",
});

/**
 * @param {string} state
 * @returns {boolean}
 */
export function isOrdinaryState(state) {
  return ORDINARY_STATES.includes(state);
}

/**
 * @param {string} state
 * @returns {string | null} the single edit type this state must carry
 */
export function editForState(state) {
  return EDITS[state] ?? null;
}

/**
 * Priority 3 always pairs with `user_waiting`, priority 1 with
 * `critical_path` (protocol section 6.4).
 *
 * @param {number} level
 * @returns {{ level: number, reason: string } | null}
 */
export function foldPriority(level) {
  if (!Number.isInteger(level) || level < 0) return null;
  if (level >= 3) return { level: 3, reason: "user_waiting" };
  if (level >= 1) return { level: 1, reason: "critical_path" };
  return null;
}

/**
 * @param {{ level: number, reason: string }} priority
 * @returns {boolean}
 */
export function isPriorityPairValid(priority) {
  const folded = foldPriority(priority.level);
  return Boolean(folded && folded.level === priority.level && folded.reason === priority.reason);
}

/**
 * True when `context_management.manage_request` is the boolean `true`.
 *
 * @param {unknown} hint
 * @returns {boolean}
 */
export function isManageHint(hint) {
  return (
    hint !== null &&
    typeof hint === "object" &&
    hint.context_management !== null &&
    typeof hint.context_management === "object" &&
    hint.context_management.manage_request === true
  );
}

const TOP_LEVEL_KEYS = ["session", "context_management", "priority_control", "cache_control"];
const SESSION_KEYS = ["session_id", "parent_session_id", "call_index", "epoch", "state"];

/**
 * Return every contract violation found in `hint`.
 *
 * @param {unknown} hint
 * @returns {string[]}
 */
export function validate(hint) {
  /** @type {string[]} */
  const errors = [];
  if (hint === null || typeof hint !== "object" || Array.isArray(hint)) {
    return ["hint must be a JSON object"];
  }

  for (const key of Object.keys(hint)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      errors.push(`unexpected top-level key: ${JSON.stringify(key)}`);
    }
  }

  const session = hint.session;
  if (session === null || typeof session !== "object" || Array.isArray(session)) {
    errors.push("session is required and must be an object");
    return errors;
  }
  validateSession(session, errors);

  const state = typeof session.state === "string" ? session.state : undefined;
  const manage = isManageHint(hint);

  if (hint.context_management !== undefined) {
    validateContextManagement(hint.context_management, errors);
  }

  if (manage) {
    if (!state || isOrdinaryState(state)) {
      errors.push(
        `manage request state must be one of pause/resume/stop/compact, got ${JSON.stringify(state)}`,
      );
    } else {
      const expected = editForState(state);
      const actual = hint.context_management?.edits?.[0]?.type;
      if (expected && actual !== expected) {
        errors.push(`edits[0].type must be ${JSON.stringify(expected)} for state ${JSON.stringify(state)}`);
      }
    }
    for (const forbidden of ["priority_control", "cache_control"]) {
      if (hint[forbidden] !== undefined) {
        errors.push(`${forbidden} MUST NOT appear on a manage request`);
      }
    }
  } else {
    if (hint.context_management !== undefined) {
      errors.push("context_management MUST NOT appear on an ordinary request");
    }
    if (!state || !isOrdinaryState(state)) {
      errors.push(`ordinary request state must be one of start/append, got ${JSON.stringify(state)}`);
    }
  }

  if (hint.priority_control !== undefined) {
    validatePriorityControl(hint.priority_control, errors);
  }
  if (hint.cache_control !== undefined) {
    validateCacheControl(hint.cache_control, errors);
  }
  return errors;
}

/**
 * @param {Record<string, unknown>} session
 * @param {string[]} errors
 */
function validateSession(session, errors) {
  for (const key of Object.keys(session)) {
    if (!SESSION_KEYS.includes(key)) {
      errors.push(`unexpected session key: ${JSON.stringify(key)}`);
    }
  }
  const id = session.session_id;
  if (typeof id !== "string" || id.length < 1 || [...id].length > 256) {
    errors.push("session.session_id must be a string of 1..256 characters");
  }
  if (
    session.parent_session_id !== undefined &&
    (typeof session.parent_session_id !== "string" || session.parent_session_id.length === 0)
  ) {
    errors.push("session.parent_session_id must be a non-empty string when present");
  }
  if (!Number.isInteger(session.call_index) || session.call_index < 1) {
    errors.push("session.call_index must be an integer >= 1");
  }
  if (!Number.isInteger(session.epoch) || session.epoch < 0) {
    errors.push("session.epoch must be an integer >= 0");
  }
  if (typeof session.state !== "string" || !STATES.includes(session.state)) {
    errors.push(
      `session.state must be one of ${STATES.join("/")}, got ${JSON.stringify(session.state)}`,
    );
  }
}

/**
 * @param {unknown} context
 * @param {string[]} errors
 */
function validateContextManagement(context, errors) {
  if (context === null || typeof context !== "object" || Array.isArray(context)) {
    errors.push("context_management must be an object");
    return;
  }
  for (const key of Object.keys(context)) {
    if (key !== "manage_request" && key !== "edits") {
      errors.push(`unexpected context_management key: ${JSON.stringify(key)}`);
    }
  }
  if (context.manage_request !== true) {
    errors.push("context_management.manage_request must be the boolean true");
  }
  const edits = context.edits;
  if (!Array.isArray(edits)) {
    errors.push("context_management.edits must be an array");
    return;
  }
  if (edits.length !== 1) {
    errors.push("context_management.edits must contain exactly one edit");
    return;
  }
  const edit = edits[0];
  if (edit === null || typeof edit !== "object") {
    errors.push("context_management.edits[0] must be an object");
    return;
  }
  for (const key of Object.keys(edit)) {
    if (key !== "type" && key !== "target") {
      errors.push(`unexpected edit key: ${JSON.stringify(key)}`);
    }
  }
  if (!["offload", "prefetch", "evict"].includes(edit.type)) {
    errors.push("edit.type must be one of offload/prefetch/evict");
  }
  if (edit.target !== "session") {
    errors.push("edit.target must be 'session'");
  }
}

/**
 * @param {unknown} control
 * @param {string[]} errors
 */
function validatePriorityControl(control, errors) {
  if (control === null || typeof control !== "object" || Array.isArray(control)) {
    errors.push("priority_control must be an object");
    return;
  }
  for (const key of Object.keys(control)) {
    if (key !== "priority") {
      errors.push(`unexpected priority_control key: ${JSON.stringify(key)}`);
    }
  }
  const priority = control.priority;
  if (priority === null || typeof priority !== "object") {
    errors.push("priority_control.priority must be an object");
    return;
  }
  for (const key of Object.keys(priority)) {
    if (key !== "level" && key !== "reason") {
      errors.push(`unexpected priority key: ${JSON.stringify(key)}`);
    }
  }
  if (![1, 3].includes(priority.level)) {
    errors.push("priority.level must be one of 1 or 3");
  }
  if (!["user_waiting", "critical_path"].includes(priority.reason)) {
    errors.push("priority.reason must be one of user_waiting or critical_path");
  }
  if ([1, 3].includes(priority.level) && typeof priority.reason === "string") {
    if (!isPriorityPairValid({ level: priority.level, reason: priority.reason })) {
      errors.push(
        `priority.level ${priority.level} must pair with the matching reason, got ${JSON.stringify(priority.reason)}`,
      );
    }
  }
}

/**
 * @param {unknown} cache
 * @param {string[]} errors
 */
function validateCacheControl(cache, errors) {
  if (cache === null || typeof cache !== "object" || Array.isArray(cache)) {
    errors.push("cache_control must be an object");
    return;
  }
  for (const key of Object.keys(cache)) {
    if (!["type", "ttl_s", "msg_offset"].includes(key)) {
      errors.push(`unexpected cache_control key: ${JSON.stringify(key)}`);
    }
  }
  if (cache.type !== "ephemeral") {
    errors.push("cache_control.type must be 'ephemeral'");
  }
  if (!Number.isInteger(cache.ttl_s) || cache.ttl_s < 60 || cache.ttl_s > 3600) {
    errors.push("cache_control.ttl_s must be an integer in [60, 3600]");
  }
  if (!Number.isInteger(cache.msg_offset) || cache.msg_offset < 1) {
    errors.push("cache_control.msg_offset must be an integer >= 1");
  }
}
