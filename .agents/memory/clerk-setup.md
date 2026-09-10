---
name: Clerk setup
description: Replit-managed Clerk needs the proxy/middleware wiring and browser sessions for protected web APIs.
---

Use Clerk's browser cookie session for web API calls; do not add bearer-token plumbing. The API must mount the Clerk proxy before body parsing, initialize `clerkMiddleware`, and protect CRM routes with `getAuth`.

**Why:** Replit-managed Clerk provisions keys automatically, but the frontend and API still need matching proxy/session wiring for preview and production.

**How to apply:** When extending this app's authenticated routes or adding protected pages, keep the existing Clerk provider, proxy middleware, and server-side auth guard pattern.

Clerk account passwords in this tenant must be at least 15 characters, and custom sign-in must navigate away from `/sign-in` after `setActive`.

**Why:** Clerk rejected shorter staff-password updates, and leaving the route unchanged made successful staff sessions appear to remain logged out.

**How to apply:** Enforce the 15-character rule in both staff forms and API validation; redirect to the CRM root after a complete email/password sign-in.