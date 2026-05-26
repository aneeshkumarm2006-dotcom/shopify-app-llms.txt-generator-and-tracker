// Producer side of the generation queue. Routes (afterAuth, the Regenerate
// action) call `enqueueGeneration` to schedule a background generation.
//
// Rate-limit checks happen here, before the BullMQ job exists, so an
// over-budget call never leaks an in-flight worker.

import { Queue, type JobsOptions } from "bullmq";

import prisma from "../db.server";
import { getRedis } from "./redis.server";

export const GENERATION_QUEUE_NAME = "llms-generation";

// PRD §14.2 — controls on Claude spend.
//   1. Per-shop cooldown: at most one regeneration every N minutes.
//   2. Soft monthly cap: at most N successful generations per shop per
//      calendar month.
// Both are checked before enqueue; both are tunable here without redeploying
// app code.
const COOLDOWN_MS = 5 * 60_000; // 5 minutes
const MONTHLY_CAP = 30;

// Special trigger label for the initial install-time generation — it is
// exempt from the cooldown (the shop has no previous job yet anyway) but
// still counts against the monthly cap.
export type GenerationTrigger = "install" | "manual" | "scheduled";

export interface GenerationJobData {
  shopDomain: string;
  shopId: string;
  trigger: GenerationTrigger;
  generationJobId: string; // points to our Prisma row
}

let queue: Queue<GenerationJobData> | null = null;

export function getGenerationQueue(): Queue<GenerationJobData> {
  if (queue) return queue;
  queue = new Queue<GenerationJobData>(GENERATION_QUEUE_NAME, {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: 1, // generate.ts already retries Claude once on its own
      removeOnComplete: { age: 60 * 60 * 24, count: 1000 },
      removeOnFail: { age: 60 * 60 * 24 * 7, count: 1000 },
    },
  });
  return queue;
}

export class RateLimitError extends Error {
  constructor(
    public readonly reason: "cooldown" | "monthly_cap",
    message: string,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

function startOfCurrentMonth(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

// Check the per-shop cooldown + monthly cap. Throws RateLimitError if either
// is hit. PRD §14.2 + TODO Phase 1 step "Add a per-shop cooldown ... and a
// soft monthly cap".
export async function assertWithinRateLimits(
  shopId: string,
  trigger: GenerationTrigger,
): Promise<void> {
  // Cooldown only applies to manual regenerations. Install-time and any
  // future scheduled regen flow are exempt.
  if (trigger === "manual") {
    const lastJob = await prisma.generationJob.findFirst({
      where: { shopId, status: { in: ["queued", "running", "done"] } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (lastJob) {
      const elapsed = Date.now() - lastJob.createdAt.getTime();
      if (elapsed < COOLDOWN_MS) {
        const waitMs = COOLDOWN_MS - elapsed;
        throw new RateLimitError(
          "cooldown",
          `Please wait ${Math.ceil(waitMs / 60_000)} more minute(s) before regenerating.`,
        );
      }
    }
  }

  // Monthly cap counts every successful generation in the current month
  // plus anything currently queued/running — pending jobs that will land in
  // the month also count against the budget.
  const monthlyCount = await prisma.generationJob.count({
    where: {
      shopId,
      status: { in: ["queued", "running", "done"] },
      createdAt: { gte: startOfCurrentMonth() },
    },
  });
  if (monthlyCount >= MONTHLY_CAP) {
    throw new RateLimitError(
      "monthly_cap",
      `Monthly regeneration limit reached (${MONTHLY_CAP}). The cap resets at the start of next month.`,
    );
  }
}

export interface EnqueueGenerationArgs {
  shopId: string;
  shopDomain: string;
  trigger: GenerationTrigger;
  // For install-time enqueues we already know the trigger is safe, but the
  // call still goes through assertWithinRateLimits so the monthly cap is
  // honoured.
  jobOptions?: JobsOptions;
}

export interface EnqueueGenerationResult {
  generationJobId: string;
  queueJobId: string;
}

// Create the Prisma GenerationJob row + add the BullMQ job. Returns the
// Prisma id so callers (the editor UI) can poll status.
export async function enqueueGeneration(
  args: EnqueueGenerationArgs,
): Promise<EnqueueGenerationResult> {
  await assertWithinRateLimits(args.shopId, args.trigger);

  const generationJob = await prisma.generationJob.create({
    data: {
      shopId: args.shopId,
      status: "queued",
    },
    select: { id: true },
  });

  const queue = getGenerationQueue();
  const bullJob = await queue.add(
    "generate",
    {
      shopDomain: args.shopDomain,
      shopId: args.shopId,
      trigger: args.trigger,
      generationJobId: generationJob.id,
    },
    args.jobOptions,
  );

  await prisma.generationJob.update({
    where: { id: generationJob.id },
    data: { queueJobId: bullJob.id ?? null },
  });

  return {
    generationJobId: generationJob.id,
    queueJobId: bullJob.id ?? "",
  };
}
