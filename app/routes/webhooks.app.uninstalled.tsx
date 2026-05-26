// app/uninstalled webhook. PRD §12.5 / TODO Phase 6.
//
// On uninstall we:
//   1. Delete the /llms.txt URL redirect (best effort — the access token is
//      about to be revoked).
//   2. Deregister the AI Referral web pixel (same caveat).
//   3. Mark the Shop row uninstalled so the proxy stops serving and any
//      tracking event that arrives in flight is dropped.
//   4. Schedule a data purge by stamping `purgeScheduledAt`. The Phase 6
//      shop/redact handler is the authoritative purge path; this stamp
//      records that Shopify has notified us the merchant is gone, in case
//      the redact webhook never arrives (Shopify only sends it 48h+ later).

import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { deleteLlmsRedirect } from "../lib/shopify/url-redirect";
import { deleteWebPixel } from "../lib/shopify/web-pixel";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, admin } = await authenticate.webhook(request);

  if (topic !== "APP_UNINSTALLED") {
    return new Response(`Unexpected topic: ${topic}`, { status: 400 });
  }

  const shopRow = await prisma.shop.findUnique({
    where: { shopDomain: shop },
    select: { id: true, redirectId: true, webPixelId: true },
  });

  if (shopRow?.redirectId && admin) {
    try {
      await deleteLlmsRedirect(admin, shopRow.redirectId);
      console.info(`[webhook:app/uninstalled] deleted llms.txt redirect for ${shop}`);
    } catch (err) {
      console.error(
        `[webhook:app/uninstalled] failed to delete llms.txt redirect for ${shop}:`,
        err,
      );
    }
  }

  if (shopRow?.webPixelId && admin) {
    try {
      await deleteWebPixel(admin, shopRow.webPixelId);
      console.info(`[webhook:app/uninstalled] deleted web pixel for ${shop}`);
    } catch (err) {
      console.error(
        `[webhook:app/uninstalled] failed to delete web pixel for ${shop}:`,
        err,
      );
    }
  }

  if (shopRow) {
    await prisma.shop.update({
      where: { id: shopRow.id },
      data: {
        status: "uninstalled",
        redirectId: null,
        webPixelId: null,
      },
    });
  }

  return new Response(null, { status: 200 });
};
