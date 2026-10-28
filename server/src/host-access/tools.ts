import { z } from "zod";
import {
  type AuditInitiator,
  type AuditStore,
  recordAuditEvent,
} from "../audit";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { REFUSAL_MARKER } from "../plugins/tools";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { type HostAccessBroker, HostAccessRefusedError } from "./broker";

const empty = z.object({});

const grantPath = z.object({
  grantId: z.string().min(1),
  path: z.string().optional(),
});

const readFile = z.object({
  grantId: z.string().min(1),
  path: z.string().min(1),
});

const writeFile = z.object({
  grantId: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
});

const runCommand = z.object({
  grantId: z.string().min(1),
  path: z.string().optional(),
  command: z.string().min(1),
  writable: z.boolean().optional(),
});

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result ?? {});
}

async function auditHostAccess(
  options: {
    auditStore?: AuditStore;
    initiator?: AuditInitiator;
    actorId: string;
    botId: string;
  },
  input: {
    operation: string;
    outcome: "requested" | "succeeded" | "refused" | "failed" | "stopped";
    grantId?: string;
    reason?: string;
  },
) {
  if (!options.auditStore) return;
  await recordAuditEvent(options.auditStore, {
    eventType: "configuration.changed",
    targetType: "host_access",
    ...(input.grantId ? { targetId: input.grantId } : {}),
    actorUserId: options.actorId,
    ...(options.initiator ? { initiator: options.initiator } : {}),
    payload: {
      change: "host_access_tool_call",
      operation: input.operation,
      bot: options.botId,
      actor: options.actorId,
      ...(input.grantId ? { grant: input.grantId } : {}),
      outcome: input.outcome,
      ...(input.reason ? { reason: input.reason.slice(0, 240) } : {}),
    },
  });
}

async function answer(
  audit: {
    auditStore?: AuditStore;
    initiator?: AuditInitiator;
    actorId: string;
    botId: string;
    operation: string;
    grantId?: string;
  },
  run: () => Promise<unknown>,
): Promise<string> {
  await auditHostAccess(audit, {
    operation: audit.operation,
    grantId: audit.grantId,
    outcome: "requested",
  });
  try {
    const result = await run();
    try {
      await auditHostAccess(audit, {
        operation: audit.operation,
        grantId: audit.grantId,
        outcome: "succeeded",
      });
    } catch {
      // The operation already happened; a broken audit trail must not turn a success into a
      // reported failure.
    }
    return resultText(result);
  } catch (error) {
    if (error instanceof HeadlessToolSuspension) throw error;
    const reason =
      error instanceof Error ? error.message : "That host operation failed.";
    try {
      await auditHostAccess(audit, {
        operation: audit.operation,
        grantId: audit.grantId,
        outcome:
          error instanceof HostAccessRefusedError
            ? reason.toLowerCase().includes("stop")
              ? "stopped"
              : "refused"
            : "failed",
        reason,
      });
    } catch {
      // The verdict below names the real outcome; an audit-write fault must not mask it.
    }
    if (error instanceof HostAccessRefusedError) {
      return `${REFUSAL_MARKER} ${error.message}`;
    }
    return `That host operation could not be completed: ${reason}`;
  }
}

