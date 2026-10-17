import { describe, expect, test } from "../tests/support/e2e-compat";
import { Writable } from "node:stream";
import { createLogger, getLogger, readLogLevel } from "./logger";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines };
}

describe("the shared logger", () => {
  test("emits single-line JSON carrying the service name", () => {
    const { stream, lines } = capture();
    const log = createLogger("test-service", stream);
    log.info("hello");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record.service).toBe("test-service");
    expect(record.level).toBe(30); // info
    expect(lines[0]!.endsWith("\n")).toBe(true);
  });

  test("a child logger carries the request id alongside the service", () => {
    const { stream, lines } = capture();
    const log = createLogger("test-service", stream);
    log.child({ request_id: "req_1" }).warn("during request");
    const record = JSON.parse(lines[0]!);
    expect(record.request_id).toBe("req_1");
    expect(record.service).toBe("test-service");
  });

  test("level comes from env-style input and unknown values fall back", () => {
    expect(readLogLevel("debug", "info")).toBe("debug");
    expect(readLogLevel(" WARN ", "info")).toBe("warn");
    expect(readLogLevel(undefined, "info")).toBe("info");
    expect(readLogLevel("", "info")).toBe("info");
    expect(readLogLevel("LOUD", "info")).toBe("info");
  });

  test("getLogger memoises per service", () => {
    expect(getLogger("memo-test")).toBe(getLogger("memo-test"));
    expect(getLogger("memo-test")).not.toBe(getLogger("memo-other"));
  });
});
