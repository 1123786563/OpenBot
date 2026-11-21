import { type ListedTool, MAX_RESULT_CHARS, type McpCallResult } from "../mcp";
import type { CorsairCloudClient } from "./cloud";

const CLOUD_URL = "corsair://cloud";

let installed: CorsairCloudClient | null = null;

export function useCorsairCloudClient(client: CorsairCloudClient | null) {
  installed = client;
}

export const listNeedsCredential = false;

function configured(): CorsairCloudClient {
  if (!installed)
    throw new Error(
      "Corsair Cloud is not configured for this deployment. Set CORSAIR_CLOUD_KEY before refreshing the Corsair Cloud app.",
    );
  return installed;
}

function result(text: string, isError = false): McpCallResult {
  if (text.length <= MAX_RESULT_CHARS)
    return { text, isError, truncated: false };
  return {
    text: `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated]`,
    isError,
    truncated: true,
  };
}

export async function listTools(connection: {
  url: string;
}): Promise<ListedTool[]> {
  if (connection.url !== CLOUD_URL)
    throw new Error(`Corsair Cloud transport cannot use ${connection.url}.`);
  const operations = await configured().listOperations();
  return operations.map((entry) => ({
    name: `${entry.plugin}.${entry.operation}`,
    vendorName: entry.operation,
    description: `Call the Corsair ${entry.plugin} integration operation ${entry.operation}. The operation is treated as a write and requires OpenBot approval.`,
    inputSchema: {
      type: "object",
      properties: { args: { type: "object", additionalProperties: true } },
    },
    effect: "write",
    destructive: false,
    unclassified: false,
  }));
}

export async function callTool(
  connection: { url: string; actorId?: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  if (connection.url !== CLOUD_URL)
    return result(
      `Corsair Cloud transport cannot use ${connection.url}.`,
      true,
    );
  if (!connection.actorId)
    return result(
      "Corsair Cloud calls require an authenticated OpenBot person.",
      true,
    );
  const separator = toolName.indexOf(".");
  if (separator <= 0 || separator === toolName.length - 1)
    return result(`Corsair Cloud operation ${toolName} is invalid.`, true);
  const plugin = toolName.slice(0, separator);
  const operation = toolName.slice(separator + 1);
  const operationArgs = args.args;
  if (
    operationArgs !== undefined &&
    (typeof operationArgs !== "object" ||
      operationArgs === null ||
      Array.isArray(operationArgs))
  )
    return result("Corsair Cloud operation args must be an object.", true);
  try {
    const payload = await configured().call(
      connection.actorId,
      plugin,
      operation,
      operationArgs ?? {},
    );
    return result(
      JSON.stringify(payload) ?? "Corsair Cloud returned no content.",
    );
  } catch (error) {
    return result(error instanceof Error ? error.message : String(error), true);
  }
}
