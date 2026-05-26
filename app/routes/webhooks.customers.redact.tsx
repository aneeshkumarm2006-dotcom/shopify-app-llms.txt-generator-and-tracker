// customers/redact GDPR webhook. PRD §15.2 / TODO Phase 6.
//
// Shopify sends this 10 days after a customer requests deletion. The app
// must wipe any personal data it holds about that specific customer. We
// store no per-customer data (PRD §15.2 — the tracking pipeline records
// only an event row keyed on the shop, with no IP / UA / customer id),
// so the response is a 200 acknowledgement.

import type { ActionFunctionArgs } from "react-router";

import { readVerifiedWebhook } from "../lib/shopify/verify-webhook";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const verified = await readVerifiedWebhook(request);
    console.info(
      `[webhook:customers/redact] acknowledged for ${verified.shopDomain ?? "(no shop header)"} — no personal data to redact.`,
    );
    return new Response(null, { status: 200 });
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("[webhook:customers/redact] handler error:", err);
    return new Response("Internal Server Error", { status: 500 });
  }
};
