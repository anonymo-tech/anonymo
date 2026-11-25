FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY scripts/migrate.ts ./scripts/migrate.ts
COPY src/db ./src/db
COPY src/webhooks/schema.ts ./src/webhooks/schema.ts
COPY src/anonymo/refusal/schema.ts ./src/anonymo/refusal/schema.ts
COPY src/facilitator/schema.ts ./src/facilitator/schema.ts
COPY src/anonymo/abuse/schema.ts ./src/anonymo/abuse/schema.ts
COPY src/anonymo/media/schema.ts ./src/anonymo/media/schema.ts
COPY src/anonymo/codes/schema.ts ./src/anonymo/codes/schema.ts
COPY src/anonymo/region/schema.ts ./src/anonymo/region/schema.ts
COPY src/anonymo/ventures/store/schema.ts ./src/anonymo/ventures/store/schema.ts
COPY src/anonymo/keysafe/schema.ts ./src/anonymo/keysafe/schema.ts
COPY src/anonymo/freetier/schema.ts ./src/anonymo/freetier/schema.ts
COPY src/anonymo/memory-sync/schema.ts ./src/anonymo/memory-sync/schema.ts
COPY src/lib/util.ts ./src/lib/util.ts
COPY src/chain/rpc-redaction.ts ./src/chain/rpc-redaction.ts
COPY src/providers/headers.ts ./src/providers/headers.ts
COPY drizzle ./drizzle

USER bun
CMD ["bun", "scripts/migrate.ts"]
