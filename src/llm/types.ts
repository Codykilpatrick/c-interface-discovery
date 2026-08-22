/** OpenAI-compatible wire types, as vLLM serves them. */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  /** Gemma 4 thinking, split out by vLLM's `--reasoning-parser gemma4`. */
  reasoning_content?: string | null;
  tool_calls?: ToolCall[];
  /** Required on `role: 'tool'` messages. */
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface JsonSchemaFormat {
  type: 'json_schema';
  json_schema: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'none' | 'required';
  response_format?: JsonSchemaFormat;
  /** vLLM passes unknown fields through to the chat template. */
  chat_template_kwargs?: Record<string, unknown>;
}

export interface ChatResult {
  content: string;
  reasoningContent: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface ModelInfo {
  id: string;
  /** vLLM reports the served context length here. Absent on some builds. */
  maxModelLen?: number;
}

/** Incremental events from a streaming completion. */
export type StreamEvent =
  | { type: 'content'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool-call-delta'; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: 'done'; finishReason: string | null };

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'http' | 'protocol' | 'aborted' | 'timeout' | 'config',
    readonly status?: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
