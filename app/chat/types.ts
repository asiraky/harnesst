/**
 * Display transcript entry for harnesst's conversational surfaces (assistant + playground). These
 * surfaces rebuild their transcript from Eve's durable event stream (`playgroundSessions` holds
 * only the cursor), so this shape is a projection, not a stored record — keep it
 * JSON-serializable and additive. Client+server safe.
 */

import type { ReasoningEffort } from "~/models/reasoning";

export interface ChatStep {
  type: string;
  name?: string | null;
  durationMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  isError?: boolean;
  code?: string | null;
  message?: string | null;
  details?: string | null;
  /** Primary tool of the step's actions (e.g. "bash", "load_skill"). Additive. */
  toolName?: string | null;
  /** Compacted summary of the primary action — command, skill, or file path. Additive. */
  summary?: string | null;
}

/**
 * A pending human-in-the-loop request from the agent (eve `input.requested`): a question
 * (`display: "text"`/`"select"`), or a tool-approval (`"confirmation"`). Options, when
 * present, are rendered as buttons — answering with an option's id/label resolves it.
 */
export interface ChatInputRequest {
  requestId: string;
  prompt: string;
  display?: "confirmation" | "select" | "text" | null;
  allowFreeform?: boolean | null;
  options?: ChatInputOption[];
}

export interface ChatInputOption {
  id: string;
  label: string;
  description?: string | null;
  style?: "danger" | "default" | "primary" | null;
}

/**
 * A request-correlated HITL answer — eve's `InputResponse` wire shape. Carried alongside the
 * continuation send so eve resolves exactly the clicked request, never the whole pending
 * batch (a plain text message would otherwise be matched against EVERY pending request's
 * options — approving one tool card must not approve the rest, issue #221 finding 2).
 */
export interface ChatInputAnswer {
  requestId: string;
  optionId?: string;
  text?: string;
}

export interface ChatEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Playground: reply is structured JSON (render as code). */
  structured?: boolean;
  /** Playground: version + model that produced the reply, and the agent's steps. */
  version?: string;
  modelId?: string | null;
  /** Explicit reasoning effort that served this turn, when selected. */
  effort?: ReasoningEffort | null;
  steps?: ChatStep[];
  /** Playground: pending input requests — questions or tool approvals — for this turn. */
  inputRequests?: ChatInputRequest[];
  /** Assistant: files staged, secrets to set, check outcome for this turn. */
  files?: string[];
  secrets?: string[];
  checks?: { ran: boolean; ok: boolean };
  error?: string | null;
  /** Raw error text for operators (rendered behind a details toggle). Additive. */
  errorDetail?: string | null;
  /** The error is a transient provider hiccup — offer a retry affordance. Additive. */
  errorRetryable?: boolean;
}
