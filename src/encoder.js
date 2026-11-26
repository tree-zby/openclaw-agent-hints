/**
 * Base64url codec for the `X-Agent-Hint` header (protocol section 3.2).
 *
 * Node's `base64url` encoding is unpadded and URL-safe. Decoding tolerates
 * padding, because a receiver may re-encode before forwarding.
 */

import { MAX_HEADER_BYTES } from "./protocol.js";

/**
 * @param {unknown} hint
 * @returns {string} base64url, no padding
 * @throws {Error} when the payload is too large for the header budget
 */
export function encode(hint) {
  const json = JSON.stringify(hint);
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  if (encoded.length > MAX_HEADER_BYTES) {
    throw new Error(
      `encoded hint is ${encoded.length} bytes, above the ${MAX_HEADER_BYTES}-byte budget`,
    );
  }
  return encoded;
}

/**
 * @param {string} value
 * @returns {Record<string, unknown>}
 */
export function decode(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length === 0) {
    throw new Error("header value is empty");
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch (error) {
    throw new Error(`invalid base64url or JSON payload: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("hint payload must be a JSON object");
  }
  return parsed;
}
