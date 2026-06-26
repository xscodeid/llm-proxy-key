export type APIFormat = "anthropic" | "openai";

export interface APIFormatContext {
  clientFormat: APIFormat;
  targetFormat: APIFormat;
  needsMapping: boolean;
}

/**
 * A loosely-typed JSON value used for tool inputs that have not been
 * validated against a schema. Replaces bare `any` while still accepting
 * arbitrary JSON structures.
 */
export interface JsonValue {
  [key: string]: string | number | boolean | null | JsonValue | JsonValue[];
}

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: JsonValue;
}

export interface AnthropicToolResultTextBlock {
  type: "text";
  text: string;
}

export type AnthropicToolResultContentBlock = AnthropicToolResultTextBlock | string;

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicToolResultContentBlock[];
  name?: string;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface AnthropicToolInputSchema {
  type: "object";
  properties: Record<string, JsonValue>;
  required?: string[];
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: AnthropicToolInputSchema;
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, JsonValue>;
      required?: string[];
    };
  };
}

export interface AnthropicSystemBlock {
  type: string;
  text?: string;
  cache_control?: { type: string };
  [key: string]: string | number | boolean | null | JsonValue | undefined;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string | AnthropicSystemBlock[];
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string | string[];
  tools?: OpenAITool[];
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } };
}

export interface AnthropicResponseContentBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: JsonValue;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicResponseContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface OpenAIChoice {
  index: number;
  message: OpenAIMessage;
  finish_reason: string | null;
}

export interface OpenAIResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
