# Club Exotica CRM

Internal customer, membership, payment, and holiday redemption management for Club Exotica staff.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Auth: Replit-managed Clerk with cookie-based browser sessions
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/club-exotica-crm` — responsive staff web app
- `artifacts/api-server` — protected CRM API routes and Clerk proxy
- `lib/db/src/schema/index.ts` — CRM relational schema
- `lib/api-spec/openapi.yaml` — source-of-truth API contract

## Architecture decisions

- Customer, membership, payment, redemption, and audit records are relational PostgreSQL data; the browser is never the source of truth.
- Payment and night usage are append-oriented ledgers; historical records are retained and current balances are derived.
- Normal package nights and offer nights are stored and calculated separately.
- Clerk owns browser sessions; the API rejects CRM requests without a Clerk session.

## Product

Dashboard, customer search and pagination, customer creation/editing, membership balance visibility, immutable payment entry, hotel/flight redemption entry, audit activity, reports, and responsive staff navigation.

## User preferences

No additional preferences recorded.

## Gotchas

- CRM API routes require a signed-in Clerk browser session.
- `pnpm --filter @workspace/club-exotica-crm run build` needs workflow-provided `PORT` and `BASE_PATH`; use the managed web workflow or the package typecheck locally.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
