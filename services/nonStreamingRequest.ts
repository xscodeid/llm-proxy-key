import { Agent as HttpAgent } from "http";
import { Agent as HttpsAgent } from "https";
import { Request, Response } from "express";
import {
  APIFormatContext,
  OpenAIRequest,
  AnthropicRequest,
} from "../types/api";
import { APIMapper } from "../utils/apiMapper";
import { logTokenUsage } from "../utils/tokenUsage";

export type ProxyRequestBody = Partial<OpenAIRequest> | Partial<AnthropicRequest>;

export interface ServiceResult {
  success: boolean;
  statusCode: number | null;
}

/**
 * Status codes that should NOT be retried (client errors except 429).
 */
const NON_RETRYABLE_CLIENT_ERRORS = new Set([400, 401, 403, 404, 422]);

/**
 * Handles a single non-streaming upstream request.
 *
 * IMPORTANT: This function sends the response to the client ONLY for
 * non-retryable errors (400, 401, 403, 404, 422). For retryable errors
 * (429, 5xx) it returns without sending, so the caller (retry loop)
 * can pick a different key and try again without double-sending.
 *
 * When the caller is a retry loop, the final "all retries exhausted"
 * response is sent by that loop (in proxy.ts).
 */
export async function handleNonStreamingRequest(
  targetUrl: string,
  apiKey: string,
  bodyData: ProxyRequestBody,
  context: APIFormatContext,
  req: Request,
  res: Response,
  agent: HttpAgent | HttpsAgent
): Promise<ServiceResult> {
  const response = await fetch(targetUrl, {
    method: req.method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bodyData),
    agent,
  } as RequestInit);

  if (!response.ok) {
    console.error(
      `[error] API response ${response.status} ${response.statusText}`
    );

    const errorText = await response.text();
    console.error("[error] details:", errorText.substring(0, 500));

    const isRetryable =
      response.status === 429 ||
      response.status === 500 ||
      response.status === 503;

    if (NON_RETRYABLE_CLIENT_ERRORS.has(response.status)) {
      const startsWithHtml = errorText.startsWith("<!DOCTYPE");
      res.status(response.status).json({
        error: `API Error: ${response.status}`,
        message: response.statusText,
        details: startsWithHtml
          ? "HTML error page returned"
          : errorText.substring(0, 200),
      });
      return { success: false, statusCode: response.status };
    }

    if (!isRetryable) {
      // Unknown status — do not retry, do not send to client;
      // let the retry loop's caller decide.
      return { success: false, statusCode: response.status };
    }

    // Retryable (429, 500, 503): do NOT send response, signal retry.
    return { success: false, statusCode: response.status };
  }

  const contentType = response.headers.get("content-type");
  if (!contentType || !contentType.includes("application/json")) {
    const responseText = await response.text();
    console.error("[error] unexpected content type:", contentType);
    // 502 is retryable — let the retry loop decide.
    console.error("[error] body:", responseText.substring(0, 500));
    return { success: false, statusCode: 502 };
  }

  let responseData: unknown;
  try {
    responseData = await response.json();
  } catch (parseError) {
    console.error("[error] JSON parse error:", parseError);
    // Malformed response — treat as retryable.
    return { success: false, statusCode: 502 };
  }

  if (responseData && typeof responseData === "object") {
    const data = responseData as Record<string, unknown>;
    if (data.usage && typeof data.usage === "object") {
      const usage = data.usage as Record<string, unknown>;
      if (typeof usage.total_tokens === "number") {
        logTokenUsage({
          total_tokens: usage.total_tokens as number,
          prompt_tokens: (usage.prompt_tokens as number) ?? 0,
          completion_tokens: (usage.completion_tokens as number) ?? 0,
          prompt_tokens_details:
            (usage.prompt_tokens_details as { cached_tokens?: number } | null) ??
            null,
        });
      } else if (typeof usage.input_tokens === "number") {
        logTokenUsage({
          total_tokens:
            (usage.input_tokens as number) +
            ((usage.output_tokens as number) ?? 0),
          prompt_tokens: usage.input_tokens as number,
          completion_tokens: (usage.output_tokens as number) ?? 0,
        });
      }
    }
  }

  responseData = APIMapper.mapResponse(responseData, context);

  res.status(response.status).json(responseData);
  return { success: true, statusCode: response.status };
}
