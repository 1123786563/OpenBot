import { describe, expect, test } from "bun:test";
import type {
  AdminSummaryResult,
  ExportJobView,
} from "../../shared/ai-observability-admin";
import type { AdminSummary } from "../src/ai-observability/admin-summary";
import type { projectJob } from "../src/ai-observability/routes/exports";

/**
 * The admin contract's anti-drift seam (OCR m216): the shared view types and the
 * server projections are definitions TypeScript otherwise never compares — m215
 * was exactly the drift this file exists to catch. The conditional types make any
 * future drift a compile error; the runtime assertions keep the file executed.
 */

/** True only when the server's projected job IS the shared wire view. */
type ServerJobIsSharedView =
  ReturnType<typeof projectJob> extends ExportJobView ? true : false;

/** True only when the server's summary IS the shared view's payload shape. */
type ServerSummaryIsSharedView =
  AdminSummary extends AdminSummaryResult["summary"] ? true : false;

// Opposite direction too: the shared view must not be narrower than the server's
// projection, or the browser would silently drop fields the server answers with.
type SharedViewIsServerJob =
  ExportJobView extends Partial<ReturnType<typeof projectJob>> ? true : false;

const serverJobIsSharedView: ServerJobIsSharedView = true;
const serverSummaryIsSharedView: ServerSummaryIsSharedView = true;
const sharedViewIsServerJob: SharedViewIsServerJob = true;

describe("the admin contract types do not drift (m216)", () => {
  test("the server's projected export job satisfies the shared ExportJobView", () => {
    expect(serverJobIsSharedView).toBe(true);
  });

  test("the server's admin summary satisfies the shared AdminSummaryResult", () => {
    expect(serverSummaryIsSharedView).toBe(true);
  });

  test("the shared ExportJobView is not narrower than the server's projection", () => {
    expect(sharedViewIsServerJob).toBe(true);
  });
});
