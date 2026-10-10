import {
  BrokerRefusalError,
  type AuthConfigOutcome,
  type BrokerApp,
  type BrokerConnection,
  type ConnectedAppBroker,
} from "./broker";
import type { AccountRef } from "./shared-accounts";
import type { OpenConnectorAction, OpenConnectorActions } from "./openconnector";

/**
 * The one module that talks to OpenConnector over HTTP — the vendor as this deployment is allowed
 * to see it, which is a projection onto `fetch`, never their SDK.
 *
 * SPLIT IN TWO LIKE `./composio-adapter`, for the reason that file gives: {@link
 * buildOpenConnectorClient} is pure assembly over an injectable dial, so every test below it is an
 * object literal and no socket is ever opened; {@link createOpenConnectorClient} is the thin layer
 * that owns the real `fetch`, the base address and the two tokens. Nothing else in this deployment
 * may construct a URL, a header or a body that reaches OpenConnector.
 *
 * THE TRUST BOUNDARY OF THE BASE ADDRESS, WRITTEN DOWN BECAUSE IT IS THE SECURITY POSTURE OF THIS
 * FILE. Every outbound request this adapter ever issues is `new URL(<literal path>, base)` where
 * `base` is the `OPENCONNECTOR_URL` the DEPLOYER set in the environment, read once at boot by
 * `config.ts` — never a value from a request body, a query, a header, a row or anything else a
 * caller has a say in. The paths are literals in this file; the one place a caller-supplied string
 * becomes part of a request is a path SEGMENT (`encodeURIComponent`d service slugs and action ids),
 * which cannot escape the configured origin. Before the client is built the base is VALIDATED — it
 * must parse as an absolute URL, its scheme must be `http` or `https`, and it must carry no user
 * info (`http://user:pass@host` puts a credential in every URL string it appears in) — and an
 * invalid one refuses at construction rather than at first use, because a mis-set variable should
 * stop the boot that mis-set it, not wait for a person's connect attempt to find out.
 *
 * A LOOPBACK BASE (`http://localhost:3100`, the documented default) IS ALLOWED AND IS NOT A HOLE:
 * the address is chosen by the deployment's operator, not by any requester, which puts it in the
 * same trust class as this repository's own `agent-computer` connection — a service this
 * deployment itself runs and reaches over localhost. What the boundary forbids is not the loopback
 * ADDRESS, it is REQUEST INPUT deciding the address; that never happens here. And `redirect:
 * "manual"` on every dial closes the one way a validated base could still lead somewhere else: a
 * redirect answer comes back as a 3xx this code reads as a failure (an `ok` of false), it is never
 * followed, so no vendor-side or in-path redirect can move a token or a typed key to a second host.
 */
export type OpenConnectorConfig = {
  url: string;
  adminToken: string;
  runtimeToken: string;
};

/** One response as this adapter reads it — the two things `Response` already answers. */
type Wire = {
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
};

/**
 * The seam every test stubs: one request, as the assembly layer builds it.
 *
 * THE BODY IS A JSON VALUE RATHER THAN A STRING, which is deliberate and is the whole difference
 * between the two layers below: the assembly layer composes objects (`{ input }`, a connection
 * body) and hands them over intact, so a test's stub sees exactly what this deployment built — and
 * the serialization is the TRANSPORT layer's business, beside the headers it also owns. A dial that
 * stringified would put `'{"input":{}}'` in front of every assertion about what was sent.
 */
export type WireDial = (
  path: string,
  init: { method: string; headers: Record<string, string>; body?: unknown },
) => Promise<Wire>;

/**
 * One field a provider asks a person to type, as far along as the vendor read carries it — the
 * nulls are the parts the provider did not publish, and the broker layer below decides what each
 * of them becomes (or refuses over) rather than the wire read deciding it twice.
 */
type ProviderField = {
  name: string;
  label: string | null;
  help: string | null;
  required: boolean | null;
  secret: boolean | null;
};

