// HMAC verification for Shopify webhook requests.
//
// Per https://shopify.dev/docs/apps/build/webhooks/subscribe/https#verify-the-webhook:
//
//   1. Read the raw request body (do not parse / re-stringify — whitespace
//      matters).
//   2. HMAC-SHA256 the raw body with the app's API secret.
//   3. Base64-encode the digest and compare against the
//      X-Shopify-Hmac-Sha256 header in constant time.
//
// `@shopify/shopify-app-react-router`'s `authenticate.webhook(request)`
// already does this for the topics we register through it (app/uninstalled).
// The mandatory compliance topics — customers/data_request, customers/redact,
// shop/redact — are registered via the `[webhooks].compliance_topics` block
// in shopify.app.toml and arrive at a single shared URI without going through
// the shopifyApp() webhook router, so we verify them ourselves here.
//
// Constant-time comparison is mandatory — a timing leak would let an
// attacker forge compliance webhooks and trigger arbitrary shop deletes.
// PRD §15.2.

import crypto from "node:crypto";

export interface WebhookVerificationResult {
  valid: boolean;
  reason?: "missing_hmac" | "missing_secret" | "mismatch";
}

export interface VerifyWebhookOptions {
  // Override for tests. Defaults to process.env.SHOPIFY_API_SECRET.
  secret?: string;
}

function safeEqualBase64(a: string, b: string): boolean {
  // Buffer.from with an invalid base64 string silently truncates rather than
  // throws, so normalise length-checks against the decoded bytes.
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, "base64");
    bufB = Buffer.from(b, "base64");
  } catch {
    return false;
  }
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

// Verify the HMAC on a raw webhook body against the request's
// X-Shopify-Hmac-Sha256 header. Caller passes the raw bytes (or a string in
// the original transmitted encoding) so we never re-encode.
export function verifyWebhookHmac(
  rawBody: string | Buffer,
  hmacHeader: string | null,
  options: VerifyWebhookOptions = {},
): WebhookVerificationResult {
  if (!hmacHeader) {
    return { valid: false, reason: "missing_hmac" };
  }

  const secret = options.secret ?? process.env.SHOPIFY_API_SECRET ?? "";
  if (!secret) {
    return { valid: false, reason: "missing_secret" };
  }

  const computed = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  return safeEqualBase64(computed, hmacHeader)
    ? { valid: true }
    : { valid: false, reason: "mismatch" };
}

export interface VerifiedWebhook {
  shopDomain: string | null;
  topic: string | null;
  rawBody: string;
}

// Read a compliance webhook request, verify its signature, and return the
// raw body + Shopify-provided headers. Throws a Response (which the calling
// route returns as-is) when verification fails — this keeps every compliance
// handler's body small and uniform.
export async function readVerifiedWebhook(
  request: Request,
  options: VerifyWebhookOptions = {},
): Promise<VerifiedWebhook> {
  const rawBody = await request.text();
  const hmac = request.headers.get("x-shopify-hmac-sha256");
  const result = verifyWebhookHmac(rawBody, hmac, options);
  if (!result.valid) {
    throw new Response("Unauthorized", { status: 401 });
  }
  return {
    shopDomain: request.headers.get("x-shopify-shop-domain"),
    topic: request.headers.get("x-shopify-topic"),
    rawBody,
  };
}
