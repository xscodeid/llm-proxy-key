import { APIFormat } from "../types/api";
import { ProviderConfig } from "../types/provider";

/**
 * Discovers all provider prefixes from environment variables.
 * A provider is identified by an uppercase prefix (e.g. "KILO") that
 * appears in env vars like:
 *   KILO_ENDPOINT=...
 *   KILO_FORMAT=...
 *   KILO_MODELS=...
 *   KILO_API_KEYS_1=...
 *
 * The prefix is converted to a URL path: "KILO" → "/kilo".
 */
function discoverProviderPrefixes(): string[] {
  const prefixes = new Set<string>();
  const pattern = /^([A-Z][A-Z0-9]*)_(ENDPOINT|FORMAT|MODELS|API_KEYS_\d+)$/;

  for (const key of Object.keys(process.env)) {
    const match = key.match(pattern);
    if (match) {
      prefixes.add(match[1]);
    }
  }

  return Array.from(prefixes).sort();
}

/**
 * Loads numbered API keys (PREFIX_API_KEYS_1, PREFIX_API_KEYS_2, ...).
 * Stops at first gap.
 */
function loadNumberedKeys(prefix: string): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= 100; i++) {
    const value = process.env[`${prefix}_API_KEYS_${i}`];
    if (value) {
      keys.push(value.trim());
    } else {
      break;
    }
  }
  return keys;
}

/**
 * Loads all provider configurations from environment variables.
 * Returns an array of ProviderConfig sorted by prefix name.
 */
export function loadProviders(): ProviderConfig[] {
  const prefixes = discoverProviderPrefixes();
  const providers: ProviderConfig[] = [];

  for (const prefix of prefixes) {
    const endpoint = process.env[`${prefix}_ENDPOINT`];
    const format = (process.env[`${prefix}_FORMAT`] as APIFormat) || "openai";
    const modelsStr = process.env[`${prefix}_MODELS`] || "";
    const apiKeys = loadNumberedKeys(prefix);

    if (!endpoint) {
      console.warn(`[provider] Skipping ${prefix}: missing ${prefix}_ENDPOINT`);
      continue;
    }

    if (apiKeys.length === 0) {
      console.warn(`[provider] Skipping ${prefix}: missing ${prefix}_API_KEYS_1`);
      continue;
    }

    const allowedModels = modelsStr
      ? modelsStr.split(",").map((m) => m.trim()).filter(Boolean)
      : [];

    providers.push({
      name: prefix.charAt(0) + prefix.slice(1).toLowerCase(),
      prefix: `/${prefix.toLowerCase()}`,
      endpoint: endpoint.trim(),
      format,
      allowedModels,
      apiKeys,
    });
  }

  return providers;
}
