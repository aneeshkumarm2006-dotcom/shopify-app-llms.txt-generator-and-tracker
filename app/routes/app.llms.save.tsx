// POST /app/llms/save — persist a merchant's manual edit to LlmsFile.
//
// PRD §11.2 / TODO Phase 3 step "Implement app/routes/app.llms.save.tsx".
//
// Flow:
//   1. Auth as embedded admin → resolve the shop.
//   2. Validate the submitted body (non-empty, under the same byte cap
//      generate.ts uses so the proxy stays consistent).
//   3. Atomically move LlmsFile.content → previousContent, write the new
//      content, bump version, set source = manual_edit.

import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

// Mirrors MAX_BYTES in app/lib/claude/generate.ts so the proxy never has to
// serve an oversized body. If you change one, change both.
const MAX_BODY_BYTES = 80_000;
const MIN_BODY_BYTES = 1;

interface SaveResult {
  ok: boolean;
  error?: string;
  reason?: "validation" | "no_file";
  version?: number;
}

function badRequest(body: SaveResult): Response {
  return Response.json(body, { status: 400 });
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { session } = await authenticate.admin(request);

  const formData = await request.formData();
  const raw = formData.get("content");
  if (typeof raw !== "string") {
    return badRequest({
      ok: false,
      reason: "validation",
      error: "Missing file contents.",
    });
  }

  const bytes = new TextEncoder().encode(raw).length;
  if (bytes < MIN_BODY_BYTES) {
    return badRequest({
      ok: false,
      reason: "validation",
      error: "File cannot be empty.",
    });
  }
  if (bytes > MAX_BODY_BYTES) {
    return badRequest({
      ok: false,
      reason: "validation",
      error: `File exceeds the ${MAX_BODY_BYTES.toLocaleString()}-byte limit (got ${bytes.toLocaleString()}).`,
    });
  }

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { llmsFile: true },
  });

  if (!shop || !shop.llmsFile) {
    // A merchant should not be able to land on the editor without a file in
    // place (the install flow enqueues one), but guard the action anyway.
    return Response.json(
      {
        ok: false,
        reason: "no_file",
        error: "No llms.txt exists yet. Generate one first.",
      } satisfies SaveResult,
      { status: 409 },
    );
  }

  const updated = await prisma.llmsFile.update({
    where: { shopId: shop.id },
    data: {
      previousContent: shop.llmsFile.content,
      content: raw,
      version: shop.llmsFile.version + 1,
      source: "manual_edit",
    },
    select: { version: true },
  });

  return Response.json({ ok: true, version: updated.version } satisfies SaveResult);
};
