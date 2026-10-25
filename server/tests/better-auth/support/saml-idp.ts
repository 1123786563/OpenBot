/*
 * A SAML identity provider that signs real Response/Assertion pairs for the
 * better-auth suites (T01.07, interface §5 SsoEvidenceBridge).
 *
 * SAML's POST binding is front-channel only: the IdP hands the browser a
 * form-encoded base64 SAMLResponse aimed at the SP's ACS, and there is no
 * back channel for the SP to interrogate. That is why this fixture is a
 * signer, not a server: what the contract under test needs is a genuinely
 * enveloped-signed XML-DSig assertion — exclusive C14N, SHA-256 digest,
 * RSA-SHA256 signature — whose signed bytes the bridge must recompute from
 * the parsed document, never trust from the transport form.
 *
 * The canonicalization and digest here are deliberately a second
 * implementation, built on a constructor-side node model rather than on the
 * parser the bridge uses: if both sides had to agree byte-for-byte on output
 * they derive through different code, agreement is evidence the bridge
 * canonicalizes, not that both share one bug (the same discipline as the
 * OIDC fixture's independent S256).
 *
 * `assertion()` signs whatever it is told to sign, including values that are
 * wrong for OpenBot — a foreign InResponseTo, another SP's audience, an
 * unsigned response, a future AuthnInstant — because those are the negative
 * cases: a signature over hostile content proves the binding checks, not just
 * the signature, are what refuses it.
 */

export const SAML_ASSERTION_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
export const SAML_PROTOCOL_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
export const XMLDSIG_NS = "http://www.w3.org/2000/09/xmldsig#";
export const BEARER_CONFIRMATION = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
export const STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";
export const STATUS_RESPONDER = "urn:oasis:names:tc:SAML:2.0:status:Responder";
export const DEFAULT_AUTHN_CONTEXT_CLASS =
  "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport";

export interface SamlAssertionInput {
  /** The AuthnRequest ID the response answers; both Response and
   * SubjectConfirmationData carry it as InResponseTo. */
  inResponseTo: string;
  /** The SP's assertion consumer service URL (Recipient / Destination). */
  acsUrl: string;
  /** The SP's entity ID (Audience). */
  spEntityId: string;
  /** The IdP's entity ID (Issuer); defaults to this IdP's own. */
  issuer?: string;
  /** The persistent NameID; defaults to the test subject. */
  subject?: string;
  /** AuthnStatement@AuthnInstant, epoch seconds. */
  authnInstant: number;
  /** Assertion/Response IssueInstant, epoch seconds. */
  issueInstant: number;
  /** Conditions@NotBefore, epoch seconds. */
  notBefore: number;
  /** Conditions@NotOnOrAfter and SubjectConfirmationData@NotOnOrAfter. */
  notOnOrAfter: number;
  /** AuthnContextClassRef; `null` omits the element entirely. */
  authnContextClassRef?: string | null;
  /** How the assertion is signed (default `valid`). */
  signature?: "valid" | "foreign" | "tampered" | "unsigned";
  /** Omit SubjectConfirmationData entirely (recipient binding gone). */
  omitSubjectConfirmationData?: boolean;
  /** Override the Audience inside AudienceRestriction. */
  audience?: string;
  /** Override SubjectConfirmationData@Recipient. */
  recipient?: string;
  /** Override Response@Destination. */
  destination?: string;
  /** Override SubjectConfirmationData@InResponseTo only. */
  subjectInResponseTo?: string;
  /** Omit AuthnStatement@AuthnInstant while keeping the statement. */
  omitAuthnInstant?: boolean;
  /** Response top-level StatusCode value (default Success). */
  status?: string;
}

export interface SamlTestIdp {
  /** The entity ID assertions carry as their Issuer. */
  entityId: string;
  /** The public key this IdP signs with, PEM SubjectPublicKeyInfo. */
  signingKeyPem: string;
  /** Build the base64 SAMLResponse of a POST-binding form for these inputs. */
  assertion(input: SamlAssertionInput): Promise<string>;
}

/** A constructor-side element; namespace prefixes resolve against `ns`
 * because this model never inherits — every element names its own scope. */
interface Node {
  ns: string;
  prefix: string | null;
  local: string;
  attrs: { prefix: string | null; local: string; value: string }[];
  children: (Node | string)[];
}

function el(
  ns: string,
  prefix: string | null,
  local: string,
  attrs: { prefix?: string | null; local: string; value: string }[] = [],
  children: (Node | string)[] = [],
): Node {
  return {
    ns,
    prefix,
    local,
    attrs: attrs.map((attr) => ({ ...attr, prefix: attr.prefix ?? null })),
    children,
  };
}

const textEncoder = new TextEncoder();

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value)
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#x9;")
    .replace(/\n/g, "&#xA;")
    .replace(/\r/g, "&#xD;");
}

/*
 * Exclusive canonical XML over the node model: namespace declarations are
 * emitted at the first element that utilizes the prefix (sorted by prefix),
 * attributes sort by (namespace, local), and text escapes per C14N. The
 * transport document is emitted in this same form — it is valid XML however
 * spelled, so canonical output doubles as serialization.
 */
