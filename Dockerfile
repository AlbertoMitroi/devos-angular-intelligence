# angular-intelligence image: deps, test and runtime stages (PLAN 1, Step 1).
# The base image is pinned by digest (rule 1.5.4); Node.js 24 LTS runs the engine's TypeScript sources directly
# (type stripping, decision A2); the analysed repository's own TypeScript and @angular/compiler are used when installed.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

FROM ${NODE_IMAGE} AS base
ENV DEBIAN_FRONTEND=noninteractive
# git reads the analysed repository (working copy export); pinned to the Debian 12 package version.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git=1:2.39.5-0+deb12u3 ca-certificates=20250419~deb12u2 \
 && rm -rf /var/lib/apt/lists/*

FROM base AS deps
WORKDIR /opt/angular-intelligence
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

# Type check, unit tests and the contract drift check. A failing test fails the build.
FROM deps AS test
COPY . .
RUN npx tsc -p tsconfig.json \
 && node --disable-warning=ExperimentalWarning --test --test-reporter=spec "tests/unit/*.test.ts"

FROM base AS runtime
ENV AI_WORK=/work \
    AI_CACHE=/cache \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    npm_config_update_notifier=false
WORKDIR /opt/angular-intelligence
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY schema ./schema
COPY scripts/fixture-repo.sh ./scripts/fixture-repo.sh
RUN mkdir -p /src /out /cache /config /work \
 && chmod 1777 /out /cache /work
USER node
WORKDIR /work
ENTRYPOINT ["node", "/opt/angular-intelligence/src/cli.ts"]
CMD ["--help"]

# GitHub Docker container actions must run as root to write GITHUB_WORKSPACE (decision A15).
# Same layers as runtime; the engine hands its output back to the workspace owner.
FROM runtime AS action
USER root
