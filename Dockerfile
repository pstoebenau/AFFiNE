# syntax=docker/dockerfile:1.7

# =============================================================================
# Stage 1: Base image with Node.js and Yarn
# =============================================================================
FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN corepack enable

# Copy dependency manifests and yarn config for caching
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases/ .yarn/releases/
COPY .yarn/patches/ .yarn/patches/

# =============================================================================
# Stage 2: Install all dependencies
# =============================================================================
FROM base AS deps
WORKDIR /app

# Copy entire source (needed for workspace resolution)
COPY . .

# Disable hardlinks-local (incompatible with Docker's overlayfs)
RUN yarn config set nmMode classic

# Install all dependencies (including dev deps needed for building)
RUN --mount=type=cache,target=/root/.yarn/berry/cache \
    HUSKY=0 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    yarn install

# =============================================================================
# Stage 3: Build Rust native modules (parallel with frontend-build)
# =============================================================================
FROM deps AS native-build
WORKDIR /app

# Install Rust toolchain and build dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential clang pkg-config libssl-dev python3 curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --default-toolchain 1.94.0 --profile minimal

ENV PATH="/root/.cargo/bin:${PATH}"

RUN yarn affine @affine/server-native build

# =============================================================================
# Stage 4: Build frontend apps (parallel with native-build)
# =============================================================================
FROM deps AS frontend-build
WORKDIR /app

# GITHUB_SHA skips the git repo lookup in the rspack HTML plugin
ARG GITHUB_SHA=docker-build
ENV GITHUB_SHA=${GITHUB_SHA}

RUN yarn affine @affine/web build
RUN yarn affine @affine/admin build
RUN yarn affine @affine/mobile build

# =============================================================================
# Stage 5: Build server and prepare production dependencies
# =============================================================================
FROM deps AS server-build
WORKDIR /app

# Copy the native binary from native-build stage (napi outputs server-native.node)
COPY --from=native-build /app/packages/backend/native/server-native.node /app/packages/backend/native/server-native.node

# Create arch-named copies of the real binary + stubs for other architectures
# so rspack can resolve all require() paths in index.js at bundle time
RUN cp packages/backend/native/server-native.node packages/backend/native/server-native.x64.node && \
    cp packages/backend/native/server-native.node packages/backend/native/server-native.arm64.node && \
    cp packages/backend/native/server-native.node packages/backend/native/server-native.armv7.node

# Bundle the server with rspack
RUN yarn workspace @affine/server build

# Install openssl before prisma generate (needed for engine detection)
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl && \
    rm -rf /var/lib/apt/lists/*

# Switch to production dependencies
RUN yarn workspaces focus @affine/server --production && \
    yarn workspace @affine/server prisma generate

# Move node_modules into the server package for the final image
RUN mv /app/node_modules /app/packages/backend/server/node_modules

# =============================================================================
# Stage 6: Assemble and clean artifacts
# =============================================================================
FROM node:22-bookworm-slim AS assets
WORKDIR /app

COPY --from=server-build /app/packages/backend/server /app
COPY --from=frontend-build /app/packages/frontend/apps/web/dist /app/static
COPY --from=frontend-build /app/packages/frontend/admin/dist /app/static/admin
COPY --from=frontend-build /app/packages/frontend/apps/mobile/dist /app/static/mobile

ARG TARGETARCH
ARG TARGETVARIANT

RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN AFFINE_DOCKER_CLEAN=1 TARGETARCH="${TARGETARCH}" TARGETVARIANT="${TARGETVARIANT}" node ./scripts/docker-clean.mjs

# =============================================================================
# Stage 7: Final runtime image
# =============================================================================
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

COPY --from=assets /app /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl libjemalloc2 && \
    rm -rf /var/lib/apt/lists/*

ENV LD_PRELOAD=libjemalloc.so.2

EXPOSE 3010

CMD ["node", "./dist/main.js"]
