// Boots the generation worker inside the web server process.
//
// The PRD's intended architecture is a separate Render "worker" service, but
// for a single-instance deployment it is simpler (and one less moving part)
// to consume the queue in the same process that serves the app. This module
// is imported once from entry.server.tsx, so the Worker starts on server boot.
//
// Idempotent: only the first call starts the Worker. Requires REDIS_URL — with
// no Redis there is no queue to consume, so we skip silently (Regenerate will
// surface the missing-queue error to the merchant on demand).

import { startGenerationWorker } from "./generation.worker";

let booted = false;

export function bootGenerationWorker(): void {
  if (booted) return;
  if (!process.env.REDIS_URL) return;
  booted = true;
  try {
    startGenerationWorker();
    console.log("[boot] in-process generation worker started");
  } catch (err) {
    booted = false;
    console.error("[boot] failed to start in-process generation worker", err);
  }
}
