import {
  AnthropicMessage,
  AnthropicRequest,
  AnthropicResponse,
  AnthropicToolResultTextBlock,
  APIFormatContext,
  OpenAIChoice,
  OpenAIMessage,
  OpenAIRequest,
  OpenAIResponse,
} from "../types/api";

// Loose types for input that hasn't been validated yet
interface LooseRequestBody {
  model?: string;
  messages?: unknown[];
  system?: string | unknown[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  stop?: string | string[];
  stop_sequences?: string[];
  tools?: unknown[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

interface NormalizedToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  name: string;
}

interface AnthropicToolUseStreamBlock {
  type: "tool_use";
  id: string;
  name: string;
}

interface RawStreamChunk {
  type?: string;
  message?: { id?: string; model?: string };
  delta?: {
    type?: string;
    text?: string;
    stop_reason?: string | null;
    input_json?: string;
    tool_use_id?: string;
    name?: string;
  };
  content_block?: AnthropicToolUseStreamBlock;
  content_block_index?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  object?: string;
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
        index?: number;
      }>;
    };
    finish_reason?: string | null;
  }>;
  [key: string]: unknown;
}

export class APIMapper {
  static mapRequest(
    body: LooseRequestBody | Record<string, unknown>,
    context: APIFormatContext
  ): unknown {
    if (!context.needsMapping) {
      return body;
    }

    if (
      context.clientFormat === "anthropic" &&
      context.targetFormat === "openai"
    ) {
      return this.anthropicToOpenAI(body as unknown as AnthropicRequest);
    }

    if (
      context.clientFormat === "openai" &&
      context.targetFormat === "anthropic"
    ) {
      return this.openAIToAnthropic(body as unknown as OpenAIRequest);
    }

    return body;
  }

  static mapResponse(
    response: unknown,
    context: APIFormatContext
  ): unknown {
    if (!context.needsMapping) return response;

    if (
      context.targetFormat === "anthropic" &&
      context.clientFormat === "openai"
    ) {
      return this.anthropicResponseToOpenAI(response as AnthropicResponse);
    }

    if (
      context.targetFormat === "openai" &&
      context.clientFormat === "anthropic"
    ) {
      return this.openAIResponseToAnthropic(response as OpenAIResponse);
    }

    return response;
  }

  static mapStreamingChunk(chunk: string, context: APIFormatContext): string {
    if (!context.needsMapping) return chunk;

    try {
      const lines = chunk.split("\n");
      const result: string[] = [];

      for (const line of lines) {
        if (!line.startsWith("data: ") || line === "data:") {
          result.push(line);
          continue;
        }

        const dataStr = line.slice(6);
        if (dataStr === "") {
          result.push(line);
          continue;
        }

        try {
          const data = JSON.parse(dataStr) as RawStreamChunk;
          let converted: unknown;

          if (
            context.targetFormat === "anthropic" &&
            context.clientFormat === "openai"
          ) {
            converted = this.convertAnthropicStreamToOpenAI(data);
          } else if (
            context.targetFormat === "openai" &&
            context.clientFormat === "anthropic"
          ) {
            converted = this.convertOpenAIStreamToAnthropic(data);
          } else {
            converted = data;
          }

          result.push(`data: ${JSON.stringify(converted)}`);
        } catch {
          result.push(line);
        }
      }

      return result.join("\n");
    } catch {
      return chunk;
    }
  }

  static getTargetEndpoint(
    originalUrl: string,
    context: APIFormatContext
  ): string {
    if (!context.needsMapping) return originalUrl;

    if (
      context.clientFormat === "anthropic" &&
      context.targetFormat === "openai"
    ) {
      return "/v1/chat/completions";
    }

    if (
      context.clientFormat === "openai" &&
      context.targetFormat === "anthropic"
    ) {
      return "/v1/messages";
    }

    return originalUrl;
  }

  // ── OpenAI message validation ────────────────────────────────────

