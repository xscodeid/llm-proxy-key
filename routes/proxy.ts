import { Agent as HttpAgent } from "http";
import { Agent as HttpsAgent } from "https";
import { Request, Response } from "express";
import { handleNonStreamingRequest } from "../services/nonStreamingRequest";
import { handleStreamingRequest } from "../services/streamingRequest";
import { APIMapper } from "../utils/apiMapper";
import { FormatDetector } from "../utils/formatDetector";
import { APIFormatContext, OpenAIRequest, AnthropicRequest } from "../types/api";
import { ProviderConfig } from "../types/provider";

// --- Connection Pool: keep-alive agents per provider ---
// Reuses TCP/TLS connections to avoid handshake overhead on every request.
const agentCache = new Map<string, HttpAgent | HttpsAgent>();

export function getAgent(provider: ProviderConfig): HttpAgent | HttpsAgent {
  const existing = agentCache.get(provider.name);
  if (existing) {
    return existing;
  }

  const isHttps = provider.endpoint.startsWith("https://");
  const agent = isHttps
    ? new HttpsAgent({ keepAlive: true, maxSockets: 10 })
    : new HttpAgent({ keepAlive: true, maxSockets: 10 });

  agentCache.set(provider.name, agent);
  return agent;
}

type ProxyRequestBody = Partial<OpenAIRequest> | Partial<AnthropicRequest>;

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;

const BEARER_PREFIX = "Bearer ";

function extractBearerToken(header: string | undefined): string | null {
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }
  return header.slice(BEARER_PREFIX.length);
}

export async function proxyHandler(
  req: Request,
  res: Response,
  provider: ProviderConfig,
  proxyAuthKey: string,
  initialKey: string,
  getNextKey: (excludeKey?: string) => {
    key: string;
    index: number;
    total: number;
  },
  agent: HttpAgent | HttpsAgent
): Promise<void> {
  try {
    // --- Authentication: require client to provide the proxy auth key ---
    if (proxyAuthKey) {
      const clientKey = extractBearerToken(req.headers.authorization);
      if (!clientKey) {
        res.status(401).json({
          error: "Unauthorized",
          message:
            "Missing or invalid Authorization header. Expected: Bearer <proxy-key>",
        });
        return;
      }
      if (clientKey !== proxyAuthKey) {
        res.status(403).json({
          error: "Forbidden",
          message: "Invalid proxy auth key.",
        });
        return;
      }
    }

    // --- Resolve API format context from provider config ---
    const clientFormat = FormatDetector.detectClientFormat(
      req.originalUrl,
      req.body
    );
    const targetFormat = provider.format === "anthropic" ? "anthropic" : "openai";
    const needsMapping = clientFormat !== targetFormat;
    const context: APIFormatContext = {
      clientFormat,
      targetFormat,
      needsMapping,
    };

    console.log(
      `  │  Format : ${context.clientFormat} → ${context.targetFormat}${context.needsMapping ? " (mapped)" : ""}`
    );

    // --- Map request body ---
    const bodyData = APIMapper.mapRequest(req.body, context) as ProxyRequestBody;

    // Reject requests that do not specify a model.
    if (!bodyData.model) {
      res.status(400).json({
        error: "Missing model",
        message:
          "Request body must include a 'model' field. The proxy does not apply a default model.",
      });
      return;
    }

    // Reject requests with a model not in the provider's allowed list.
    if (
      provider.allowedModels.length > 0 &&
      !provider.allowedModels.includes(bodyData.model)
    ) {
      res.status(400).json({
        error: "Invalid model",
        message: `Model '${bodyData.model}' is not allowed for provider '${provider.name}'. Allowed: ${provider.allowedModels.join(", ")}`,
      });
      return;
    }

    // --- Build target URL (strip provider prefix from path) ---
    const strippedPath = stripProviderPrefix(req.originalUrl, provider);
    const endpoint = APIMapper.getTargetEndpoint(strippedPath, context);
    const targetUrl = provider.endpoint + endpoint;

    // --- Use the initial key provided by the rotation layer ---
    const upstreamApiKey = initialKey;

    const isStreaming = (bodyData as { stream?: boolean }).stream === true;
    console.log(
      `  │  Type   : ${isStreaming ? "streaming" : "non-streaming"}`
    );
    console.log(`  │  Target : ${targetUrl}`);
    console.log(`  └─`);

    let success = false;

    if (isStreaming) {
      success = await handleStreamingWithRetry(
        targetUrl,
        upstreamApiKey,
        bodyData,
        context,
        req,
        res,
        getNextKey,
        provider.apiKeys.length,
        agent
      );
    } else {
      success = await handleNonStreamingWithRetry(
        targetUrl,
        upstreamApiKey,
        bodyData,
        context,
        req,
        res,
        getNextKey,
        provider.apiKeys.length,
        agent
      );
    }

    if (!success && !res.headersSent) {
      res.status(500).json({ error: "Request failed" });
    }
  } catch (error: unknown) {
    console.error("[error] Proxy error:", error);

    if (!res.headersSent) {
      if (error instanceof Error) {
        res.status(500).json({
          error: "Internal server error",
          message: error.message,
        });
      } else {
        res.status(500).json({ error: "Unknown error occurred" });
      }
    }
  }
}

