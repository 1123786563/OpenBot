import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import { mcpServers, mcpTools } from "../src/db/schema/plugins";
import { createMemoryIngestion } from "../src/memory/ingestion";
import { classifyMemorySensitivity } from "../src/memory/sensitivity";
import { createMemoryStore } from "../src/memory/store";
import { MemoryRefusedError } from "../src/memory/types";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `sensitivity-${randomUUID()}`;
const owner = `${prefix}-owner`;
const bot = `${prefix}-bot`;
const server = `${prefix}-connector`;
const ref = `${server}/read_documents`;
let vendorText =
  '[{"id":"doc1","text":"Project launch is Tuesday","title":"Roadmap"}]';
const vendorError = false;
const plugins = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  callVendor: async () => ({ text: vendorText, isError: vendorError }),
});
const store = createMemoryStore(database);
const ingestion = createMemoryIngestion({ store, plugins });

beforeAll(async () => {
  await database.insert(users).values({
    id: owner,
    email: `${owner}@example.test`,
  });
  await database.insert(agents).values({
    id: bot,
    name: "Sensitivity Bot",
    type: "built_in",
    configuration: {},
  });
  await database.insert(agentProfiles).values({
    agentId: bot,
    ownerUserId: owner,
    title: "Sensitivity Bot",
    roleDescription: "Assist",
    avatarSeed: bot,
    visibility: "private",
  });
  await database.insert(mcpServers).values({
    id: server,
    title: "Sensitivity connector",
    vendor: "Fixture",
    url: "https://sensitivity.example.test/mcp",
    provenance: "custom",
  });
  await database.insert(mcpTools).values({
    serverId: server,
    name: "read_documents",
    effect: "read",
    inputSchema: {},
  });
  await plugins.grant("mcp", ref, bot, owner);
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner]));
  await database.delete(agents).where(inArray(agents.id, [bot]));
  await database.delete(mcpServers).where(inArray(mcpServers.id, [server]));
  await database.$client.close();
});