/**
 * The vendor as this deployment is allowed to see it — one projection, both token faces.
 *
 * Every method is a name for one REST call this adapter has a reason to make, read into the shapes
 * the broker and the actions client already speak. The wire's envelopes are unwrapped and its
 * failures thrown HERE, so the two consumers above never see an envelope, a status, or a body they
 * have to interpret — exactly the narrowing `ComposioVendor` performs for `./composio-adapter`.
 */
type Vendor = {
  listProviders(): Promise<
    { service: string; name: string; description: string; authType: string | undefined }[]
  >;  listAllActions(): Promise<(OpenConnectorAction & { service: string })[]>;
  providerFields(service: string, authType: string): Promise<ProviderField[]>;
  putConnection(
    service: string,
    body: { authType: string; values: Record<string, string>; connectionName: string },
  ): Promise<void>;
  deleteConnection(service: string, connectionName: string): Promise<void>;
  listConnections(): Promise<{ service: string; connectionName: string }[]>;
};

/** The input kinds a text-box form can draw honestly; everything else is refused, not approximated. */
const TEXT_INPUT_TYPES = ["text", "password", "textarea", "json"] as const;

/**
 * A vendor answer that says the thing this deployment asked about is not there.
 *
 * THROWN RATHER THAN ANSWERED EMPTY, and kept module-private, because only one consumer can act on
 * it: {@link ConnectedAppBroker.revoke}'s contract distinguishes "there was nothing to withdraw"
 * (false) from "the withdrawal failed" (throw), and a 404 on a delete-by-alias is exactly the first
 * of those. Every other 404 — a provider, a directory — stays the failure it arrived as, because
 * for those callers an absent thing is not an answer their question has a shape for.
 */
class OpenConnectorAbsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenConnectorAbsentError";
  }
}

