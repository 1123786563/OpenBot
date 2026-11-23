import { expect, test } from "bun:test";
import { createNasClient, NasError } from "../src/personal-saas/nas";

// Fake credentials and the signature the official Alibaba SDK produced
// offline for this exact request. Never used against a real account.
const vector = {
  region: "cn-hangzhou",
  accessKeyId: "AKIDEXAMPLE",
  accessKeySecret: "examplesecret",
  date: "2026-11-24T01:02:03Z",
  nonce: "0123456789abcdef",
  space: {
    fileSystemId: "31a8e4a b+c/d=e",
    agenticSpaceId: "agentic-229oypxjgpau2****",
  },
  authorization:
    "ACS3-HMAC-SHA256 Credential=AKIDEXAMPLE,SignedHeaders=accept;host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=53cc91f45314fb80ca81c578ec13dfe72a488118dc3fbc17ae93716f52b57cde",
};
// Response shape from the public API metadata (GetAgenticSpace).
const spaceResponse = {
  RequestId: "fixture-request-id",
  AgenticSpace: {
    FileSystemId: "31a8e4a b+c/d=e",
    AgenticSpaceId: "agentic-229oypxjgpau2****",
    Description: "AgenticSpace Description.",
    FileSystemPath: "/test/",
    Azone: "cn-hangzhou-i",
    Status: "Running",
    CreateTimeUtc: "2026-06-10T10:08:08Z",
    UpdateTimeUtc: "2026-06-10T10:08:08Z",
    Quota: { SizeLimit: 10737418240, FileCountLimit: 10000 },
    FileCountUsage: 2,
    SpaceUsage: 4096,
  },
};

function fixture(respond: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  return {
    requests,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return respond(request);
    }) as typeof fetch,
  };
}

function client(
  transport: typeof fetch,
  overrides: Partial<Parameters<typeof createNasClient>[0]> = {},
) {
  return createNasClient({
    region: vector.region,
    accessKeyId: vector.accessKeyId,
    accessKeySecret: vector.accessKeySecret,
    now: () => Date.parse(vector.date),
    nonce: () => vector.nonce,
    fetch: transport,
    ...overrides,
  });
}

test("NAS signs GetAgenticSpace like the official client", async () => {
  const http = fixture(() => Response.json(spaceResponse));
  // Only the fields the runtime reads survive; IDs are returned verbatim.
  const space = await client(http.fetch).getAgenticSpace(vector.space);
  expect(space).toEqual({
    FileSystemId: "31a8e4a b+c/d=e",
    AgenticSpaceId: "agentic-229oypxjgpau2****",
    Status: "Running",
    Quota: { SizeLimit: 10737418240, FileCountLimit: 10000 },
    SpaceUsage: 4096,
    FileCountUsage: 2,
  });
  expect(http.requests).toHaveLength(1);
  const [request] = http.requests;
  const url = new URL(request.url);
  expect(request.method).toBe("POST");
  expect(`${url.origin}${url.pathname}`).toBe(
    "https://nas.cn-hangzhou.aliyuncs.com/",
  );
  expect(url.search).toBe(
    "?AgenticSpaceId=agentic-229oypxjgpau2%2A%2A%2A%2A&FileSystemId=31a8e4a%20b%2Bc%2Fd%3De",
  );
  expect(request.headers.get("authorization")).toBe(vector.authorization);
  expect(Object.fromEntries(request.headers)).toMatchObject({
    accept: "application/json",
    "x-acs-action": "GetAgenticSpace",
    "x-acs-version": "2017-06-26",
    "x-acs-date": vector.date,
    "x-acs-signature-nonce": vector.nonce,
    "x-acs-content-sha256":
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  });
  expect(request.redirect).toBe("error");
  expect(await request.text()).toBe("");
});

// Error codes and statuses are the documented ones for GetAgenticSpace.
const refusal = async (
  respond: (request: Request) => Response | Promise<Response>,
) => {
  const http = fixture(respond);
  return client(http.fetch)
    .getAgenticSpace(vector.space)
    .then(
      () => undefined,
      (error: unknown) => error,
    );
};

