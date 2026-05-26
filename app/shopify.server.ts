import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";

import prisma from "./db.server";
import { buildBillingConfig, isBillingEnabled } from "./lib/billing";

// Billing stays off at MVP. `buildBillingConfig()` returns undefined unless
// BILLING_REQUIRED=true is set in the env, so spreading it is a no-op until
// we flip the switch. PRD §12.6 / §18.1.
const billing = buildBillingConfig();

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  // PRD §13, Phase 0 — sessions persist in Postgres, not the template's SQLite file.
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  ...(billing ? { billing } : {}),
  // FutureFlags in @shopify/shopify-app-react-router 1.2 no longer exposes
  // `unstable_newEmbeddedAuthStrategy` or `removeRest` — both are the default
  // now (token-exchange embedded auth + REST removed), so we drop the block
  // entirely.
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
  hooks: {
    afterAuth: async ({ session, admin }) => {
      // Phase 1 — upsert the Shop row + enqueue the first llms.txt
      // generation if we have not generated one for this shop yet.
      // Phase 2 — create the /llms.txt URL redirect (idempotent).
      // Phase 4 — register the AI Referral web pixel (idempotent).
      shopify.registerWebhooks({ session });

      // Lazy-import side-effect modules so test environments without Redis /
      // an Admin API connection don't crash on `import "./shopify.server"`.
      const { enqueueGeneration, RateLimitError } = await import(
        "./jobs/generation.queue"
      );
      const { ensureLlmsRedirect } = await import(
        "./lib/shopify/url-redirect"
      );
      const { ensureWebPixel } = await import("./lib/shopify/web-pixel");

      const shop = await prisma.shop.upsert({
        where: { shopDomain: session.shop },
        create: {
          shopDomain: session.shop,
          status: "active",
        },
        update: {
          status: "active",
        },
        include: { llmsFile: true },
      });

      // Ensure the /llms.txt → /apps/llms URL redirect exists. Idempotent:
      // re-auth on an existing install will pick up the stored id without
      // creating a duplicate. PRD §6.4, §12.3.
      try {
        const { redirectId, created } = await ensureLlmsRedirect(admin);
        if (shop.redirectId !== redirectId) {
          await prisma.shop.update({
            where: { id: shop.id },
            data: { redirectId },
          });
        }
        console.info(
          `[afterAuth] llms.txt redirect ${created ? "created" : "verified"} for ${shop.shopDomain}`,
        );
      } catch (err) {
        // A redirect failure must not block install — the editor UI can
        // surface a repair button later (Phase 6 settings page).
        console.error(
          `[afterAuth] failed to ensure llms.txt redirect for ${shop.shopDomain}:`,
          err,
        );
      }

      // Ensure the AI Referral Pixel is registered. Idempotent across
      // re-auth and across concurrent installs (Phase 4, PRD §7, §12.4).
      try {
        const { webPixelId, created } = await ensureWebPixel(
          admin,
          shop.shopDomain,
        );
        if (shop.webPixelId !== webPixelId) {
          await prisma.shop.update({
            where: { id: shop.id },
            data: { webPixelId },
          });
        }
        console.info(
          `[afterAuth] web pixel ${created ? "created" : "verified"} for ${shop.shopDomain}`,
        );
      } catch (err) {
        // A pixel failure must not block install — the settings page (Phase 6)
        // exposes a "Reinstall web pixel" repair button so merchants can
        // recover without re-authing.
        console.error(
          `[afterAuth] failed to ensure web pixel for ${shop.shopDomain}:`,
          err,
        );
      }

      if (!shop.llmsFile) {
        try {
          await enqueueGeneration({
            shopId: shop.id,
            shopDomain: shop.shopDomain,
            trigger: "install",
          });
          console.info(
            `[afterAuth] enqueued initial generation for ${shop.shopDomain}`,
          );
        } catch (err) {
          if (err instanceof RateLimitError) {
            console.warn(
              `[afterAuth] initial generation blocked by ${err.reason} for ${shop.shopDomain}`,
            );
          } else {
            console.error(
              `[afterAuth] failed to enqueue initial generation for ${shop.shopDomain}:`,
              err,
            );
          }
        }
      }
    },
  },
});

export default shopify;
export const apiVersion = ApiVersion.January25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
export const billingEnabled = isBillingEnabled;
