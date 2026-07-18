# =============================================================================
# Auth Service — Multi-stage Dockerfile
#
# THREE stages:
#   1) deps    — install ALL dependencies (incl. dev) needed to build.
#   2) build   — compile TypeScript → JavaScript.
#   3) runtime — a minimal image with ONLY production deps + compiled output.
#
# WHY MULTI-STAGE (the interview answer):
#   - The final image contains NO source TypeScript, NO dev dependencies, NO
#     compiler, NO build cache. Smaller image = faster pulls, smaller attack
#     surface, fewer CVEs.
#   - Build tools (tsc, type packages) never ship to production.
#   - Each stage is cacheable independently → faster rebuilds.
# =============================================================================

# ----------------------------------------------------------------------------- 
# Stage 1: deps — install all dependencies (production + dev).
# We copy ONLY package files first so this layer is cached and only reruns when
# dependencies change, not on every source edit (Docker layer caching).
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# `npm ci` is reproducible (respects the lockfile exactly) — the right choice
# for CI/CD and images, unlike `npm install` which can mutate the lockfile.
# If no lockfile exists yet, fall back to install so the build still works.
RUN npm ci || npm install

# -----------------------------------------------------------------------------
# Stage 2: build — compile TypeScript to JavaScript.
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build           # tsc → ./dist
# Prune dev dependencies so we can copy a lean node_modules into runtime.
RUN npm prune --omit=dev

# -----------------------------------------------------------------------------
# Stage 3: runtime — the only image that actually ships.
#
# We use the slim Debian-based Node image (not Alpine) because native modules
# like argon2 compile against glibc; Alpine's musl libc can cause subtle issues.
# In Phase 6 we discuss distroless as a hardening step.
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# SECURITY: run as a non-root user. The node image ships an unprivileged `node`
# user (uid 1000). Running as root inside a container is a real risk: a process
# escape would land as root on the host namespace. Least privilege always.
USER node

# Copy only what's needed at runtime: pruned node_modules + compiled JS.
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/package.json ./package.json

EXPOSE 3000

# EXEC-FORM CMD (JSON array), NOT shell form. With exec form, Node becomes the
# direct child of the container init and RECEIVES SIGTERM, enabling the graceful
# shutdown handler in index.ts. We also run the container with `--init` (set in
# compose) so tini reaps zombies and forwards signals correctly — solving the
# classic "PID 1" problem.
CMD ["node", "dist/index.js"]
