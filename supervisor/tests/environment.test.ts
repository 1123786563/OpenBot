import { describe, expect, test } from "bun:test";
import { environmentFor } from "../src/environment";

describe("what the supervisor tells a computer about its browser", () => {
  test("passes the deployment's browser mode to every per-Bot computer", () => {
    expect(
      environmentFor("invoice-collector", {
        COMPUTER_TOKEN: "secret",
        COMPUTER_BROWSER_MODE: "headed",
      }),
    ).toEqual([
      "COMPUTER_BOT_ID=invoice-collector",
      "COMPUTER_TOKEN=secret",
      "COMPUTER_BROWSER_MODE=headed",
    ]);
  });

  test("does not invent a browser mode when the deployment left it unset", () => {
    expect(
      environmentFor("invoice-collector", { COMPUTER_TOKEN: "secret" }),
    ).toEqual(["COMPUTER_BOT_ID=invoice-collector", "COMPUTER_TOKEN=secret"]);
  });

  test("forwards the trace export endpoint so a computer's spans join the deployment's traces", () => {
    expect(
      environmentFor("knowledge", {
        COMPUTER_TOKEN: "secret",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://tempo:4318",
      }),
    ).toEqual([
      "COMPUTER_BOT_ID=knowledge",
      "COMPUTER_TOKEN=secret",
      "OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318",
    ]);
  });
});
