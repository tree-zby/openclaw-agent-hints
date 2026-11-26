/**
 * Deterministic hint derivation (protocol sections 5-6).
 *
 * The state machine is the sender side of the contract: one request in, one
 * hint out, with every mutable fact held on a {@link HintSession}.
 */

import { createHash, randomBytes } from "node:crypto";

import { foldPriority, isOrdinaryState } from "./protocol.js";

/** Raised when a session has an unresolved manage mutation (section 8.4). */
export class SessionIsolatedError extends Error {
  /**
   * @param {string} sessionId
   */
  constructor(sessionId) {
    super(
      `session ${JSON.stringify(sessionId)} is isolated after an unresolved manage request; ` +
        "clear it once the backend state is confirmed, or start a new session",
    );
    this.name = "SessionIsolatedError";
    this.sessionId = sessionId;
  }
}

export class HintError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "HintError";
  }
}

/** @typedef {import("./protocol.js").STATE} STATE */

/**
 * @typedef {object} HintConfig
 * @property {boolean} [enabled]
 * @property {"dynamic" | "omit"} [priority]
 * @property {"dynamic" | "omit"} [cache]
 * @property {number | null} [priorityLevel]
 * @property {string | null} [priorityReason]
 * @property {number} [cacheMinPrefixTokens]
 * @property {number} [defaultTtlS]
 * @property {number} [ttlMinS]
 * @property {number} [ttlMaxS]
 * @property {string | null} [parentSessionId]
 * @property {boolean} [hasHistory]
 * @property {boolean} [assumeExistingSession]
 */

/** @type {Required<HintConfig>} */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  priority: "dynamic",
  cache: "dynamic",
  priorityLevel: null,
  priorityReason: null,
  cacheMinPrefixTokens: 128,
  defaultTtlS: 600,
  ttlMinS: 60,
  ttlMaxS: 3600,
  parentSessionId: null,
  hasHistory: false,
  assumeExistingSession: false,
});

/**
 * @param {HintConfig} [overrides]
 * @returns {Required<HintConfig>}
 */
export function normalizeConfig(overrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  if (
    !Number.isInteger(config.ttlMinS) ||
    !Number.isInteger(config.ttlMaxS) ||
    config.ttlMinS < 60 ||
    config.ttlMaxS > 3600 ||
    config.ttlMinS > config.ttlMaxS
  ) {
    throw new HintError("TTL bounds must satisfy 60 <= min <= max <= 3600");
  }
  if (
    !Number.isInteger(config.defaultTtlS) ||
    config.defaultTtlS < config.ttlMinS ||
    config.defaultTtlS > config.ttlMaxS
  ) {
    throw new HintError("defaultTtlS must be inside the TTL bounds");
  }
  if (config.priorityLevel !== null) {
    const folded = foldPriority(config.priorityLevel);
    if (!folded) {
      throw new HintError("priorityLevel must be >= 1");
    }
    if (config.priorityReason !== null && config.priorityReason !== folded.reason) {
      throw new HintError(
        `priorityLevel ${folded.level} must pair with reason ${JSON.stringify(folded.reason)}`,
      );
    }
  }
  return config;
}

/**
 * @typedef {object} MessageView
 * @property {string} role
 * @property {string} text
 * @property {boolean} [hasToolResult]
 * @property {boolean} [hasToolCall]
 */

/**
 * @typedef {object} RequestView
 * @property {MessageView[]} messages
 * @property {string} model
 * @property {string[]} tools
 * @property {boolean} [auxiliary]
 * @property {boolean | null} [turnOpening]
 * @property {string | null} [fingerprint]
 * @property {string | null} [systemText]
 * @property {number | null} [now]
 */

/** Opaque, non-identifying session id (max 256 chars). */
export function newSessionId(prefix = "ah") {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}

/**
 * Stable identity of a logical request, used to reuse a hint on retry.
 *
 * @param {RequestView} request
 * @returns {string}
 */
