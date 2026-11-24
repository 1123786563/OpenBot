// Runs the old revision's actual ledger and mounted billing routes. The
// rollback ingress only exposes reads from this process during the drain.
const source = `${process.env.REHEARSAL_LEGACY_DIR}/server/src`;
const { createDatabase } = await import(`${source}/db/client.ts`);
const { createTestCreditLedger } = await import(
  `${source}/billing/test-credit.ts`
);
const { createTestCreditRoutes } = await import(
  `${source}/billing/test-credit-routes.ts`
);
const [url, issuer, subject, phase] = process.argv.slice(2);
const database = createDatabase(url, { max: 1 });
try {
  if (phase === "drained") {
    const { configure, emptyCatalog, pilotCatalogKey, publish, verify } =
      await import(`${source}/admin/bifrost-catalog.ts`);
    const { enterpriseSettings } = await import(`${source}/db/schema/index.ts`);
    const { fixtureTraceReport } = await import(
      `${source}/../tests/support/bifrost-evidence.ts`
    );
    const harnessImage = `agent-langgraph-agui@sha256:${"a".repeat(64)}`;
    const id = "recovery-replacement";
    const draft = configure(emptyCatalog, {
      harnessImage,
      routes: {
        [id]: {
          model: "fixture-model",
          provider: "fixture-provider",
          gatewayRevision: "fixture-gateway",
          meteringRevision: "fixture-metering",
          maxInputTokens: 10,
          maxOutputTokens: 2,
          tools: false,
          price: { inputPerMillion: 10_000_000, outputPerMillion: 0 },
        },
      },
    });
    const catalog = publish(
      verify(
        draft,
        id,
        fixtureTraceReport(harnessImage, draft.routes[id]),
        "fixture",
      ),
      [id],
      id,
      "fixture",
    ).catalog;
    await database
      .insert(enterpriseSettings)
      .values({ key: pilotCatalogKey, value: catalog })
      .onConflictDoUpdate({
        target: enterpriseSettings.key,
        set: { value: catalog },
      });
  }
  const ledger = createTestCreditLedger(database);
  const app = createTestCreditRoutes({
    ledger,
    authenticate: async () => ({ issuer, subject }),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      request.method === "GET"
        ? app.fetch(request)
        : new Response(null, { status: 405 }),
  });
  try {
    console.log(server.port);
    await new Promise((resolve) => process.once("SIGTERM", resolve));
  } finally {
    server.stop(true);
  }
} finally {
  await database.$client.close();
}
