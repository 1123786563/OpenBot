FROM openbot-server:persaas-casdoor-20261128
COPY server/src/billing/flexprice-client.ts server/src/billing/flexprice-usage.ts /app/server/src/billing/
COPY server/src/db/schema/test-credit.ts /app/server/src/db/schema/test-credit.ts
COPY server/src/telemetry/runtime-log.ts /app/server/src/telemetry/runtime-log.ts
COPY worker/src/index.ts /app/worker/src/index.ts
COPY server/scripts/flexprice-live.ts /app/server/scripts/flexprice-live.ts
COPY server/drizzle/0166_flexprice_usage_deliveries.sql server/drizzle/0167_flexprice_alipay_checkout.sql /app/server/drizzle/
COPY server/drizzle/meta/_journal.json /app/server/drizzle/meta/_journal.json
