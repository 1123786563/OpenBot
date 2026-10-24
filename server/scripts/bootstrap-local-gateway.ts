/**
 * One-off bootstrap for the local Bifrost gateway readiness state (05.x/01.x wiring the
 * B-wave has not productized yet). Run from server/: 
 *   bun --env-file=../.env scripts/bootstrap-local-gateway.ts
 *
 * It writes the endpoint, the admin credential and the conversion rate, then runs the probe
 * and the capability negotiation against the gateway, and prints the readiness verdict.
 * Everything it writes is exactly what the admin API would write; no code path is bypassed.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { credentials, userRoles, users } from "../src/db/schema";
import { createEnterpriseStore } from "../src/admin/settings-store";
import {
	createGatewayAdminCredentialService,
} from "../src/gateway/admin-credential";
import { createConversionRateStore } from "../src/gateway/conversion-rate-store";
import { createGatewayEndpointService } from "../src/gateway/endpoint-config";
import {
	createEnterpriseGatewayProbeStore,
	createGatewayProbeService,
} from "../src/gateway/probe";
import {
	createEnterpriseGatewayNegotiationStore,
	createGatewayCapabilityNegotiationService,
} from "../src/gateway/capability-negotiation";
import { getLogger } from "../../shared/logger";

const GATEWAY_URL = process.env.GATEWAY_URL_OVERRIDE ?? "http://127.0.0.1:9900";
const ADMIN_KEY = `local-gateway-admin-${randomUUID().slice(0, 12)}`;
const ADMIN_ID = `gateway-bootstrap-${randomUUID().slice(0, 8)}`;
const ADMIN_EMAIL = "gateway-bootstrap@openbot.local";
const encryptionKey = process.env.KEY_ENCRYPTION_KEY;

if (!encryptionKey) throw new Error("KEY_ENCRYPTION_KEY missing from environment");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL missing from environment");

const log = getLogger("gateway-bootstrap");
const database = createDatabase(databaseUrl, { max: 2 });
const enterpriseStore = createEnterpriseStore(database);
const endpointService = createGatewayEndpointService({ store: enterpriseStore });
const credentialService = createGatewayAdminCredentialService({
	database,
	encryptionKey,
	member: (userId) => enterpriseStore.member(userId),
});
const rateStore = createConversionRateStore({ database });

// The admin identity the writes are attributed to. Created if the deployment has none.
const existing = await database
	.select({ id: users.id, email: users.email })
	.from(users)
	.where(eq(users.email, ADMIN_EMAIL));
let actor: { userId: string; email: string };
if (existing[0]) {
	actor = { userId: existing[0].id, email: existing[0].email };
	log.info({ actor }, "reusing existing bootstrap admin");
} else {
	await database
		.insert(users)
		.values([{ id: ADMIN_ID, email: ADMIN_EMAIL }])
		.onConflictDoNothing();
	await database
		.insert(userRoles)
		.values([{ userId: ADMIN_ID, role: "admin" }])
		.onConflictDoNothing();
	actor = { userId: ADMIN_ID, email: ADMIN_EMAIL };
	log.info({ actor }, "created bootstrap admin");
}

// 01.1 the endpoint
const endpointResult = await endpointService.saveGatewayEndpoint(
	{ baseUrl: GATEWAY_URL },
	actor,
);
if (!endpointResult.ok) {
	throw new Error(`endpoint save refused: ${JSON.stringify(endpointResult)}`);
}
log.info({ baseUrl: GATEWAY_URL }, "gateway endpoint saved");

// 01.2 the credential
const credentialResult = await credentialService.saveGatewayAdminCredential(
	{ adminKey: ADMIN_KEY },
	actor,
);
if (!credentialResult.ok) {
	throw new Error(`credential save refused: ${JSON.stringify(credentialResult)}`);
}
log.info({ fingerprint: credentialResult.status.fingerprint }, "gateway admin credential saved");

// 01.3/01.4 the conversion rate: 1 USD = 100 credits
await rateStore.save({ numerator: "100", denominator: "1" }, actor.email);
log.info("conversion rate saved (1 USD = 100 credits)");

// 01.5 the probe
const probe = createGatewayProbeService({
	store: createEnterpriseGatewayProbeStore(database),
	readGatewayEndpoint: () => endpointService.readGatewayEndpoint(),
	resolveGatewayAdminCredential: () =>
		credentialService.resolveGatewayAdminCredential(),
	log,
});
const probeRun = await probe.probeGateway();
const probeReason = probeRun.ready ? probeRun.result.reasonCode : probeRun.reasonCode;
log.info({ ready: probeRun.ready, reason: probeReason }, "probe finished");
if (!probeRun.ready) {
	throw new Error(`probe did not succeed: ${probeRun.reasonCode}`);
}

// 01.6 the negotiation
const negotiation = createGatewayCapabilityNegotiationService({
	store: createEnterpriseGatewayNegotiationStore(database),
	readGatewayEndpoint: () => endpointService.readGatewayEndpoint(),
	resolveGatewayAdminCredential: () =>
		credentialService.resolveGatewayAdminCredential(),
	log,
});
const negotiationRun = await negotiation.negotiateGatewayCapabilities();
const negotiationReason = negotiationRun.negotiated
	? negotiationRun.negotiation.reasonCode
	: negotiationRun.reasonCode;
log.info({ negotiated: negotiationRun.negotiated, reason: negotiationReason }, "negotiation finished");
if (!negotiationRun.negotiated) {
	throw new Error(`negotiation did not complete: ${negotiationRun.reasonCode}`);
}

await database.$client.close();
log.info("gateway readiness state is on file; restart the server to pick it up");