export function hostAccessTools(options: {
  broker: HostAccessBroker;
  botId: string;
  actorId: string;
  auditStore?: AuditStore;
  initiator?: AuditInitiator;
}): GrantedTool[] {
  const { broker, botId, actorId } = options;
  const status = broker.statusFor(actorId);
  const grants = status.grants.filter(
    (grant) => grant.botId === botId && !grant.revoked,
  );
  // Re-read per execute: a grant revoked (or the desktop disconnecting) while the tools sat
  // assembled must not keep answering from the construction-time snapshot. The per-call
  // broker re-validation stays callHost's job; this keeps what we hand out live.
  const liveGrants = () =>
    broker
      .statusFor(actorId)
      .grants.filter((grant) => grant.botId === botId && !grant.revoked);
  const audit = (operation: string, grantId?: string) => ({
    auditStore: options.auditStore,
    initiator: options.initiator,
    actorId,
    botId,
    operation,
    ...(grantId ? { grantId } : {}),
  });

  const tools: GrantedTool[] = [
    {
      name: "host_list_folders",
      ref: "host-access/list_folders",
      description:
        "List the host folders this person has explicitly granted to this Bot, including the grantId to use with host file and command tools.",
      parameters: empty,
      execute: async () => {
        const current = liveGrants();
        if (current.length === 0) {
          await auditHostAccess(audit("list_folders"), {
            operation: "list_folders",
            outcome: "refused",
            reason: "No host folders are granted to this Bot.",
          });
          return `${REFUSAL_MARKER} No host folders are granted to this Bot.`;
        }
        await auditHostAccess(audit("list_folders"), {
          operation: "list_folders",
          outcome: "succeeded",
        });
        return JSON.stringify({
          connected: broker.statusFor(actorId).connected,
          folders: current.map((grant) => ({
            grantId: grant.id,
            displayName: grant.displayName,
          })),
        });
      },
    },
  ];

  if (!status.connected || grants.length === 0) return tools;

  tools.push(
    {
      name: "host_list_files",
      ref: "host-access/list_files",
      description:
        "List files in a host folder this person granted to this Bot. First call host_list_folders for grantId values.",
      parameters: grantPath,
      execute: async (args) => {
        const parsed = grantPath.safeParse(args ?? {});
        if (!parsed.success)
          return answer(audit("list_files"), async () => {
            throw new HostAccessRefusedError(
              "Supply a grant id (from host_list_folders) and a folder path.",
            );
          });
        return answer(audit("list_files", parsed.data.grantId), () =>
          broker.callHost({
            kind: "list_files",
            botId,
            actorId,
            grantId: parsed.data.grantId,
            relativePath: parsed.data.path ?? ".",
          }),
        );
      },
    },
    {
      name: "host_read_file",
      ref: "host-access/read_file",
      description:
        "Read one file from a granted host folder. Use only paths relative to that folder.",
      parameters: readFile,
      execute: async (args) => {
        const parsed = readFile.safeParse(args ?? {});
        if (!parsed.success)
          return answer(audit("read_file"), async () => {
            throw new HostAccessRefusedError(
              "Supply a grant id (from host_list_folders) and a file path.",
            );
          });
        return answer(audit("read_file", parsed.data.grantId), () =>
          broker.callHost({
            kind: "read_file",
            botId,
            actorId,
            grantId: parsed.data.grantId,
            relativePath: parsed.data.path,
          }),
        );
      },
    },
    {
      name: "host_write_file",
      ref: "host-access/write_file",
      description:
        "Request an exact native-owner-confirmed file write in a granted host folder. The native app backs up the original and refuses unless the owner approves this operation.",
      parameters: writeFile,
      execute: async (args) => {
        const parsed = writeFile.safeParse(args ?? {});
        if (!parsed.success)
          return answer(audit("write_file"), async () => {
            throw new HostAccessRefusedError(
              "Supply a grant id, a file path and the exact content to write.",
            );
          });
        return answer(audit("write_file", parsed.data.grantId), () =>
          broker.callHost({
            kind: "write_file",
            botId,
            actorId,
            grantId: parsed.data.grantId,
            relativePath: parsed.data.path,
            content: parsed.data.content,
          }),
        );
      },
    },
    {
      name: "host_run_command",
      ref: "host-access/run_command",
      description:
        "Request an exact native-owner-confirmed shell command in the offline sandbox for a granted host folder. Set writable true only if the command needs write access; native still prompts before running.",
      parameters: runCommand,
      execute: async (args) => {
        const parsed = runCommand.safeParse(args ?? {});
        if (!parsed.success)
          return answer(audit("run_command"), async () => {
            throw new HostAccessRefusedError(
              "Supply a grant id and the command to run.",
            );
          });
        return answer(audit("run_command", parsed.data.grantId), () =>
          broker.callHost({
            kind: "run_command",
            botId,
            actorId,
            grantId: parsed.data.grantId,
            relativePath: parsed.data.path,
            command: parsed.data.command,
            writable: parsed.data.writable === true,
          }),
        );
      },
    },
  );

  return tools.map((tool) => ({ ...tool, initiator: options.initiator }));
}
