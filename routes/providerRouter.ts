import { ProviderConfig } from "../types/provider";

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
  // Longest prefix first so "/kilo" matches before "/" would.
  const sorted = [...providers].sort(
    (a, b) => b.prefix.length - a.prefix.length
  );

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
