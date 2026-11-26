import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

import { packageDir } from "./support/1panel-package";

const app = packageDir("hindsight");
const consoleAccessKey = "HINDSIGHT_CP_ACCESS_KEY";

/** Hindsight only shows its login page when this variable reaches the control plane, so it must not be optional. */
test("the 1Panel Hindsight package always gives the console an access key", () => {
  const form = parse(readFileSync(join(app, "data.yml"), "utf8")) as {
    additionalProperties: { formFields: Array<Record<string, unknown>> };
  };
  const field = form.additionalProperties.formFields.find(
    (candidate) => candidate.envKey === consoleAccessKey,
  );

  expect(field?.type).toBe("password");
  // Read at every start, so an existing install can gain a key after the fact.
  expect(field?.edit).toBe(true);
  expect(field?.required).toBe(true);

  const compose = join(app, "docker-compose.yml");
  const services = (
    parse(readFileSync(compose, "utf8")) as {
      services: Record<string, { environment: Record<string, string> }>;
    }
  ).services;
  expect(services.hindsight?.environment[consoleAccessKey]).toBe(
    `\${${consoleAccessKey}:?Enter the console access key}`,
  );

  // The form is one thing; what Compose renders is what runs. An empty key must stop the
  // container instead of starting a console that anyone can open.
  const env = mkdtempSync(join(tmpdir(), "openbot-1panel-hindsight-"));
  const variables = {
    CONTAINER_NAME: "hindsight-test",
    PANEL_APP_PORT_HTTP: "19999",
    PANEL_APP_PORT_API: "18888",
    PANEL_DB_HOST: "127.0.0.1",
    PANEL_DB_PORT: "5432",
    PANEL_DB_NAME: "hindsight",
    PANEL_DB_USER: "hindsight",
    PANEL_DB_USER_PASSWORD: "hindsight",
    // The API's own key is required too, so the render stops on the console key alone.
    HINDSIGHT_API_TENANT_API_KEY: "a-tenant-key",
  };
  const render = (key: string) => {
    const file = join(env, "test.env");
    writeFileSync(
      file,
      Object.entries({ ...variables, [consoleAccessKey]: key })
        .map(([name, value]) => `${name}=${value}`)
        .join("\n"),
    );
    return execFileSync(
      "docker",
      ["compose", "-f", compose, "--env-file", file, "config"],
      { stdio: ["ignore", "pipe", "pipe"] },
    ).toString();
  };

  try {
    expect(render("a-test-key")).toContain(
      `HINDSIGHT_CP_ACCESS_KEY: a-test-key`,
    );
    expect(() => render("")).toThrow();
  } finally {
    rmSync(env, { recursive: true, force: true });
  }
});
