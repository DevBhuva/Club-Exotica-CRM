---
name: Clerk setup
description: Replit-managed Clerk needs the proxy/middleware wiring and browser sessions for protected web APIs.
---

Use Clerk's browser cookie session for web API calls; do not add bearer-token plumbing. The API must mount the Clerk proxy before body parsing, initialize `clerkMiddleware`, and protect CRM routes with `getAuth`.

**Why:** Replit-managed Clerk provisions keys automatically, but the frontend and API still need matching proxy/session wiring for preview and production.

**How to apply:** When extending this app's authenticated routes or adding protected pages, keep the existing Clerk provider, proxy middleware, and server-side auth guard pattern.