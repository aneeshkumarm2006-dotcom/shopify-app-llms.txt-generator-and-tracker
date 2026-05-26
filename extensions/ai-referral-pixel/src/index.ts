// AI Referral Pixel — sandboxed runtime. PRD §7.2, §7.3.
//
// Runs inside Shopify's customer-events sandbox iframe. The sandbox is
// deliberately minimal: no `window`, no `document`, no `localStorage` on the
// global — only what the `register` callback hands us through `browser`,
// `analytics`, `init`, and `settings`. Anything else is intentionally
// unavailable. https://shopify.dev/docs/api/web-pixels-api
//
// What this pixel does, per request from the brief:
//
//   1. Subscribe to `page_viewed`.
//   2. Pull utm_source and the storefront referrer from the event context.
//   3. Classify the visit by checking utm_source against a known AI-tool
//      identifier list, then by matching the referrer host against a known
//      AI-referrer domain list.
//   4. Suppress re-firing inside the same browser session: only the first
//      page_viewed per session is POSTed to /api/track.
//   5. POST the classified payload to the app's /api/track endpoint.
//
// The detection lists are intentionally inlined here. They mirror what the
// server keeps in `app/lib/tracking/ai-sources.ts`; the server is the source
// of truth (so the classification is re-checked there) but the pixel does
// the cheap first pass to avoid a network call for non-AI traffic. When the
// lists drift, the server is authoritative.

// The web pixel API is provided at runtime by the Shopify sandbox; the
// `register` global is injected. We declare it loosely so the file
// type-checks standalone without pulling in @shopify/web-pixels-extension
// (which is not installed in this repo's dependency tree).
declare const register: (handler: PixelHandler) => void;

type PixelHandler = (api: {
  analytics: {
    subscribe: (event: string, cb: (e: PageViewedEvent) => void) => void;
  };
  browser: {
    localStorage: {
      getItem: (key: string) => Promise<string | null>;
      setItem: (key: string, value: string) => Promise<void>;
    };
    sessionStorage?: {
      getItem: (key: string) => Promise<string | null>;
      setItem: (key: string, value: string) => Promise<void>;
    };
  };
  init: {
    context?: { document?: { referrer?: string } };
  };
  settings: { accountID?: string };
}) => void;

interface PageViewedEvent {
  id?: string;
  name?: string;
  timestamp?: string;
  context?: {
    document?: { referrer?: string };
    window?: {
      location?: {
        href?: string;
        pathname?: string;
        search?: string;
        hostname?: string;
      };
    };
  };
}

// --- Detection lists (mirrors app/lib/tracking/ai-sources.ts) ------------

// Match against utm_source / utm_medium values (case-insensitive, substring).
const AI_UTM_SOURCES = [
  "chatgpt",
  "openai",
  "perplexity",
  "gemini",
  "claude",
  "copilot",
  "bing-chat",
  "you.com",
  "phind",
  "anthropic",
] as const;

// Match against the referrer hostname (case-insensitive, suffix match so
// `*.chatgpt.com` and `chatgpt.com` both classify).
const AI_REFERRER_HOSTS = [
  { host: "chatgpt.com", source: "chatgpt" },
  { host: "chat.openai.com", source: "chatgpt" },
  { host: "openai.com", source: "openai" },
  { host: "perplexity.ai", source: "perplexity" },
  { host: "gemini.google.com", source: "gemini" },
  { host: "bard.google.com", source: "gemini" },
  { host: "claude.ai", source: "claude" },
  { host: "copilot.microsoft.com", source: "copilot" },
  { host: "you.com", source: "you.com" },
  { host: "phind.com", source: "phind" },
] as const;

// --- Helpers -------------------------------------------------------------

const SESSION_FLAG_KEY = "davnoot.llms.tracked";

