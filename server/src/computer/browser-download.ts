import { z } from "zod";
import {
  BROWSER_DOWNLOAD_ID,
  type BrowserDownloadResult,
  browserDownloadPath,
  readBrowserDownload,
} from "../../../shared/browser-download";
import { type AuditStore, recordAuditEvent } from "../audit";
import type {
  ComputerConnection,
  ComputerTransport,
  SeatAddress,
} from "./client";
import { type ComputerSeat, computerKeyText } from "./computer-key";
import type { ActionActor } from "./gateway";

const captured = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    id: z.string().regex(BROWSER_DOWNLOAD_ID),
  }),
  z.object({ status: z.literal("failed") }),
]);
const receipt = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
});

export function createBrowserDownloadHandoff(options: {
  transport: ComputerTransport;
  auditStore: AuditStore;
  executionAt: (seat: ComputerSeat) => Promise<ComputerConnection>;
}) {
  async function audit(
    seat: ComputerSeat,
    actor: ActionActor,
    eventType:
      | "computer.browser_download_attempted"
      | "computer.browser_download_failed"
      | "computer.browser_download_delivered",
    payload: { id?: string; path?: string; bytes?: number },
  ) {
    await recordAuditEvent(options.auditStore, {
      eventType,
      targetType: "computer",
      targetId: seat.botId,
      actorUserId: actor.userId,
      initiator: actor.initiator,
      payload: {
        ...payload,
        computer: computerKeyText(seat.key),
        bot: seat.botId,
        actor: actor.id,
      },
    });
  }

  async function deliver(
    seat: ComputerSeat,
    actor: ActionActor,
    id: string,
    source: ComputerConnection,
    address: SeatAddress,
    signal?: AbortSignal,
  ): Promise<BrowserDownloadResult> {
    await audit(seat, actor, "computer.browser_download_attempted", { id });
    let saved: z.infer<typeof receipt>;
    try {
      // Resolve both connections for the same server-owned seat. Only the CubeSandbox
      // source can supply bytes for the opaque id.
      const download = await options.transport.download(
        source,
        address,
        `/browser-downloads/${id}`,
        signal,
        30_000,
      );
      const body = await readBrowserDownload(download.body, download.bytes);
      const destination = await options.executionAt(seat);
      saved = receipt.parse(
        await options.transport.call<unknown>(
          destination,
          seat.botId,
          `/files/browser-downloads/${id}`,
          {
            method: "PUT",
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(download.bytes),
            },
            body,
          },
          signal,
          30_000,
        ),
      );
      if (
        saved.path !== browserDownloadPath(id) ||
        saved.bytes !== download.bytes
      )
        throw new Error("Invalid browser download receipt.");
    } catch (error) {
      await audit(seat, actor, "computer.browser_download_failed", { id });
      throw error;
    }
    await audit(seat, actor, "computer.browser_download_delivered", {
      id,
      ...saved,
    });
    return { status: "delivered", id, ...saved };
  }

  async function finish<T extends object>(
    result: T & { browserDownload?: unknown },
    seat: ComputerSeat,
    actor: ActionActor,
    source: ComputerConnection,
    address: SeatAddress,
    signal?: AbortSignal,
  ): Promise<T & { download?: BrowserDownloadResult }> {
    const { browserDownload } = result;
    if (browserDownload === undefined) return result;
    const action = { ...result };
    delete action.browserDownload;
    const file = captured.safeParse(browserDownload);
    if (!file.success || file.data.status === "failed") {
      await audit(seat, actor, "computer.browser_download_failed", {});
      return {
        ...action,
        download: {
          status: "failed",
          retryable: false,
          error: "The browser did not stage one completed download.",
        },
      };
    }

    const { id } = file.data;
    try {
      return {
        ...action,
        download: await deliver(seat, actor, id, source, address, signal),
      };
    } catch {
      return {
        ...action,
        download: {
          status: "failed",
          id,
          retryable: true,
          error:
            "The download could not be delivered. Retry the handoff using this id.",
        },
      };
    }
  }

  return { deliver, finish };
}
