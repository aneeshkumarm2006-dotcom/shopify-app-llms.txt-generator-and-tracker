// POST /app/llms/regenerate — enqueue a new Claude generation for the
// authenticated shop. PRD §6.3 / TODO Phase 3.
//
// Returns 202 Accepted on success so the client knows the work is in flight
// rather than complete; the editor page then polls /app/llms/status until
// the job lands.
//
// Rate-limit errors from the queue (RateLimitError — cooldown / monthly cap,
// PRD §14.2) are surfaced as 429 with a structured payload the UI banner
// can render verbatim.

import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  RateLimitError,
  enqueueGeneration,
} from "../jobs/generation.queue";

interface RegenerateResult {
  ok: boolean;
  error?: string;
  reason?: "cooldown" | "monthly_cap" | "no_shop";
  generationJobId?: string;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true, shopDomain: true, status: true },
  });

  if (!shop || shop.status === "uninstalled") {
    return Response.json(
      {
        ok: false,
        reason: "no_shop",
        error: "Shop is not active. Reinstall the app to regenerate.",
      } satisfies RegenerateResult,
      { status: 409 },
    );
  }

  try {
    const { generationJobId } = await enqueueGeneration({
      shopId: shop.id,
      shopDomain: shop.shopDomain,
      trigger: "manual",
    });
    return Response.json(
      { ok: true, generationJobId } satisfies RegenerateResult,
      { status: 202 },
    );
  } catch (err) {
    if (err instanceof RateLimitError) {
      return Response.json(
        {
          ok: false,
          reason: err.reason,
          error: err.message,
        } satisfies RegenerateResult,
        { status: 429 },
      );
    }
    console.error(
      `[app.llms.regenerate] failed to enqueue for ${shop.shopDomain}:`,
      err,
    );
    return Response.json(
      {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : "Could not enqueue a regeneration. Try again in a moment.",
      } satisfies RegenerateResult,
      { status: 500 },
    );
  }
};
