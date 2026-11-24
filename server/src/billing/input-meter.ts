import { z } from "zod";
import { UnsentBifrostRequest } from "./test-credit-bifrost";

export async function measureInput({
  endpoint,
  token,
  request,
  revision,
  signal,
}: {
  endpoint: string | URL;
  token: string;
  request: {
    body: string;
    requestId: string;
    digest: string;
    operationId?: string;
  };
  revision: { gatewayRevision: string; meteringRevision: string };
  signal: AbortSignal;
}) {
  const headers = new Headers({
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "x-request-id": request.requestId,
    "x-openbot-bifrost-gateway-revision": revision.gatewayRevision,
    "x-openbot-bifrost-metering-revision": revision.meteringRevision,
  });
  if (request.operationId)
    headers.set("x-openbot-operation-id", request.operationId);
  const body: unknown = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    signal,
    headers,
    body: request.body,
  })
    .then((response) => (response.ok ? response.json() : undefined))
    .catch(() => undefined);
  const proof = z
    .object({
      requestId: z.literal(request.requestId),
      requestSha256: z.literal(request.digest),
      gatewayRevision: z.literal(revision.gatewayRevision),
      meteringRevision: z.literal(revision.meteringRevision),
      inputTokenUpperBound: z.number().int().nonnegative(),
    })
    .safeParse(body);
  if (!proof.success || signal.aborted)
    throw new UnsentBifrostRequest("route_unavailable");
  return proof.data.inputTokenUpperBound;
}
