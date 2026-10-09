/**
 * Where the billing provider may be reached, decided before the request is made.
 *
 * A provider base URL is deployment configuration, which makes it more trusted than user input but
 * not trusted: a wrong value here turns the server into a proxy for whatever sits next to it, and
 * the interesting neighbours (the database, the cloud metadata service) are exactly the ones that
 * never appear in a legitimate provider address. So the URL is judged the way a Bot's browsing is
 * judged (../computer/target.ts): a short allow-list of schemes plus a deny-list of destinations,
 * applied up front.
 *
 * This file owns its own tables rather than calling `checkNavigationTarget`, because that function
 * judges browsing on behalf of a person and this needs three things it does not offer: DNS
 * resolution (a hostname that resolves into the deployment is as inside as a literal address), a
 * narrower private-host opt-in (link-local and the rest of reserved space stay refused even then,
 * because no billing provider answers on them), and a verdict rather than a person-facing message.
 * One name is shared with it and imported from it: `isNeverAllowedHostname`, the cloud metadata
 * list, which must not grow a second copy here. Everything else is written to match its semantics
 * (target.ts `canonicalHostname`, `embeddedIpv6`, `expandIpv6`) with a comment at each divergence,
 * because two full copies that drift is how a door opens.
 *
 * TOCTOU, stated plainly: the DNS lookup that vetstes the hostname and the resolution `fetch` does
 * when it connects are two queries, and a hostname can answer them differently (DNS rebinding). The
 * IP is not pinned, because `fetch` has no way to pin an address while keeping the TLS SNI and
 * Host header the certificate and virtual host need. What bounds the window: `redirect: "error"` on
 * every request this module's caller makes (a redirect to a bad address is never followed), and the
 * base URL comes from the deployer's environment rather than from anything a request can influence.
 */
import { lookup } from "node:dns/promises";
import { isNeverAllowedHostname } from "../computer/target";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export type OutboundVerdict = { allowed: true } | { allowed: false; reason: string };

export type OutboundOptions = {
  /**
   * The private-host opt-in, and its exact shape: loopback (127/8, ::1, the 0.0.0.0 and :: literals,
   * localhost and *.localhost), RFC1918 (10/8, 172.16/12, 192.168/16) and fc00::/7 are permitted.
   * Link-local (169.254/16, fe80::/10), CGNAT, TEST-NET, multicast, the rest of reserved space and
   * the cloud metadata addresses are NOT in the opt-in; a deployment that trusts its own network
   * still has no billing business on them.
   */
  allowPrivate?: boolean;
  /** Test seam; production resolves with `node:dns/promises` `lookup({ all: true })`. */
  resolveDns?: (hostname: string) => Promise<{ address: string }[]>;
};

/** How a destination is treated when `allowPrivate` is on. Loopback and private are forgiven; the rest never. */
type AddressKind = "loopback" | "private" | "protected";

function ipv4Kind(
  octets: [number, number, number, number],
): AddressKind | undefined {
  const [a, b] = octets;
  if (a === 127) return "loopback";
  if (octets.every((octet) => octet === 0)) return "loopback"; // 0.0.0.0: "this host"
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 0) return "protected"; // the rest of "this network"
  if (a === 169 && b === 254) return "protected"; // link-local, includes the metadata addresses
  if (a === 100 && b >= 64 && b <= 127) return "protected"; // carrier-grade NAT
  if (a === 192 && b === 0) return "protected"; // 192.0.0.0/24 and TEST-NET-1 192.0.2.0/24
  if (a === 198) {
    // benchmarking 198.18.0.0/15 and TEST-NET-2 198.51.100.0/24
    if (b === 18 || b === 19 || b === 51) return "protected";
  }
  if (a === 203 && b === 0) return "protected"; // TEST-NET-3
  if (a >= 224) return "protected"; // multicast 224/4 and reserved 240/4, incl. 255.255.255.255
  return undefined;
}

/** The IPv4 address an IPv6 one is carrying, if it is carrying one. Mirrors target.ts `embeddedIpv4`. */
function embeddedIpv4(
  groups: number[],
): [number, number, number, number] | null {
  const [a, b, c, d, e, f, high = 0, low = 0] = groups;
  const zeros = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;
  const mapped = zeros && f === 0xffff;
  const compatible = zeros && f === 0;
  const nat64 =
    a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0;

  if (!mapped && !compatible && !nat64) return null;
  /*
   * Divergence from target.ts `embeddedIpv4` (which returns null here): the compatible form's
   * 0.0.0.0/8 tail is unwrapped too, so `::5` (which is `::0.0.0.5` serialised) reaches the IPv4
   * reserved table instead of falling through the IPv6 tables as a public address. The two
   * spellings the private opt-in does name — `::` and `::1` — are recognised before this runs.
   */
  return [high >> 8, high & 255, low >> 8, low & 255];
}

