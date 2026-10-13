# Portable container image for the Fastify API + browser application (W8, TAS §7).
# Provider-neutral: runs identically on any container host (local Docker, ECS, Cloud Run, etc.).
# The image runs the TypeScript server directly via `tsx`, matching how it already runs in every
# other environment (`npm run server:dev`) -- no separate build/bundle step to keep in sync.

FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 (used by the one-way legacy-SQLite-to-Postgres cutover CLI, server:migrate-legacy)
# has no prebuilt binary for this image's platform/ABI and falls back to compiling from source.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run web:build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system app && useradd --system --gid app --home-dir /app app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server ./server
COPY --from=build /app/src/shared ./src/shared
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/tsconfig.base.json /app/tsconfig.server.json ./
RUN mkdir -p /app/var/documents && chown -R app:app /app
USER app
ENV WEB_ROOT=/app/web/dist
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "--tsconfig", "tsconfig.server.json", "server/src/index.ts"]
