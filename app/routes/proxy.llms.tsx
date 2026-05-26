// App Proxy endpoint: serves the current llms.txt body for the requesting
// shop. PRD §6.4, §12.2.
//
// Storefront request flow:
//   1. Crawler hits https://<shop>.myshopify.com/llms.txt
//   2. The URL redirect we create on install (Phase 2, urlRedirectCreate)
//      302s that request to /apps/llms on the same domain.
//   3. Shopify proxies /apps/llms to https://<app-url>/proxy/llms with a
//      signed query string. THIS route handles step 3.
//
// Every request must be HMAC-verified before we touch the database — an
// unauthenticated request could otherwise probe arbitrary `shop` values.

import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { verifyAppProxyRequest } from "../lib/shopify/verify-proxy";
import { recordProxyHit } from "../lib/shopify/proxy-log";
import { captureException } from "../lib/sentry.server";

// Five-minute edge cache — long enough to absorb crawl bursts, short enough
// that a manual regenerate is reflected publicly within minutes (TODO Phase 3
// definition of done: within 5s. The 5s target is end-to-end including
// crawler recheck; the cache header is the upper bound on a single CDN edge).
const CACHE_CONTROL = "public, max-age=300";

function plainTextResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": CACHE_CONTROL,
      ...(init.headers ?? {}),
    },
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const verification = verifyAppProxyRequest(request.url);
  if (!verification.valid) {
    recordProxyHit("unauthorized");
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const shopDomain = url.searchParams.get("shop");
  if (!shopDomain) {
    recordProxyHit("unauthorized");
    return new Response("Missing shop parameter", { status: 400 });
  }

  try {
    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { llmsFile: true },
    });

    if (!shop || !shop.llmsFile) {
      recordProxyHit("not_found");
      // Plain-text 404 so a crawler sees a clear "no file yet" rather than
      // a confusing HTML error page.
      return plainTextResponse(
        "# llms.txt has not been generated for this store yet.\n",
        { status: 404 },
      );
    }

    if (shop.status === "uninstalled") {
      recordProxyHit("not_found");
      return plainTextResponse("# This store is no longer active.\n", {
        status: 404,
      });
    }

    recordProxyHit("ok");
    return plainTextResponse(shop.llmsFile.content);
  } catch (err) {
    recordProxyHit("error");
    console.error("[proxy.llms] failed to load llms file:", err);
    captureException(err, {
      route: "/proxy/llms",
      tags: { shop: shopDomain },
    });
    return new Response("Internal Server Error", { status: 500 });
  }
};
