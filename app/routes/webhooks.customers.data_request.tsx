// customers/data_request GDPR webhook. PRD §15.2 / TODO Phase 6.
//
// Shopify sends this when a customer (or merchant on a customer's behalf)
// requests the personal data the app holds about them. We store no per-
// customer data — no IPs, no user-agents, no customer IDs (see the
// TrackingEvent comment in schema.prisma) — so the response is a simple 200
// acknowledgement. The merchant is responsible for forwarding "we hold
// nothing" to the customer; Shopify's contract is just that we respond.

import type { ActionFunctionArgs } from "react-router";

import { readVerifiedWebhook } from "../lib/shopify/verify-webhook";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const verified = await readVerifiedWebhook(request);
    console.info(
      `[webhook:customers/data_request] acknowledged for ${verified.shopDomain ?? "(no shop header)"} — no personal data stored.`,
    );
    return new Response(null, { status: 200 });
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("[webhook:customers/data_request] handler error:", err);
    return new Response("Internal Server Error", { status: 500 });
  }
};
