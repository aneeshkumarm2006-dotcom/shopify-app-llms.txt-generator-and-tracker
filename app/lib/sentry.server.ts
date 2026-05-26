// Minimal Sentry error reporter. PRD §13 / TODO Phase 6.
//
// We don't pull in `@sentry/node` at MVP — it has a large dependency tree
// and runs an unconditional inits-on-import side effect. Instead this file
// posts Sentry's "event" envelope directly via fetch when SENTRY_DSN is set
// and silently no-ops otherwise. Good enough to surface worker crashes and
// 5xx loader failures during pilot, replaceable later with the full SDK
// without touching call sites.
//
// Usage:
//   import { captureException } from "../lib/sentry.server";
//   try { ... } catch (err) { captureException(err, { route: "/app/llms" }); throw err; }
//
// All call sites are fire-and-forget. We never await the report — Sentry is
// best-effort and must not block user-facing requests.

interface ParsedDsn {
  projectId: string;
  publicKey: string;
  host: string;
  protocol: string;
}

function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    const projectId = url.pathname.replace(/^\//, "");
    if (!publicKey || !projectId) return null;
    return {
      publicKey,
      projectId,
      host: url.host,
      protocol: url.protocol.replace(":", ""),
    };
  } catch {
    return null;
  }
}

let cachedDsn: ParsedDsn | null | undefined;
function getDsn(): ParsedDsn | null {
  if (cachedDsn !== undefined) return cachedDsn;
  const raw = process.env.SENTRY_DSN;
  cachedDsn = raw ? parseDsn(raw) : null;
  return cachedDsn;
}

export function isSentryEnabled(): boolean {
  return getDsn() !== null;
}

export interface CaptureContext {
  // Free-form tags surfaced in the Sentry UI. Keep keys short — they appear
  // as filterable facets.
  tags?: Record<string, string | number | boolean | undefined>;
  // Logical area of the app — used as the Sentry transaction name.
  route?: string;
  // Optional fingerprint override for grouping.
  fingerprint?: string[];
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

interface SentryFrame {
  filename?: string;
  lineno?: number;
  function?: string;
}

function parseStackFrames(stack: string): SentryFrame[] {
  return stack
    .split("\n")
    .slice(1)
    .map((line): SentryFrame | null => {
      // Best-effort parse of V8 stack frames; we tolerate failure.
      const m = line.match(/at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
      if (!m) return null;
      return {
        function: m[1] || undefined,
        filename: m[2],
        lineno: Number(m[3]),
      };
    })
    .filter((f): f is SentryFrame => f !== null)
    .reverse();
}

function errorToSentryException(err: unknown): {
  type: string;
  value: string;
  stacktrace?: { frames: SentryFrame[] };
} {
  if (err instanceof Error) {
    const frames = parseStackFrames(err.stack ?? "");
    return {
      type: err.name || "Error",
      value: err.message,
      stacktrace: frames.length ? { frames } : undefined,
    };
  }
  return { type: "UnknownError", value: String(err) };
}

// Fire-and-forget exception report. Resolves to false when Sentry is disabled
// or the network call fails — callers should never await it.
export function captureException(err: unknown, context: CaptureContext = {}): boolean {
  const dsn = getDsn();
  if (!dsn) return false;

  const eventId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/-/g, "");
  const environment = process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "production";

  const event = {
    event_id: eventId,
    timestamp: nowSeconds(),
    platform: "node",
    level: "error",
    environment,
    transaction: context.route,
    fingerprint: context.fingerprint,
    tags: context.tags,
    exception: { values: [errorToSentryException(err)] },
  };

  const envelopeHeader = JSON.stringify({
    event_id: eventId,
    sent_at: new Date().toISOString(),
    dsn: process.env.SENTRY_DSN,
  });
  const itemHeader = JSON.stringify({ type: "event" });
  const body = `${envelopeHeader}\n${itemHeader}\n${JSON.stringify(event)}\n`;

  const url = `${dsn.protocol}://${dsn.host}/api/${dsn.projectId}/envelope/`;
  const auth = [
    "Sentry sentry_version=7",
    "sentry_client=davnoot-llms/0.1",
    `sentry_key=${dsn.publicKey}`,
  ].join(", ");

  // Fire-and-forget. Use globalThis.fetch so non-Node runtimes (Bun, Deno) work.
  void fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-sentry-envelope",
      "X-Sentry-Auth": auth,
    },
    body,
  }).catch(() => {
    // Swallow — Sentry is best-effort and must not break the request.
  });

  return true;
}
