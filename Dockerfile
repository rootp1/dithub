FROM oven/bun:1-debian AS base
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates coreutils \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /data/repos /data/worker && chown -R bun:bun /data
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/remote-helper/package.json packages/remote-helper/package.json
COPY packages/indexer/package.json packages/indexer/package.json
COPY packages/web/package.json packages/web/package.json
RUN bun install --frozen-lockfile --production
COPY apps apps
COPY packages/sdk packages/sdk
COPY packages/db packages/db
COPY deployments deployments
ARG GIT_COMMIT=dev
RUN GIT_COMMIT=$GIT_COMMIT bun apps/web/build.ts
ENV NODE_ENV=production REPOS_DIR=/data/repos WORKER_DIR=/data/worker
USER bun
EXPOSE 3000
CMD ["bun", "apps/api/src/index.ts"]
