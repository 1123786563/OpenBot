FROM openbot-server:persaas-casdoor-20261128
COPY server/src/billing/flexprice-client.ts server/src/billing/flexprice-usage.ts server/src/billing/usage-export.ts /app/server/src/billing/
COPY server/src/db/schema/test-credit.ts /app/server/src/db/schema/test-credit.ts
COPY server/src/telemetry/runtime-log.ts /app/server/src/telemetry/runtime-log.ts
COPY worker/src/index.ts /app/worker/src/index.ts
COPY server/scripts/flexprice-live.ts /app/server/scripts/flexprice-live.ts
COPY server/drizzle/0165_flexprice_usage_deliveries.sql /app/server/drizzle/0165_flexprice_usage_deliveries.sql
COPY server/drizzle/meta/_journal.json /app/server/drizzle/meta/_journal.json
