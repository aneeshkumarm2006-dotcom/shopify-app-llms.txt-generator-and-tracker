// Consumer side of the generation queue. Run as a separate process in
// production (`node ./app/jobs/generation.worker.ts` via tsx or the compiled
// build); on Render this is the "worker" service alongside the "web"
// service. Locally you can run it in a second terminal during development.
//
// Lifecycle per job:
//   1. Resolve the BullMQ job → Prisma GenerationJob row; mark `running`.
//   2. Resolve an authenticated Admin client for the shop via
//      `unauthenticated.admin(shopDomain)` (the offline session was stored
//      during OAuth — PRD §13).
//   3. Call generateLlmsFile(admin) — fetch content, prompt Claude, validate.
//   4. Upsert the LlmsFile row: move current content → previousContent,
//      bump version, write new content, source = generated.
//   5. Mark the GenerationJob done. On any failure, persist the error
//      message and mark the job failed.

import { Worker, type Job } from "bullmq";

import prisma from "../db.server";
import { generateLlmsFile, LlmsGenerationError } from "../lib/claude/generate";
import { captureException } from "../lib/sentry.server";
import shopify from "../shopify.server";

import {
  GENERATION_QUEUE_NAME,
  type GenerationJobData,
} from "./generation.queue";
import { getRedis } from "./redis.server";

async function persistGeneratedFile(
  shopId: string,
  body: string,
): Promise<void> {
  const existing = await prisma.llmsFile.findUnique({ where: { shopId } });
  const now = new Date();

  if (!existing) {
    await prisma.llmsFile.create({
      data: {
        shopId,
        content: body,
        previousContent: null,
        version: 1,
        source: "generated",
      },
    });
  } else {
    await prisma.llmsFile.update({
      where: { shopId },
      data: {
        previousContent: existing.content,
        content: body,
        version: existing.version + 1,
        source: "generated",
        updatedAt: now,
      },
    });
  }

  await prisma.shop.update({
    where: { id: shopId },
    data: { lastGenerationAt: now },
  });
}

export async function processGenerationJob(
  job: Job<GenerationJobData>,
): Promise<void> {
  const { shopDomain, shopId, generationJobId } = job.data;

  await prisma.generationJob.update({
    where: { id: generationJobId },
    data: { status: "running" },
  });

  try {
    const { admin } = await shopify.unauthenticated.admin(shopDomain);

    const result = await generateLlmsFile(admin);
    await persistGeneratedFile(shopId, result.body);

    await prisma.generationJob.update({
      where: { id: generationJobId },
      data: {
        status: "done",
        completedAt: new Date(),
        error: null,
      },
    });

    // Visible in the worker logs so operators can correlate Claude spend
    // with shops without storing token counts per-shop in Postgres.
    console.log(
      `[generation.worker] done shop=${shopDomain} job=${generationJobId} ` +
        `attempts=${result.attempts} inTokens=${result.usage.inputTokens} ` +
        `outTokens=${result.usage.outputTokens}`,
    );
  } catch (err) {
    const message =
      err instanceof LlmsGenerationError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);

    await prisma.generationJob.update({
      where: { id: generationJobId },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: message.slice(0, 2000),
      },
    });

    console.error(
      `[generation.worker] failed shop=${shopDomain} job=${generationJobId}: ${message}`,
    );
    captureException(err, {
      route: "generation.worker",
      tags: { shop: shopDomain, jobId: generationJobId },
    });
    // Re-throw so BullMQ records the failure on the job. We do NOT rely on
    // BullMQ retries here (`attempts: 1` in the queue config) because
    // generate.ts already retries the Claude call once internally — a second
    // worker-level retry would duplicate Admin API fetches and could blow
    // through the cooldown.
    throw err;
  }
}

// Module-level singleton so `import { worker }` from elsewhere reuses the
// same Worker instance. Created lazily so importing this file in a test
// does not eagerly connect to Redis.
let worker: Worker<GenerationJobData> | null = null;

export function startGenerationWorker(): Worker<GenerationJobData> {
  if (worker) return worker;
  worker = new Worker<GenerationJobData>(
    GENERATION_QUEUE_NAME,
    processGenerationJob,
    {
      connection: getRedis(),
      concurrency: 2,
    },
  );

  worker.on("error", (err) => {
    console.error("[generation.worker] worker error", err);
    captureException(err, { route: "generation.worker.error" });
  });

  return worker;
}

// When this file is executed directly (e.g. `node generation.worker.js` in
// production), boot the worker. When it is imported for tests, the caller
// drives the worker via processGenerationJob() or startGenerationWorker().
const isMain =
  typeof process !== "undefined" &&
  process.argv?.[1] &&
  import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`;

if (isMain) {
  startGenerationWorker();
  console.log(
    `[generation.worker] listening on queue "${GENERATION_QUEUE_NAME}"`,
  );
}
