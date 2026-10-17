import { randomBytes } from "node:crypto";
import { type Decides, type SchemeKind, schemeKind } from "./broker";
import { isBrokeredProvenance } from "../../../shared/src/brokered-provenance";

/**
 * Whose account a brokered call reaches, decided in one place.
 *
 * Every other reader — the gate before a call, the transport, the audit row, the memory sync — asks
 * this, so the account a person was checked against and the account the call ran in cannot be two
 * answers that happened to agree.
 */

export const ACCOUNT_MODES = ["personal", "shared"] as const;
export type AccountMode = (typeof ACCOUNT_MODES)[number];

export const HOLDERS = ["person", "deployment"] as const;
export type Holder = (typeof HOLDERS)[number];

/** Who a broker is asked to act for. The broker sends `vendorUserId` and never chooses the holder. */
export type AccountRef =
  | { holder: "person"; userId: string; vendorUserId: string }
  | { holder: "deployment"; vendorUserId: string };

export function asAccountMode(value: unknown): AccountMode | null {
  return value === "personal" || value === "shared" ? value : null;
}

export type AccountAnswer =
  | { kind: "none" }
  | { kind: "person"; userId: string }
  | { kind: "deployment" }
  | { kind: "ambiguous"; message: string };

export function accountFor(
  row: {
    title: string;
    provenance: string;
    authScheme: string | null;
    accountMode: string | null;
  },
  credentialActorId: string,
): AccountAnswer {
  /*
   * ANY BROKER'S PROVENANCE, asked through the one list both processes share, because the question
   * is "does this row have an account at a broker" and Composio is no longer the only broker. A
   * literal here answered `none` — no account, nothing to connect, nothing to gate — for every
   * OpenConnector row, which is the fail-OPEN direction for a connector whose whole purpose is
   * per-person accounts: the row would have been callable by anybody with no connection at all.
   * Unknown provenances still answer `none`: a row this deployment cannot name a broker for is not
   * brokered, and this list is the closed set of names it knows.
   */
  if (!isBrokeredProvenance(row.provenance)) return { kind: "none" };

  const kind = schemeKind(row.authScheme);
  type _AccountForDecides = Decides<
    SchemeKind,
    {
      key: "has an account, chosen by the mode";
      consent: "has an account, chosen by the mode";
      none: "has no account in either mode, so the mode is not read";
      unreadable: "is treated as having an account, which is the closed direction";
    }
  >;
  if (kind === "none") return { kind: "none" };

  const mode = asAccountMode(row.accountMode);
  type _ModeDecides = Decides<
    AccountMode,
    {
      personal: "the credential actor's own account — the asker, or a Team Bot's owner";
      shared: "the deployment's one account, whoever asked";
    }
  >;
  if (mode === "personal") return { kind: "person", userId: credentialActorId };
  if (mode === "shared") return { kind: "deployment" };
  return {
    kind: "ambiguous",
    message: `${row.title} does not say whether it is reached through each person's account or a shared one, so it was not called. An administrator can choose on its Plugins page.`,
  };
}

export const DEPLOYMENT_VENDOR_PREFIX = "openbot-deployment:";

/**
 * The identity a deployment's own account is held under at the vendor.
 *
 * THE RANDOM PART IS WHAT RULES OUT A COLLISION WITH A PERSON. Better Auth's ids never contain a
 * colon, but organization-auth mode takes user ids verbatim from its authority, so the prefix alone
 * promises nothing. Minted once per switch to Shared and stored; never recomputed.
 */
export function mintDeploymentVendorUserId(
  deploymentId: string,
  random: () => string = () => randomBytes(16).toString("base64url"),
): string {
  const named = deploymentId.trim();
  if (!named) {
    throw new Error(
      "A deployment with no id cannot hold a shared account; set DEPLOYMENT_ID.",
    );
  }
  return `${DEPLOYMENT_VENDOR_PREFIX}${named}:${random()}`;
}
