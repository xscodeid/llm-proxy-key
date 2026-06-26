import { Agent as HttpAgent } from "http";
import { Agent as HttpsAgent } from "https";
import { Request, Response } from "express";
import { APIFormatContext, OpenAIRequest, AnthropicRequest } from "../types/api";
import { APIMapper } from "../utils/apiMapper";
import { logTokenUsage } from "../utils/tokenUsage";

export type ProxyRequestBody = Partial<OpenAIRequest> | Partial<AnthropicRequest>;

export interface ServiceResult {
  success: boolean;
  statusCode: number | null;
}

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

    const isRetriable = response.status === 429 || response.status >= 500;
    if (!isRetriable) {
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

    return { success: false, statusCode: response.status };
  }

  const contentType = response.headers.get("content-type");
  if (!contentType || !contentType.includes("application/json")) {
    const responseText = await response.text();
    console.error("[error] unexpected content type:", contentType);
    res.status(502).json({
      error: "Invalid response format",
      message: "API returned non-JSON response",
      contentType: contentType,
    });
    return { success: false, statusCode: 502 };
  }

  let responseData: unknown;
  try {
    responseData = await response.json();
  } catch (parseError) {
    console.error("[error] JSON parse error:", parseError);
    res.status(502).json({
      error: "Response parsing failed",
      message: "Could not parse API response as JSON",
    });
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
