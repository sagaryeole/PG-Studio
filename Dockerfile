# PG Studio container image.
#   docker run --rm -p 127.0.0.1:4321:4321 -e DATABASE_URL=postgres://... ghcr.io/sagaryeole/pg-studio
# Always publish to 127.0.0.1: PG Studio has no login, and inside the
# container it has to listen on all interfaces for the port to be forwarded.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
LABEL org.opencontainers.image.title="PG Studio" \
      org.opencontainers.image.description="A fast, read-only PostgreSQL browser" \
      org.opencontainers.image.source="https://github.com/sagaryeole/PG-Studio" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    PG_STUDIO_CONTAINER=1 \
    PORT=4321
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
COPY package.json LICENSE connections.example.json ./
USER node
EXPOSE 4321
# /api/connections answers without touching the database.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null --header "Host: 127.0.0.1:${PORT}" "http://127.0.0.1:${PORT}/api/connections" || exit 1
ENTRYPOINT ["node", "dist/cli.js"]
