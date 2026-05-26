// shop/redact GDPR webhook. PRD §15.2 / TODO Phase 6.
//
// Shopify sends this 48h after the app is uninstalled. The contract is that
// every piece of shop-scoped data the app holds must be deleted on receipt.
// We respond 200 only after the database delete commits — Shopify will
// retry on non-200 responses, which is fine and idempotent here.
//
// Cascades configured in schema.prisma mean deleting the `Shop` row also
// drops the associated LlmsFile, GenerationJobs, and TrackingEvents.
// Sessions are keyed on the shop domain string (not the internal Shop.id),
// so we wipe them separately in the same transaction.

import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { readVerifiedWebhook } from "../lib/shopify/verify-webhook";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let verified;
  try {
    verified = await readVerifiedWebhook(request);
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("[webhook:shop/redact] verify failed:", err);
    return new Response("Internal Server Error", { status: 500 });
  }

  const shopDomain = verified.shopDomain;
  if (!shopDomain) {
    return new Response("Missing X-Shopify-Shop-Domain", { status: 400 });
  }

  try {
    const result = await prisma.$transaction([
      prisma.session.deleteMany({ where: { shop: shopDomain } }),
      prisma.shop.deleteMany({ where: { shopDomain } }),
    ]);
    const sessionsDeleted = result[0].count;
    const shopsDeleted = result[1].count;
    console.info(
      `[webhook:shop/redact] purged ${shopDomain} — sessions: ${sessionsDeleted}, shops: ${shopsDeleted}`,
    );
    return new Response(null, { status: 200 });
  } catch (err) {
    console.error(`[webhook:shop/redact] purge failed for ${shopDomain}:`, err);
    return new Response("Internal Server Error", { status: 500 });
  }
};