function c14n(node: Node): string {
  const write = (current: Node, inherited: Set<string>): string => {
    const emitted = new Set(inherited);
    const utilized = new Set<string>();
    if (current.prefix) utilized.add(current.prefix);
    for (const attr of current.attrs) {
      if (attr.prefix && attr.prefix !== "xml") utilized.add(attr.prefix);
    }
    const declarations = [...utilized]
      .filter((prefix) => !emitted.has(prefix))
      .sort()
      .map((prefix) => ` xmlns:${prefix}="${escapeAttr(current.ns)}"`);
    for (const prefix of utilized) emitted.add(prefix);
    const qname = current.prefix
      ? `${current.prefix}:${current.local}`
      : current.local;
    const attributes = [...current.attrs]
      .sort((left, right) => {
        const ns =
          (left.prefix ? current.ns : "") < (right.prefix ? current.ns : "")
            ? -1
            : (left.prefix ? current.ns : "") > (right.prefix ? current.ns : "")
              ? 1
              : 0;
        return ns !== 0 ? ns : left.local < right.local ? -1 : 1;
      })
      .map(
        (attr) =>
          ` ${attr.prefix ? `${attr.prefix}:` : ""}${attr.local}="${escapeAttr(attr.value)}"`,
      )
      .join("");
    const open = `<${qname}${declarations.join("")}${attributes}>`;
    const body = current.children
      .map((child) =>
        typeof child === "string" ? escapeText(child) : write(child, emitted),
      )
      .join("");
    return `${open}${body}</${qname}>`;
  };
  return write(node, new Set());
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(input),
  );
  return new Uint8Array(digest);
}

async function generateRsaPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

function pemSpki(publicKey: CryptoKey): Promise<string> {
  return crypto.subtle.exportKey("spki", publicKey).then((der) => {
    const bytes = new Uint8Array(der);
    let body = "";
    for (const byte of bytes) body += String.fromCharCode(byte);
    return `-----BEGIN PUBLIC KEY-----\n${btoa(body)}\n-----END PUBLIC KEY-----`;
  });
}

