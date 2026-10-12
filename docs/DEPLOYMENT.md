# Deployment (W8)

See DECISIONS.md D47 for the full cloud-provider comparison, recommendation, and what has and has
not been verified. This document is the operational how-to.

## Container image

```
docker build -t bpoam-server .
```

Multi-stage build: stage 1 installs dependencies and runs `npm run web:build`; stage 2 is the
runtime image (non-root user, `WEB_ROOT` pre-set to the built browser app so the API serves it
same-origin). The server runs via `tsx` directly (matching every other environment this project
already runs in — no separate bundle step to keep in sync with source).

**Not verified this session**: an actual `docker build`/`docker run` — the Docker daemon was
unavailable in the environment this was built in. The Dockerfile and `docker-compose.yml` syntax
were validated with `docker compose config`. Build and run the image before relying on it.

## Local/staging stack

```
docker compose up --build
```

Brings up the app, a real PostgreSQL 18, and MinIO (S3-compatible) with a `bpoam-documents` bucket
auto-created. This is a **local/staging topology only** — see the comment at the top of
`docker-compose.yml`. It is not a production deployment: production requires a managed PostgreSQL
and managed (or at least externally operated) object storage, not containers on the same host as
the application.

## Environment configuration (`server/src/config.ts`)

Required in every environment: `DATABASE_URL`, `PUBLIC_ORIGIN`. Required additionally in
production: `STORAGE_DRIVER=s3` plus `STORAGE_S3_BUCKET`/`STORAGE_S3_REGION`/
`STORAGE_S3_ACCESS_KEY_ID`/`STORAGE_S3_SECRET_ACCESS_KEY` (validated at boot — the process refuses
to start with an incomplete S3 configuration rather than falling back to local storage). See
`.env.example` for the full list and local-development defaults.

- **Development**: `.env` file (git-ignored), `STORAGE_DRIVER=local`, HTTP origin.
- **Test**: `TEST_DATABASE_URL` env var overrides the ephemeral-cluster default; a temporary
  `LocalStorage` directory is created and torn down per test run.
- **Staging**: the compose stack above, or a cloud account's staging project — same container
  image as production, `STORAGE_DRIVER=s3` against a staging bucket, a staging database.
- **Production**: `APP_ENV=production` (enforces HTTPS `PUBLIC_ORIGIN` and `STORAGE_DRIVER=s3` at
  boot — the process will not start otherwise), real managed PostgreSQL, real managed/S3-compatible
  bucket, `TRUST_PROXY=true` if behind a load balancer/reverse proxy.

Never seed a development/test account or enable a development authentication shortcut in
production — none exist in this codebase (bootstrap is a one-time interactive CLI step, not an
HTTP endpoint; see `server/src/cli/admin.ts`).

## Release procedure

1. `npm run server:migrate` (or set `MIGRATE_ON_START=true` only for a single-instance deployment
   where a separate migration step isn't practical — multi-instance deployments must use the
   explicit step, to avoid two instances racing to apply the same migration).
2. Deploy the new container image.
3. Confirm `GET /api/health/ready` returns `{"status":"ready", ...}` with the expected
   `schemaVersion` before routing traffic to the new instance.

## HTTPS, cookies, and the proxy

`server/src/config.ts` derives `secureCookies` and the `__Host-` cookie prefix from whether
`PUBLIC_ORIGIN` is `https://`. Behind a TLS-terminating proxy/load balancer, set `TRUST_PROXY=true`
so Fastify trusts `X-Forwarded-*` for client IP (used by rate limiting and audit `ip_address`).
**Not verified this session**: actual behavior behind a real TLS proxy (no such proxy exists in
this environment) — verify cookie `Secure`/`SameSite` behavior and the CSRF `Origin` check with
the real `PUBLIC_ORIGIN` before go-live, per TAS's explicit instruction not to claim this from
local HTTP testing alone.

## Rollback

The container image is immutable per build; rolling back means redeploying the previous image tag.
Database migrations are append-only and forward-only (CLAUDE.md: never edit an applied migration)
— a schema rollback is not supported by the migration tool itself. If a migration must be undone,
restore from the most recent backup taken before it was applied (see `docs/BACKUP_RECOVERY.md`)
rather than attempting to hand-write a reverse migration.
