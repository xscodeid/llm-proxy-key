import { timingSafeEqual } from "crypto";

/**
 * Compares two strings in constant time to prevent timing attacks.
 * Returns true if they are equal, false otherwise.
 */
export function createTimingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
