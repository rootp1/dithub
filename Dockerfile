FROM oven/bun:1.4.4-debian AS base
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates coreutils \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /data/repos /data/worker /data/db && chown -R bun:bun /data
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/dit/package.json packages/dit/package.json
COPY packages/vscode/package.json packages/vscode/package.json
COPY packages/remote-helper/package.json packages/remote-helper/package.json
COPY packages/indexer/package.json packages/indexer/package.json
COPY packages/web/package.json packages/web/package.json
RUN bun install --frozen-lockfile --production
COPY apps apps
COPY packages/sdk packages/sdk
COPY packages/db packages/db
COPY packages/indexer packages/indexer
COPY deployments deployments
COPY scripts/pg-to-sqlite.ts scripts/pg-to-sqlite.ts
ARG GIT_COMMIT=dev
ARG L1_NETWORK=sepolia
RUN GIT_COMMIT=$GIT_COMMIT L1_NETWORK=$L1_NETWORK bun apps/web/build.ts
ENV NODE_ENV=production REPOS_DIR=/data/repos WORKER_DIR=/data/worker DATABASE_PATH=/data/db/dithub.sqlite
USER bun
EXPOSE 3000
CMD ["bun", "apps/api/src/index.ts"]
