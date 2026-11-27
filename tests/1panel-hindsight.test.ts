import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

import { packageDir } from "./support/1panel-package";

const app = packageDir("hindsight");
const consoleAccessKey = "HINDSIGHT_CP_ACCESS_KEY";
const tenantApiKey = "HINDSIGHT_API_TENANT_API_KEY";

type Form = {
  additionalProperties: { formFields: Array<Record<string, unknown>> };
};
const form = () => parse(readFileSync(join(app, "data.yml"), "utf8")) as Form;
const field = (envKey: string) =>
  form().additionalProperties.formFields.find(
    (candidate) => candidate.envKey === envKey,
  );

const variables = {
  CONTAINER_NAME: "hindsight-test",
  PANEL_APP_PORT_HTTP: "19999",
  PANEL_APP_PORT_API: "18888",
  PANEL_DB_HOST: "127.0.0.1",
  PANEL_DB_PORT: "5432",
  PANEL_DB_NAME: "hindsight",
  PANEL_DB_USER: "hindsight",
  PANEL_DB_USER_PASSWORD: "hindsight",
};

/** What Compose renders is what runs, so every assertion about the running system reads this. */
function render(overrides: Record<string, string> = {}) {
  const env = mkdtempSync(join(tmpdir(), "openbot-1panel-hindsight-"));
  try {
    const file = join(env, "test.env");
    writeFileSync(
      file,
      Object.entries({
        ...variables,
        [consoleAccessKey]: "a-test-key",
        [tenantApiKey]: "a-tenant-key",
        ...overrides,
      })
        .map(([name, value]) => `${name}=${value}`)
        .join("\n"),
    );
    return execFileSync(
      "docker",
      [
        "compose",
        "-f",
        join(app, "docker-compose.yml"),
        "--env-file",
        file,
        "config",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    ).toString();
  } finally {
    rmSync(env, { recursive: true, force: true });
  }
}

/** Hindsight only shows its login page when this variable reaches the control plane, so it must not be optional. */
test("the 1Panel Hindsight package always gives the console an access key", () => {
  const key = field(consoleAccessKey);
  // Read at every start, so an existing install can gain a key after the fact.
  expect(key).toMatchObject({ type: "password", edit: true, required: true });

  // An empty key must stop the container instead of starting a console that anyone can open.
  expect(render()).toContain(`HINDSIGHT_CP_ACCESS_KEY: a-test-key`);
  expect(() => render({ [consoleAccessKey]: "" })).toThrow();

  // Same for the API: without a key the API would answer anyone who can reach the port.
  expect(field(tenantApiKey)).toMatchObject({
    type: "password",
    edit: true,
    required: true,
  });
  expect(() => render({ [tenantApiKey]: "" })).toThrow();
});

type Rendered = {
  services: Record<
    string,
    {
      image?: string;
      ports?: unknown[];
      networks?: Record<string, null>;
      environment?: Record<string, string>;
      depends_on?: Record<string, { condition?: string }>;
    }
  >;
  networks: Record<string, { internal?: boolean; external?: boolean }>;
};
const rendered = (overrides: Record<string, string> = {}) =>
  parse(render(overrides)) as Rendered;

/*
 * The 1Panel PostgreSQL cluster image carries a pgvector built for AVX-512. On a CPU without it a
 * vector write kills the backend and every connection on the cluster, so the package must keep its
 * database on an image that chooses its instructions at run time.
 */
test("the 1Panel Hindsight package keeps its database to itself", () => {
  const { services, networks } = rendered();

  expect(field("PANEL_DB_HOST")).toMatchObject({
    type: "text",
    default: "postgres",
    edit: true,
  });
  expect(field("PANEL_DB_PORT")).toMatchObject({ default: 5432, edit: true });

  // The database publishes nothing and sits on an internal network, so only Hindsight reaches it.
  expect(services.postgres?.image).toBe("pgvector/pgvector:pg17");
  expect(services.postgres?.ports).toBeUndefined();
  expect(Object.keys(services.postgres?.networks ?? {})).toEqual(["db"]);
  expect(services.postgres?.environment).toMatchObject({
    POSTGRES_USER: "hindsight",
    POSTGRES_DB: "hindsight",
  });
  expect(networks.db).toMatchObject({ internal: true });

  expect(services.hindsight?.depends_on?.postgres).toMatchObject({
    condition: "service_healthy",
  });
  // The form decides where Hindsight connects: a named host, or the built-in database.
  expect(services.hindsight?.environment?.HINDSIGHT_API_DATABASE_URL).toMatch(
    /^postgresql:\/\/hindsight:[^@]+@127\.0\.0\.1:5432\/hindsight\?sslmode=disable$/,
  );
  expect(
    rendered({ PANEL_DB_HOST: "postgres" }).services.hindsight?.environment
      ?.HINDSIGHT_API_DATABASE_URL,
  ).toMatch(
    /^postgresql:\/\/hindsight:[^@]+@postgres:5432\/hindsight\?sslmode=disable$/,
  );
});
