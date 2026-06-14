import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";

import prisma from "./db.server";
import { enqueueGeneration } from "./jobs/generation.queue";

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
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    removeRest: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
  hooks: {
    afterAuth: async ({ session }) => {
      await shopify.registerWebhooks({ session });

      // Create (or reactivate, on reinstall) the Shop row. Without this no
      // Shop record exists, so every shop-scoped route — Regenerate, the
      // proxy, tracking — treats the install as "not active". The uninstall
      // webhook flips status back to "uninstalled"; reinstalling flips it
      // here to "active" again.
      const shop = await prisma.shop.upsert({
        where: { shopDomain: session.shop },
        create: { shopDomain: session.shop, status: "active" },
        update: { status: "active" },
        select: { id: true, shopDomain: true },
      });

      // Kick off the initial llms.txt generation so the editor isn't empty
      // on first load. Non-fatal: if the queue (Redis) is unreachable the
      // install still succeeds and the merchant can click Regenerate later.
      try {
        await enqueueGeneration({
          shopId: shop.id,
          shopDomain: shop.shopDomain,
          trigger: "install",
        });
      } catch (err) {
        console.error(
          `[afterAuth] initial generation enqueue failed for ${shop.shopDomain}:`,
          err,
        );
      }

      // Phase 2 will create the /llms.txt URL redirect here.
      // Phase 4 will register the web pixel here.
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