test("classification is conservative: only explicit triggers are sensitive", () => {
  // Credentials, and credentials err on the side of refusing.
  expect(
    classifyMemorySensitivity("My password for the intranet is hunter2"),
  ).toBe("credential");
  expect(
    classifyMemorySensitivity("The OpenAI api key lives in the vault"),
  ).toBe("credential");
  expect(
    classifyMemorySensitivity("Bearer token for the gateway rotated"),
  ).toBe("credential");
  expect(classifyMemorySensitivity("My passphrase is a sentence I like")).toBe(
    "credential",
  );
  expect(
    classifyMemorySensitivity("Secret key sk-live-9f3cab21e8d0 for staging"),
  ).toBe("credential");
  // 宁误拒: an ordinary use of "token" is refused rather than slipped through.
  expect(
    classifyMemorySensitivity("A token of appreciation for the team"),
  ).toBe("credential");
  expect(classifyMemorySensitivity("Remember the DB password")).toBe(
    "credential",
  );
  // High-frequency credential shapes (fix1 F-L1): pwd/pass code with a value, ssh key, .pem
  // files, database URLs with credentials in them.
  expect(classifyMemorySensitivity("DB pwd=hunter2 for staging")).toBe(
    "credential",
  );
  expect(classifyMemorySensitivity("the pwd is hunter2")).toBe("credential");
  expect(classifyMemorySensitivity("The device passcode is 482113")).toBe(
    "credential",
  );
  expect(classifyMemorySensitivity("her pwd is p@ssw0rd")).toBe("credential");
  expect(
    classifyMemorySensitivity("Remember my ssh key for the build server"),
  ).toBe("credential");
  expect(
    classifyMemorySensitivity("Copy the new key to /etc/ssl/server.pem"),
  ).toBe("credential");
  expect(
    classifyMemorySensitivity(
      "postgres://admin:hunter2@db.example.com:5432/app",
    ),
  ).toBe("credential");
  expect(
    classifyMemorySensitivity("mongodb+srv://user:p4ss@cluster.example.net/db"),
  ).toBe("credential");
  // ...and the shapes stay off ordinary prose: `pwd` without a value (it is also a shell
  // command), `pass code` describing a screen, ssh without a key, the PEM acronym, and database
  // URLs that name a server without carrying credentials.
  expect(
    classifyMemorySensitivity("our pwd policy follows NIST guidance"),
  ).toBe("normal");
  expect(
    classifyMemorySensitivity("the pwd command prints the directory"),
  ).toBe("normal");
  expect(classifyMemorySensitivity("The passcode entry screen is slow")).toBe(
    "normal",
  );
  // After "is", only a value-shaped token counts (ocr fix): a bare noun is prose, sentence
  // punctuation and all, while a token carrying a digit or a symbol is still a secret.
  expect(classifyMemorySensitivity("the passcode is required")).toBe("normal");
  expect(classifyMemorySensitivity("our pwd is wrong")).toBe("normal");
  expect(
    classifyMemorySensitivity("ssh into the staging box and restart"),
  ).toBe("normal");
  expect(
    classifyMemorySensitivity("PEM is a container format for certificates"),
  ).toBe("normal");
  expect(classifyMemorySensitivity("redis://cache.internal:6379/0")).toBe(
    "normal",
  );
  expect(classifyMemorySensitivity("postgres://db.example.com:5432/app")).toBe(
    "normal",
  );
  // Underscore/prefix credential shapes (ocr7): Stripe's underscored keys that the
  // hyphenated `sk-` patterns cannot reach, the fine-grained GitHub PAT, and name+value
  // pairs (`client_secret=…`, `SECRET=…`) whose value is long and token-shaped.
  expect(
    classifyMemorySensitivity("Stripe live key sk_live_51H8mK2pQ9rT4vX7zAbCd"),
  ).toBe("credential");
  expect(
    classifyMemorySensitivity("restricted key rk_live_9f8e7d6c5b4a3210fedc"),
  ).toBe("credential");
  expect(
    classifyMemorySensitivity("pasted github_pat_11AAAA0bbbbbbbbbbbbbbbbbbb"),
  ).toBe("credential");
  expect(classifyMemorySensitivity("client_secret=9f8e7d6c5b4a32109f8e")).toBe(
    "credential",
  );
  expect(
    classifyMemorySensitivity("the oauth client-secret: 0a1b2c3d4e5f6a7b8c9d"),
  ).toBe("credential");
  expect(classifyMemorySensitivity("SECRET=9f8e7d6c5b4a3210")).toBe(
    "credential",
  );
  expect(classifyMemorySensitivity("API_KEY=0a1b2c3d4e5f6a7b")).toBe(
    "credential",
  );
  // ...and the name alone, or with a prose-length value, stays ordinary text: no separator
  // or too-short value means no secret, and mentioning a prefix format is not one either.
  expect(
    classifyMemorySensitivity("rotate the client secret tomorrow morning"),
  ).toBe("normal");
  expect(
    classifyMemorySensitivity("our secret handshake predates the team"),
  ).toBe("normal");
  expect(classifyMemorySensitivity("SECRET=none")).toBe("normal");
  expect(
    classifyMemorySensitivity("the docs describe the sk_live_ prefix format"),
  ).toBe("normal");
  expect(
    classifyMemorySensitivity("github_pat_ is the fine-grained format"),
  ).toBe("normal");
  // Recovery/seed phrases, 2FA backup codes and OTP/verification codes (ocr8): a name followed
  // by a word-list or numeric value is refused even though every word itself is innocent.
  expect(
    classifyMemorySensitivity(
      "Please remember my wallet recovery seed phrase: apple banana cherry danger",
    ),
  ).toBe("credential");
  expect(
    classifyMemorySensitivity(
      "my seed phrase apple banana cherry dog elephant fuel",
    ),
  ).toBe("credential");
  expect(
    classifyMemorySensitivity("the mnemonic is amber fossil ledger river"),
  ).toBe("credential");
  expect(classifyMemorySensitivity("2FA backup codes 8722 0091 4455")).toBe(
    "credential",
  );
  expect(classifyMemorySensitivity("my backup code is 87220091")).toBe(
    "credential",
  );
  expect(classifyMemorySensitivity("the transfer OTP is 482913")).toBe(
    "credential",
  );
  expect(classifyMemorySensitivity("verification code: 042917")).toBe(
    "credential",
  );
  expect(classifyMemorySensitivity("auth code 4821 arrived by SMS")).toBe(
    "credential",
  );
  // ...while the name with ordinary prose after it — no separator and no value shape — stays
  // ordinary text (ocr8 negatives): the word list cannot open on a grammar or list-prose word,
  // and the numeric names without a numeric value name no secret.
  expect(
    classifyMemorySensitivity("the recovery phrase is explained in the docs"),
  ).toBe("normal");
  expect(
    classifyMemorySensitivity("the mnemonic for the wallet is in the vault"),
  ).toBe("normal");
  expect(
    classifyMemorySensitivity("seed words written on paper are gone"),
  ).toBe("normal");
  expect(
    classifyMemorySensitivity("backup codes are required for the admin panel"),
  ).toBe("normal");
  expect(classifyMemorySensitivity("our 2FA rollout covers every admin")).toBe(
    "normal",
  );
  expect(
    classifyMemorySensitivity("the OTP screen times out after thirty seconds"),
  ).toBe("normal");
  expect(
    classifyMemorySensitivity("verification codes expire after five minutes"),
  ).toBe("normal");
  expect(
    classifyMemorySensitivity("the auth code field is case sensitive"),
  ).toBe("normal");
  // A Bearer value counts when it has the shape of a token (fix1 F-L2): at least one digit or
  // symbol among the token characters.
  expect(
    classifyMemorySensitivity("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9"),
  ).toBe("credential");
  // ...while a protocol description after the word Bearer is ordinary prose, not a secret.
  expect(
    classifyMemorySensitivity("Bearer authentication is used by the API"),
  ).toBe("normal");
  // Medical.
  expect(
    classifyMemorySensitivity("Diagnosed with type 2 diabetes last spring"),
  ).toBe("medical");
  expect(
    classifyMemorySensitivity("Chemotherapy schedule is Tuesday mornings"),
  ).toBe("medical");
  expect(classifyMemorySensitivity("Takes medication for blood pressure")).toBe(
    "medical",
  );
  expect(classifyMemorySensitivity("Prescription refill is due")).toBe(
    "medical",
  );
  // Financial.
  expect(classifyMemorySensitivity("Salary is 120k plus bonus")).toBe(
    "financial",
  );
  expect(
    classifyMemorySensitivity("IBAN NL91 ABNA 0417 1643 00 for payouts"),
  ).toBe("financial");
  expect(classifyMemorySensitivity("The mortgage runs until 2040")).toBe(
    "financial",
  );
  expect(classifyMemorySensitivity("Credit card was replaced")).toBe(
    "financial",
  );
  // Customer data.
  expect(
    classifyMemorySensitivity("Customer data export with client emails"),
  ).toBe("customer-data");
  expect(
    classifyMemorySensitivity("The client list is in the shared drive"),
  ).toBe("customer-data");
  // Ordinary facts stay normal, and so does anything uncertain.
  expect(classifyMemorySensitivity("Prefers morning meetings and tea")).toBe(
    "normal",
  );
  expect(classifyMemorySensitivity("The login bug ships Friday")).toBe(
    "normal",
  );
  expect(classifyMemorySensitivity("Owns the billing migration")).toBe(
    "normal",
  );
  expect(classifyMemorySensitivity("asdf qwerty zxcv")).toBe("normal");
  // A classification that cannot happen fails safe to normal.
  expect(classifyMemorySensitivity("")).toBe("normal");
  expect(classifyMemorySensitivity(undefined as unknown as string)).toBe(
    "normal",
  );
});

