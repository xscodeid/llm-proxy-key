import { Request, Response } from "express";
import { APIFormatContext } from "../types/api";
import { APIMapper } from "../utils/apiMapper";
import { extractUsageFromChunk, logTokenUsage } from "../utils/tokenUsage";
export async function handleStreamingRequest(
  context: APIFormatContext,
  req: Request,
  res: Response,
  response: globalThis.Response
): Promise<boolean> {
  if (!response.ok) {
    console.error(
      `[error] API response ${response.status} ${response.statusText}`
    );

    const errorText = await response.text();
    console.error("[error] details:", errorText.substring(0, 500));

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

  req.on("close", cleanup);
  req.on("aborted", cleanup);
  res.on("close", cleanup);

  try {
    while (isStreamActive) {
      const { done, value } = await reader.read();

      if (done) break;
      if (!isStreamActive || res.destroyed) break;

      let chunk = decoder.decode(value, { stream: true });

      const usage = extractUsageFromChunk(chunk);
      if (usage) {
        logTokenUsage(usage);
      }

      chunk = APIMapper.mapStreamingChunk(chunk, context);

      res.write(chunk);
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
