/**
 * The offline run-provisioning CLI, per plan 03 §4.4 (E1-D).
 *
 * Eleven fixed modes — six registrations (release-register, run-grant, route-register,
 * model-grant, budget-open, delegation-register) and five revocations (disable-release,
 * revoke-run-grant, disable-route, revoke-model-grant, revoke-delegation) — and nothing else:
 * no arbitrary SQL, no table chosen by input, no global principal work (that stays
 * `enterprise-identity-provision.ts`), and no workspace/resource creation (02's
 * `enterprise-provision.ts` owns those). Each dispatch parses the SAME strict union the domain
 * function enforces; every mode admits only its own fields.
 *
 * The default is a dry run: it validates and prints the parsed plan and never opens a
 * connection or a write transaction. Writing needs BOTH `--apply` and `--operation-id` — the
 * audit anchor cannot exist without one. The database URL comes from
 * ENTERPRISE_RUN_PROVISION_DATABASE_URL only, with no fallback to DATABASE_URL: pointing the
 * offline operator at the application database by accident is not a mode this CLI offers.
 *
 * The approved upstream target keys come from ENTERPRISE_MODEL_TARGETS (comma-separated
 * deployment config) — an unset list answers NO to every route-register, so a route whose
 * target the deployment never mapped is refused closed. The real endpoint and its credentials
 * stay in the deployment mapping; no flag of this CLI can carry them, and no input URI can
 * become a target.
 *
 * Production provisioning still requires separate authorization (plan §4.4): the connection
 * behind ENTERPRISE_RUN_PROVISION_DATABASE_URL must be the DBA-approved operator login.
 *
 * Output carries the command, mode, operation id and the parsed plan/outcome only — never a
 * connection string, a credential, an endpoint or a secret.
 */
import { createDatabase } from "../src/db/client";
import { EnterpriseError } from "../src/enterprise/errors";
import {
  applyRunProvision,
  type RunProvisionCommand,
  RunProvisionCommandSchema,
} from "../src/enterprise/runs/provision";

const MODES = [
  "release-register",
  "run-grant",
  "route-register",
  "model-grant",
  "budget-open",
  "delegation-register",
  "disable-release",
  "revoke-run-grant",
  "disable-route",
  "revoke-model-grant",
  "revoke-delegation",
] as const;
type Mode = (typeof MODES)[number];

const USAGE = `Usage: bun server/scripts/enterprise-run-provision.ts <mode> --input <json> --tenant <id> --operator <actor> --operation-id <id> [--apply]

Modes: ${MODES.join(", ")}
--input          the mode's JSON payload (strict; only that mode's fields)
--tenant         the tenant the operation is scoped to
--operator       the approved operator identity recorded in the audit event
--operation-id   unique id of this operation; replays must reuse the exact same payload
--apply          without it the CLI validates and prints a plan only

Reads ENTERPRISE_RUN_PROVISION_DATABASE_URL for --apply (never falls back to DATABASE_URL)
and ENTERPRISE_MODEL_TARGETS for the approved upstream target keys.`;

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

const [mode, ...flags] = process.argv.slice(2);
if (mode === undefined || !MODES.includes(mode as Mode)) {
  usage();
}

let inputJson: string | undefined;
let tenantId: string | undefined;
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
    flag !== "--tenant" &&
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
  } else if (flag === "--tenant") {
    tenantId = value;
  } else if (flag === "--operator") {
    operator = value;
  } else {
    operationId = value;
  }
  index += 1;
}
if (
  inputJson === undefined ||
  tenantId === undefined ||
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

/* The strict union is parsed ONCE, here: the dry run validates exactly what --apply would. */
function parseCommand(): RunProvisionCommand {
  const parsed = RunProvisionCommandSchema.safeParse({
    ...payload,
    mode,
    tenant_id: tenantId,
    operator,
    operation_id: operationId,
  });
  if (!parsed.success) {
    console.error(
      JSON.stringify({ error: "INVALID_PROVISION_INPUT", status: 400 }),
    );
    process.exit(1);
  }
  return parsed.data;
}

const command = parseCommand();

if (!apply) {
  /* Dry run: the plan only — no URL is read, no connection is opened. */
  console.info(
    JSON.stringify({ command: mode, mode: "dry-run", plan: command }),
  );
  process.exit(0);
}

const url = process.env.ENTERPRISE_RUN_PROVISION_DATABASE_URL?.trim();
if (!url) {
  console.error(
    "ENTERPRISE_RUN_PROVISION_DATABASE_URL is required for --apply; this CLI never falls back to DATABASE_URL.",
  );
  process.exit(1);
}

const database = createDatabase(url, { max: 1 });
try {
  /* One transaction per operation: locks, the idempotency anchor and the audit land together,
   * exactly as the domain function arranges them. The approved target keys come from the
   * deployment environment via the domain module's default registry. */
  await database.$client.begin(async (tx) => {
    await applyRunProvision(tx, command);
  });
  console.info(
    JSON.stringify({
      command: mode,
      mode: "applied",
      operationId,
      plan: command,
    }),
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