test("NAS reports a refused read as unconfirmed with status, code and RequestId", async () => {
  const error = await refusal(() =>
    Response.json(
      {
        Code: "InvalidFileSystem.NotFound",
        Message: "The specified filesystem does not exist.",
        RequestId: "01A2-fixture-request",
      },
      { status: 404 },
    ),
  );
  expect(error).toBeInstanceOf(NasError);
  expect((error as NasError).message).toBe(
    "NAS GetAgenticSpace unconfirmed: HTTP 404 InvalidFileSystem.NotFound, RequestId 01A2-fixture-request",
  );
  // The official client also accepts lowercase keys.
  const throttled = await refusal(() =>
    Response.json(
      { code: "Throttling.User", requestId: "01A2-throttled" },
      { status: 429 },
    ),
  );
  expect((throttled as NasError).message).toBe(
    "NAS GetAgenticSpace unconfirmed: HTTP 429 Throttling.User, RequestId 01A2-throttled",
  );
});

test("NAS leaves an unanswered read unconfirmed", async () => {
  // A transport that rejects reaches no caller as a space.
  const offline = await refusal(() => {
    throw new TypeError("fetch failed");
  });
  expect(offline).toBeInstanceOf(TypeError);
  const unparseable = await refusal(
    () => new Response("<html>", { status: 200 }),
  );
  expect((unparseable as NasError).message).toBe(
    "NAS GetAgenticSpace unconfirmed: HTTP 200",
  );
  const failing = await refusal(() =>
    Response.json(
      { Code: "InternalError", RequestId: "01A2-internal" },
      { status: 500 },
    ),
  );
  expect((failing as NasError).message).toBe(
    "NAS GetAgenticSpace unconfirmed: HTTP 500 InternalError, RequestId 01A2-internal",
  );
  const empty = await refusal(() => Response.json({ RequestId: "01A2-empty" }));
  expect((empty as NasError).message).toBe(
    "NAS GetAgenticSpace response unconfirmed",
  );
  // Nothing a failure carries may repeat the credentials that were signed with.
  for (const error of [unparseable, failing, empty])
    expect(JSON.stringify(error)).not.toContain(vector.accessKeySecret);
  // Nor may an answer choose what reaches the operator's log.
  const hostile = await refusal(() =>
    Response.json(
      {
        Code: `Refused ${vector.accessKeySecret}\n{"type":"forged"}`,
        RequestId: "x".repeat(5_000),
      },
      { status: 403 },
    ),
  );
  expect(hostile).toMatchObject({
    message: "NAS GetAgenticSpace unconfirmed: HTTP 403",
    detail: { status: 403 },
  });
});

test("NAS refuses a space whose bytes, counts or state it cannot confirm", async () => {
  const mutations = [
    { SpaceUsage: "4096" },
    { SpaceUsage: -1 },
    { SpaceUsage: 2 ** 53 },
    { FileCountUsage: 1.5 },
    { Status: "running" },
    { Status: "Paused" },
    { Quota: { SizeLimit: "10737418240", FileCountLimit: 10000 } },
    { Quota: { SizeLimit: 10737418240.5, FileCountLimit: 10000 } },
    { Quota: undefined },
    { AgenticSpaceId: "" },
  ];
  for (const mutation of mutations) {
    const error = await refusal(() =>
      Response.json({
        ...spaceResponse,
        AgenticSpace: { ...spaceResponse.AgenticSpace, ...mutation },
      }),
    );
    expect(error).toBeInstanceOf(NasError);
  }
});

test("NAS gives up on a read that never answers", async () => {
  const error = await refusal(
    (request) =>
      new Promise<never>((_, reject) => {
        request.signal.addEventListener("abort", () =>
          reject(request.signal.reason),
        );
      }),
  );
  expect(error).toMatchObject({ name: "TimeoutError" });
}, 10_000);