export function buildOpenConnectorClient(input: { dial: WireDial }): {
  actions: OpenConnectorActions;
  broker: ConnectedAppBroker;
} {
  /**
   * THE ONE PLACE A REQUEST IS COMPOSED. Paths are literals; the alias header is added only when a
   * call runs in somebody's connection; the body crosses as the JSON value the caller built. What
   * is deliberately NOT here: the base address, the tokens, the serialization — the transport
   * layer's three facts, so a test stubbing `dial` needs none of them.
   */
  const request = async (
    path: string,
    init: { method: string; body?: unknown },
    alias?: string | null,
  ): Promise<unknown> => {
    const headers: Record<string, string> = {};
    if (alias !== undefined && alias !== null) {
      headers["x-oo-connector-alias"] = alias;
    }
    const wire = await input.dial(path, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    return answerOf(wire);
  };

  const vendor: Vendor = {
  async listProviders() {
    const body = await request("/v1/providers", { method: "GET" });
    return rowsOf(body, "provider directory").flatMap((row) => {
      if (row === null || typeof row !== "object") return [];
      const record = row as Record<string, unknown>;
      if (typeof record.service !== "string" || record.service === "") return [];
      /*
       * THE CATALOGUE PUBLISHES AUTH TYPES AS AN ARRAY (`authTypes: ["api_key"]`), not a singular
       * `authType` — read as the singular, every provider resolved to `undefined` and the whole
       * 1568-provider directory classified `unsupported`, which the live E2E caught within one
       * enable press. The display name is `displayName` on the wire (`name` does not exist), so
       * the read falls through to the service id when even that is absent.
       */
      const authTypes = Array.isArray(record.authTypes)
        ? record.authTypes.filter(
            (candidate): candidate is string => typeof candidate === "string",
          )
        : [];
      return [
        {
          service: record.service,
          name:
            typeof record.displayName === "string" && record.displayName !== ""
              ? record.displayName
              : record.service,
          description: typeof record.description === "string" ? record.description : "",
          authType: pickAuthType(authTypes),
        },
      ];
    });
  },
    async listAllActions() {
      const body = await request("/v1/actions", { method: "GET" });
      return rowsOf(body, "action directory").flatMap((row) => {
        if (row === null || typeof row !== "object") return [];
        const record = row as Record<string, unknown>;
        if (typeof record.service !== "string" || typeof record.id !== "string") return [];
        return [
          {
            service: record.service,
            id: record.id,
            description: typeof record.description === "string" ? record.description : "",
            inputSchema:
              record.inputSchema !== null && typeof record.inputSchema === "object"
                ? record.inputSchema
                : null,
          },
        ];
      });
    },
    async providerFields(service, authType) {
      const body = await request(
        `/api/providers/${encodeURIComponent(service)}`,
        { method: "GET" },
      );
      const detail = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : null;
      const auth = Array.isArray(detail?.auth) ? (detail.auth as unknown[]) : null;
      const entry = (auth ?? []).find(
        (candidate) =>
          candidate !== null &&
          typeof candidate === "object" &&
          (candidate as Record<string, unknown>).type === authType,
      );
      const record =
        entry !== null && entry !== undefined && typeof entry === "object"
          ? (entry as Record<string, unknown>)
          : null;
      if (record === null) {
        throw new BrokerRefusalError(
          `OpenConnector publishes no ${authType} fields for ${service} that this deployment could read, so the form was refused rather than guessed. Check the container's provider catalogue.`,
        );
      }
      /*
       * THE API-KEY ENTRY DESCRIBES ONE IMPLICIT FIELD. OpenConnector's provider definition carries
       * the label and the description for the credential on the AUTH entry itself and names the
       * value `apiKey` on the wire (its own connection input reads `values: { ...extra, apiKey }`),
       * so the form's first box is composed here rather than read — and it is composed as required
       * and secret because it IS the credential, which is a fact about the auth type rather than a
       * guess about metadata. `extraFields` (api_key) and `fields` (custom_credential) are the
       * declared field lists, and they are the only other source.
       */
      const declared =
        authType === "api_key"
          ? [
              {
                key: "apiKey",
                label: typeof record.label === "string" ? record.label : null,
                description: typeof record.description === "string" ? record.description : null,
                inputType: "text",
                required: true,
                secret: true,
              },
              ...(Array.isArray(record.extraFields) ? (record.extraFields as unknown[]) : []),
            ]
          : authType === "custom_credential"
            ? Array.isArray(record.fields)
              ? (record.fields as unknown[])
              : null
            : [];
      if (declared === null) {
        throw new BrokerRefusalError(
          `OpenConnector's ${authType} entry for ${service} has no field list this deployment could read, so the form was refused rather than guessed.`,
        );
      }
      const fields: ProviderField[] = [];
      for (const raw of declared) {
        if (raw === null || typeof raw !== "object") {
          throw new BrokerRefusalError(
            `OpenConnector's field list for ${service} has an entry that could not be read as a field, so the form was refused rather than drawn with a guess.`,
          );
        }
        const field = raw as Record<string, unknown>;
        if (typeof field.key !== "string" || field.key === "") {
          throw new BrokerRefusalError(
            `OpenConnector's field list for ${service} has an entry whose name could not be read, so the form was refused rather than drawn with a guess.`,
          );
        }
        if (typeof field.required !== "boolean" || typeof field.secret !== "boolean") {
          throw new BrokerRefusalError(
            `OpenConnector's "${field.key}" field on ${service} has a required or secret flag that could not be read, so the form was refused rather than guessed — an unreadable mask would show a credential in clear.`,
          );
        }
        if (
          typeof field.inputType !== "string" ||
          !(TEXT_INPUT_TYPES as readonly string[]).includes(field.inputType)
        ) {
          throw new BrokerRefusalError(
            `OpenConnector's "${field.key}" field on ${service} asks for input of a kind that could not be read as text, so the form was refused rather than approximated.`,
          );
        }
        fields.push({
          name: field.key,
          label: typeof field.label === "string" && field.label !== "" ? field.label : field.key,
          help: typeof field.description === "string" ? field.description : null,
          required: field.required,
          secret: field.secret,
        });
      }
      return fields;
    },
    async putConnection(service, body) {
      await request(`/api/connections/${encodeURIComponent(service)}`, {
        method: "PUT",
        body: {
          authType: body.authType,
          values: body.values,
          connectionName: body.connectionName,
        },
      });
    },
    async deleteConnection(service, connectionName) {
      await request(
        `/api/connections/${encodeURIComponent(service)}?connectionName=${encodeURIComponent(connectionName)}`,
        { method: "DELETE" },
      );
    },
    async listConnections() {
      const body = await request("/api/connections", { method: "GET" });
      return rowsOf(body, "connection list").flatMap((row) => {
        if (row === null || typeof row !== "object") return [];
        const record = row as Record<string, unknown>;
        if (typeof record.service !== "string" || typeof record.connectionName !== "string") {
          return [];
        }
        return [{ service: record.service, connectionName: record.connectionName }];
      });
    },
  };

  const actions: OpenConnectorActions = {
    async listActions(service) {
      /*
       * FILTERED, NOT RE-DIALLED, because the directory endpoint already fetched every action for
       * `listApps`; a per-service query would be a second copy of the same answer held against the
       * first. The route-level TTL cache in `routes.ts` is what keeps the transport's listing honest
       * on this arrangement — see the composio twin for the shape.
       */
      const all = await vendor.listAllActions();
      return all
        .filter((action) => action.service === service)
        .map((action) => ({
          id: action.id,
          description: action.description,
          inputSchema: action.inputSchema,
        }));
    },
    async execute(call, args) {
      const body = await request(
        `/v1/actions/${encodeURIComponent(call.actionId)}`,
        { method: "POST", body: { input: args } },
        call.alias,
      );
      return { data: body };
    },
  };

  const broker: ConnectedAppBroker = {
    async listApps(): Promise<BrokerApp[]> {
      const [providers, actions] = await Promise.all([
        vendor.listProviders(),
        vendor.listAllActions(),
      ]);
      const counts = new Map<string, number>();
      for (const action of actions) {
        counts.set(action.service, (counts.get(action.service) ?? 0) + 1);
      }
      return providers.map((provider) => ({
        slug: provider.service,
        name: provider.name,
        description: provider.description,
        /*
         * NULL BECAUSE THE VENDOR PUBLISHES NONE, unlike Composio's logo urls — a missing image is
         * what the picker already draws for a toolkit without one.
         */
        logo: null,
        categories: [],
        actionCount: counts.get(provider.service) ?? 0,
        connection: connectionFor(provider.authType),
      }));
    },
    async ensureAuthConfig(): Promise<AuthConfigOutcome> {
      /*
       * "NOT-NEEDED" BECAUSE THERE IS NO CONFIG TO MAKE. OpenConnector holds a connection as the
       * credential itself — the person's key, PUT once at connect time under the alias — and has no
       * per-deployment auth config for a key or custom-credential provider at all. The outcome that
       * matters to the caller (`addBrokeredApp`) is the third one on the interface: nothing was
       * created, so nothing can disagree with the scheme recorded on the row.
       */
      return "not-needed";
    },
    async deleteAuthConfig(): Promise<void> {
      /*
       * NOTHING TO DELETE, for `ensureAuthConfig`' reason: no config was ever created, so removing
       * an app has nothing of this deployment's own to withdraw at the broker. What removing an app
       * DOES have to withdraw — the connections people made — is the store's business, done through
       * `revoke` per account, not through this method.
       */
    },
    async authorize(): Promise<{ redirectUrl: string }> {
      throw new BrokerRefusalError(
        "This app connects through a consent screen, and consent apps are not offered through OpenConnector here yet — there is nowhere to hold the OAuth client it would need. Choose an app that connects with a key.",
      );
    },
    async isConnected(request) {
      const rows = await vendor.listConnections();
      return rows.some(
        (row) =>
          row.service === request.toolkit &&
          row.connectionName === aliasOf(request.account, request.toolkit),
      );
    },
    async revoke(request) {
      const alias = aliasOf(request.account, request.toolkit);
      try {
        await vendor.deleteConnection(request.toolkit, alias);
        return true;
      } catch (error) {
        /*
         * THE ONE ANSWER A 404 CAN GIVE HERE. The interface's boolean is "was there anything to
         * withdraw", and a delete-by-alias that the vendor answers "no such connection" has
         * answered exactly that — false, without a second dial to check first. Every other failure
         * propagates: a refused withdrawal must leave the row standing for a second press.
         */
        if (error instanceof OpenConnectorAbsentError) return false;
        throw error;
      }
    },
    async revokeAccount(accountId) {
      /*
       * TWO ADMIN CALLS FOR AN UNDO PATH PHASE 1 NEVER RUNS, which is the cost accepted here. The
       * accountId IS the alias, and an alias embeds its service only as an escaped tail segment —
       * parsing it back would be reading our own minting in reverse, so instead the admin
       * connection list is scanned for the row whose connectionName is this alias, and THAT row's
       * service names the delete. Nothing matches is a FAILURE on an undo path, not a quiet
       * success: the caller is taking back an account it believes it just made.
       */
      const rows = await vendor.listConnections();
      const row = rows.find((candidate) => candidate.connectionName === accountId);
      if (row === undefined) {
        throw new Error(
          `OpenConnector has no connection under ${accountId} — nothing was there to take back, which is a failure on an undo path rather than a quiet success.`,
        );
      }
      await vendor.deleteConnection(row.service, accountId);
    },
    async connectionFields(request) {
      const fields = await vendor.providerFields(
        request.toolkit,
        authTypeFor(request.authScheme),
      );
      /*
       * MAPPED HERE RATHER THAN IN THE VENDOR READ, because the refusal is this deployment's
       * sentence and the vendor layer already refused everything unreadable — what is left to decide
       * is presentation: a label the provider did not publish becomes the field's own name (the
       * person still gets a box they can name), and no help sentence becomes the empty one the form
       * already renders.
       */
      return fields.map((field) => ({
        name: field.name,
        label: field.label ?? field.name,
        help: field.help ?? "",
        required: field.required ?? true,
        secret: field.secret ?? true,
      }));
    },
    async connectWithFields(request) {
      /*
       * THE NO-`cause` RULE'S TWIN, for `./broker`'s reason: a failure here carries somebody's
       * just-typed credential in the request it names, so the vendor's sentence is rethrown with no
       * request object attached — `request` below composes the throw already stripped, and nothing
       * else in this file appends one.
       */
      await vendor.putConnection(request.toolkit, {
        authType: authTypeFor(request.authScheme),
        values: request.values,
        connectionName: request.account.vendorUserId,
      });
      return { accountId: request.account.vendorUserId };
    },
    async accountName() {
      /*
       * NULL BECAUSE OPENCONNECTOR PUBLISHES NO ACCOUNT DISPLAY NAME for a key connection — the
       * connection IS a key under a name this deployment minted, and the person knows which key it
       * is because they typed it. Inventing one (the service, the alias) would put a label beside
       * the row that looks like the vendor vouching for it.
       */
      return null;
    },
  };

  return { actions, broker };
}

export function createOpenConnectorClient(config: OpenConnectorConfig): {
  actions: OpenConnectorActions;
  broker: ConnectedAppBroker;
} {
  const base = outboundBase(config.url);
  const dial: WireDial = (path, init) => {
    const url = new URL(path, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(
        "This deployment's OpenConnector base resolved to a scheme it refuses to dial; only http and https are allowed.",
      );
    }
    /*
     * THE FACE IS THE PATH, because the vendor draws the line the same way: `/v1/*` answers to the
     * runtime token, everything under `/api/*` to the admin one. Deciding by prefix here — rather
     * than threading a face argument through the assembly layer — keeps the tokens entirely inside
     * this closure, which is the one place `OpenConnectorConfig` is destructured.
     */
    const token = path.startsWith("/v1/") ? config.runtimeToken : config.adminToken;
    return fetch(url, {
      method: init.method,
      redirect: "manual",
      headers: {
        ...init.headers,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        Authorization: `Bearer ${token}`,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  };
  return buildOpenConnectorClient({ dial });
}

/**
 * The validated base every outbound request is resolved against, or a refusal naming the setting.
 *
 * REFUSED AT CONSTRUCTION RATHER THAN AT FIRST USE, because a base this code cannot dial is a
 * deployment error the operator can fix in one place — and a boot that carries it silently is a
 * boot whose first OpenConnector failure arrives dressed as a vendor outage. The three checks are
 * the trust boundary above, stated as code: `new URL` must parse it (relative strings, empty
 * values, schemeless hosts all refuse here), the scheme must be `http` or `https` (everything else
 * — `ftp`, `file`, a broker url like `openconnector://github` — is not an address this deployment
 * dials), and it must carry no user info, because `http://user:pass@host` embeds a credential in
 * every URL string derived from it — in logs, in errors, in anything that ever prints the base.
 *
 * THE ADDRESS IS AN ORIGIN: any path on it is not carried into a request, because the requests
 * below are absolute paths resolved against it. A deployer who needs a prefix must put it on the
 * proxy in front of the container, not on this variable.
 */
function outboundBase(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "OPENCONNECTOR_URL is not an address this deployment can dial. Set it to the absolute http:// or https:// origin of this deployment's OpenConnector container, such as http://localhost:3100.",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      "OPENCONNECTOR_URL must be an http:// or https:// address. Other schemes are not dialed, so the OpenConnector client was not built.",
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(
      "OPENCONNECTOR_URL must not carry user info (a user:pass@ prefix). It names where the container listens, not who to authenticate as; the tokens belong in OPENCONNECTOR_ADMIN_TOKEN and OPENCONNECTOR_RUNTIME_TOKEN.",
    );
  }
  return parsed;
}

/**
 * A vendor-named failure, raised as the absent thing when the wire says 404 — the one status
 * {@link answerOf} reads — and as the vendor's own plain sentence otherwise.
 */
function absentOrPlain(wire: Wire, message: string): Error {
  return wire.status === 404 ? new OpenConnectorAbsentError(message) : new Error(message);
}

/**
 * ONE READING OF ONE RESPONSE, so no caller above re-derives it. A body that is not JSON is a
 * refusal rather than a guess ("could not be read", never an empty answer standing in for one); a
 * body the vendor marked `{ success: false }` fails with the vendor's own sentence, which is the
 * only message this deployment treats as written for a person; and an `ok` of false that arrives
 * as 404 is the ONE status read here — lifted into {@link OpenConnectorAbsentError} for `revoke`'s
 * boolean, while every other failure names the status it came with when the vendor said nothing.
 */
async function answerOf(wire: Wire): Promise<unknown> {
  let body: unknown;
  try {
    body = await wire.json();
  } catch {
    throw new Error(
      "OpenConnector answered with something this deployment could not be read as JSON. Check the container and the address in OPENCONNECTOR_URL.",
    );
  }
  const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const vendorMessage = (candidate: Record<string, unknown> | null): string | null => {
    if (candidate === null) return null;
    if (typeof candidate.message === "string" && candidate.message.trim() !== "") {
      return candidate.message;
    }
    const nested = candidate.error;
    if (nested !== null && typeof nested === "object") {
      const nestedMessage = (nested as Record<string, unknown>).message;
      if (typeof nestedMessage === "string" && nestedMessage.trim() !== "") {
        return nestedMessage;
      }
    }
    return null;
  };
  if (record !== null && record.success === false) {
    const message = vendorMessage(record);
    if (message !== null) {
      throw absentOrPlain(wire, message);
    }
  }
  if (!wire.ok) {
    const message = vendorMessage(record);
    if (message !== null) {
      throw absentOrPlain(wire, message);
    }
    if (wire.status === 404) {
      throw new OpenConnectorAbsentError(
        "OpenConnector reported that nothing was there to act on.",
      );
    }
    throw new Error(
      `OpenConnector answered this deployment's request with a failure (${wire.status ?? "an unreadable status"}) and no reason. Check its container and its logs.`,
    );
  }
  /*
   * THE ENVELOPE IS UNWRAPPED ONCE, HERE, because the vendor is not of one mind about it: the
   * runtime face answers `{ data: ... }`, while some admin endpoints answer the payload bare. A
   * body carrying a `data` key IS the envelope; anything else is the payload itself, and both
   * readings reach the caller as one shape.
   */
  if (record !== null && "data" in record) {
    return record.data;
  }
  return body;
}

function rowsOf(body: unknown, noun: string): unknown[] {
  if (!Array.isArray(body)) {
    throw new Error(
      `OpenConnector's ${noun} came back in a shape this deployment could not read. Check the container's version against the address in OPENCONNECTOR_URL.`,
    );
  }
  return body;
}

/**
 * How a provider's auth type becomes the one fact everything else reads. `no_auth` and the two
 * field kinds map onto the connections this deployment can drive; EVERYTHING ELSE — `oauth2`, an
 * auth type this deployment does not recognize, or none published at all — is `unsupported`, which
 * is the closed direction: the picker hides it, the enable path refuses it, and nobody meets an
 * Add button that can only fail.
 */
/**
 * The one member of a provider's published `authTypes` this deployment will drive, by a fixed
 * priority — a provider may publish several (Airtable lists `oauth2` beside `api_key`), and the
 * choice must not depend on array order. `api_key` wins over `no_auth` because a keyless read of
 * a provider that offers a keyed one runs under the vendor's anonymous limits nobody here can see;
 * `oauth2`-only providers keep no member and land in {@link connectionFor}'s `unsupported`, which
 * is the closed direction: the picker hides them, nobody meets an Add button that can only fail.
 */
function pickAuthType(authTypes: string[]): string | undefined {
  if (authTypes.includes("api_key")) return "api_key";
  if (authTypes.includes("custom_credential")) return "custom_credential";
  if (authTypes.includes("no_auth")) return "no_auth";
  return undefined;
}

function connectionFor(authType: string | undefined): BrokerConnection {
  if (authType === "no_auth") return { kind: "no-auth" };
  if (authType === "api_key") return { kind: "fields", authScheme: "API_KEY" };
  if (authType === "custom_credential") {
    return { kind: "fields", authScheme: "CUSTOM_CREDENTIAL" };
  }
  return {
    kind: "unsupported",
    reason: `connects through ${authType ?? "an auth type this deployment could not read"}, which this deployment does not drive yet`,
  };
}

/**
 * The inverse of {@link connectionFor}, for the one body this adapter writes that names an auth
 * type. Phase 1 records only `API_KEY` and `CUSTOM_CREDENTIAL` on an OpenConnector row — `no-auth`
 * rows connect nothing and `unsupported` rows are never enabled — so the two members are the whole
 * honest domain, and anything else arriving here is a scheme this deployment never wrote.
 */
function authTypeFor(scheme: string): string {
  if (scheme === "CUSTOM_CREDENTIAL") return "custom_credential";
  return "api_key";
}

/**
 * The connection an account's calls run in, at the broker. NOT re-minted here — the alias was
 * minted by `./openconnector` from ids this deployment trusts and rides the account's
 * `vendorUserId` to this seam, so this function is a pass-through that says so: a second minting
 * would be a second answer to "which connection is this person's", which is exactly the drift the
 * one-minting rule exists to prevent.
 */
function aliasOf(account: AccountRef, _service: string): string {
  return account.vendorUserId;
}
