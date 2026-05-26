// HMAC verification for Shopify App Proxy requests.
//
// Per the App Proxy signature spec
// (https://shopify.dev/docs/apps/build/online-store/display-dynamic-data#calculate-a-digital-signature):
//
//   1. Remove the `signature` parameter from the query string.
//   2. Sort the remaining parameters alphabetically by key.
//   3. Concatenate them as `key=value` pairs with NO separator between pairs.
//      For repeated keys, Shopify joins their values with `,` before concat.
//   4. HMAC-SHA256 the result using the app's API secret as the key.
//   5. The hex digest must equal the `signature` query param.
//
// Constant-time comparison is mandatory — timing leaks here would let a
// remote attacker forge proxy URLs and serve any shop's llms.txt to anyone.
// PRD §12.2.

import crypto from "node:crypto";

export interface ProxyVerificationResult {
  valid: boolean;
  reason?: "missing_signature" | "missing_secret" | "mismatch";
}

// Build the canonical message Shopify signs. Exported for tests.
export function buildProxyMessage(searchParams: URLSearchParams): string {
  // Collect every param except `signature`. Group repeats so `foo=a&foo=b`
  // serialises as `foo=a,b` (Shopify spec).
  const grouped = new Map<string, string[]>();
  for (const [key, value] of searchParams.entries()) {
    if (key === "signature") continue;
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(value);
    } else {
      grouped.set(key, [value]);
    }
  }

  const sortedKeys = [...grouped.keys()].sort();
  return sortedKeys
    .map((key) => `${key}=${(grouped.get(key) ?? []).join(",")}`)
    .join("");
}

// Timing-safe hex compare. crypto.timingSafeEqual throws if lengths differ,
// so we normalise first.
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export interface VerifyProxyOptions {
  // Optional override for tests. Defaults to process.env.SHOPIFY_API_SECRET.
  secret?: string;
}

// Verify the signature on an App Proxy request URL. Pass the full Request.url.
export function verifyAppProxyRequest(
  requestUrl: string | URL,
  options: VerifyProxyOptions = {},
): ProxyVerificationResult {
  const url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
  const signature = url.searchParams.get("signature");
  if (!signature) {
    return { valid: false, reason: "missing_signature" };
  }

  const secret = options.secret ?? process.env.SHOPIFY_API_SECRET ?? "";
  if (!secret) {
    return { valid: false, reason: "missing_secret" };
  }

  const message = buildProxyMessage(url.searchParams);
  const expected = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  return safeEqualHex(expected, signature)
    ? { valid: true }
    : { valid: false, reason: "mismatch" };
}

// Convenience: return the `shop` query param Shopify forwards on every signed
// proxy request, after verification. Returns null when verification fails or
// the param is missing.
export function getVerifiedProxyShop(
  requestUrl: string | URL,
  options: VerifyProxyOptions = {},
): string | null {
  const result = verifyAppProxyRequest(requestUrl, options);
  if (!result.valid) return null;
  const url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
  return url.searchParams.get("shop");
}
