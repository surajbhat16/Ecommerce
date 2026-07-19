# =============================================================================
# Storefront — Multi-stage Dockerfile (build the SPA, serve it with nginx).
#
# Stage 1 builds the static Vite bundle with Node. Stage 2 is a tiny nginx
# image serving ONLY those static files — no Node runtime in the final image,
# so the attack surface is just nginx + static assets. Same multi-stage
# discipline as every backend service: build tools never reach runtime.
# =============================================================================

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS runtime
# SPA routing: unknown paths fall back to index.html (client-side routing).
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
# nginx runs as non-root by default in recent images for the worker processes;
# the alpine image already drops privileges for request handling.
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -q --spider http://localhost:8080/ || exit 1
