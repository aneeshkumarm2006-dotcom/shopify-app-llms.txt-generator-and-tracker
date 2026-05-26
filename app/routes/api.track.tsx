// Tracking ingestion endpoint. PRD §7, §12.4.
//
// The AI Referral Pixel POSTs one event per browser session to this URL.
// Contract (see extensions/ai-referral-pixel/src/index.ts):
//
//   POST /api/track
//   Content-Type: application/json
//   Origin: https://<shop>.myshopify.com (or custom shop domain)
//
//   { shop, classification, source, matchedBy, utm: {...}, referrerDomain,
//     landingPath, timestamp }
//
// Three things this route is responsible for:
//
//   1. CORS — only accept POSTs from myshopify.com / configured custom
//      domains. Browsers enforce the response header, but we also validate
//      the Origin header server-side and 403 mismatches.
//   2. Validation — zod-parse the payload, drop oversized/malformed inputs.
//   3. Re-classification — the pixel's first-pass guess is advisory; we
//      rebuild the verdict from utm + referrer using app/lib/tracking/
//      ai-sources.ts (the server-side source of truth, per PRD §7.3).
//
// No HMAC: the pixel runs in an untrusted browser, so this endpoint is open
// to the public Internet. We mitigate spam at the aggregation layer (the
// pixel suppresses repeats per-session; the dashboard shows counts only).

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { z } from "zod";

import prisma from "../db.server";
import { classifyVisit } from "../lib/tracking/ai-sources";

// The pixel posts at most ~1 KB; cap at 8 KB to give headroom and reject
// anything obviously bogus. Bigger bodies are dropped before we touch JSON
// parsing.
const MAX_BODY_BYTES = 8 * 1024;

// Hosts we accept Origin from. Custom domains added via the SHOP_CUSTOM_DOMAIN
// env var (same one shopify.server.ts reads) are appended at runtime.
const ALLOWED_HOST_SUFFIXES = [".myshopify.com"];

function allowedHostSuffixes(): string[] {
  const extra = process.env.SHOP_CUSTOM_DOMAIN;
  return extra ? [...ALLOWED_HOST_SUFFIXES, `.${extra}`, extra] : ALLOWED_HOST_SUFFIXES;
}

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedHostSuffixes().some(
    (suffix) =>
      host === suffix.replace(/^\./, "") ||
      host.endsWith(suffix.startsWith(".") ? suffix : `.${suffix}`),
  );
}

