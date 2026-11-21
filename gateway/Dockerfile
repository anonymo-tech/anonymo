# The router serves no website (the workspace is dash/, deployed on its own). docs/ holds the OpenAPI document it serves.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts --minimum-release-age 604800

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
WORKDIR /app
ENV ANONYMO_ENV=production HOST=0.0.0.0 PORT=8787
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY drizzle ./drizzle
COPY config ./config
# Anonymo signal exporter (compose.monitoring.yml runs it from this image).
COPY monitoring/anonymo-exporter.ts ./monitoring/anonymo-exporter.ts
COPY docs ./docs
# ffmpeg samples still frames from generated video for the safety gate (src/anonymo/media/video-frames.ts).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
USER bun
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s CMD bun -e "fetch('http://127.0.0.1:8787/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "src/index.ts"]
