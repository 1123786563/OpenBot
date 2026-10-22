import "../preload";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "../../../tests/support/bun-test-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { SCOPE_HEADER_ALLOWED_PATHS } from "../../src/lib/client";
import { SCOPE_STREAM_ALLOWED_PATHS } from "../../src/lib/enterprise/tenant/stream-scope";

/**
 * MT093 / Issue #136: the knowledge-management and document-processing pages this ticket asked
 * to bind DO NOT EXIST — the KB subsystem was fully removed by ADR 0009 (accepted 2026-10-19,
 * commit 887f0cff: the kb service, the knowledge middleware, /admin/knowledge, the craft
 * company-search relay, the app's knowledge pages and the upload-queue that served them), with
 * the user's explicit confirmation. Every AC of the ticket is therefore satisfied vacuously —
 * there is no list, no retrieval surface, no upload/delete/reparse action and no public
 * knowledge base left to leak another scope's content — and this suite pins THAT: the removal
 * is the isolation. If a knowledge surface is ever reintroduced, these tests fail until it is
 * either scoped through the MT091/MT094 seams or this pin is consciously revised.
 *
 * What the retrieval half keeps (ADR 0009's own boundary): ai-observability's
 * recordRetrieval/RetrievalStepObservation seam stays as a generic observation surface with no
 * producer since the KB's removal — it observes runs, it is not a retrieval UI.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const appRoot = join(here, "..", "..");

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

describe("MT093 — the removed knowledge surface cannot leak (ADR 0009 pins)", () => {
  test("no knowledge route exists in the generated route tree", async () => {
    const routeTree = await Bun.file(
      join(appRoot, "src", "routeTree.gen.ts"),
    ).text();
    expect(routeTree.includes("knowledge")).toBe(false);
  });

  test("no knowledge module survives under the app's lib", () => {
    // The five lib files ADR 0009 removed, by their family.
    for (const pattern of [
      "src/lib/knowledge.ts",
      "src/lib/knowledge",
      "src/lib/upload-queue",
      "src/components/knowledge",
    ]) {
      expect(existsSync(join(appRoot, pattern))).toBe(false);
    }
  });

  test("no knowledge locale namespace ships", () => {
    for (const locale of ["en", "zh-CN"]) {
      expect(
        existsSync(join(appRoot, "src", "locales", locale, "knowledge.json")),
      ).toBe(false);
    }
  });

  test("neither reviewed transport carries a knowledge or kb path family", () => {
    // The closed inventories are the only paths a selection pair may ride; a reintroduced
    // knowledge surface must earn its own review entry, never inherit one.
    for (const entry of SCOPE_HEADER_ALLOWED_PATHS) {
      expect(entry.prefix.toLowerCase().includes("knowledge")).toBe(false);
      expect(entry.prefix.toLowerCase().includes("/kb")).toBe(false);
    }
    for (const entry of SCOPE_STREAM_ALLOWED_PATHS) {
      expect(entry.prefix.toLowerCase().includes("knowledge")).toBe(false);
      expect(entry.prefix.toLowerCase().includes("/kb")).toBe(false);
    }
  });

  test("the document-processing actions the ticket names have no client face", async () => {
    // Upload, delete, import and reparse for documents were the KB's verbs (MT038's service,
    // removed with the subsystem). The authoritative shape check: the removed API families are
    // absent from the generated route tree and from the transport's reviewed inventories
    // (asserted above) — a client face for them cannot exist without both.
    const routeTree = await Bun.file(
      join(appRoot, "src", "routeTree.gen.ts"),
    ).text();
    expect(routeTree.includes("document")).toBe(false);
    expect(routeTree.includes("reparse")).toBe(false);
  });
});
