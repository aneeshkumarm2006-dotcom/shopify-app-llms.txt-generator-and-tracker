// Phase 4 smoke test — exercise /api/track end to end.
//
// What this does:
//   1. Resolve/insert the Shop row (so the route can look it up).
//   2. POST a synthetic AI-referred event to /api/track with the storefront
//      Origin header set, exactly as the pixel sandbox would.
//   3. Assert: a row lands in `tracking_events` with classification='ai'
//      and source='chatgpt'.
//   4. POST a non-AI event, assert classification='other'.
//
// This mirrors the TODO's Phase 4 manual step "open the storefront with
// ?utm_source=chatgpt, confirm a row appears with classification='ai'" but
// without needing a real browser session or the pixel sandbox.
//
// Run with:
//   cd app
//   DATABASE_URL=... \
//   SMOKE_APP_URL=http://localhost:3000 \
//   SMOKE_SHOP_DOMAIN=<your-dev-store>.myshopify.com \
//   npx tsx scripts/smoke-track.ts

import process from "node:process";

import prisma from "../app/db.server";

interface TrackPayload {
  shop: string;
  classification?: "ai" | "other";
  source?: string | null;
  matchedBy?: "utm" | "referrer" | null;
  utm?: {
    source?: string | null;
    medium?: string | null;
    campaign?: string | null;
    term?: string | null;
    content?: string | null;
  };
  referrerDomain?: string | null;
  landingPath?: string | null;
  timestamp?: string;
}

async function postEvent(args: {
  appUrl: string;
  shopDomain: string;
  payload: TrackPayload;
}): Promise<number> {
  const res = await fetch(`${args.appUrl}/api/track`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: `https://${args.shopDomain}`,
    },
    body: JSON.stringify(args.payload),
  });
  return res.status;
}

async function main() {
  const shopDomain = process.env.SMOKE_SHOP_DOMAIN;
  const appUrl = process.env.SMOKE_APP_URL;
  if (!shopDomain || !appUrl) {
    console.error(
      "SMOKE_SHOP_DOMAIN and SMOKE_APP_URL are required (e.g. https://localhost:3000)",
    );
    process.exit(2);
  }

  console.info(`[smoke:track] shop=${shopDomain} app=${appUrl}`);

  const shop = await prisma.shop.upsert({
    where: { shopDomain },
    create: { shopDomain, status: "active" },
    update: { status: "active" },
  });
  console.info(`[smoke:track] shop.id=${shop.id}`);

  const baselineCount = await prisma.trackingEvent.count({
    where: { shopId: shop.id },
  });

  // 1. AI-referred event via utm_source.
  const aiStatus = await postEvent({
    appUrl,
    shopDomain,
    payload: {
      shop: shopDomain,
      utm: { source: "chatgpt", medium: "referral", campaign: "share" },
      referrerDomain: "chatgpt.com",
      landingPath: "/products/example",
      timestamp: new Date().toISOString(),
    },
  });
  if (aiStatus !== 204) {
    throw new Error(`expected 204 for AI event, got ${aiStatus}`);
  }

  // 2. Non-AI event via plain utm.
  const otherStatus = await postEvent({
    appUrl,
    shopDomain,
    payload: {
      shop: shopDomain,
      utm: { source: "newsletter", medium: "email" },
      referrerDomain: null,
      landingPath: "/",
      timestamp: new Date().toISOString(),
    },
  });
  if (otherStatus !== 204) {
    throw new Error(`expected 204 for non-AI event, got ${otherStatus}`);
  }

  // 3. Cross-origin event must be rejected.
  const forbiddenRes = await fetch(`${appUrl}/api/track`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://evil.example.com",
    },
    body: JSON.stringify({ shop: shopDomain, utm: { source: "chatgpt" } }),
  });
  if (forbiddenRes.status !== 403) {
    throw new Error(`expected 403 for cross-origin POST, got ${forbiddenRes.status}`);
  }

  const events = await prisma.trackingEvent.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  const writtenSinceBaseline = events.length - baselineCount;
  if (writtenSinceBaseline < 2) {
    throw new Error(
      `expected at least 2 new tracking events, found ${writtenSinceBaseline}`,
    );
  }

  const ai = events.find(
    (e) => e.classification === "ai" && e.source === "chatgpt",
  );
  if (!ai) {
    throw new Error("no AI-classified event with source=chatgpt found");
  }
  const other = events.find((e) => e.classification === "other");
  if (!other) {
    throw new Error("no 'other'-classified event found");
  }

  console.info(`[smoke:track] AI event id=${ai.id} matchedBy=${ai.matchedBy}`);
  console.info(
    `[smoke:track] other event id=${other.id} utm_source=${other.utmSource}`,
  );
  console.info("[smoke:track] PASS");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[smoke:track] FAIL", err);
  try {
    await prisma.$disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
