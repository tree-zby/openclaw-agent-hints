export {
  HEADER_NAME,
  MAX_HEADER_BYTES,
  ORDINARY_STATES,
  STATES,
  editForState,
  foldPriority,
  isManageHint,
  isOrdinaryState,
  isPriorityPairValid,
  validate,
} from "./protocol.js";

export { decode, encode } from "./encoder.js";

export {
  DEFAULT_CONFIG,
  HintError,
  HintSession,
  SessionIsolatedError,
  deriveTurnOpening,
  estimatePrefixTokens,
  estimateTextTokens,
  messageViews,
  newSessionId,
  normalizeConfig,
  requestFingerprint,
  systemText,
  toolNames,
} from "./state.js";

export { ManageClient } from "./manage.js";

export { HintAdapter, REQUEST_KINDS, isAuxiliaryKind } from "./adapter.js";

export { PLUGIN_ID, createAgentHintsPlugin } from "./plugin.js";
export { createAgentHintsPlugin as default } from "./plugin.js";

export const VERSION = "0.1.0";
