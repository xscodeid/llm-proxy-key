import { APIFormat } from "./api";

/**
 * Provider configuration resolved from environment variables.
 * Each provider is identified by a URL prefix (e.g. "/kilo") and
 * carries its own endpoint, format, model whitelist, and API keys.
 */
export interface ProviderConfig {
  /** Human-readable name for logging. */
  name: string;
  /** URL path prefix that routes to this provider, e.g. "/kilo". */
  prefix: string;
  /** Base URL of the upstream API, e.g. "https://api.kilo.ai/api/gateway". */
  endpoint: string;
  /** Target API format for request/response mapping. */
  format: APIFormat;
  /** Whitelisted models. Empty array means "allow all". */
  allowedModels: string[];
  /** Rotated API keys for upstream authentication. */
  apiKeys: string[];
}