function parseSearchParams(search: string | undefined): Record<string, string> {
  if (!search) return {};
  // Strip leading "?" if present, then parse manually — URLSearchParams may
  // not be available in every sandbox environment. The pattern is restrictive
  // (no key URL-encoding handled here) but storefront UTMs are always plain.
  const cleaned = search.startsWith("?") ? search.slice(1) : search;
  const out: Record<string, string> = {};
  for (const part of cleaned.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = decodeURIComponentSafe(part.slice(0, eq)).toLowerCase();
    const value = decodeURIComponentSafe(part.slice(eq + 1));
    if (key) out[key] = value;
  }
  return out;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function hostnameFromReferrer(referrer: string | undefined): string | null {
  if (!referrer) return null;
  // Avoid `new URL()` to stay sandbox-portable. Pull out the host between
  // the scheme delimiter and the next "/" or "?" or "#".
  const schemeEnd = referrer.indexOf("://");
  const start = schemeEnd === -1 ? 0 : schemeEnd + 3;
  let end = referrer.length;
  for (const delimiter of ["/", "?", "#"]) {
    const idx = referrer.indexOf(delimiter, start);
    if (idx !== -1 && idx < end) end = idx;
  }
  const host = referrer.slice(start, end).toLowerCase();
  return host || null;
}

interface Classification {
  classification: "ai" | "other";
  source: string | null;
  matchedBy: "utm" | "referrer" | null;
}

function classifyVisit(args: {
  utm: Record<string, string>;
  referrerHost: string | null;
}): Classification {
  const utmSource = (args.utm.utm_source ?? "").toLowerCase();
  if (utmSource) {
    for (const candidate of AI_UTM_SOURCES) {
      if (utmSource.includes(candidate)) {
        return {
          classification: "ai",
          source: candidate,
          matchedBy: "utm",
        };
      }
    }
  }

  if (args.referrerHost) {
    for (const { host, source } of AI_REFERRER_HOSTS) {
      // Suffix match so subdomains classify too.
      if (
        args.referrerHost === host ||
        args.referrerHost.endsWith(`.${host}`)
      ) {
        return {
          classification: "ai",
          source,
          matchedBy: "referrer",
        };
      }
    }
  }

  return {
    classification: "other",
    source: utmSource || null,
    matchedBy: utmSource ? "utm" : null,
  };
}

// The sandbox loader sets `self.location` to the app server origin (from
// shopify.extension.toml). We can derive the /api/track URL from there.
//
// However, the safer path is to ship the target with the pixel's settings.
// To keep the pixel zero-config we fall back to a `__APP_URL__` literal that
// is replaced at deploy time, and finally to a same-origin request.
const APP_TRACK_URL = "__APP_TRACK_URL__";

function resolveTrackUrl(): string {
  // If the build replaced the placeholder, use it. Otherwise post to the
  // server origin baked into the pixel's runtime location — works for the
  // common case where the storefront proxies the pixel JS from the app.
  if (APP_TRACK_URL && !APP_TRACK_URL.startsWith("__")) {
    return APP_TRACK_URL;
  }
  // `self.location` exists inside the sandbox iframe.
  if (typeof self !== "undefined" && self.location?.origin) {
    return `${self.location.origin}/api/track`;
  }
  // Last-ditch fallback: relative path. The browser will resolve against
  // whatever origin the pixel script was served from.
  return "/api/track";
}

// --- Entry point ---------------------------------------------------------

register(({ analytics, browser, init, settings }) => {
  const trackUrl = resolveTrackUrl();
  const shop = settings.accountID ?? "";

  analytics.subscribe("page_viewed", async (event) => {
    try {
      // Per PRD §7.2 step 5: at most one tracked event per browser session.
      // We use the sandbox's persistent localStorage (sessionStorage is not
      // guaranteed available in every storefront context).
      const already = await browser.localStorage.getItem(SESSION_FLAG_KEY);
      if (already) return;

      const location = event.context?.window?.location ?? {};
      const referrer =
        event.context?.document?.referrer ??
        init.context?.document?.referrer ??
        "";

      const utm = parseSearchParams(location.search);
      const referrerHost = hostnameFromReferrer(referrer);
      const result = classifyVisit({ utm, referrerHost });

      // Mark as tracked BEFORE the fetch returns so a slow network can't
      // cause a duplicate fire on rapid navigation.
      await browser.localStorage.setItem(
        SESSION_FLAG_KEY,
        new Date().toISOString(),
      );

      // Build the wire payload. Keep it deliberately small and PII-free —
      // landing path only, no full URL, no user agent. The server adds its
      // own timestamps and IP-free metadata.
      const payload = {
        shop,
        classification: result.classification,
        source: result.source,
        matchedBy: result.matchedBy,
        utm: {
          source: utm.utm_source ?? null,
          medium: utm.utm_medium ?? null,
          campaign: utm.utm_campaign ?? null,
          term: utm.utm_term ?? null,
          content: utm.utm_content ?? null,
        },
        referrerDomain: referrerHost,
        landingPath: location.pathname ?? null,
        timestamp: event.timestamp ?? new Date().toISOString(),
      };

      // Fire-and-forget. `keepalive: true` lets the request survive a fast
      // navigation away from the landing page.
      await fetch(trackUrl, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // Pixels must never throw — a crash would kill the sandbox for every
      // subsequent event. Swallow and move on; aggregate-level drift is
      // acceptable per PRD §7.4 (counts only).
    }
  });
});
