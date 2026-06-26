import { ProviderConfig } from "../types/provider";

// Cache sorted providers to avoid re-sorting on every request.
let cachedSorted: ProviderConfig[] | null = null;
let cachedVersion = 0;

/**
 * Matches an incoming request path against registered providers.
 * Returns the provider whose prefix matches, or null if no match.
 *
 * Matching rules:
 *  - /kilo/v1/chat/completions  → prefix="/kilo" → KILO provider
 *  - /openrouter/v1/messages  → prefix="/openrouter" → OPENROUTER provider
 *  - /v1/chat/completions      → no match → null (no provider found)
 */
export function resolveProvider(
  path: string,
  providers: ProviderConfig[]
): ProviderConfig | null {
  // Use cached sorted array if providers list hasn't changed.
  const sorted = getSortedProviders(providers);

  for (const provider of sorted) {
    if (
      path.startsWith(provider.prefix + "/") ||
      path === provider.prefix ||
      path === provider.prefix + "/"
    ) {
      return provider;
    }
  }

  return null;
}

/**
 * Returns providers sorted by prefix length (longest first), using a cache
 * that is invalidated only when the providers array reference changes.
 */
function getSortedProviders(providers: ProviderConfig[]): ProviderConfig[] {
  if (cachedSorted && cachedVersion === providers.length) {
    return cachedSorted;
  }
  cachedSorted = [...providers].sort(
    (a, b) => b.prefix.length - a.prefix.length
  );
  cachedVersion = providers.length;
  return cachedSorted;
}
