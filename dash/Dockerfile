FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@11.19.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
ENV CONCLAVE_DEPLOY_TARGET=node
RUN pnpm build

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV TZ=UTC
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/server ./server
COPY --from=build /app/lib ./lib
COPY --from=build /app/components/dashboard/feature-switches.ts ./components/dashboard/feature-switches.ts
COPY --from=build /app/scripts/runtime ./scripts/runtime
COPY --from=build /app/scripts/start-runtime.mjs /app/scripts/run-released-worker.mjs ./scripts/
USER node
STOPSIGNAL SIGTERM
EXPOSE 3000
CMD ["node", "scripts/start-runtime.mjs"]