/** The eight groups of an IPv6 address, compression expanded. Mirrors target.ts `expandIpv6`. */
function expandIpv6(hostname: string): number[] | null {
  // An IPv4 tail (`::ffff:127.0.0.1`) is legal in an IPv6 literal. `new URL` serialises it away into
  // hexadecimal groups, so this is belt and braces for hostnames that reached here un-parsed.
  const v4tail = /(^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(hostname);
  const prepared = v4tail
    ? hostname.slice(0, hostname.length - v4tail[2].length)
    : hostname;
  const tailOctets = v4tail
    ? v4tail[2].split(".").map((part) => Number.parseInt(part, 10))
    : undefined;
  if (tailOctets?.some((octet) => Number.isNaN(octet) || octet > 255)) {
    return null;
  }

  // A `::` splits into exactly two halves; either half may be empty (`::1`, `fe80::`).
  const halves = prepared.split("::");
  if (halves.length > 2) return null;

  const parse = (part: string) =>
    part === "" ? [] : part.split(":").map((group) => Number.parseInt(group, 16));
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const extra = tailOctets
    ? [(tailOctets[0] << 8) | tailOctets[1], (tailOctets[2] << 8) | tailOctets[3]]
    : [];
  const all = [...head, ...tail, ...extra];
  if (all.some((group) => Number.isNaN(group))) return null;

  if (halves.length === 1) return all.length === 8 ? all : null;
  const missing = 8 - all.length;
  if (missing < 0) return null;
  return [...head, ...Array(missing).fill(0), ...tail, ...extra];
}

function ipv6Kind(groups: number[]): AddressKind | undefined {
  if (groups.every((group) => group === 0)) return "loopback"; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return "loopback"; // ::1
  }
  const embedded = embeddedIpv4(groups);
  if (embedded) return ipv4Kind(embedded);
  const [first, second] = groups as [number, number, ...number[]];
  if (first >= 0xfe80 && first <= 0xfebf) return "protected"; // link-local
  if (first >= 0xfc00 && first <= 0xfdff) return "private"; // unique-local
  if (first >= 0xff00) return "protected"; // multicast
  if (first === 0x2001 && second === 0x0db8) return "protected"; // documentation
  if (first === 0x0100 && groups.slice(1, 4).every((group) => group === 0)) {
    return "protected"; // discard-only 100::/64
  }
  return undefined;
}

function parseIpv4(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  if (!/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(hostname)) {
    return null;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
    return null;
  }
  return octets as [number, number, number, number];
}

function isLocalhostName(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

/** One hostname reduced and judged; `dns` means the tables cannot answer it yet. */
function judgeHostname(
  hostname: string,
): { kind: AddressKind | undefined; dns: boolean } {
  // The root dot. `example.com.` and `example.com` are the same name to DNS and to fetch.
  const name = hostname.replace(/\.+$/, "");
  if (!name.startsWith("[") || !name.endsWith("]")) {
    const ipv4 = parseIpv4(name);
    if (ipv4) return { kind: ipv4Kind(ipv4), dns: false };
    if (name.includes(":")) {
      const groups = expandIpv6(name);
      if (groups) return { kind: ipv6Kind(groups), dns: false };
    }
    if (isLocalhostName(name)) return { kind: "loopback", dns: false };
    // The metadata list is matched after canonicalisation, exactly as target.ts does, so the
    // trailing-dot and IPv6 spellings are seen through here as well.
    if (isNeverAllowedHostname(name)) return { kind: "protected", dns: false };
    return { kind: undefined, dns: true };
  }
  const inner = name.slice(1, -1);
  const groups = expandIpv6(inner);
  if (groups) return { kind: ipv6Kind(groups), dns: false };
  if (isNeverAllowedHostname(inner)) return { kind: "protected", dns: false };
  return { kind: undefined, dns: true };
}

/**
 * Decide whether a URL may be opened as the billing provider.
 *
 * Order: parse, then the scheme allow-list, then the destination tables on the literal hostname,
 * then (for a name, not an address) DNS resolution with every answer re-judged as an address. A
 * hostname whose lookup fails is refused rather than passed through: an unresolvable provider is
 * not a deployment we can vouch for.
 */
export async function checkOutboundUrl(
  raw: string,
  options: OutboundOptions = {},
): Promise<OutboundVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: "The billing provider URL is not a URL." };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return {
      allowed: false,
      reason: "The billing provider must be reached over http or https.",
    };
  }

  const { kind, dns } = judgeHostname(url.hostname.toLowerCase());
  if (!dns) return kindVerdict(kind, options.allowPrivate === true);

  let answers: { address: string }[];
  try {
    const resolve = options.resolveDns ?? defaultResolveDns;
    answers = await resolve(url.hostname.toLowerCase());
  } catch {
    return {
      allowed: false,
      reason: "The billing provider hostname does not resolve.",
    };
  }
  if (answers.length === 0) {
    return {
      allowed: false,
      reason: "The billing provider hostname resolves to nothing.",
    };
  }
  for (const answer of answers) {
    const judged = judgeHostname(answer.address.toLowerCase());
    // `protected` here also catches a hostname on the metadata list resolving anywhere else.
    if (judged.dns) continue;
    if (judged.kind !== undefined) {
      const verdict = kindVerdict(judged.kind, options.allowPrivate === true);
      if (!verdict.allowed) return verdict;
    }
  }
  return { allowed: true };
}

function kindVerdict(
  kind: AddressKind | undefined,
  allowPrivate: boolean,
): OutboundVerdict {
  if (kind === undefined) return { allowed: true };
  if (allowPrivate && (kind === "loopback" || kind === "private")) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason:
      kind === "loopback" || kind === "private"
        ? "The billing provider address is inside this deployment's own network."
        : "The billing provider address is reserved, so it is never called.",
  };
}

async function defaultResolveDns(hostname: string) {
  return lookup(hostname, { all: true });
}
