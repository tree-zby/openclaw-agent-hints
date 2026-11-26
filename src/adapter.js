/**
 * OpenClaw adapter: request facts in, `X-Agent-Hint` out.
 *
 * OpenClaw has no outbound-header hook, so this repository ships one small
 * patch (`patches/0001-before-model-headers.patch`) that widens
 * `before_model_request` into a header channel. The adapter itself has no
 * dependency on OpenClaw and can be driven from any host.
 */

import { encode } from "./encoder.js";
import { HEADER_NAME } from "./protocol.js";
import { ManageClient } from "./manage.js";
import {
  HintError,
  HintSession,
  messageViews,
  systemText,
  toolNames,
} from "./state.js";

/**
 * Where a model call sits in the harness.
 *
 * OpenClaw reports `requestKind` for every model call; anything that is not
 * `turn` is auxiliary and never carries a hint (protocol section 7.2).
 *
 * @typedef {"turn" | "compaction" | "side_question"} RequestKind
 */

export const REQUEST_KINDS = Object.freeze(["turn", "compaction", "side_question"]);

/**
 * Auxiliary calls never carry a hint (protocol section 7.2).
 *
 * OpenClaw says new kinds may appear and should be treated like `turn`, so only
 * the two known auxiliary kinds are excluded.
 *
 * @param {string | null | undefined} kind
 * @returns {boolean}
 */
export function isAuxiliaryKind(kind) {
  return kind === "compaction" || kind === "side_question";
}

/**
 * @typedef {object} RequestFacts
 * @property {string} provider
 * @property {string} model
 * @property {import("./state.js").MessageView[]} messages
 * @property {string[]} tools
 * @property {RequestKind | null} kind
 * @property {string | null} systemText
 * @property {number | null} now
 */

export class HintAdapter {
  /**
   * @param {{ sessionId?: string | null, config?: import("./state.js").HintConfig, session?: HintSession }} [options]
   */
  constructor({ sessionId = null, config = {}, session } = {}) {
    /** @type {HintSession} */
    this.session = session ?? new HintSession({ sessionId, config });
  }

  get sessionId() {
    return this.session.sessionId;
  }

  snapshot() {
    return this.session.snapshot();
  }

  /**
   * Build facts from the exact JSON body that is about to be sent.
   *
   * @param {{ provider: string, model: string, body: unknown, requestKind?: string | null, now?: number | null }} input
   * @returns {RequestFacts}
   */
  static factsFromBody({ provider, model, body, requestKind = "turn", now = null }) {
    const payload = body !== null && typeof body === "object" ? body : {};
    return {
      provider,
      model,
      messages: messageViews(payload.messages),
      tools: toolNames(payload.tools),
      kind: REQUEST_KINDS.includes(requestKind) ? requestKind : null,
      systemText: systemText(payload.system),
      now,
    };
  }

  /**
   * Build and encode the hint for one ordinary request.
   *
   * @param {RequestFacts} facts
   * @returns {string | null} header value, or `null` when no hint applies
   */
  tryHeaderValue(facts) {
    const hint = this.session.build({
      messages: facts.messages,
      model: facts.model,
      tools: facts.tools,
      auxiliary: isAuxiliaryKind(facts.kind),
      systemText: facts.systemText,
      now: facts.now,
    });
    if (hint === null) return null;
    return encode(hint);
  }

  /**
   * Fail-open variant: a hint problem must never break the model call.
   *
   * @param {RequestFacts} facts
   * @returns {string | null}
   */
  headerValue(facts) {
    try {
      return this.tryHeaderValue(facts);
    } catch {
      return null;
    }
  }

  /**
   * Header object shaped for `StreamOptions.headers`.
   *
   * @param {RequestFacts} facts
   * @returns {Record<string, string>}
   */
  headers(facts) {
    const value = this.headerValue(facts);
    return value === null ? {} : { [HEADER_NAME]: value };
  }

  noteAccepted() {
    this.session.noteAccepted();
  }

  /** @param {number | null} [now] */
  noteResponseEnd(now = null) {
    this.session.noteResponseEnd(now);
  }

  noteRewrite() {
    return this.session.noteRewrite();
  }

  isolate() {
    this.session.isolate();
  }

  clearIsolation() {
    this.session.clearIsolation();
  }

  /**
   * @param {ManageClient} client
   * @param {"pause" | "resume" | "stop" | "compact"} state
   */
  lifecycleRequest(client, state) {
    return client.lifecycle(this.session, state);
  }

  /** @param {ManageClient} client */
  compactRequest(client) {
    return client.compact(this.session);
  }
}

export { HintError, HintSession, ManageClient };
