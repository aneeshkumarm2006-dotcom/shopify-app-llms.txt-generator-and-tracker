// generateLlmsFile — the end-to-end Claude generation step described in
// PRD §6.3:
//
//   2. Fetch       — pull the store content brief via Admin API
//   3. Prompt      — build system + user messages from the prompt templates
//   4. Generate    — call the Claude Messages API
//   5. Validate    — non-empty, has top-level sections, under size cap;
//                    retry once on failure
//   6. Store       — caller (the worker) is responsible for persistence
//
// The worker calls `generateLlmsFile(admin)` and gets back the validated
// body string plus metadata; persistence and version-bumping live in the
// worker so we can keep this function side-effect free and easy to test.

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { getAnthropic, getModel } from "./client";
import { buildContentBrief, type ContentBrief } from "./brief-builder";
import { fetchStoreData } from "../shopify/admin-fetcher";

// Prompt templates are imported as raw strings so Vite inlines them into the
// server bundle at build time. Reading them from disk at runtime fails on
// hosts (e.g. Render) whose build output does not include the .md files.
import llmsSystemPrompt from "./prompts/llms-system.md?raw";
import llmsUserPromptTemplate from "./prompts/llms-user.md?raw";

// Hard size cap on the generated body. 6,000 words is roughly 40 KB; we set
// the byte cap higher so a long-but-valid file is not rejected on length
// alone. PRD §6.3 step 5: validated for size.
const MAX_BYTES = 80_000;
// Minimum: a useful file always has at least a title and a couple of
// sections. Below this we treat the output as invalid and retry.
const MIN_BYTES = 200;

function loadSystemPrompt(): string {
  return llmsSystemPrompt;
}

function loadUserPromptTemplate(): string {
  return llmsUserPromptTemplate;
}

function renderUserPrompt(brief: ContentBrief): string {
  const template = loadUserPromptTemplate();
  return template.replace("{{BRIEF_JSON}}", JSON.stringify(brief, null, 2));
}

export class LlmsGenerationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LlmsGenerationError";
  }
}

interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export function validateLlmsBody(body: string): ValidationResult {
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, reason: "empty body" };
  const bytes = Buffer.byteLength(trimmed, "utf8");
  if (bytes < MIN_BYTES)
    return { ok: false, reason: `body too short (${bytes}B < ${MIN_BYTES}B)` };
  if (bytes > MAX_BYTES)
    return { ok: false, reason: `body too long (${bytes}B > ${MAX_BYTES}B)` };
  if (!/^#\s+\S/m.test(trimmed))
    return { ok: false, reason: "missing top-level '#' heading" };
  // We require at least one '##' section. PRD §6.6 mandates themed sections
  // (Products / Collections / Pages / Contact, etc.). A bare title with no
  // sections is not a valid llms.txt.
  if (!/^##\s+\S/m.test(trimmed))
    return { ok: false, reason: "missing any '##' sub-section" };
  return { ok: true };
}

// Strip any accidental code-fence wrappers the model may have added despite
// the system prompt telling it not to. Cheap and defensive — better than
// rejecting an otherwise-fine response.
function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(
    /^```(?:[a-zA-Z]+)?\s*\n([\s\S]*?)\n```\s*$/,
  );
  return fence ? fence[1].trim() : trimmed;
}

async function callClaude(systemPrompt: string, userPrompt: string) {
  const client = getAnthropic();
  const response = await client.messages.create({
    model: getModel(),
    max_tokens: 8000,
    temperature: 0.4,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  // Concatenate every text block in the response — Claude usually returns
  // one but the SDK shape allows multiple.
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => ("text" in block ? block.text : ""))
    .join("");

  return {
    body: stripFences(text),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

export interface GenerateResult {
  body: string;
  brief: ContentBrief;
  usage: { inputTokens: number; outputTokens: number };
  attempts: number;
}

// One generation attempt: build prompts → call Claude → validate → return.
// Throws LlmsGenerationError if the Claude call or validation fails.
async function attemptGenerate(brief: ContentBrief): Promise<{
  body: string;
  usage: { inputTokens: number; outputTokens: number };
}> {
  const systemPrompt = loadSystemPrompt();
  const userPrompt = renderUserPrompt(brief);

  let claude;
  try {
    claude = await callClaude(systemPrompt, userPrompt);
  } catch (err) {
    throw new LlmsGenerationError(
      `Claude Messages API call failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const validation = validateLlmsBody(claude.body);
  if (!validation.ok) {
    throw new LlmsGenerationError(
      `Generated body failed validation: ${validation.reason}`,
    );
  }

  return claude;
}

// Public entry point used by the worker and the smoke test.
//
// Performs Fetch → Brief → Prompt → Generate → Validate. Retries the Claude
// call exactly once on failure (PRD §6.3 step 5: "on failure it retries
// once, then surfaces an error").
//
// `admin` must be an authenticated Admin API client — either from
// `authenticate.admin(request)` or `unauthenticated.admin(shop)`. The caller
// owns persistence: `result.body` is the validated body, ready to write to
// `LlmsFile.content`.
export async function generateLlmsFile(
  admin: AdminApiContext,
): Promise<GenerateResult> {
  const storeData = await fetchStoreData(admin);
  const brief = buildContentBrief(storeData);

  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { body, usage } = await attemptGenerate(brief);
      return { body, brief, usage, attempts: attempt };
    } catch (err) {
      lastError = err;
      // Only retry once. The loop bound is the second-attempt cap.
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new LlmsGenerationError("Generation failed for unknown reason");
}