export function requestFingerprint(request) {
  const payload = {
    model: request.model,
    tools: [...request.tools].sort(),
    messages: request.messages.map((message) => [
      message.role,
      message.text,
      Boolean(message.hasToolResult),
      Boolean(message.hasToolCall),
    ]),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Approximate token count for one piece of text.
 *
 * CJK characters count as one token each, other text as four characters per
 * token (protocol section 6.8).
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTextTokens(text) {
  let cjk = 0;
  let chars = 0;
  for (const character of text) {
    chars += 1;
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x3400 && code <= 0x9fff) cjk += 1;
  }
  return cjk + (chars - cjk) / 4;
}

/**
 * `null` when there is no text to measure.
 *
 * @param {MessageView[]} messages
 * @returns {number | null}
 */
export function estimatePrefixTokens(messages) {
  let sawText = false;
  let total = 0;
  for (const message of messages) {
    if (message.text.length > 0) sawText = true;
    total += estimateTextTokens(message.text);
  }
  return sawText ? Math.trunc(total) : null;
}

/**
 * A turn opens when the latest user input has no reply after it.
 *
 * Walks backwards: empty assistant placeholders are skipped, the first real
 * assistant message or tool call means the turn is already in progress, and a
 * plain user message means this is the first main-line call of the turn.
 *
 * @param {MessageView[]} messages
 * @returns {boolean}
 */
export function deriveTurnOpening(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") {
      if (message.text.length === 0 && !message.hasToolCall) continue;
      return false;
    }
    if (message.hasToolCall || message.hasToolResult) return false;
    if (message.role === "user") return true;
  }
  return false;
}

/**
 * @typedef {object} SessionSnapshot
 * @property {string} sessionId
 * @property {number} callIndex
 * @property {number} epoch
 * @property {boolean} firstAccepted
 * @property {boolean} started
 * @property {boolean} isolated
 * @property {string[] | null} lastSignature
 * @property {number | null} lastResponseEnd
 */

export class HintSession {
  /**
   * @param {{ sessionId?: string | null, config?: HintConfig }} [options]
   */
  constructor({ sessionId = null, config = {} } = {}) {
    this.config = normalizeConfig(config);
    const id = sessionId ?? newSessionId();
    if (typeof id !== "string" || [...id].length < 1 || [...id].length > 256) {
      throw new HintError("sessionId must be a non-empty string <= 256 chars");
    }
    /** @type {string} */
    this.sessionId = id;
    this.callIndex = 0;
    this.epoch = 0;
    this.firstAccepted = false;
    this.started = false;
    this.isolated = false;
    this.afterRewrite = false;
    /** @type {string[] | null} */
    this.lastSignature = null;
    /** @type {number | null} */
    this.lastResponseEnd = null;
    /** @type {string | null} */
    this.lastFingerprint = null;
    /** @type {Record<string, unknown> | null} */
    this.lastHint = null;
    /** @type {"pending" | "accepted"} */
    this.lastOutcome = "pending";
  }

  /** @returns {SessionSnapshot} */
  snapshot() {
    return {
      sessionId: this.sessionId,
      callIndex: this.callIndex,
      epoch: this.epoch,
      firstAccepted: this.firstAccepted,
      started: this.started,
      isolated: this.isolated,
      lastSignature: this.lastSignature ? [...this.lastSignature] : null,
      lastResponseEnd: this.lastResponseEnd,
    };
  }

  /** @param {SessionSnapshot} snapshot */
  restore(snapshot) {
    if (snapshot.sessionId !== this.sessionId) {
      throw new HintError("snapshot belongs to a different session");
    }
    this.callIndex = snapshot.callIndex;
    this.epoch = snapshot.epoch;
    this.firstAccepted = snapshot.firstAccepted;
    this.started = snapshot.started;
    this.isolated = snapshot.isolated;
    this.lastSignature = snapshot.lastSignature ? [...snapshot.lastSignature] : null;
    this.lastResponseEnd = snapshot.lastResponseEnd;
  }

