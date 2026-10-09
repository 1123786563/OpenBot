/**
 * The offline tenant operator CLI, per plan 02 §5 T1-C step 4.
 *
 * Six controlled commands — provision-member, suspend-member, create-workspace, create-resource,
 * grant-read, revoke-read — and nothing else: no arbitrary SQL, no table chosen by input, no
 * global principal work (that is `enterprise-identity-provision.ts` on its own login and audit).
 * Each branch parses its own strict schema before dispatching to the typed handler.
 *
 * The default is a dry run: it validates and prints a redacted plan and never opens a write
 * transaction or a connection. Writing needs BOTH `--apply` and `--operation-id`. The database
 * URL comes from ENTERPRISE_OPERATOR_DATABASE_URL only — there is no fallback to DATABASE_URL,
 * because an offline operator pointing at the application database by accident is not a mode this
 * CLI offers.
 *
 * Output carries command, mode, operation id and the parsed input only — never a connection
 * string, credential, session, email or a member listing.
 */
import { createDatabase } from "../src/db/client";
import { EnterpriseError } from "../src/enterprise/errors";
import {
  CreateResourceInputSchema,
  CreateWorkspaceInputSchema,
  createResource,
  createWorkspace,
  GrantInputSchema,
  grantRead,
  type OperationOutcome,
  ProvisionInputSchema,
  provisionMember,
  revokeRead,
  SuspendInputSchema,
  suspendMember,
} from "../src/enterprise/tenancy/provision";

const COMMANDS = [
  "provision-member",
  "suspend-member",
  "create-workspace",
  "create-resource",
  "grant-read",
  "revoke-read",
] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = `Usage: bun server/scripts/enterprise-provision.ts <command> --input <json> --operator <actor> --operation-id <id> [--apply]

Commands: ${COMMANDS.join(", ")}
--input        the command's JSON payload (strict; no unknown keys)
--operator     the approved operator identity recorded in the audit event
--operation-id unique id of this operation; replays must reuse the exact same payload
--apply        without it the CLI validates and prints a plan only

Reads ENTERPRISE_OPERATOR_DATABASE_URL. Never falls back to DATABASE_URL.`;

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

const [command, ...flags] = process.argv.slice(2);
if (command === undefined || !COMMANDS.includes(command as Command)) {
  usage();
}

let inputJson: string | undefined;
let operator: string | undefined;
let operationId: string | undefined;
let apply = false;
for (let index = 0; index < flags.length; index += 1) {
  const flag = flags[index];
  if (flag === "--apply") {
    apply = true;
    continue;
  }
  if (
    flag !== "--input" &&
    flag !== "--operator" &&
    flag !== "--operation-id"
  ) {
    usage();
  }
  const value = flags[index + 1];
  if (value === undefined || value.startsWith("--")) {
    usage();
  }
  if (flag === "--input") {
    inputJson = value;
  } else if (flag === "--operator") {
    operator = value;
  } else {
    operationId = value;
  }
  index += 1;
}
if (
  inputJson === undefined ||
  operator === undefined ||
  operationId === undefined
) {
  usage();
}

let payload: Record<string, unknown>;
try {
  const parsed: unknown = JSON.parse(inputJson);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("input must be a JSON object");
  }
  payload = parsed as Record<string, unknown>;
} catch {
  console.error("--input must be one JSON object");
  process.exit(2);
}

const base = { operator, operationId };

/** Parses the selected command's strict schema; the switch is total over the command union. */
/** Each command's strict validation, collected for the dry run's redacted plan. */
function parseSelectedPlan(): Record<string, unknown> {
  switch (command as Command) {
    case "provision-member":
      return ProvisionInputSchema.parse({ ...payload, ...base });
    case "suspend-member":
      return SuspendInputSchema.parse({ ...payload, ...base });
    case "create-workspace":
      return CreateWorkspaceInputSchema.parse({ ...payload, ...base });
    case "create-resource":
      return CreateResourceInputSchema.parse({ ...payload, ...base });
    case "grant-read":
      return GrantInputSchema.parse({ ...payload, ...base });
    case "revoke-read":
      return GrantInputSchema.parse({ ...payload, ...base });
  }
}

if (!apply) {
  /* Dry run: validate exactly what --apply would validate, then stop without touching a database. */
  const plan = parseSelectedPlan();
  console.info(JSON.stringify({ command, mode: "dry-run", ...plan }));
  process.exit(0);
}

const url = process.env.ENTERPRISE_OPERATOR_DATABASE_URL?.trim();
if (!url) {
  console.error(
    "ENTERPRISE_OPERATOR_DATABASE_URL is required for --apply; this CLI never falls back to DATABASE_URL.",
  );
  process.exit(1);
}

const database = createDatabase(url, { max: 1 });
try {
  /* Each branch parses its own strict schema before calling its typed handler — the dispatch
   * never funnels a shared union through a broad signature. */
  let outcome: OperationOutcome;
  switch (command as Command) {
    case "provision-member":
      outcome = await provisionMember(
        database,
        ProvisionInputSchema.parse({ ...payload, ...base }),
      );
      break;
    case "suspend-member":
      outcome = await suspendMember(
        database,
        SuspendInputSchema.parse({ ...payload, ...base }),
      );
      break;
    case "create-workspace":
      outcome = await createWorkspace(
        database,
        CreateWorkspaceInputSchema.parse({ ...payload, ...base }),
      );
      break;
    case "create-resource":
      outcome = await createResource(
        database,
        CreateResourceInputSchema.parse({ ...payload, ...base }),
      );
      break;
    case "grant-read":
      outcome = await grantRead(
        database,
        GrantInputSchema.parse({ ...payload, ...base }),
      );
      break;
    case "revoke-read":
      outcome = await revokeRead(
        database,
        GrantInputSchema.parse({ ...payload, ...base }),
      );
      break;
  }
  console.info(
    JSON.stringify({ command, mode: "applied", operationId, outcome }),
  );
} catch (error) {
  if (error instanceof EnterpriseError) {
    console.error(JSON.stringify({ error: error.code, status: error.status }));
    process.exit(1);
  }
  throw error;
} finally {
  await database.$client.close();
}
