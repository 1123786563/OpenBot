/**
 * The offline global identity CLI, per plan 02 §5 T1-C step 2 (identity half) and step 4.
 *
 * Two commands — create-principal and suspend-principal — on the identity operator's own login,
 * with its own global audit domain. Deliberately NOT part of the tenant operator CLI: the tenant
 * operator has no write access to principals (TEN-21), and identity work must not inherit a
 * tenant's context or locks. There is no reactivation and no binding-repair command here; binding
 * repair is a separate DBA-approved, drain-and-audit path.
 *
 * Default is a dry run; writing needs BOTH `--apply` and `--operation-id`. The database URL comes
 * from ENTERPRISE_IDENTITY_OPERATOR_DATABASE_URL only, never from DATABASE_URL. A users row must
 * already exist for create-principal — this CLI never creates users, and the foreign-key
 * rejection is the honest answer when one is missing.
 */
import { createDatabase } from "../src/db/client";
import { EnterpriseError } from "../src/enterprise/errors";
import {
  CreatePrincipalInputSchema,
  createPrincipal,
  SuspendPrincipalInputSchema,
  suspendPrincipal,
} from "../src/enterprise/tenancy/identity";
import type { OperationOutcome } from "../src/enterprise/tenancy/provision";

const COMMANDS = ["create-principal", "suspend-principal"] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = `Usage: bun server/scripts/enterprise-identity-provision.ts <command> --input <json> --operator <actor> --operation-id <id> [--apply]

Commands: ${COMMANDS.join(", ")}
--input        create-principal: {"principalId","userId"}; suspend-principal: {"principalId"}
--operator     the approved identity operator recorded in the global audit event
--operation-id unique id of this operation; replays must reuse the exact same payload
--apply        without it the CLI validates and prints a plan only

Reads ENTERPRISE_IDENTITY_OPERATOR_DATABASE_URL. Never falls back to DATABASE_URL.`;

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

/** Each command's strict validation, collected for the dry run's redacted plan. */
function parseSelectedPlan(): Record<string, unknown> {
  switch (command as Command) {
    case "create-principal":
      return CreatePrincipalInputSchema.parse({ ...payload, ...base });
    case "suspend-principal":
      return SuspendPrincipalInputSchema.parse({ ...payload, ...base });
  }
}

if (!apply) {
  const plan = parseSelectedPlan();
  console.info(JSON.stringify({ command, mode: "dry-run", ...plan }));
  process.exit(0);
}

const url = process.env.ENTERPRISE_IDENTITY_OPERATOR_DATABASE_URL?.trim();
if (!url) {
  console.error(
    "ENTERPRISE_IDENTITY_OPERATOR_DATABASE_URL is required for --apply; this CLI never falls back to DATABASE_URL.",
  );
  process.exit(1);
}

const database = createDatabase(url, { max: 1 });
try {
  /* Each branch parses its own strict schema before calling its typed handler. */
  let outcome: OperationOutcome;
  switch (command as Command) {
    case "create-principal":
      outcome = await createPrincipal(
        database,
        CreatePrincipalInputSchema.parse({ ...payload, ...base }),
      );
      break;
    case "suspend-principal":
      outcome = await suspendPrincipal(
        database,
        SuspendPrincipalInputSchema.parse({ ...payload, ...base }),
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
