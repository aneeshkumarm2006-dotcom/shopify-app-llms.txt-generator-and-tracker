// Lazy server-only Anthropic client. PRD §8.3 — the Claude API key is never
// exposed to the browser, the pixel, or the merchant. This module must never
// be imported from a client component or a route that ships to the browser.
//
// Lazy because:
//   1. `vite build` evaluates module top-level on the server only, but we
//      want a clear, early error if ANTHROPIC_API_KEY is missing at runtime
//      rather than at import time — that way the rest of the app still boots
//      and the editor can render an "API key not configured" banner.
//   2. Tests can stub `getAnthropic()` without monkey-patching a singleton.

import Anthropic from "@anthropic-ai/sdk";

let cached: Anthropic | null = null;

export class AnthropicNotConfiguredError extends Error {
  constructor() {
    super(
      "ANTHROPIC_API_KEY is not set. Configure it in .env (local) or your " +
        "host's environment variables (production). See PRD §13 and §14.",
    );
    this.name = "AnthropicNotConfiguredError";
  }
}

export function getAnthropic(): Anthropic {
  if (cached) return cached;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new AnthropicNotConfiguredError();
  cached = new Anthropic({ apiKey });
  return cached;
}

// Default model — overridable via ANTHROPIC_MODEL so we can A/B against
// Haiku/Sonnet without redeploying. Matches the value documented in
// .env.example (claude-sonnet-4-6). PRD §17.2 open question Q2.
export function getModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-6";
}

// Exported for tests to reset the cached client between cases.
export function __resetAnthropicClient() {
  cached = null;
}
