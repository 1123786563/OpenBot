import { createHash, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";

const version = "2017-06-26";
// SHA-256 of the empty body that every RPC operation sends.
const emptyBodySha256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
// encodeURIComponent leaves these five reserved characters bare.
const encode = (value: string) =>
  encodeURIComponent(value).replaceAll(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

// A NAS request that did not produce a confirmed answer. Callers treat it as
// "unconfirmed", never as zero, absence or success. Only this error's message
// may be logged: a raw transport error can quote the request it was sending.
export class NasError extends Error {
  constructor(
    message: string,
    readonly detail: {
      status?: number;
      code?: string;
      requestId?: string;
    } = {},
  ) {
    super(message);
  }
}

const failure = z.object({
  Code: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  RequestId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
});
const agenticSpace = z.object({
  FileSystemId: z.string().min(1),
  AgenticSpaceId: z.string().min(1),
  Status: z.enum([
    "Creating",
    "Running",
    "Deleting",
    "Deleted",
    "CreateFailed",
  ]),
  Quota: z.object({
    SizeLimit: z.int().nonnegative(),
    FileCountLimit: z.int().nonnegative(),
  }),
  SpaceUsage: z.int().nonnegative(),
  FileCountUsage: z.int().nonnegative(),
});
export type NasAgenticSpace = z.infer<typeof agenticSpace>;

type NasConfig = {
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  now?: () => number;
  nonce?: () => string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
};

// Shared Alibaba NAS control-plane client. The signer and request function
// serve quota reads and workspace storage erasure.
export function createNasClient(config: NasConfig) {
  if (!/^[a-z0-9-]+$/.test(config.region))
    throw new Error("Invalid NAS region");
  const host = `nas.${config.region}.aliyuncs.com`;

  async function call(action: string, params: Record<string, string>) {
    const date = `${new Date((config.now ?? Date.now)()).toISOString().slice(0, 19)}Z`;
    const nonce = (config.nonce ?? (() => randomBytes(16).toString("hex")))();
    const query = Object.entries(params)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${encode(key)}=${encode(value)}`)
      .join("&");
    // Sorted names; every canonical header line ends with one newline, and
    // only one blank line separates them from the signed header names.
    const headers: [string, string][] = [
      ["accept", "application/json"],
      ["host", host],
      ["x-acs-action", action],
      ["x-acs-content-sha256", emptyBodySha256],
      ["x-acs-date", date],
      ["x-acs-signature-nonce", nonce],
      ["x-acs-version", version],
    ];
    const canonical = [
      "POST",
      "/",
      query,
      headers.map(([name, value]) => `${name}:${value}\n`).join(""),
      headers.map(([name]) => name).join(";"),
      emptyBodySha256,
    ].join("\n");
    const signature = createHmac("sha256", config.accessKeySecret)
      .update(`ACS3-HMAC-SHA256\n${sha256(canonical)}`)
      .digest("hex");

    const response = await (config.fetch ?? fetch)(
      `https://${host}/?${query}`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "x-acs-action": action,
          "x-acs-version": version,
          "x-acs-date": date,
          "x-acs-signature-nonce": nonce,
          "x-acs-content-sha256": emptyBodySha256,
          authorization: `ACS3-HMAC-SHA256 Credential=${config.accessKeyId},SignedHeaders=${headers.map(([name]) => name).join(";")},Signature=${signature}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(4_000),
      },
    );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const { Code, code, RequestId, requestId } =
      failure.safeParse(body).data ?? {};
    // Status, code and RequestId are what an Alibaba support ticket needs. The
    // rest reaches the operator's log, so only an identifier is kept.
    const identifier = (value: string | undefined) =>
      /^[\w.:*-]{1,128}$/.test(value ?? "") ? value : undefined;
    const detail = {
      status: response.status,
      code: identifier(Code ?? code),
      requestId: identifier(RequestId ?? requestId),
    };
    if (!response.ok || body === undefined) {
      const summary = [`HTTP ${detail.status}`, detail.code]
        .filter(Boolean)
        .join(" ");
      throw new NasError(
        `NAS ${action} unconfirmed: ${summary}${detail.requestId ? `, RequestId ${detail.requestId}` : ""}`,
        detail,
      );
    }
    return body;
  }

  async function confirmErased({
    read,
    remove,
    missing,
    deleting,
  }: {
    read: () => Promise<"present" | "deleting" | "absent">;
    remove: () => Promise<unknown>;
    missing: (error: unknown) => boolean;
    deleting: string;
  }) {
    const observe = () =>
      read().catch((error: unknown) => {
        if (missing(error)) return "absent";
        throw error;
      });
    const state = await observe();
    if (state === "absent") return;
    if (state === "present") {
      await remove().catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
    }
    if ((await observe()) !== "absent") throw new NasError(deleting);
  }

  return {
    async eraseWorkspaceStorage(binding: {
      fileSystemId: string;
      accessPointId: string;
      agenticSpaceId: string;
    }) {
      const FileSystemId = binding.fileSystemId;
      const AccessPointId = binding.accessPointId;
      const AgenticSpaceId = binding.agenticSpaceId;
      const access = { FileSystemId, AccessPointId };
      const space = { FileSystemId, AgenticSpaceId };

      await confirmErased({
        async read() {
          const { AccessPoint: point } = z
            .object({
              AccessPoint: z.object({
                FileSystemId: z.literal(FileSystemId),
                AccessPointId: z.literal(AccessPointId),
                AgenticSpaceId: z.literal(AgenticSpaceId),
                Status: z.string().min(1),
              }),
            })
            .parse(await call("DescribeAccessPoint", access));
          return point.Status.toLowerCase() === "deleting"
            ? "deleting"
            : "present";
        },
        remove: () => call("DeleteAccessPoint", access),
        missing: (error) =>
          error instanceof NasError &&
          error.detail.status === 404 &&
          error.detail.code === "InvalidAccessPointId.NotFound",
        deleting: "NAS access point erasure unconfirmed",
      });

      await confirmErased({
        async read() {
          const { AgenticSpace: current } = z
            .object({
              AgenticSpace: z.object({
                FileSystemId: z.literal(FileSystemId),
                AgenticSpaceId: z.literal(AgenticSpaceId),
                Status: agenticSpace.shape.Status,
              }),
            })
            .parse(await call("GetAgenticSpace", space));
          if (current.Status === "Deleted") return "absent";
          return current.Status === "Deleting" ? "deleting" : "present";
        },
        remove: () => call("DeleteAgenticSpace", space),
        missing: (error) =>
          error instanceof NasError &&
          (error.detail.status === 400 || error.detail.status === 404) &&
          error.detail.code === "InvalidAgenticSpace.NotFound",
        deleting: "NAS AgenticSpace erasure unconfirmed",
      });
    },
    async getAgenticSpace(space: {
      fileSystemId: string;
      agenticSpaceId: string;
    }) {
      const body = await call("GetAgenticSpace", {
        FileSystemId: space.fileSystemId,
        AgenticSpaceId: space.agenticSpaceId,
      });
      const parsed = z.object({ AgenticSpace: agenticSpace }).safeParse(body);
      if (!parsed.success)
        throw new NasError("NAS GetAgenticSpace response unconfirmed");
      return parsed.data.AgenticSpace;
    },
  };
}
export type NasClient = ReturnType<typeof createNasClient>;