/**
 * Strips the provider prefix from the request path so the upstream
 * receives a standard path like /v1/chat/completions.
 *
 *   /kilo/v1/chat/completions  → /v1/chat/completions
 *   /openrouter/v1/messages    → /v1/messages
 */
function stripProviderPrefix(path: string, provider: ProviderConfig): string {
  if (path.startsWith(provider.prefix)) {
    const stripped = path.slice(provider.prefix.length);
    return stripped.startsWith("/") ? stripped : "/" + stripped;
  }
  return path;
}

/**
 * Retries streaming requests on initial fetch failure (before SSE headers sent).
 * Only retries for status codes in RETRYABLE_STATUS_CODES.
 */
async function handleStreamingWithRetry(
  targetUrl: string,
  apiKey: string,
  bodyData: ProxyRequestBody,
  context: APIFormatContext,
  req: Request,
  res: Response,
  getNextKey: (excludeKey?: string) => {
    key: string;
    index: number;
    total: number;
  },
  apiKeyCount: number,
  agent: HttpAgent | HttpsAgent
): Promise<boolean> {
  let currentKey = apiKey;
  let attempt = 0;
  const maxRetries = Math.min(MAX_RETRIES, apiKeyCount - 1);

  const buildFetchFn = (key: string) => () =>
    fetch(targetUrl, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyData),
      agent,
    } as RequestInit);

  while (true) {
    const response = await buildFetchFn(currentKey)();

    if (response.ok) {
      return handleStreamingRequest(context, req, res, response);
    }

    if (!RETRYABLE_STATUS_CODES.has(response.status)) {
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

    if (attempt >= maxRetries) {
      console.error(
        `[error] API response ${response.status} ${response.statusText} — no more retries`
      );
      const errorText = await response.text();
      res.status(response.status).json({
        error: `API Error: ${response.status}`,
        message: response.statusText,
        details: errorText.substring(0, 200),
      });
      return false;
    }

    const nextKeyInfo = getNextKey(currentKey);
    if (!nextKeyInfo) {
      return false;
    }

    attempt++;
    console.log(
      `[retry] streaming attempt ${attempt}/${maxRetries} with new key (${nextKeyInfo.index}/${nextKeyInfo.total})`
    );
    currentKey = nextKeyInfo.key;
  }
}

/**
 * Retries non-streaming requests with a different key on retryable errors.
 * Only retries for status codes in RETRYABLE_STATUS_CODES.
 */
async function handleNonStreamingWithRetry(
  targetUrl: string,
  apiKey: string,
  bodyData: ProxyRequestBody,
  context: APIFormatContext,
  req: Request,
  res: Response,
  getNextKey: (excludeKey?: string) => {
    key: string;
    index: number;
    total: number;
  },
  apiKeyCount: number,
  agent: HttpAgent | HttpsAgent
): Promise<boolean> {
  let currentKey = apiKey;
  let attempt = 0;
  const maxRetries = Math.min(MAX_RETRIES, apiKeyCount - 1);

  let result = await handleNonStreamingRequest(
    targetUrl,
    currentKey,
    bodyData,
    context,
    req,
    res,
    agent
  );

  if (result.success) {
    return true;
  }

  if (
    result.statusCode !== null &&
    !RETRYABLE_STATUS_CODES.has(result.statusCode)
  ) {
    return false;
  }

  while (attempt < maxRetries) {
    const nextKeyInfo = getNextKey(currentKey);
    if (!nextKeyInfo) {
      return false;
    }

    attempt++;
    console.log(
      `[retry] attempt ${attempt}/${maxRetries} with new key (${nextKeyInfo.index}/${nextKeyInfo.total})`
    );

    currentKey = nextKeyInfo.key;
    result = await handleNonStreamingRequest(
      targetUrl,
      currentKey,
      bodyData,
      context,
      req,
      res,
      agent
    );

    if (result.success) {
      return true;
    }

    if (
      result.statusCode !== null &&
      !RETRYABLE_STATUS_CODES.has(result.statusCode)
    ) {
      return false;
    }
  }

  return false;
}
