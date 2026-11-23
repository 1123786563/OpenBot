import { z } from "zod";
import { createBifrostLogProxy } from "../src/billing/bifrost-evidence";

Bun.serve({
  hostname: "127.0.0.1",
  port: z.coerce
    .number()
    .int()
    .min(1)
    .max(65_535)
    .parse(process.env.BIFROST_LOG_PROXY_PORT ?? "4207"),
  fetch: createBifrostLogProxy(process.env),
});
