// POST /app/llms/restore — swap LlmsFile.content ↔ previousContent so a
// merchant can roll back to the last version. PRD §6.5 / TODO Phase 3.
//
// We keep the rollback reversible: the version we are replacing becomes the
// new previousContent, so a second "Restore previous" call moves the
// merchant back to where they started. Source flips to manual_edit because a
// merchant-initiated rollback is a manual action, not a fresh generation.

import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

interface RestoreResult {
  ok: boolean;
  error?: string;
  reason?: "no_previous" | "no_file";
  version?: number;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { llmsFile: true },
  });

  if (!shop || !shop.llmsFile) {
    return Response.json(
      {
        ok: false,
        reason: "no_file",
        error: "No llms.txt exists yet.",
      } satisfies RestoreResult,
      { status: 409 },
    );
  }

  const previous = shop.llmsFile.previousContent;
  if (!previous) {
    return Response.json(
      {
        ok: false,
        reason: "no_previous",
        error: "There is no previous version to restore.",
      } satisfies RestoreResult,
      { status: 409 },
    );
  }

  const updated = await prisma.llmsFile.update({
    where: { shopId: shop.id },
    data: {
      content: previous,
      previousContent: shop.llmsFile.content,
      version: shop.llmsFile.version + 1,
      source: "manual_edit",
    },
    select: { version: true },
  });

  return Response.json({ ok: true, version: updated.version } satisfies RestoreResult);
};
