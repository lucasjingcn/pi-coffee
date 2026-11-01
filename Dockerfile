# --- build stage: compile the daemon ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.ext.json ./
COPY src ./src
COPY extensions ./extensions
RUN npm run build

# --- runtime stage ---
FROM node:22-bookworm-slim AS runtime

# pi needs bash and git; ripgrep backs its search tool. procps provides `ps`,
# which the daemon uses to prove worker process ownership after a restart.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git procps ripgrep \
  && rm -rf /var/lib/apt/lists/*

# Bundle pi so users do not install it separately. Pin the version CI verifies
# instead of floating to whatever the registry calls latest.
ARG PI_VERSION=1.4.0
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION}

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# The worker extension is TypeScript: pi loads it with jiti, and it imports
# ../src/bash-paths.js, so the source tree must be present as well.
COPY src ./src
COPY extensions ./extensions
# The runtime orchestration policy is loaded from the authoritative skill.
COPY codex ./codex
COPY scripts/container-health.mjs ./scripts/container-health.mjs

ENV NODE_ENV=production \
    PI_COFFEE_HOST=0.0.0.0 \
    PI_COFFEE_PORT=8787 \
    PI_COFFEE_DATA_DIR=/data \
    PI_COFFEE_WORKSPACE_ROOT=/data/worktrees \
    PI_COFFEE_DEFAULT_REPO=/workspace

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node scripts/container-health.mjs

CMD ["node", "dist/index.js"]
