# Davnoot LLMs Generator — Shopify App

Shopify-embedded admin app that generates an `llms.txt` file for the merchant's
store using Claude, serves it at `https://<store>.myshopify.com/llms.txt`, and
tracks AI-referred visits.

Product spec and phase plan are kept locally in `_ai_context/` (one level
above this folder); they are not part of the published repo.

---

## Stack

- **Shopify CLI** + `@shopify/shopify-app-react-router` (Remix v2 became
  React Router v7 in 2025; the underlying programming model is unchanged).
- **React Router 7** (file-system routing, server loaders/actions).
- **Postgres** via Prisma — sessions, generated files, jobs, tracking events.
- **Redis** + **BullMQ** for background generation jobs (added in Phase 1).
- **Claude API** (`@anthropic-ai/sdk`) for content generation.
- **Polaris** + **App Bridge** for the embedded admin UI.

> The PRD says `npm init @shopify/app@latest -- --template remix`. The Shopify
> CLI now defaults to React Router; we use that template here. The packages
> (`@shopify/shopify-app-react-router`) are the direct successors of the old
> Remix packages and the auth flow is identical.

---

## Folder layout

```
app/                              <-- this Shopify app
  app/                            <-- React Router app source
    routes/                       file-routed pages and API endpoints
    lib/
      shopify/                    Admin GraphQL + HMAC verification helpers
      claude/                     Claude client, prompts, generation pipeline
      tracking/                   AI-source detection + aggregation
    jobs/                         BullMQ queues + workers (added in Phase 1)
    components/                   Reusable Polaris UI pieces
    shopify.server.ts             shopifyApp() instance + auth/session wiring
    db.server.ts                  Singleton PrismaClient
    root.tsx                      Document shell
    entry.server.tsx              SSR entry
  prisma/
    schema.prisma                 Postgres datasource + models
  extensions/                     Shopify CLI extensions (web pixel — Phase 4)
  public/                         Static assets
  shopify.app.toml                Partner-app config (scopes, app proxy, webhooks)
  shopify.web.toml                Local-dev process declaration
  vite.config.ts                  Vite + React Router plugin
  react-router.config.ts          React Router config (SSR on)
  package.json                    Scripts: dev / build / lint / typecheck
.env.example                      Env-var inventory (copy to .env)
.editorconfig                     Editor defaults (UTF-8, LF, 2-space)
```

---

## Prerequisites

- Node.js LTS (≥ 20.x).
- Shopify CLI: `npm install -g @shopify/cli @shopify/app`.
- A Shopify Partner account and a development store.
- A managed Postgres instance and a Redis instance (or local Docker).
- An Anthropic API key.

---

## Local setup

```bash
cd app
npm install
cp .env.example .env             # then fill in real values
npx prisma generate
npx prisma migrate dev --name init_sessions
shopify app dev                  # opens the OAuth flow against your dev store
```

`shopify app dev` will:

1. Tunnel `http://localhost:3000` to a public HTTPS URL.
2. Rewrite `application_url` and `redirect_urls` in `shopify.app.toml` to that
   tunnel URL (because `automatically_update_urls_on_dev = true`).
3. Open the install URL for your dev store.

After install, the embedded admin should load at `/app`.

---

## Scripts

| Command              | What it does                                                |
| -------------------- | ----------------------------------------------------------- |
| `npm run dev`        | `shopify app dev` — tunnel + Vite + watcher                 |
| `npm run build`      | Build the React Router app for production                   |
| `npm start`          | Serve the production build                                  |
| `npm run lint`       | ESLint — fails CI if anything warns or errors               |
| `npm run typecheck`  | `react-router typegen` + `tsc --noEmit`                     |
| `npx prisma migrate dev` | Create/apply a dev migration                            |
| `npx prisma validate` | Validate schema only (no DB connection needed)              |

---

## Environment variables

See [`.env.example`](.env.example). All variables must be set for `shopify app dev`
to start cleanly. `ANTHROPIC_API_KEY` is only required once Phase 1 lands.

---

## Phase status

Phase 0 ships: project scaffold, Postgres session storage, Session model,
lint/format baseline, and embedded admin shell. Subsequent phases extend the
Prisma schema, add the Claude generation pipeline, the App Proxy route, the
editor UI, the web pixel extension, the tracking dashboard, and the GDPR
webhooks.
