# syntax=docker/dockerfile:1.7
FROM node:22-slim AS builder
WORKDIR /app
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile --ignore-scripts
COPY src/ ./src/
COPY prisma/ ./prisma/
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
RUN pnpm prisma generate && pnpm build
RUN pnpm prune --prod --ignore-scripts

FROM node:22-slim AS production
WORKDIR /app
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs nodejs
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules/
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma/
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist/
USER nodejs
EXPOSE 3000
CMD ["node", "dist/main.js"]