test("'remember' refuses credentials outright and stores nothing", async () => {
  await expect(
    store.create(owner, { content: "My password for the intranet is hunter2" }),
  ).rejects.toBeInstanceOf(MemoryRefusedError);
  await expect(
    store.create(owner, { content: "The api key is sk-live-9f3cab21e8d0" }),
  ).rejects.toBeInstanceOf(MemoryRefusedError);
  expect(
    (await store.list(owner)).some((row) =>
      /hunter2|sk-live/.test(row.content),
    ),
  ).toBe(false);
});

test("'remember' turns a sensitive fact into a candidate, not a confirmation", async () => {
  const medical = await store.create(owner, {
    content: `Diagnosed with type 2 diabetes ${randomUUID()}`,
  });
  expect(medical.reviewState).toBe("unreviewed");
  const financial = await store.create(owner, {
    content: `Salary review landed at 120k ${randomUUID()}`,
  });
  expect(financial.reviewState).toBe("unreviewed");
  const customers = await store.create(owner, {
    content: `Client list export ${randomUUID()}`,
  });
  expect(customers.reviewState).toBe("unreviewed");
  // An ordinary fact asked for explicitly is still confirmed directly (#377 behavior).
  const plain = await store.create(owner, {
    content: `Prefers morning meetings ${randomUUID()}`,
  });
  expect(plain.reviewState).toBe("confirmed");
  // The person's list shows the candidates with their content and source; no Bot recalls them
  // until the person confirms them once more — the #377 gate, reused, is the extra confirmation.
  const listed = await store.list(owner);
  expect(listed.some((row) => row.id === medical.id)).toBe(true);
  expect(listed.some((row) => row.id === financial.id)).toBe(true);
  expect(listed.some((row) => row.id === customers.id)).toBe(true);
  const recalled = await store.retrieve(owner, []);
  expect(recalled.some((row) => row.id === medical.id)).toBe(false);
  expect(recalled.some((row) => row.id === financial.id)).toBe(false);
  expect(recalled.some((row) => row.id === customers.id)).toBe(false);
  expect(recalled.some((row) => row.id === plain.id)).toBe(true);
  await store.update(owner, medical.id, { reviewState: "confirmed" });
  expect(
    (await store.retrieve(owner, [])).some((row) => row.id === medical.id),
  ).toBe(true);
});

