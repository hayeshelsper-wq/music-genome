# ---- Next.js web app → Cloud Run ----
# Multi-stage build using Next's standalone output (server.js + trimmed deps).

# 1. install + build
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Browser-side WS base for the crossfader's audio-service proxy — NEXT_PUBLIC_*
# vars are inlined at build time, so it must arrive as a build arg.
ARG NEXT_PUBLIC_AUDIO_WS=""
ENV NEXT_PUBLIC_AUDIO_WS=${NEXT_PUBLIC_AUDIO_WS}
RUN npm run build

# 2. minimal runtime
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Cloud Run sends traffic to $PORT (8080); Next standalone reads it.
ENV PORT=8080
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 8080
CMD ["node", "server.js"]