function corsHeaders(origin: string | null): HeadersInit {
  // Echo the request origin only when it's on the allow list; never *.
  // Pixels post from the storefront, so credentials are unnecessary.
  const headers: Record<string, string> = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (origin && isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

const utmSchema = z.object({
  source: z.string().max(255).nullish(),
  medium: z.string().max(255).nullish(),
  campaign: z.string().max(255).nullish(),
  term: z.string().max(255).nullish(),
  content: z.string().max(255).nullish(),
});

const payloadSchema = z.object({
  shop: z.string().min(1).max(255),
  classification: z.enum(["ai", "other"]).optional(),
  source: z.string().max(255).nullish(),
  matchedBy: z.enum(["utm", "referrer"]).nullish(),
  utm: utmSchema.optional(),
  referrerDomain: z.string().max(255).nullish(),
  landingPath: z.string().max(2048).nullish(),
  timestamp: z.string().max(64).optional(),
});

// Browsers fire an OPTIONS preflight for any non-simple POST with a JSON
// content-type. Answer it without touching the database.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request.headers.get("origin")),
    });
  }
  // GET is not a valid verb on this endpoint — guard against accidental
  // browser navigation.
  return new Response("Method Not Allowed", {
    status: 405,
    headers: corsHeaders(request.headers.get("origin")),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const origin = request.headers.get("origin");
  const baseHeaders = corsHeaders(origin);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: baseHeaders });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: baseHeaders,
    });
  }

  // Origin gating. The pixel runs on the storefront, so any legitimate
  // request will carry an Origin header pointing at the merchant's domain.
  // Reject anything else with 403 — but still return CORS headers so the
  // browser console surfaces the failure clearly.
  if (!isAllowedOrigin(origin)) {
    return new Response("Forbidden", { status: 403, headers: baseHeaders });
  }

  // Reject obvious oversize without buffering. Some hosts strip
  // content-length on chunked uploads; in that case we fall through and the
  // .text() read below will still be bounded by the platform.
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return new Response("Payload Too Large", {
      status: 413,
      headers: baseHeaders,
    });
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return new Response("Bad Request", { status: 400, headers: baseHeaders });
  }

  if (raw.length > MAX_BODY_BYTES) {
    return new Response("Payload Too Large", {
      status: 413,
      headers: baseHeaders,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Response("Invalid JSON", {
      status: 400,
      headers: baseHeaders,
    });
  }

  const validation = payloadSchema.safeParse(parsed);
  if (!validation.success) {
    return new Response(
      JSON.stringify({ error: "validation_failed", issues: validation.error.flatten() }),
      {
        status: 400,
        headers: { ...baseHeaders, "Content-Type": "application/json" },
      },
    );
  }
  const payload = validation.data;

  // Origin host must match the claimed `shop` — prevents one storefront's
  // pixel from reporting traffic against another shop. The pixel's `shop`
  // setting comes from webPixelCreate at install time, so this should
  // always agree in practice; mismatches mean someone is replaying.
  const originHost = origin ? safeHost(origin) : null;
  if (originHost && !shopMatchesOrigin(payload.shop, originHost)) {
    return new Response("Shop / origin mismatch", {
      status: 403,
      headers: baseHeaders,
    });
  }

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: payload.shop },
    select: { id: true, status: true },
  });

  if (!shop) {
    // No row yet — most likely an event arrived before afterAuth finished
    // the install upsert. Acknowledge with 204 so the pixel does not retry.
    return new Response(null, { status: 204, headers: baseHeaders });
  }

  if (shop.status === "uninstalled") {
    return new Response(null, { status: 204, headers: baseHeaders });
  }

  // Server-side reclassification — PRD §7.3 calls this the canonical
  // verdict. We ignore payload.classification entirely; the pixel's hint is
  // advisory.
  const utm = payload.utm ?? {};
  const verdict = classifyVisit({
    utmSource: utm.source ?? null,
    referrerDomain: payload.referrerDomain ?? null,
  });

  const occurredAt = parseTimestamp(payload.timestamp);

  await prisma.trackingEvent.create({
    data: {
      shopId: shop.id,
      classification: verdict.classification,
      source: verdict.source,
      matchedBy: verdict.matchedBy,
      utmSource: utm.source ?? null,
      utmMedium: utm.medium ?? null,
      utmCampaign: utm.campaign ?? null,
      utmTerm: utm.term ?? null,
      utmContent: utm.content ?? null,
      referrerDomain: payload.referrerDomain ?? null,
      landingPath: payload.landingPath ?? null,
      occurredAt,
    },
  });

  return new Response(null, { status: 204, headers: baseHeaders });
};

function safeHost(origin: string): string | null {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function shopMatchesOrigin(shopDomain: string, originHost: string): boolean {
  const shop = shopDomain.toLowerCase();
  if (shop === originHost) return true;
  // Shopify storefronts may post from the primary custom domain even when
  // the shop's "canonical" name is *.myshopify.com. We allow that via the
  // SHOP_CUSTOM_DOMAIN env var (same hook used by shopifyApp()). The strict
  // myshopify.com-only path is the common case; everything else falls back
  // to the suffix allowlist evaluated in isAllowedOrigin.
  const extra = process.env.SHOP_CUSTOM_DOMAIN?.toLowerCase();
  if (extra && originHost.endsWith(extra)) return true;
  return false;
}

function parseTimestamp(value: string | undefined): Date {
  if (!value) return new Date();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date();
  // Don't let the pixel claim events from the future (clock skew) or the
  // ancient past — clamp to ±24h.
  const now = Date.now();
  const drift = Math.abs(parsed.getTime() - now);
  if (drift > 24 * 60 * 60 * 1000) return new Date();
  return parsed;
}