function isoInstant(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function createSamlTestIdp(): Promise<SamlTestIdp> {
  const entityId = "urn:openbot:test:saml-idp";
  const primary = await generateRsaPair();
  const foreign = await generateRsaPair();
  const signingKeyPem = await pemSpki(primary.publicKey);

  let issued = 0;

  function buildAssertion(input: SamlAssertionInput): Node {
    const id = `_assertion-${++issued}-${crypto.randomUUID()}`;
    const authnStatementAttrs: {
      prefix?: string | null;
      local: string;
      value: string;
    }[] = [];
    if (!input.omitAuthnInstant) {
      authnStatementAttrs.push({
        local: "AuthnInstant",
        value: isoInstant(input.authnInstant),
      });
    }
    const authnContextChildren: (Node | string)[] = [];
    if (input.authnContextClassRef !== null) {
      authnContextChildren.push(
        el(
          SAML_ASSERTION_NS,
          "saml",
          "AuthnContextClassRef",
          [],
          [input.authnContextClassRef ?? DEFAULT_AUTHN_CONTEXT_CLASS],
        ),
      );
    }
    const confirmationChildren: (Node | string)[] = [];
    if (!input.omitSubjectConfirmationData) {
      confirmationChildren.push(
        el(SAML_ASSERTION_NS, "saml", "SubjectConfirmationData", [
          {
            local: "InResponseTo",
            value: input.subjectInResponseTo ?? input.inResponseTo,
          },
          { local: "NotOnOrAfter", value: isoInstant(input.notOnOrAfter) },
          { local: "Recipient", value: input.recipient ?? input.acsUrl },
        ]),
      );
    }
    return el(
      SAML_ASSERTION_NS,
      "saml",
      "Assertion",
      [
        { local: "ID", value: id },
        { local: "IssueInstant", value: isoInstant(input.issueInstant) },
        { local: "Version", value: "2.0" },
      ],
      [
        el(SAML_ASSERTION_NS, "saml", "Issuer", [], [input.issuer ?? entityId]),
        // The Signature is spliced in at index 1 (schema order) once the
        // digest over the assertion without it is known.
        el(
          SAML_ASSERTION_NS,
          "saml",
          "Subject",
          [],
          [
            el(
              SAML_ASSERTION_NS,
              "saml",
              "NameID",
              [
                {
                  local: "Format",
                  value: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
                },
              ],
              [input.subject ?? "saml-test-subject"],
            ),
            el(
              SAML_ASSERTION_NS,
              "saml",
              "SubjectConfirmation",
              [{ local: "Method", value: BEARER_CONFIRMATION }],
              confirmationChildren,
            ),
          ],
        ),
        el(
          SAML_ASSERTION_NS,
          "saml",
          "Conditions",
          [
            { local: "NotBefore", value: isoInstant(input.notBefore) },
            { local: "NotOnOrAfter", value: isoInstant(input.notOnOrAfter) },
          ],
          [
            el(
              SAML_ASSERTION_NS,
              "saml",
              "AudienceRestriction",
              [],
              [
                el(
                  SAML_ASSERTION_NS,
                  "saml",
                  "Audience",
                  [],
                  [input.audience ?? input.spEntityId],
                ),
              ],
            ),
          ],
        ),
        el(SAML_ASSERTION_NS, "saml", "AuthnStatement", authnStatementAttrs, [
          el(
            SAML_ASSERTION_NS,
            "saml",
            "AuthnContext",
            [],
            authnContextChildren,
          ),
        ]),
      ],
    );
  }

  async function signatureOf(assertion: Node): Promise<Node> {
    const assertionId = assertion.attrs.find(
      (attr) => attr.local === "ID",
    )!.value;
    const digest = base64(await sha256(c14n(assertion)));
    const signedInfo = el(
      XMLDSIG_NS,
      "ds",
      "SignedInfo",
      [],
      [
        el(XMLDSIG_NS, "ds", "CanonicalizationMethod", [
          {
            local: "Algorithm",
            value: "http://www.w3.org/2001/10/xml-exc-c14n#",
          },
        ]),
        el(XMLDSIG_NS, "ds", "SignatureMethod", [
          {
            local: "Algorithm",
            value: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
          },
        ]),
        el(
          XMLDSIG_NS,
          "ds",
          "Reference",
          [{ local: "URI", value: `#${assertionId}` }],
          [
            el(
              XMLDSIG_NS,
              "ds",
              "Transforms",
              [],
              [
                el(XMLDSIG_NS, "ds", "Transform", [
                  {
                    local: "Algorithm",
                    value:
                      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
                  },
                ]),
                el(XMLDSIG_NS, "ds", "Transform", [
                  {
                    local: "Algorithm",
                    value: "http://www.w3.org/2001/10/xml-exc-c14n#",
                  },
                ]),
              ],
            ),
            el(XMLDSIG_NS, "ds", "DigestMethod", [
              {
                local: "Algorithm",
                value: "http://www.w3.org/2001/04/xmlenc#sha256",
              },
            ]),
            el(XMLDSIG_NS, "ds", "DigestValue", [], [digest]),
          ],
        ),
      ],
    );
    const key =
      (inputOf(assertion)?.signature ?? "valid") === "foreign"
        ? foreign.privateKey
        : primary.privateKey;
    const raw = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      textEncoder.encode(c14n(signedInfo)),
    );
    let signature = base64(new Uint8Array(raw));
    if (inputOf(assertion)?.signature === "tampered") {
      const bytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
      bytes[bytes.length - 1] ^= 0xff;
      signature = base64(bytes);
    }
    return el(
      XMLDSIG_NS,
      "ds",
      "Signature",
      [],
      [
        signedInfo,
        el(XMLDSIG_NS, "ds", "SignatureValue", [], [signature]),
        el(
          XMLDSIG_NS,
          "ds",
          "KeyInfo",
          [],
          [el(XMLDSIG_NS, "ds", "KeyName", [], ["openbot-saml-test-idp"])],
        ),
      ],
    );
  }

  // buildAssertion needs the inputs at signature time; carry them on the
  // assertion node without ever serializing them.
  const inputs = new WeakMap<Node, SamlAssertionInput>();
  function inputOf(node: Node): SamlAssertionInput | undefined {
    return inputs.get(node);
  }

  return {
    entityId,
    signingKeyPem,
    async assertion(input) {
      const mode = input.signature ?? "valid";
      const assertion = buildAssertion(input);
      inputs.set(assertion, { ...input, signature: mode });
      const children: (Node | string)[] = [assertion.children[0]];
      if (mode !== "unsigned") {
        children.push(await signatureOf(assertion));
      }
      children.push(...assertion.children.slice(1));
      const signedAssertion: Node = { ...assertion, children };
      const response = el(
        SAML_PROTOCOL_NS,
        "samlp",
        "Response",
        [
          {
            local: "ID",
            value: `_response-${++issued}-${crypto.randomUUID()}`,
          },
          { local: "Version", value: "2.0" },
          { local: "IssueInstant", value: isoInstant(input.issueInstant) },
          { local: "Destination", value: input.destination ?? input.acsUrl },
          { local: "InResponseTo", value: input.inResponseTo },
        ],
        [
          el(
            SAML_ASSERTION_NS,
            "saml",
            "Issuer",
            [],
            [input.issuer ?? entityId],
          ),
          el(
            SAML_PROTOCOL_NS,
            "samlp",
            "Status",
            [],
            [
              el(SAML_PROTOCOL_NS, "samlp", "StatusCode", [
                { local: "Value", value: input.status ?? STATUS_SUCCESS },
              ]),
            ],
          ),
          signedAssertion,
        ],
      );
      const text = c14n(response);
      const bytes = textEncoder.encode(text);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    },
  };
}
