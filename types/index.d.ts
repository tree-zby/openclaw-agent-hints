/**
 * Type declarations for `openclaw-agent-hints`.
 *
 * The implementation is plain ESM JavaScript with JSDoc; these declarations are
 * hand-maintained and kept in sync with `src/`.
 */

export type State = "start" | "append" | "pause" | "resume" | "stop" | "compact";
export type OrdinaryState = "start" | "append";
export type ManageState = "pause" | "resume" | "stop" | "compact";
export type RequestKind = "turn" | "compaction" | "side_question";

export const HEADER_NAME: "X-Agent-Hint";
export const MAX_HEADER_BYTES: 4096;
export const ORDINARY_STATES: readonly OrdinaryState[];
export const STATES: readonly State[];
export const REQUEST_KINDS: readonly RequestKind[];
export const PLUGIN_ID: "agent-hints";
export const VERSION: string;

export interface Priority {
  level: 1 | 3;
  reason: "user_waiting" | "critical_path";
}

export interface MessageView {
  role: string;
  text: string;
  hasToolResult?: boolean;
  hasToolCall?: boolean;
}

export interface HintConfig {
  enabled?: boolean;
  priority?: "dynamic" | "omit";
  cache?: "dynamic" | "omit";
  priorityLevel?: number | null;
  priorityReason?: string | null;
  cacheMinPrefixTokens?: number;
  defaultTtlS?: number;
  ttlMinS?: number;
  ttlMaxS?: number;
  parentSessionId?: string | null;
  hasHistory?: boolean;
  assumeExistingSession?: boolean;
}

export const DEFAULT_CONFIG: Readonly<Required<HintConfig>>;

export interface RequestView {
  messages: MessageView[];
  model: string;
  tools: string[];
  auxiliary?: boolean;
  turnOpening?: boolean | null;
  fingerprint?: string | null;
  systemText?: string | null;
  now?: number | null;
}

export interface SessionSnapshot {
  sessionId: string;
  callIndex: number;
  epoch: number;
  firstAccepted: boolean;
  started: boolean;
  isolated: boolean;
  lastSignature: string[] | null;
  lastResponseEnd: number | null;
}

export interface Hint {
  session: {
    session_id: string;
    call_index: number;
    epoch: number;
    state: State;
    parent_session_id?: string;
  };
  priority_control?: { priority: Priority };
  cache_control?: { type: "ephemeral"; ttl_s: number; msg_offset: number };
  context_management?: {
    manage_request: true;
    edits: Array<{ type: "offload" | "prefetch" | "evict"; target: "session" }>;
  };
}

export class HintError extends Error {}

export class SessionIsolatedError extends HintError {
  readonly sessionId: string;
  constructor(sessionId: string);
}

export class HintSession {
  constructor(options?: { sessionId?: string | null; config?: HintConfig });
  readonly sessionId: string;
  readonly config: Required<HintConfig>;
  callIndex: number;
  epoch: number;
  snapshot(): SessionSnapshot;
  restore(snapshot: SessionSnapshot): void;
  noteAccepted(): void;
  noteResponseEnd(now?: number | null): void;
  noteRewrite(): number;
  isolate(): void;
  clearIsolation(): void;
  build(request: RequestView): Hint | null;
  buildManage(state: ManageState, options?: { callIndex?: number; epoch?: number }): Hint;
}

export interface ManageRequest {
  method: "POST";
  url: string;
  headers: Array<[string, string]>;
  body: string;
}

export class ManageClient {
  constructor(options: { baseUrl: string; model: string; apiKey?: string | null; path?: string });
  readonly endpoint: string;
  build(hint: Hint): ManageRequest;
  compact(session: HintSession): ManageRequest;
  lifecycle(session: HintSession, state: ManageState): ManageRequest;
}

export interface RequestFacts {
  provider: string;
  model: string;
  messages: MessageView[];
  tools: string[];
  kind: RequestKind | null;
  systemText: string | null;
  now: number | null;
}

export class HintAdapter {
  constructor(options?: { sessionId?: string | null; config?: HintConfig; session?: HintSession });
  readonly session: HintSession;
  readonly sessionId: string;
  static factsFromBody(input: {
    provider: string;
    model: string;
    body: unknown;
    requestKind?: string | null;
    now?: number | null;
  }): RequestFacts;
  snapshot(): SessionSnapshot;
  tryHeaderValue(facts: RequestFacts): string | null;
  headerValue(facts: RequestFacts): string | null;
  headers(facts: RequestFacts): Record<string, string>;
  noteAccepted(): void;
  noteResponseEnd(now?: number | null): void;
  noteRewrite(): number;
  isolate(): void;
  clearIsolation(): void;
  lifecycleRequest(client: ManageClient, state: ManageState): ManageRequest;
  compactRequest(client: ManageClient): ManageRequest;
}

export interface AgentHintsPlugin {
  id: "agent-hints";
  name: string;
  description: string;
  adapter: HintAdapter;
  hooks: {
    before_model_request(event: {
      runtime?: "embedded" | "cli";
      requestKind?: string;
      payload?: unknown;
      provider?: string;
      model?: string;
    }): Promise<{ payload: unknown; headers: Record<string, string> } | undefined>;
    model_call_ended(event: { outcome?: "completed" | "error" }): Promise<void>;
  };
}

export function createAgentHintsPlugin(options?: {
  sessionId?: string | null;
  config?: HintConfig;
  adapter?: HintAdapter;
}): AgentHintsPlugin;
export default createAgentHintsPlugin;

export function validate(hint: unknown): string[];
export function isManageHint(hint: unknown): boolean;
export function isOrdinaryState(state: string): boolean;
export function editForState(state: string): string | null;
export function foldPriority(level: number): Priority | null;
export function isPriorityPairValid(priority: { level: number; reason: string }): boolean;
export function isAuxiliaryKind(kind: string | null | undefined): boolean;
export function encode(hint: unknown): string;
export function decode(value: string): Record<string, unknown>;
export function newSessionId(prefix?: string): string;
export function requestFingerprint(request: RequestView): string;
export function estimatePrefixTokens(messages: MessageView[]): number | null;
export function estimateTextTokens(text: string): number;
export function deriveTurnOpening(messages: MessageView[]): boolean;
export function messageViews(messages: unknown): MessageView[];
export function toolNames(tools: unknown): string[];
export function systemText(value: unknown): string | null;
export function normalizeConfig(overrides?: HintConfig): Required<HintConfig>;