  /** The endpoint accepted the in-flight ordinary request. */
  noteAccepted() {
    this.firstAccepted = true;
    this.lastOutcome = "accepted";
  }

  /** @param {number | null} [now] */
  noteResponseEnd(now = null) {
    if (typeof now === "number" && Number.isFinite(now)) {
      this.lastResponseEnd = now;
    }
  }

  /** Record a committed history rewrite; returns the superseded epoch. */
  noteRewrite() {
    const superseded = this.epoch;
    this.epoch += 1;
    this.afterRewrite = true;
    return superseded;
  }

  isolate() {
    this.isolated = true;
  }

  clearIsolation() {
    this.isolated = false;
    this.lastOutcome = "pending";
  }

  assertReady() {
    if (this.isolated) throw new SessionIsolatedError(this.sessionId);
  }

  /**
   * Return the hint for an ordinary request, or `null` to send none.
   *
   * @param {RequestView} request
   * @returns {Record<string, unknown> | null}
   */
  build(request) {
    if (!this.config.enabled || request.auxiliary === true) return null;
    this.assertReady();

    const fingerprint = request.fingerprint ?? requestFingerprint(request);
    if (this.lastFingerprint === fingerprint && this.lastOutcome !== "accepted") {
      // Same logical request again: a retry reuses the exact hint.
      return this.lastHint;
    }

    this.callIndex += 1;
    const opening = request.turnOpening ?? deriveTurnOpening(request.messages);
    const state = this.ordinaryState();

    /** @type {Record<string, unknown>} */
    const session = {
      session_id: this.sessionId,
      call_index: this.callIndex,
      epoch: this.epoch,
      state,
    };
    if (this.config.parentSessionId) {
      session.parent_session_id = this.config.parentSessionId;
    }

    /** @type {Record<string, unknown>} */
    const hint = { session };

    if (this.config.priority === "dynamic") {
      const priority = this.priority(opening);
      hint.priority_control = { priority };
    }
    const cache = this.cache(request);
    if (cache) hint.cache_control = cache;

    this.lastFingerprint = fingerprint;
    this.lastHint = hint;
    this.lastOutcome = "pending";
    this.afterRewrite = false;
    return hint;
  }

  /**
   * Build a manage hint (protocol sections 5.3 and 8.2).
   *
   * @param {"pause" | "resume" | "stop" | "compact"} state
   * @param {{ callIndex?: number, epoch?: number }} [options]
   * @returns {Record<string, unknown>}
   */
  buildManage(state, { callIndex, epoch } = {}) {
    if (isOrdinaryState(state)) {
      throw new HintError(
        `manage verb must be one of pause/resume/stop/compact, got ${JSON.stringify(state)}`,
      );
    }
    const edit = { pause: "offload", resume: "prefetch", stop: "evict", compact: "evict" }[state];
    const index = callIndex ?? this.manageCallIndex(state);
    const epochValue = epoch ?? this.epoch;

    /** @type {Record<string, unknown>} */
    const session = {
      session_id: this.sessionId,
      call_index: Math.max(1, index),
      epoch: epochValue,
      state,
    };
    if (this.config.parentSessionId) {
      session.parent_session_id = this.config.parentSessionId;
    }

    return {
      session,
      context_management: {
        manage_request: true,
        edits: [{ type: edit, target: "session" }],
      },
    };
  }

  ordinaryState() {
    const fresh =
      this.callIndex === 1 &&
      !this.config.hasHistory &&
      !this.config.assumeExistingSession &&
      !this.firstAccepted &&
      !this.started;
    if (fresh) {
      this.started = true;
      return "start";
    }
    return "append";
  }

  /** @param {boolean} opening */
  priority(opening) {
    if (this.config.priorityLevel !== null) {
      const folded = foldPriority(this.config.priorityLevel);
      if (folded) return folded;
    }
    return opening
      ? { level: 3, reason: "user_waiting" }
      : { level: 1, reason: "critical_path" };
  }

