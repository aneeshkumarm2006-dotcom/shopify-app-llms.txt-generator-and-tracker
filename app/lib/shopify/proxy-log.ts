// In-memory hit counters for App Proxy traffic.
//
// We intentionally do not persist these to the database (PRD §12.2 — counts
// only, no PII). For production-grade analytics, swap this for a write into
// `TrackingEvent` once Phase 4 lands the schema. Until then, an in-process
// counter is enough to debug whether the proxy is being hit at all.
//
// No headers, IPs, user agents, or query strings are logged. Just totals.

interface ProxyCounters {
  total: number;
  ok: number;
  unauthorized: number;
  notFound: number;
  error: number;
  lastHitAt: Date | null;
}

const counters: ProxyCounters = {
  total: 0,
  ok: 0,
  unauthorized: 0,
  notFound: 0,
  error: 0,
  lastHitAt: null,
};

export type ProxyHitOutcome = "ok" | "unauthorized" | "not_found" | "error";

export function recordProxyHit(outcome: ProxyHitOutcome): void {
  counters.total += 1;
  counters.lastHitAt = new Date();
  switch (outcome) {
    case "ok":
      counters.ok += 1;
      break;
    case "unauthorized":
      counters.unauthorized += 1;
      break;
    case "not_found":
      counters.notFound += 1;
      break;
    case "error":
      counters.error += 1;
      break;
  }
  // One log line per hit, no PII. `console.log` is captured by Render's
  // log aggregator out of the box.
  console.info(
    `[proxy.llms] hit outcome=${outcome} total=${counters.total} ok=${counters.ok} 401=${counters.unauthorized} 404=${counters.notFound} 5xx=${counters.error}`,
  );
}

export function getProxyCounters(): Readonly<ProxyCounters> {
  return counters;
}
