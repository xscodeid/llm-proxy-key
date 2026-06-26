import { APIFormat } from "../types/api";

interface RequestBody {
  max_tokens?: number;
  messages?: Array<{ role?: string }>;
  [key: string]: unknown;
}

/**
 * Detects the client's API format based on request path and body.
 * This is the only source of truth for determining client format —
 * target format comes from the provider config (KILO_FORMAT, etc.).
 */
export class FormatDetector {
  static detectClientFormat(path: string, body: RequestBody): APIFormat {
    if (path.includes("/v1/messages")) {
      return "anthropic";
    }
    if (path.includes("/chat/completions")) {
      return "openai";
    }

    if (
      body.max_tokens !== undefined &&
      Array.isArray(body.messages) &&
      !body.messages.some((m) => m.role === "system")
    ) {
      return "anthropic";
    }

    return "openai";
  }
}
