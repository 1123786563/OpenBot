import { describe, expect, test } from "../../tests/support/e2e-compat";
import { checkOutboundUrl } from "../src/billing/outbound";

/** A resolver that answers one fixed address, so no test touches a real DNS server. */
function resolvesTo(...addresses: string[]) {
  const seen: string[] = [];
  return {
    seen,
    resolveDns: async (hostname: string) => {
      seen.push(hostname);
      return addresses.map((address) => ({ address }));
    },
  };
}

/** Every destination the default posture (no private-host opt-in) must refuse. */
const REFUSED = [
  "localhost",
  "http://localhost",
  "https://app.localhost:8080",
  "http://127.0.0.1",
  "https://127.8.8.8",
  "http://[::1]",
  "http://0.0.0.0",
  "http://0.0.0.5",
  "http://10.0.0.1",
  "http://172.16.0.1",
  "http://172.31.255.255",
  "http://192.168.1.1",
  "http://169.254.1.1",
  "http://169.254.169.254",
  "http://metadata.google.internal",
  "http://metadata.goog",
  "http://100.64.1.1",
  "http://100.100.100.200",
  "http://192.0.0.9",
  "http://192.0.2.1",
  "http://198.18.5.5",
  "http://198.19.5.5",
  "http://198.51.100.7",
  "http://203.0.113.9",
  "http://224.0.0.1",
  "http://239.255.255.1",
  "http://240.0.0.1",
  "http://255.255.255.255",
  "http://[fc00::1]",
  "http://[fd12::1]",
  "http://[fe80::1]",
  "http://[ff02::1]",
  "http://[ff0e::1]",
  "http://[2001:db8::1]",
  "http://[100::]",
  "file:///etc/passwd",
  "gopher://127.0.0.1:7070",
];

/** `new URL` normalises these inet_aton shorthands to dotted quad before the tables run. */
const REFUSED_SHORTHAND = [
  ["http://127.1", "127.0.0.1"],
  ["http://2130706433", "127.0.0.1"],
  ["http://0x7f000001", "127.0.0.1"],
] as const;

/** An IPv4 address riding inside an IPv6 literal is the IPv4 address. */
const REFUSED_EMBEDDED = [
  "http://[::ffff:127.0.0.1]",
  "http://[::ffff:10.0.0.1]",
  "http://[::ffff:100.64.1.1]",
  "http://[::ffff:192.0.2.1]",
  "http://[::ffff:198.51.100.7]",
  "http://[64:ff9b::100.64.1.1]",
  "http://[64:ff9b::10.0.0.1]",
  "http://[::100.64.1.1]",
  "http://[::ffff:169.254.169.254]",
];

describe("checkOutboundUrl default posture", () => {
  test.each(REFUSED)("refuses %s", async (raw) => {
    const verdict = await checkOutboundUrl(raw);
    expect(verdict).toMatchObject({ allowed: false });
  });

  test.each(REFUSED_SHORTHAND)("refuses %s (as %s)", async (raw) => {
    const verdict = await checkOutboundUrl(raw);
    expect(verdict).toMatchObject({ allowed: false });
  });

  test.each(REFUSED_EMBEDDED)("refuses embedded-IPv4 %s", async (raw) => {
    const verdict = await checkOutboundUrl(raw);
    expect(verdict).toMatchObject({ allowed: false });
  });

  test("refuses a name that resolves into the deployment", async () => {
    const verdict = await checkOutboundUrl("https://provider.example.test", {
      resolveDns: resolvesTo("10.0.0.7").resolveDns,
    });
    expect(verdict).toMatchObject({ allowed: false });
  });

  test("refuses a name when any resolved address is reserved", async () => {
    const verdict = await checkOutboundUrl("https://provider.example.test", {
      resolveDns: resolvesTo("93.184.216.34", "169.254.169.254").resolveDns,
    });
    expect(verdict).toMatchObject({ allowed: false });
  });

  test("refuses a name that resolves to an IPv6 unique-local address", async () => {
    const verdict = await checkOutboundUrl("https://provider.example.test", {
      resolveDns: resolvesTo("fd12::1").resolveDns,
    });
    expect(verdict).toMatchObject({ allowed: false });
  });

  test("refuses a name whose lookup fails rather than passing it through", async () => {
    const verdict = await checkOutboundUrl("https://provider.example.test", {
      resolveDns: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(verdict).toMatchObject({ allowed: false });
  });

  test("refuses a name that resolves to nothing", async () => {
    const verdict = await checkOutboundUrl("https://provider.example.test", {
      resolveDns: resolvesTo().resolveDns,
    });
    expect(verdict).toMatchObject({ allowed: false });
  });

  test("refuses the metadata hostname even written with a root dot", async () => {
    const verdict = await checkOutboundUrl("http://metadata.google.internal.");
    expect(verdict).toMatchObject({ allowed: false });
  });

  test("allows a public https address by literal", async () => {
    const verdict = await checkOutboundUrl("https://93.184.216.34/api/v1");
    expect(verdict).toEqual({ allowed: true });
  });

  test("allows a public name and does not treat a literal as a DNS question", async () => {
    const resolver = resolvesTo("93.184.216.34");
    const verdict = await checkOutboundUrl("https://provider.example.test", {
      resolveDns: resolver.resolveDns,
    });
    expect(verdict).toEqual({ allowed: true });
    expect(resolver.seen).toEqual(["provider.example.test"]);
  });

  test("allows a public IPv6 name", async () => {
    const verdict = await checkOutboundUrl("https://provider.example.test", {
      resolveDns: resolvesTo("2606:2800:220:1:248:1893:25c8:1946").resolveDns,
    });
    expect(verdict).toEqual({ allowed: true });
  });
});

describe("checkOutboundUrl private-host opt-in", () => {
  const OPT_IN = { allowPrivate: true } as const;

  test.each([
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "https://10.1.2.3",
    "http://172.20.0.5",
    "http://192.168.1.1",
    "http://[fc00::1]",
    "http://[fd12::1]",
    "http://[::1]",
    "http://0.0.0.0",
  ])("allows the opted-in address %s", async (raw) => {
    const verdict = await checkOutboundUrl(raw, OPT_IN);
    expect(verdict).toEqual({ allowed: true });
  });

  test.each([
    "http://169.254.1.1",
    "http://169.254.169.254",
    "http://metadata.google.internal",
    "http://[fe80::1]",
    "http://100.64.1.1",
    "http://224.0.0.1",
    "http://192.0.2.1",
    "http://203.0.113.9",
    "http://[ff02::1]",
    "http://[2001:db8::1]",
    "http://0.0.0.5",
  ])("still refuses %s under the opt-in", async (raw) => {
    const verdict = await checkOutboundUrl(raw, OPT_IN);
    expect(verdict).toMatchObject({ allowed: false });
  });

  test("allows a name that resolves to an opted-in address", async () => {
    const verdict = await checkOutboundUrl("https://provider.internal.test", {
      allowPrivate: true,
      resolveDns: resolvesTo("10.0.0.7").resolveDns,
    });
    expect(verdict).toEqual({ allowed: true });
  });

  test("still refuses a name that resolves to link-local under the opt-in", async () => {
    const verdict = await checkOutboundUrl("https://provider.internal.test", {
      allowPrivate: true,
      resolveDns: resolvesTo("169.254.9.9").resolveDns,
    });
    expect(verdict).toMatchObject({ allowed: false });
  });

  test("still refuses non-http schemes under the opt-in", async () => {
    const verdict = await checkOutboundUrl("file:///etc/passwd", OPT_IN);
    expect(verdict).toMatchObject({ allowed: false });
  });
});
