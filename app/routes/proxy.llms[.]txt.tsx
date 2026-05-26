// Fallback variant for crawlers that include the `.txt` suffix in the
// proxied path (e.g. /apps/llms.txt) instead of the canonical /apps/llms.
// Delegates entirely to the loader in proxy.llms.tsx so the verification +
// serving logic lives in exactly one place. PRD §6.4 redirect-fallback note.

export { loader } from "./proxy.llms";