test("a Bot never forms sensitive candidates from what it observes", async () => {
  await expect(
    store.formMemory(owner, {
      agentId: bot,
      content: "Password for the dashboard is s3cret",
      sourceApp: "Docs",
      sourceRef: ref,
    }),
  ).rejects.toBeInstanceOf(MemoryRefusedError);
  await expect(
    store.formMemory(owner, {
      agentId: bot,
      content: "Chemotherapy schedule is Tuesday mornings",
      sourceApp: "Docs",
      sourceRef: ref,
    }),
  ).rejects.toBeInstanceOf(MemoryRefusedError);
  await expect(
    store.formMemory(owner, {
      agentId: bot,
      content: "Customer data export with client emails",
      sourceApp: "Docs",
      sourceRef: ref,
    }),
  ).rejects.toBeInstanceOf(MemoryRefusedError);
  expect(
    (await store.list(owner)).some((row) =>
      /s3cret|Chemotherapy|Client emails/.test(row.content),
    ),
  ).toBe(false);
  // An ordinary observation still becomes a candidate.
  const normal = await store.formMemory(owner, {
    agentId: bot,
    content: `Prefers async updates ${randomUUID()}`,
    sourceApp: "Docs",
    sourceRef: ref,
  });
  expect(normal.duplicate).toBe(false);
});

test("an edit into credentials is refused; the memory keeps its content", async () => {
  const fact = await store.create(owner, {
    content: `Prefers tea over coffee ${randomUUID()}`,
  });
  await expect(
    store.update(owner, fact.id, { content: "My api key is sk-live-9f3cab21" }),
  ).rejects.toBeInstanceOf(MemoryRefusedError);
  expect(
    (await store.list(owner)).find((row) => row.id === fact.id)?.content,
  ).toBe(fact.content);
});

test("an edit into sensitive content returns the memory to review (fix1 F-M1)", async () => {
  const fact = await store.create(owner, {
    content: `Prefers tea over coffee ${randomUUID()}`,
  });
  expect(fact.reviewState).toBe("confirmed");
  // Same semantics as create(): sensitive content must be confirmed once more by the person
  // before any Bot may recall it, however the content got there.
  const edited = await store.update(owner, fact.id, {
    content: `Diagnosed with type 2 diabetes ${randomUUID()}`,
  });
  expect(edited.reviewState).toBe("unreviewed");
  expect(
    (await store.retrieve(owner, [])).some((row) => row.id === fact.id),
  ).toBe(false);
  await store.update(owner, fact.id, { reviewState: "confirmed" });
  expect(
    (await store.retrieve(owner, [])).some((row) => row.id === fact.id),
  ).toBe(true);
  // An ordinary edit stays reviewed (#377 semantics unchanged).
  const plain = await store.create(owner, {
    content: `Prefers window seats ${randomUUID()}`,
  });
  const editedPlain = await store.update(owner, plain.id, {
    content: `Prefers aisle seats ${randomUUID()}`,
  });
  expect(editedPlain.reviewState).toBe("edited");
});

test("a connected-app sync stores only ordinary records as candidates", async () => {
  vendorText = JSON.stringify([
    { id: "doc1", text: "Project launch is Tuesday", title: "Roadmap" },
    {
      id: "doc2",
      text: "Bank account IBAN NL91 for payouts",
      title: "Finance",
    },
    { id: "doc3", text: "Customer data: client emails", title: "CRM" },
    { id: "doc4", text: "Prescription refill is due", title: "Health" },
    { id: "doc5", text: "Access token pasted in the doc", title: "Secrets" },
  ]);
  const { imported } = await ingestion.createSource(owner, {
    agentId: bot,
    toolRef: ref,
    title: "Sensitive files",
    args: {},
  });
  expect(imported).toBe(1);
  const contents = (await store.list(owner)).map((row) => row.content);
  expect(contents.some((content) => content.includes("Project launch"))).toBe(
    true,
  );
  expect(
    contents.some((content) =>
      /IBAN|client emails|Prescription|token pasted/.test(content),
    ),
  ).toBe(false);
});
