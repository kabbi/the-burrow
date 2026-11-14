# syntax=docker/dockerfile:1
# Burrow: one image, API + built web app. Node runs the TypeScript directly (type stripping).

FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @burrow/web build

FROM node:24-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
RUN pnpm install --frozen-lockfile --prod --filter "@burrow/server..." && pnpm store prune
COPY packages/core/src packages/core/src
COPY apps/server/src apps/server/src
COPY --from=build /app/apps/web/dist apps/web/dist

ARG BURROW_VERSION=dev
ENV NODE_ENV=production \
    PORT=4100 \
    BURROW_DB=/data/burrow.sqlite \
    BURROW_MEDIA=/data/media \
    BURROW_MODELS=/data/models \
    BURROW_VERSION=$BURROW_VERSION
VOLUME /data
USER node
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/server/src/main.ts"]
