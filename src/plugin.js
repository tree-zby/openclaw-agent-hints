/**
 * OpenClaw plugin definition for `openclaw-agent-hints`.
 *
 * The plugin is a plain object, not a `definePluginEntry(...)` call, so this
 * package has no dependency on OpenClaw and can be unit-tested without the
 * host. Wrap it if your OpenClaw version wants the helper:
 *
 * ```ts
 * import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
 * import { createAgentHintsPlugin } from "openclaw-agent-hints";
 * export default definePluginEntry(createAgentHintsPlugin());
 * ```
 *
 * The header channel itself comes from `patches/0001-model-request-headers.patch`:
 * `before_model_request` may now return `{ payload, headers }` and the runner
 * merges `headers` into the stream options. Without the patch the module still
 * works, but the returned `headers` are ignored by the host.
 */

import { HintAdapter, isAuxiliaryKind } from "./adapter.js";

export const PLUGIN_ID = "agent-hints";

/**
 * @typedef {object} AgentHintsPluginOptions
 * @property {string | null} [sessionId]
 * @property {import("./state.js").HintConfig} [config]
 * @property {HintAdapter} [adapter]
 */

/**
 * @param {AgentHintsPluginOptions} [options]
 */
export function createAgentHintsPlugin({ sessionId = null, config = {}, adapter } = {}) {
  const hints = adapter ?? new HintAdapter({ sessionId, config });

  return {
    id: PLUGIN_ID,
    name: "Agent Hints",
    description:
      "Adds X-Agent-Hint (agent-hint-protocol v1.0) to outbound model requests for hint-aware inference gateways.",
    /** Escape hatch for hosts that want to drive lifecycle verbs themselves. */
    adapter: hints,

    hooks: {
      /**
       * Called by OpenClaw for every embedded model call, after the body is
       * final. Returns the payload untouched plus the hint header.
       *
       * @param {{
       *   runtime?: "embedded" | "cli",
       *   requestKind?: string,
       *   payload?: unknown,
       *   provider?: string,
       *   model?: string,
       * }} event
       * @returns {Promise<{ payload: unknown, headers: Record<string, string> } | undefined>}
       */
      before_model_request: async (event) => {
        // CLI runtimes own their own wire request and ignore `headers`; a hint
        // emitted there would still advance the counters, so skip them.
        if (event?.runtime !== "embedded") return undefined;
        if (isAuxiliaryKind(event.requestKind)) return undefined;

        const facts = HintAdapter.factsFromBody({
          provider: String(event.provider ?? ""),
          model: String(event.model ?? ""),
          body: event.payload,
          requestKind: event.requestKind ?? "turn",
          now: Date.now() / 1000,
        });
        const headers = hints.headers(facts);
        if (Object.keys(headers).length === 0) return undefined;
        return { payload: event.payload, headers };
      },

      /**
       * A completed call is evidence the endpoint accepted the hint.
       *
       * OpenClaw does not correlate this event with the request that produced
       * it, so a completed auxiliary call also counts. The only effect is that
       * the next byte-identical main-line request gets a fresh `call_index`
       * instead of reusing the previous hint.
       *
       * @param {{ outcome?: string }} event
       */
      model_call_ended: async (event) => {
        if (event?.outcome !== "completed") return;
        hints.noteAccepted();
        hints.noteResponseEnd(Date.now() / 1000);
      },
    },
  };
}

export default createAgentHintsPlugin;
