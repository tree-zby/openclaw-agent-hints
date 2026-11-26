/**
 * Manage requests (protocol sections 9.2 and 9.3).
 *
 * A manage request is a *separate* HTTP call with a placeholder body. This
 * module only materialises the request; the caller's HTTP client sends it.
 */

import { encode } from "./encoder.js";
import { HEADER_NAME, validate } from "./protocol.js";
import { HintError, HintSession } from "./state.js";

/**
 * @typedef {object} ManageRequest
 * @property {"POST"} method
 * @property {string} url
 * @property {Array<[string, string]>} headers
 * @property {string} body
 */

export class ManageClient {
  /**
   * @param {{ baseUrl: string, model: string, apiKey?: string | null, path?: string }} options
   */
  constructor({ baseUrl, model, apiKey = null, path = "/v1/messages" }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.apiKey = apiKey;
    this.path = path.startsWith("/") ? path : `/${path}`;
  }

  /** @returns {string} */
  get endpoint() {
    return `${this.baseUrl}${this.path}`;
  }

  /**
   * @param {Record<string, unknown>} hint
   * @returns {ManageRequest}
   */
  build(hint) {
    const errors = validate(hint);
    if (errors.length > 0) {
      throw new HintError(errors.join("; "));
    }
    /** @type {Array<[string, string]>} */
    const headers = [
      ["content-type", "application/json"],
      [HEADER_NAME, encode(hint)],
    ];
    if (this.apiKey) headers.push(["x-api-key", this.apiKey]);

    // The body is a fixed placeholder: a manage request carries no prompt.
    const body = JSON.stringify({ model: this.model, messages: [], stream: false });
    return { method: "POST", url: this.endpoint, headers, body };
  }

  /**
   * Build the `compact` manage request and advance the local epoch.
   *
   * The hint carries the *superseded* epoch: the next ordinary request must
   * advertise `epoch + 1` and must not carry `cache_control` yet.
   *
   * @param {HintSession} session
   * @returns {ManageRequest}
   */
  compact(session) {
    const request = this.build(session.buildManage("compact"));
    session.noteRewrite();
    return request;
  }

  /**
   * Build a lifecycle manage request without mutating sender state.
   *
   * @param {HintSession} session
   * @param {"pause" | "resume" | "stop" | "compact"} state
   * @returns {ManageRequest}
   */
  lifecycle(session, state) {
    return this.build(session.buildManage(state));
  }
}
