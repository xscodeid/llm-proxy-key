import { Request, Response } from "express";
import { APIFormatContext } from "../types/api";
import { APIMapper } from "../utils/apiMapper";
import { extractUsageFromChunk, logTokenUsage } from "../utils/tokenUsage";

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/**
 * Handles a streaming (SSE) upstream request.
 *
 * Returns true if the response was successfully piped to the client.
 * Returns false if the response was not OK and the status is retryable
 * (so the caller can retry with a different key without double-sending).
 *
 * IMPORTANT: This function sends the response only for:
 *   - Non-retryable errors (400, 401, 403, etc.)
 *   - Stream errors after SSE started
 *
 * For retryable upstream errors, it returns false without sending,
 * allowing the retry loop to pick a different key.
 */
export async function handleStreamingRequest(
  context: APIFormatContext,
  _req: Request,
  res: Response,
  response: globalThis.Response
): Promise<boolean> {
  if (!response.ok) {
    console.error(
      `[error] API response ${response.status} ${response.statusText}`
    );

    const errorText = await response.text();
    console.error("[error] details:", errorText.substring(0, 500));

    // If retryable, do NOT send response — let the retry loop handle it.
    if (RETRYABLE_STATUS_CODES.has(response.status)) {
      return false;
    }

    // Non-retryable — send error to client.
    res.status(response.status).json({
      error: `API Error: ${response.status}`,
      message: response.statusText,
      details: errorText.startsWith("<!DOCTYPE")
        ? "HTML error page returned"
        : errorText.substring(0, 200),
    });
    return false;
  }

  if (!response.body) {
    console.error("[error] No response body from API");
    res.status(500).json({ error: "No response body from API" });
    return false;
  }

  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Cache-Control",
    "X-Accel-Buffering": "no",
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let isStreamActive = true;

  const cleanup = () => {
    isStreamActive = false;
    reader.cancel().catch(() => {});
  };

  _req.on("close", cleanup);
  _req.on("aborted", cleanup);
  res.on("close", cleanup);

  try {
    while (isStreamActive) {
      const { done, value } = await reader.read();

      if (done) break;
      if (!isStreamActive || res.destroyed) break;

      const chunk = decoder.decode(value, { stream: true });

      const usage = extractUsageFromChunk(chunk);
      if (usage) {
        logTokenUsage(usage);
      }

      const mappedChunk = APIMapper.mapStreamingChunk(chunk, context);
      res.write(mappedChunk);
    }
  } catch (readError) {
    console.error("[error] Stream read error:", readError);
    if (isStreamActive && !res.destroyed) {
      res.write(
        'data: {"error":{"message":"Stream read error","type":"stream_error"}}\n\n'
      );
      res.write("data: [DONE]\n\n");
    }
  } finally {
    cleanup();
    if (!res.destroyed) {
      res.end();
    }
  }

  return true;
}
