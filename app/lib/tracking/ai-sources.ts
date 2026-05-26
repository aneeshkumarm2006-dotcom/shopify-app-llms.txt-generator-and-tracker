// AI source / referrer detection lists. PRD §7.3.
//
// Single server-side source of truth. The pixel extension keeps a copy
// inlined for the cheap first-pass check (sandbox can't import server code),
// but every event the server receives is re-classified against THIS list
// before it lands in `tracking_events`. Updating this file ships a fresh
// classification rule without redeploying the pixel.
//
// PRD §17.2 Q4: this list needs a weekly review owner — new assistants
// emerge often. Keep entries in lower case; matching is case-insensitive.

/** A canonical AI-tool identifier we surface in dashboards. */
export type AiSourceKey =
  | "chatgpt"
  | "openai"
  | "perplexity"
  | "gemini"
  | "claude"
  | "copilot"
  | "you.com"
  | "phind"
  | "anthropic";

export interface AiSourceMatch {
  classification: "ai";
  source: AiSourceKey;
  matchedBy: "utm" | "referrer";
}

export interface OtherMatch {
  classification: "other";
  // Echo back the raw utm_source for dashboards even when it isn't AI —
  // PRD §7.4 wants a full UTM table, not just the AI cut.
  source: string | null;
  matchedBy: "utm" | null;
}

export type ClassificationResult = AiSourceMatch | OtherMatch;

// utm_source substrings (lower case). Substring rather than exact match so
// utm_source=`chatgpt-share` and `chatgpt_referral` both classify.
export const AI_UTM_SOURCES: Array<{ needle: string; source: AiSourceKey }> = [
  { needle: "chatgpt", source: "chatgpt" },
  { needle: "openai", source: "openai" },
  { needle: "perplexity", source: "perplexity" },
  { needle: "gemini", source: "gemini" },
  { needle: "bard", source: "gemini" },
  { needle: "claude", source: "claude" },
  { needle: "anthropic", source: "anthropic" },
  { needle: "copilot", source: "copilot" },
  { needle: "bing-chat", source: "copilot" },
  { needle: "bingchat", source: "copilot" },
  { needle: "you.com", source: "you.com" },
  { needle: "phind", source: "phind" },
];

// Referrer host matches. Exact host or any subdomain (`endsWith("." + host)`).
export const AI_REFERRER_HOSTS: Array<{ host: string; source: AiSourceKey }> = [
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
];

/**
 * Re-classify on the server. The pixel sends its own first-pass guess in
 * `matchedBy` / `source`, but we never trust that wire field — we rebuild
 * the verdict from the raw inputs. This way the server-side list stays
 * authoritative, and dashboards stay coherent if the pixel runs an older
 * detection list.
 */
export function classifyVisit(args: {
  utmSource: string | null | undefined;
  referrerDomain: string | null | undefined;
}): ClassificationResult {
  const utm = (args.utmSource ?? "").trim().toLowerCase();
  if (utm) {
    const hit = AI_UTM_SOURCES.find((entry) => utm.includes(entry.needle));
    if (hit) {
      return {
        classification: "ai",
        source: hit.source,
        matchedBy: "utm",
      };
    }
  }

  const host = (args.referrerDomain ?? "").trim().toLowerCase();
  if (host) {
    const hit = AI_REFERRER_HOSTS.find(
      (entry) => host === entry.host || host.endsWith(`.${entry.host}`),
    );
    if (hit) {
      return {
        classification: "ai",
        source: hit.source,
        matchedBy: "referrer",
      };
    }
  }

  return {
    classification: "other",
    source: utm || null,
    matchedBy: utm ? "utm" : null,
  };
}
