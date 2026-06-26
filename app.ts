import dotenv from "dotenv";
import express, { Request, Response } from "express";
import { configureServer } from "./config/server";
import { corsMiddleware, handleCorsOptions } from "./middleware/cors";
import { validateRequest } from "./middleware/validateRequest";
import { proxyHandler, getAgent } from "./routes/proxy";
import { resolveProvider } from "./routes/providerRouter";
import { ProviderConfig } from "./types/provider";
import { loadProviders } from "./services/providerRegistry";

dotenv.config();

const app = express();
const PROXY_AUTH_KEY = process.env.PROXY_AUTH_KEY || "";

// --- Load all providers from environment ---
const providers = loadProviders();

if (providers.length === 0) {
  throw new Error(
    "No providers configured. At least one provider is required. " +
      "Example: KILO_ENDPOINT=..., KILO_API_KEYS_1=..."
  );
}

// --- Per-provider key rotation state ---
const providerKeyIndex = new Map<string, number>();

interface KeyInfo {
  key: string;
  index: number;
  total: number;
}

/**
 * Advances the rotation index for the given provider and returns the next key.
 * The index is always moved forward FIRST, so subsequent calls (including
 * retries with excludeKey) start from the correct position.
 */
function getNextKey(provider: ProviderConfig, excludeKey?: string): KeyInfo {
  const total = provider.apiKeys.length;

  if (total === 1) {
    return { key: provider.apiKeys[0], index: 1, total };
  }

  const current = providerKeyIndex.get(provider.name) ?? 0;
  let next = (current + 1) % total;

  // Skip the excluded key (the one that just failed)
  if (excludeKey) {
    let safety = 0;
    while (provider.apiKeys[next] === excludeKey && safety < total) {
      next = (next + 1) % total;
      safety++;
    }
  }

  providerKeyIndex.set(provider.name, next);
  return { key: provider.apiKeys[next], index: next + 1, total };
}

// --- Mask API key for logging ---
function maskApiKey(key: string): string {
  if (key.length <= 20) {
    return "***";
  }
  return `${key.slice(0, 12)}...${key.slice(-8)}`;
}

// --- Parse request body with configurable size limit ---
// Default 10MB covers large context windows (up to ~2M tokens with base64 images).
// Prevents DoS via oversized payloads while remaining compatible with all LLM APIs.
const BODY_LIMIT = process.env.BODY_SIZE_LIMIT || "10mb";

app.use(corsMiddleware);
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ limit: BODY_LIMIT, extended: true }));

// --- Health check endpoint ---
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    providers: providers.map((p) => p.name),
  });
});

// --- Handle OPTIONS for CORS ---
app.options("/*splat", handleCorsOptions);

// --- Main proxy route (validated) ---
app.all("/*splat", validateRequest, async (req: Request, res: Response) => {
  // Resolve provider from URL path
  const provider = resolveProvider(req.path, providers);

  if (!provider) {
    res.status(404).json({
      error: "Provider not found",
      message: `No provider matches path '${req.path}'. Available prefixes: ${providers.map((p) => p.prefix).join(", ")}`,
      availableProviders: providers.map((p) => ({
        name: p.name,
        prefix: p.prefix,
      })),
    });
    return;
  }

  // Get next key for this provider
  const { key: apiKey, index: keyIndex, total: keyTotal } =
    getNextKey(provider);

  // Extract model from request body for logging
  const requestBody = req.body as { model?: string } | undefined;
  const requestedModel = requestBody?.model;

  if (req.path !== "/health") {
    console.log(`\n  �─ [${provider.name}]`);
    console.log(`  │  Key    : ${maskApiKey(apiKey)} (${keyIndex}/${keyTotal})`);
    console.log(`  │  Model  : ${requestedModel ?? "(none)"}`);
    console.log(`  │  Path   : ${req.originalUrl}`);
    console.log(`  └─`);
  }

  // Bind getNextKey to this provider so proxy.ts can call it
  // with an excludeKey to skip the failed key on retry.
  const getNextKeyForProvider = (excludeKey?: string) =>
    getNextKey(provider, excludeKey);

  await proxyHandler(
    req,
    res,
    provider,
    PROXY_AUTH_KEY,
    apiKey,
    getNextKeyForProvider,
    getAgent(provider)
  );
});

const server = app.listen(process.env.PORT || 8888, () => {
  const port = process.env.PORT || 8888;

  console.log("");
  console.log("  ██�  ██�███████╗ ██████�  ██████╗ ██████╗ ███████╗");
  console.log("  ╚██╗██╔╝██╔════╝██╔════╝ ██╔═══██╗██╔══██�██╔════╝");
  console.log("   ╚███╔╝ ███████╗██║      ██║   ██║██║  ██║█████╗  ");
  console.log("   ██�██╗ ╚════██�██║      ██║   ██║██�  ██�██╔══╝  ");
  console.log("  ██╔╝ ██╗███████║�██████╗ ╚██████╔╝██████╔╝███████╗");
  console.log("  ╚═╝  ╚═╝╚══════╝ ╚═════╝  ╚═════╝ �═════╝ ╚══════╝");
  console.log("");
  console.log(
    "  LLM Proxy Key  —  Multi-provider API key proxy with round-robin rotation"
  );
  console.log(`  Listening on port ${port}`);
  console.log(
    `  Providers: ${providers.map((p) => `${p.name} (${p.prefix})`).join(", ")}`
  );
  console.log("");
});

configureServer(server);

export default app;
