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

# pi needs bash and git; ripgrep backs its search tool.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

# Bundle pi so users do not install it separately.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# The worker extension is TypeScript: pi loads it with jiti, and it imports
# ../src/bash-paths.js, so the source tree must be present as well.
COPY src ./src
COPY extensions ./extensions

ENV NODE_ENV=production \
    PI_COFFEE_HOST=0.0.0.0 \
    PI_COFFEE_PORT=8787 \
    PI_COFFEE_DATA_DIR=/data \
    PI_COFFEE_WORKSPACE_ROOT=/data/worktrees \
    PI_COFFEE_DEFAULT_REPO=/workspace

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PI_COFFEE_PORT||8787)+'/internal/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
