import { expect, test } from "../../tests/support/bun-test-compat";
import { createOtelEventExporter } from "../src/telemetry/otel";

/**
 * The audit trail keeps the command a Bot ran in full; what leaves for an outside collector must
 * not carry the credentials in it. Checked against a real OTLP/HTTP collector on 127.0.0.1, because
 * the bytes on the wire are the thing that has to be clean.
 */
test("a command exported to the collector is scrubbed of the secrets in it", async () => {
  const secret = "fixture-value-7f3a91c0d2";
  const loginSecret = "fixture-glorb-4e6b2a91d5c3";
  const received: string[] = [];
  const collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      received.push(await request.text());
      return new Response("{}");
    },
  });
  try {
    const exporter = createOtelEventExporter({
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${collector.port}/v1/logs`,
    });
    exporter?.emit({
      eventType: "computer.action_allowed",
      targetType: "computer",
      targetId: "bot-1",
      actorUserId: null,
      initiatorKind: "person",
      initiatorId: null,
      payload: {
        bot: "bot-1",
        action: "computer_run_command",
        command: `curl -H "Authorization: Bearer ${secret}" https://api.example.test`,
        login: {
          command: `docker login -p ${loginSecret} registry.example.test`,
        },
        nested: { command: `export API_TOKEN=${secret}` },
      },
    });
    await exporter?.shutdown();
  } finally {
    collector.stop(true);
  }
  const wire = received.join("");
  expect(wire).toContain("computer.action_allowed");
  expect(wire).toContain("computer_run_command");
  expect(wire).toContain("[REDACTED]");
  expect(wire).not.toContain(secret);
  expect(wire).not.toContain(loginSecret);
});

/*
 * Separators inside quoted arguments once ended the mid-rule scan early (A-H1), and a getopt flag
 * cluster like `-vp` was swallowed whole, so its trailing `p` — the password flag — was never
 * reached (A-M8). Neither shape may survive the hop to a collector, and neither fix may turn a
 * port into a redaction: an uppercase `-P3306` stays a port even beside an attached lowercase one.
 */
test("separators in quoted arguments and clustered sshpass flags are scrubbed on the wire too", async () => {
  const mysqlSecret = "fixture-mysql-5f2a8c91e3d7";
  const dockerSecret = "fixture-dq-6b3d92e4f1a8";
  const sshSecret = "fixture-sq-7c4e83a5d2b9";
  const attachedSecret = "fixture-attach-9e1f54b7c8a2";
  const received: string[] = [];
  const collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      received.push(await request.text());
      return new Response("{}");
    },
  });
  try {
    const exporter = createOtelEventExporter({
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${collector.port}/v1/logs`,
    });
    exporter?.emit({
      eventType: "computer.action_allowed",
      targetType: "computer",
      targetId: "bot-1",
      actorUserId: null,
      initiatorKind: "person",
      initiatorId: null,
      payload: {
        // The `;` rides inside the quoted `-e` script; the scan must cross the quote to the flag.
        mysqlQuoted: {
          command: `mysql -h db.internal -e "SELECT 1;" -p"${mysqlSecret}"`,
        },
        // The `&` rides inside the quoted username.
        dockerQuoted: {
          command: `docker login -u "dev&ops" -p ${dockerSecret} registry.example.test`,
        },
        // `-vp` is getopt for `-v -p`: the cluster must not swallow its own trailing password flag.
        sshpassCluster: {
          command: `sshpass -vp ${sshSecret} ssh deploy@host.example.test`,
        },
        // An uppercase `-P` stays a port even in the same command as an attached lowercase one.
        mysqlPort: {
          command: `mysql -h db.internal -P3306 -p${attachedSecret} appdb`,
        },
      },
    });
    await exporter?.shutdown();
  } finally {
    collector.stop(true);
  }
  const wire = received.join("");
  // The commands ride inside a JSON-encoded payload attribute, so the quotes come back escaped;
  // decode the attributes and assert on the commands themselves.
  const commands = received.flatMap((body) =>
    (
      JSON.parse(body).resourceLogs as Array<{
        scopeLogs: Array<{
          logRecords: Array<{
            attributes: Array<{ key: string; value: { stringValue?: string } }>;
          }>;
        }>;
      }>
    )
      .flatMap((resource) => resource.scopeLogs)
      .flatMap((scope) => scope.logRecords)
      .flatMap((record) => record.attributes)
      .filter((attribute) => attribute.key.startsWith("openbot.payload."))
      .map(
        (attribute) =>
          JSON.parse(attribute.value.stringValue ?? "{}").command as string,
      ),
  );
  expect(commands).toContain(
    'mysql -h db.internal -e "SELECT 1;" -p[REDACTED]',
  );
  expect(commands).toContain(
    'docker login -u "dev&ops" -p [REDACTED] registry.example.test',
  );
  expect(commands).toContain(
    "sshpass -vp [REDACTED] ssh deploy@host.example.test",
  );
  expect(commands).toContain("mysql -h db.internal -P3306 -p[REDACTED] appdb");
  expect(wire).not.toContain(mysqlSecret);
  expect(wire).not.toContain(dockerSecret);
  expect(wire).not.toContain(sshSecret);
  expect(wire).not.toContain(attachedSecret);
});

/*
 * The positional rules fixed in V01-F4, at the same wire level: docker's global options sit between
 * the command and its subcommand, sshpass's env form keeps the password out of the process list —
 * and neither shape may survive the hop to an outside collector any better than the `-p` forms do.
 */
test("docker global options and the sshpass env form are scrubbed on the wire too", async () => {
  const dockerSecret = "fixture-docker-91c3e7a2b5d4";
  const sshSecret = "fixture-sshpass-3d8c1f6e90b7";
  const received: string[] = [];
  const collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      received.push(await request.text());
      return new Response("{}");
    },
  });
  try {
    const exporter = createOtelEventExporter({
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${collector.port}/v1/logs`,
    });
    exporter?.emit({
      eventType: "computer.action_allowed",
      targetType: "computer",
      targetId: "bot-1",
      actorUserId: null,
      initiatorKind: "person",
      initiatorId: null,
      payload: {
        dockerLogin: {
          command: `docker -H tcp://registry.example:2375 login -p ${dockerSecret}`,
        },
        // A subcommand is not a global option: `run`'s own `-p` is a port mapping, and the port
        // must survive.
        dockerPort: { command: "docker run login -p 8080:80 nginx" },
        sshpassEnv: {
          command: `SSHPASS=${sshSecret} sshpass -e ssh deploy@host.example.test`,
        },
      },
    });
    await exporter?.shutdown();
  } finally {
    collector.stop(true);
  }
  const wire = received.join("");
  expect(wire).toContain("login -p [REDACTED]");
  expect(wire).toContain("SSHPASS=[REDACTED]");
  expect(wire).toContain("docker run login -p 8080:80 nginx");
  expect(wire).not.toContain(dockerSecret);
  expect(wire).not.toContain(sshSecret);
});
