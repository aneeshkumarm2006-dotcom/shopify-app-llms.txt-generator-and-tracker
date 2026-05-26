// Phase 1 smoke test — run the full generation pipeline (Admin API fetch →
// brief → Claude → validate → persist) against the dev store and assert an
// LlmsFile row exists with non-empty content.
//
// Run with:
//   cd app
//   DATABASE_URL=... ANTHROPIC_API_KEY=... SHOPIFY_API_KEY=... \
//   SHOPIFY_API_SECRET=... SHOPIFY_APP_URL=... SCOPES=... \
//   SMOKE_SHOP_DOMAIN=<your-dev-store>.myshopify.com \
//   npx tsx scripts/smoke-generate.ts
//
// The shop must already have completed OAuth (so an offline session is in
// Postgres). Otherwise `unauthenticated.admin(shop)` throws.

import process from "node:process";

import prisma from "../app/db.server";
import { generateLlmsFile } from "../app/lib/claude/generate";
import shopify from "../app/shopify.server";

async function main() {
  const shopDomain = process.env.SMOKE_SHOP_DOMAIN;
  if (!shopDomain) {
    console.error(
      "SMOKE_SHOP_DOMAIN is required (e.g. my-dev-store.myshopify.com)",
    );
    process.exit(2);
  }

  console.log(`[smoke] shop=${shopDomain}`);

  // 1. Resolve/insert Shop row so we can persist LlmsFile against it.
  const shop = await prisma.shop.upsert({
    where: { shopDomain },
    create: { shopDomain, status: "active" },
    update: {},
  });
  console.log(`[smoke] shop.id=${shop.id}`);

  // 2. Get an Admin client. Requires a stored offline session.
  let admin;
  try {
    ({ admin } = await shopify.unauthenticated.admin(shopDomain));
  } catch (err) {
    console.error(
      `[smoke] could not obtain admin client — has ${shopDomain} completed OAuth?\n`,
      err,
    );
    process.exit(3);
  }

  // 3. Run the full generation flow.
  console.log("[smoke] running generateLlmsFile…");
  const t0 = Date.now();
  const result = await generateLlmsFile(admin);
  const ms = Date.now() - t0;
  console.log(
    `[smoke] generated in ${ms}ms — ${result.body.length} chars, ` +
      `attempts=${result.attempts}, in=${result.usage.inputTokens}t, ` +
      `out=${result.usage.outputTokens}t`,
  );

  // 4. Persist the same way the worker does so the post-condition holds.
  const existing = await prisma.llmsFile.findUnique({
    where: { shopId: shop.id },
  });

  if (!existing) {
    await prisma.llmsFile.create({
      data: {
        shopId: shop.id,
        content: result.body,
        version: 1,
        source: "generated",
      },
    });
  } else {
    await prisma.llmsFile.update({
      where: { shopId: shop.id },
      data: {
        previousContent: existing.content,
        content: result.body,
        version: existing.version + 1,
        source: "generated",
      },
    });
  }

  // 5. Assert: an LlmsFile row exists with non-empty content.
  const persisted = await prisma.llmsFile.findUnique({
    where: { shopId: shop.id },
  });
  if (!persisted) throw new Error("smoke failure: LlmsFile not persisted");
  if (!persisted.content || persisted.content.trim().length === 0) {
    throw new Error("smoke failure: LlmsFile.content is empty");
  }
  console.log(
    `[smoke] persisted LlmsFile.id=${persisted.id} version=${persisted.version}`,
  );

  console.log("\n----- generated body (first 800 chars) -----\n");
  console.log(persisted.content.slice(0, 800));
  console.log("\n----- end preview -----\n");

  console.log("[smoke] PASS");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[smoke] FAIL", err);
  try {
    await prisma.$disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