  /**
   * @param {RequestView} request
   * @returns {Record<string, unknown> | null}
   */
  cache(request) {
    if (this.config.cache === "omit" || this.afterRewrite) return null;

    const signature = [request.model, ...[...request.tools].sort()];
    const stable =
      this.lastSignature === null
        ? this.callIndex <= 1
        : this.lastSignature.length === signature.length &&
          this.lastSignature.every((value, index) => value === signature[index]);
    this.lastSignature = signature;
    if (!stable) return null;

    const tokens = this.prefixTokens(request);
    if (tokens !== null && tokens < this.config.cacheMinPrefixTokens) return null;

    const msgOffset = request.messages.length;
    if (msgOffset < 1) return null;

    return { type: "ephemeral", ttl_s: this.ttl(request.now ?? null), msg_offset: msgOffset };
  }

  /** @param {RequestView} request */
  prefixTokens(request) {
    const bodyTokens = estimatePrefixTokens(request.messages);
    const systemTokens = request.systemText ? estimateTextTokens(request.systemText) : 0;
    if (bodyTokens === null && systemTokens === 0) return null;
    return Math.trunc((bodyTokens ?? 0) + systemTokens);
  }

  /** @param {number | null} now */
  ttl(now) {
    if (now === null || this.lastResponseEnd === null) return this.config.defaultTtlS;
    const gap = Math.max(0, now - this.lastResponseEnd);
    const ttl = Math.round(gap * 2);
    return Math.min(this.config.ttlMaxS, Math.max(this.config.ttlMinS, ttl));
  }

  /** @param {"pause" | "resume" | "stop" | "compact"} state */
  manageCallIndex(state) {
    return state === "resume" ? this.callIndex + 1 : Math.max(1, this.callIndex);
  }
}

/**
 * Convert chat messages (already parsed JSON) into views.
 *
 * Handles both OpenAI `role`/`content` messages and Anthropic content blocks
 * (`tool_use`, `tool_result`).
 *
 * @param {unknown} messages
 * @returns {MessageView[]}
 */
export function messageViews(messages) {
  const list = Array.isArray(messages) ? messages : messages == null ? [] : [messages];
  return list.map((message) => {
    if (message === null || typeof message !== "object") {
      return { role: "user", text: String(message ?? "") };
    }
    const role = typeof message.role === "string" ? message.role : "user";
    const content = message.content;
    return {
      role,
      text: contentText(content),
      hasToolResult: role === "tool" || message.tool_call_id != null || hasBlockType(content, "tool_result"),
      hasToolCall:
        (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ||
        hasBlockType(content, "tool_use"),
    };
  });
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function contentText(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") return part.text;
        return "";
      })
      .filter((part) => part.length > 0)
      .join("\n");
  }
  return JSON.stringify(content);
}

/**
 * @param {unknown} content
 * @param {string} wanted
 * @returns {boolean}
 */
function hasBlockType(content, wanted) {
  return Array.isArray(content) && content.some((part) => part && part.type === wanted);
}

/**
 * Extract tool names from OpenAI or Anthropic tool schemas, sorted.
 *
 * @param {unknown} tools
 * @returns {string[]}
 */
export function toolNames(tools) {
  const names = new Set();
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (typeof tool === "string") {
        names.add(tool);
      } else if (tool && typeof tool === "object") {
        const name = tool.function?.name ?? tool.name;
        if (typeof name === "string") names.add(name);
      }
    }
  } else if (tools && typeof tools === "object") {
    for (const key of Object.keys(tools)) names.add(key);
  }
  return [...names].sort();
}

/**
 * Accepts both Anthropic `system` shapes: a plain string and a text-block
 * array.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function systemText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (Array.isArray(value)) {
    const joined = value
      .map((block) => (block && typeof block.text === "string" ? block.text : ""))
      .filter((text) => text.length > 0)
      .join("\n");
    return joined.length > 0 ? joined : null;
  }
  return String(value);
}
