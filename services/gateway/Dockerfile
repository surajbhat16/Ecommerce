# =============================================================================
# API Gateway — Multi-stage Dockerfile
# Identical structure to the auth service (deps → build → runtime). See the
# auth Dockerfile for the fully-annotated rationale; comments here are terse.
# =============================================================================

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
USER node
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/package.json ./package.json
EXPOSE 8080
# Exec-form CMD so Node receives SIGTERM for graceful shutdown.
CMD ["node", "dist/index.js"]
