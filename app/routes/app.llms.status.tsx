// GET /app/llms/status — lightweight polling endpoint for the editor UI.
//
// While a GenerationJob is queued or running, the editor calls this every 3s
// (useFetcher.load) so it can flip the "Generating…" banner off and trigger
// a single revalidation once the job reaches a terminal state. We return
// only the fields the polling loop needs — full file content is fetched by
// the page loader's revalidation, not here.

import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export interface StatusResult {
  jobId: string | null;
  status: "queued" | "running" | "done" | "failed" | null;
  error: string | null;
  completedAt: string | null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });

  if (!shop) {
    return {
      jobId: null,
      status: null,
      error: null,
      completedAt: null,
    } satisfies StatusResult;
  }

  const latest = await prisma.generationJob.findFirst({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      error: true,
      completedAt: true,
    },
  });

  if (!latest) {
    return {
      jobId: null,
      status: null,
      error: null,
      completedAt: null,
    } satisfies StatusResult;
  }

  return {
    jobId: latest.id,
    status: latest.status,
    error: latest.error,
    completedAt: latest.completedAt?.toISOString() ?? null,
  } satisfies StatusResult;
};