  private static validateAndFixOpenAIMessages(
    messages: OpenAIMessage[]
  ): OpenAIMessage[] {
    const fixed: OpenAIMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === "tool" && fixed.length > 0) {
        const prev = fixed[fixed.length - 1];
        const hasCall =
          prev.role === "assistant" &&
          prev.tool_calls?.some((tc) => tc.id === msg.tool_call_id);

        if (!hasCall) {
          fixed.push({
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: msg.tool_call_id || `synthetic_${Date.now()}`,
                type: "function" as const,
                function: {
                  name: msg.name || "unknown_tool",
                  arguments: "{}",
                },
              },
            ],
          });
        }

        fixed.push(msg);
        continue;
      }

      fixed.push(msg);

      if (
        msg.role === "assistant" &&
        msg.tool_calls &&
        msg.tool_calls.length > 0
      ) {
        const expectedIds = new Set(msg.tool_calls.map((tc) => tc.id));
        const foundIds = new Set<string>();

        let j = i + 1;
        while (j < messages.length && messages[j].role === "tool") {
          const t = messages[j];
          if (t.tool_call_id && expectedIds.has(t.tool_call_id)) {
            foundIds.add(t.tool_call_id);
            fixed.push(t);
          }
          j++;
        }

        for (const call of msg.tool_calls) {
          if (!foundIds.has(call.id)) {
            fixed.push({
              role: "tool",
              content: `Tool call completed: ${call.function.name}`,
              tool_call_id: call.id,
              name: call.function.name,
            });
          }
        }

        i = j - 1;
      }
    }

    return fixed;
  }

  // ── Anthropic message validation ─────────────────────────────────

  private static validateAndFixAnthropicMessages(
    messages: AnthropicMessage[]
  ): AnthropicMessage[] {
    const fixed: AnthropicMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === "assistant") {
        const toolUses: Array<{ id: string; name: string }> = [];

        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (
              block.type === "tool_use" &&
              "id" in block &&
              "name" in block
            ) {
              toolUses.push({ id: block.id, name: block.name });
            }
          }
        }

        fixed.push(msg);

        if (toolUses.length > 0) {
          const next = i + 1 < messages.length ? messages[i + 1] : null;
          let hasResults = false;

          if (
            next &&
            next.role === "user" &&
            Array.isArray(next.content)
          ) {
            const resultIds = new Set<string>();
            for (const block of next.content) {
              if (block.type === "tool_result" && "tool_use_id" in block) {
                resultIds.add(block.tool_use_id);
                hasResults = true;
              }
            }

            const missing = toolUses.filter((tu) => !resultIds.has(tu.id));

            if (missing.length > 0) {
              const updatedContent = [...next.content];
              for (const tu of missing) {
                updatedContent.push({
                  type: "tool_result" as const,
                  tool_use_id: tu.id,
                  content: `Tool executed: ${tu.name}`,
                });
              }
              fixed.push({ ...next, content: updatedContent });
              i++;
            }
          } else if (!hasResults) {
            const results = toolUses.map((tu) => ({
              type: "tool_result" as const,
              tool_use_id: tu.id,
              content: `Tool executed: ${tu.name}`,
            }));

            fixed.push({
              role: "user",
              content: [
                { type: "text" as const, text: "Please continue." },
                ...results,
              ],
            });
          }
        }
      } else {
        fixed.push(msg);
      }
    }

    return fixed;
  }

  // ── Anthropic → OpenAI ───────────────────────────────────────────

  private static anthropicToOpenAI(req: AnthropicRequest): OpenAIRequest {
    const msgs: OpenAIMessage[] = [];

    if (req.system) {
      let sys = "";
      if (typeof req.system === "string") {
        sys = req.system;
      } else if (Array.isArray(req.system)) {
        sys = req.system
          .filter((b) => b.type === "text")
          .map((b) => ("text" in b ? (b.text ?? "") : ""))
          .join("");
      }
      msgs.push({ role: "system", content: sys });
    }

    for (const m of req.messages) {
      if (m.role === "user") {
        let text = "";
        const results: NormalizedToolResult[] = [];

        if (typeof m.content === "string") {
          text = m.content;
        } else if (Array.isArray(m.content)) {
          const textBlocks = m.content.filter((b) => b.type === "text");
          text = textBlocks
            .map((b) => ("text" in b ? (b.text ?? "") : ""))
            .join("");

          for (const b of m.content) {
            if (b.type === "tool_result") {
              let c = "";
              if (typeof b.content === "string") {
                c = b.content;
              } else if (Array.isArray(b.content)) {
                c = b.content
                  .filter(
                    (x): x is AnthropicToolResultTextBlock =>
                      typeof x === "object" && x.type === "text"
                  )
                  .map((x) => x.text ?? "")
                  .join("");
              }
              results.push({
                type: "tool_result",
                tool_use_id: b.tool_use_id || "",
                content: c,
                name: b.name || "",
              });
            }
          }
        }

        msgs.push({ role: "user", content: text });

        for (const r of results) {
          msgs.push({
            role: "tool",
            content: r.content,
            tool_call_id: r.tool_use_id,
            name: r.name,
          });
        }
      } else if (m.role === "assistant") {
        let text = "";
        const calls: OpenAIMessage["tool_calls"] = [];

        if (typeof m.content === "string") {
          text = m.content;
        } else if (Array.isArray(m.content)) {
          text = m.content
            .filter((b) => b.type === "text")
            .map((b) => ("text" in b ? (b.text ?? "") : ""))
            .join("");

          for (const b of m.content) {
            if (b.type === "tool_use") {
              calls.push({
                id: b.id || "",
                type: "function" as const,
                function: {
                  name: b.name || "",
                  arguments: b.input ? JSON.stringify(b.input) : "{}",
                },
              });
            }
          }
        }

        const assistantMsg: OpenAIMessage = {
          role: "assistant",
          content: text || null,
        };
        if (calls.length > 0) {
          assistantMsg.tool_calls = calls;
        }
        msgs.push(assistantMsg);
      }
    }

    const validated = this.validateAndFixOpenAIMessages(msgs);

    const out: OpenAIRequest = {
      model: req.model,
      messages: validated,
      max_tokens: req.max_tokens,
      stream: req.stream,
    };

    if (req.tools) {
      out.tools = req.tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));
    }

    if (req.tool_choice) {
      if (req.tool_choice.type === "auto") out.tool_choice = "auto";
      else if (req.tool_choice.type === "any") out.tool_choice = "required";
      else if (req.tool_choice.type === "tool" && req.tool_choice.name) {
        out.tool_choice = {
          type: "function",
          function: { name: req.tool_choice.name },
        };
      }
    }

    if (req.temperature !== undefined) out.temperature = req.temperature;
    if (req.top_p !== undefined) out.top_p = req.top_p;
    if (req.stop_sequences) out.stop = req.stop_sequences;

    return out;
  }

  // ── OpenAI → Anthropic ───────────────────────────────────────────

  private static openAIToAnthropic(req: OpenAIRequest): AnthropicRequest {
    const msgs: AnthropicMessage[] = [];
    let system: string | undefined;

    let i = 0;
    while (i < req.messages.length) {
      const m = req.messages[i];

      if (m.role === "system") {
        system = m.content || "";
        i++;
      } else if (m.role === "user") {
        const content: AnthropicMessage["content"] = [];

        if (m.content) {
          content.push({ type: "text", text: m.content });
        }

        let j = i + 1;
        while (j < req.messages.length && req.messages[j].role === "tool") {
          const t = req.messages[j];
          content.push({
            type: "tool_result",
            tool_use_id: t.tool_call_id || "",
            content: t.content || "",
          });
          j++;
        }

        msgs.push({
          role: "user",
          content:
            content.length === 1 && content[0].type === "text"
              ? content[0].text
              : content,
        });
        i = j;
      } else if (m.role === "assistant") {
        const content: AnthropicMessage["content"] = [];

        if (m.content) {
          content.push({ type: "text", text: m.content });
        }

        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            content.push({
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
              input: tc.function.arguments ? JSON.parse(tc.function.arguments) : {},
            });
          }
        }

        msgs.push({
          role: "assistant",
          content:
            content.length === 1 && content[0].type === "text"
              ? content[0].text
              : content,
        });
        i++;
      } else {
        i++;
      }
    }

    const validated = this.validateAndFixAnthropicMessages(msgs);

    const out: AnthropicRequest = {
      model: req.model,
      messages: validated,
      max_tokens: req.max_tokens || 1024,
      stream: req.stream,
    };

    if (req.tools) {
      out.tools = req.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    if (req.tool_choice) {
      if (req.tool_choice === "auto") out.tool_choice = { type: "auto" };
      else if (req.tool_choice === "required")
        out.tool_choice = { type: "any" };
      else if (typeof req.tool_choice === "object") {
        out.tool_choice = {
          type: "tool",
          name: req.tool_choice.function.name,
        };
      }
    }

    if (system) out.system = system;
    if (req.temperature !== undefined) out.temperature = req.temperature;
    if (req.top_p !== undefined) out.top_p = req.top_p;
    if (req.stop) {
      out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
    }

    return out;
  }

  // ── Response mapping ─────────────────────────────────────────────

  private static anthropicResponseToOpenAI(resp: AnthropicResponse): OpenAIResponse {
    let text = "";
    let toolCalls: OpenAIMessage["tool_calls"];

    for (const block of resp.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        if (!toolCalls) toolCalls = [];
        toolCalls.push({
          id: block.id || "",
          type: "function" as const,
          function: {
            name: block.name || "",
            arguments: block.input ? JSON.stringify(block.input) : "{}",
          },
        });
      }
    }

    const choice: OpenAIChoice = {
      index: 0,
      message: { role: "assistant" as const, content: text || null },
      finish_reason: resp.stop_reason,
    };

    if (toolCalls) {
      choice.message.tool_calls = toolCalls;
    }

    return {
      id: resp.id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: resp.model,
      choices: [choice],
      usage: {
        prompt_tokens: resp.usage.input_tokens,
        completion_tokens: resp.usage.output_tokens,
        total_tokens: resp.usage.input_tokens + resp.usage.output_tokens,
      },
    };
  }

  private static openAIResponseToAnthropic(resp: OpenAIResponse): AnthropicResponse {
    const choice = resp.choices[0];
    const content: AnthropicResponse["content"] = [];

    if (choice.message.content) {
      content.push({ type: "text", text: choice.message.content });
    }

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: tc.function.arguments ? JSON.parse(tc.function.arguments) : {},
        });
      }
    }

    return {
      id: resp.id,
      type: "message",
      role: "assistant",
      content,
      model: resp.model,
      stop_reason: choice.finish_reason,
      stop_sequence: null,
      usage: {
        input_tokens: resp.usage.prompt_tokens,
        output_tokens: resp.usage.completion_tokens,
      },
    };
  }

  // ── Streaming converters ─────────────────────────────────────────

  private static convertAnthropicStreamToOpenAI(
    data: RawStreamChunk
  ): unknown {
    const stableId = data.message?.id ?? `chatcmpl-${Date.now()}`;
    const model = data.message?.model ?? "unknown";

    if (data.type === "message_start") {
      return {
        id: data.message?.id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
          { index: 0, delta: { role: "assistant" }, finish_reason: null },
        ],
      };
    }

    if (data.type === "content_block_start" && data.content_block?.type === "tool_use") {
      const toolIndex = data.content_block_index ?? 0;
      return {
        id: stableId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: data.content_block.id,
                  type: "function",
                  function: {
                    name: data.content_block.name,
                    arguments: "",
                  },
                  index: toolIndex,
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
    }

    if (data.type === "content_block_delta" && data.delta?.type === "input_json_delta") {
      const toolIndex = data.content_block_index ?? 0;
      return {
        id: stableId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  function: {
                    arguments: data.delta.input_json,
                  },
                  index: toolIndex,
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
    }

    if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
      return {
        id: stableId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
          { index: 0, delta: { content: data.delta.text }, finish_reason: null },
        ],
      };
    }

    if (data.type === "content_block_stop") {
      return {
        id: stableId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
          { index: 0, delta: {}, finish_reason: null },
        ],
      };
    }

    if (data.type === "message_delta") {
      return {
        id: stableId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
          { index: 0, delta: {}, finish_reason: data.delta?.stop_reason },
        ],
        usage: data.usage
          ? {
              prompt_tokens: data.usage.input_tokens || 0,
              completion_tokens: data.usage.output_tokens || 0,
              total_tokens:
                (data.usage.input_tokens || 0) +
                (data.usage.output_tokens || 0),
            }
          : undefined,
      };
    }

    return data;
  }

  private static convertOpenAIStreamToAnthropic(
    data: RawStreamChunk
  ): unknown {
    if (data.object === "chat.completion.chunk") {
      const choice = data.choices?.[0];

      if (choice?.delta?.role && choice?.delta?.tool_calls) {
        const toolCall = choice.delta.tool_calls[0];
        return {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function?.name ?? "",
          },
        };
      }

      if (choice?.delta?.role) {
        return {
          type: "message_start",
          message: {
            id: data.id,
            type: "message",
            role: "assistant",
            content: [],
            model: data.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 1 },
          },
        };
      }

      if (choice?.delta?.tool_calls) {
        const toolCall = choice.delta.tool_calls[0];
        return {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            input_json: toolCall.function?.arguments ?? "",
          },
        };
      }

      if (choice?.delta?.content) {
        return {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: choice.delta.content },
        };
      }

      if (choice?.finish_reason) {
        if (choice.delta?.tool_calls) {
          return {
            type: "content_block_stop",
            index: 0,
          };
        }
        return {
          type: "message_delta",
          delta: { stop_reason: choice.finish_reason, stop_sequence: null },
          usage: data.usage
            ? {
                input_tokens: data.usage.prompt_tokens,
                output_tokens: data.usage.completion_tokens,
              }
            : undefined,
        };
      }
    }

    return data;
  }
}
