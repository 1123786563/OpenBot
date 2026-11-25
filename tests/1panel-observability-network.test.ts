import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const deploy = join(import.meta.dir, "../deploy");

type Networks = Record<
  string,
  { name?: string; external?: boolean; internal?: boolean }
>;

const networksOf = (...path: string[]): Networks =>
  (
    parse(readFileSync(join(deploy, ...path), "utf8")) as {
      networks: Networks;
    }
  ).networks;

/** OpenBot joins this network as external, so installing it must never depend on a hand-made network. */
test("the 1Panel OpenObserve package creates the network OpenBot sends logs over", () => {
  const owner = networksOf(
    "1panel/apps/openobserve/0.139.0/docker-compose.yml",
  ).observability;
  expect(owner?.name).toBe("openbot-observability");
  expect(owner?.external).not.toBe(true);
  // No gateway: the network only carries logs between containers.
  expect(owner?.internal).toBe(true);

  expect(
    networksOf("1panel/apps/openbot/1.0.3/docker-compose.yml").telemetry,
  ).toEqual({ name: "openbot-observability", external: true });
});

test("the Compose OpenObserve project creates the same network", () => {
  const owner = networksOf("openobserve/docker-compose.yml").observability;

  expect(owner?.name).toBe("openbot-observability");
  expect(owner?.external).not.toBe(true);
  expect(owner?.internal).toBe(true);
});
