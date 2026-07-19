FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/pilot-realtime-api/package.json ./apps/pilot-realtime-api/package.json

RUN npm ci --workspace=@cloudnexus/pilot-realtime-api

COPY apps/pilot-realtime-api ./apps/pilot-realtime-api

RUN npm run build --workspace=@cloudnexus/pilot-realtime-api


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3010

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/pilot-realtime-api/package.json ./apps/pilot-realtime-api/package.json

RUN npm ci --omit=dev --workspace=@cloudnexus/pilot-realtime-api \
  && npm cache clean --force

COPY --from=builder \
  /app/apps/pilot-realtime-api/dist \
  ./apps/pilot-realtime-api/dist

USER node

EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3010/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"

CMD ["node", "apps/pilot-realtime-api/dist/server.js"]
