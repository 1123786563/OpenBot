import { describe, expect, test } from "../../../../tests/support/e2e-compat";
import {
  type DNSResolver,
  isRestrictedIP,
  parseIP,
  ssrfSafeDownload,
  validateURLForSSRF,
} from "./ssrf";

/** WeKnora utils/security.go ValidateURLForSSRF 直译验证（DNS 注入，不起网络）。 */

/** 公网 IP 解析器：任何主机名都解析到 93.184.216.34（example.com 真实地址段）。 */
const publicDNS: DNSResolver = async () => ["93.184.216.34"];
/** 内网解析器：模拟 DNS rebinding——公网域名解析到 169.254.169.254。 */
const privateDNS: DNSResolver = async () => ["169.254.169.254"];
const failingDNS: DNSResolver = async () => {
  throw new Error("NXDOMAIN");
};

const ok = async (url: string, dns: DNSResolver = publicDNS) =>
  (await validateURLForSSRF(url, { resolveDNS: dns })) === null;

describe("scheme and format", () => {
  test("empty URL passes (callers validate non-empty separately)", async () => {
    expect(await validateURLForSSRF("", { resolveDNS: publicDNS })).toBeNull();
  });

  test("rejects non-http(s) schemes", async () => {
    for (const url of [
      "ftp://example.com/x",
      "file:///etc/passwd",
      "gopher://example.com",
    ]) {
      const err = await validateURLForSSRF(url, { resolveDNS: publicDNS });
      expect(err?.reason).toContain("invalid scheme");
    }
  });

  test("rejects URLs over 2048 chars", async () => {
    const err = await validateURLForSSRF(
      `https://example.com/${"a".repeat(2100)}`,
      { resolveDNS: publicDNS },
    );
    expect(err?.reason).toContain("maximum length");
  });

  test("rejects URLs without a usable hostname", async () => {
    // WHATWG URL 对 "https://" 直接抛错 → invalid format（Go 版为 no hostname，同为拒绝）
    const err = await validateURLForSSRF("https://", { resolveDNS: publicDNS });
    expect(err).not.toBeNull();
  });
});

describe("restricted hostnames and suffixes", () => {
  test("rejects localhost and metadata endpoints", async () => {
    for (const host of [
      "localhost",
      "metadata.google.internal",
      "metadata.tencentyun.com",
      "host.docker.internal",
      "kubernetes.default.svc",
    ]) {
      const err = await validateURLForSSRF(`https://${host}/`, {
        resolveDNS: publicDNS,
      });
      expect(err?.reason).toContain("restricted");
    }
  });

  test("rejects internal suffixes (.local/.internal/.svc.cluster.local)", async () => {
    for (const host of [
      "printer.local",
      "db.internal",
      "svc.x.svc.cluster.local",
    ]) {
      const err = await validateURLForSSRF(`https://${host}/`, {
        resolveDNS: publicDNS,
      });
      expect(err?.reason).toContain("restricted");
    }
  });
});

describe("direct IP refusal (STRICT MODE)", () => {
  test("rejects public IPv4 literal", async () => {
    const err = await validateURLForSSRF("https://93.184.216.34/", {
      resolveDNS: publicDNS,
    });
    expect(err?.reason).toContain("direct IP");
  });

  test("rejects IPv6 literal (bracketed)", async () => {
    const err = await validateURLForSSRF("https://[2001:db8::1]/", {
      resolveDNS: publicDNS,
    });
    expect(err?.reason).toContain("direct IP");
  });

  test("rejects obfuscated IP-like hostnames (WHATWG URL normalizes most forms)", async () => {
    // JS 的 URL 解析器比 Go net/url 更早反混淆：0177.0.0.1/0x7f.0.0.1 被
    // 规范化成 127.0.0.1 → 命中 restricted/direct-IP；十进制整数形式命中 IP-like。
    for (const host of [
      "0177.0.0.1",
      "0x7f.0.0.1",
      "2130706433",
      "3232235777",
    ]) {
      const err = await validateURLForSSRF(`https://${host}/`, {
        resolveDNS: publicDNS,
      });
      expect(err).not.toBeNull();
      expect(err?.reason).toMatch(/IP-like|restricted|direct IP/);
    }
  });
});

describe("DNS resolution checks (rebinding defence)", () => {
  test("hostname resolving to a public IP passes", async () => {
    expect(await ok("https://example.com/path?q=1")).toBe(true);
  });

  test("hostname resolving to link-local IP is rejected (cloud metadata)", async () => {
    const err = await validateURLForSSRF("https://rebind.example.com/", {
      resolveDNS: privateDNS,
    });
    expect(err?.reason).toContain("resolves to restricted IP");
    expect(err?.reason).toContain("169.254.169.254");
  });

  test("DNS failure is rejected (cannot verify safety)", async () => {
    const err = await validateURLForSSRF("https://nonexistent.example.com/", {
      resolveDNS: failingDNS,
    });
    expect(err?.reason).toContain("DNS resolution failed");
  });

  test("any restricted answer among resolved IPs rejects (mixed A records)", async () => {
    const mixed: DNSResolver = async () => ["93.184.216.34", "10.0.0.5"];
    const err = await validateURLForSSRF("https://mixed.example.com/", {
      resolveDNS: mixed,
    });
    expect(err?.reason).toContain("10.0.0.5");
  });
});

describe("restricted ports", () => {
  test("non-HTTP ports are blocked", async () => {
    for (const port of ["22", "25", "3306", "5432", "6379", "9200"]) {
      const err = await validateURLForSSRF(`https://example.com:${port}/`, {
        resolveDNS: publicDNS,
      });
      expect(err?.reason).toContain("blocked for security reasons");
    }
  });

  test("regular HTTP(S) ports pass", async () => {
    expect(await ok("https://example.com:443/")).toBe(true);
    expect(await ok("http://example.com:8080/")).toBe(true);
  });
});

describe("isRestrictedIP (ipclass.go parity)", () => {
  const restricted = (s: string) => {
    const ip = parseIP(s);
    expect(ip).not.toBeNull();
    return isRestrictedIP(ip!).restricted;
  };

  test("private ranges: 10/8, 172.16/12, 192.168/16", () => {
    expect(restricted("10.0.0.1")).toBe(true);
    expect(restricted("172.16.0.1")).toBe(true);
    expect(restricted("172.31.255.255")).toBe(true);
    expect(restricted("192.168.1.1")).toBe(true);
    expect(restricted("172.32.0.1")).toBe(false); // 172.32 不在 172.16/12
  });

  test("loopback 127/8 and ::1", () => {
    expect(restricted("127.0.0.1")).toBe(true);
    expect(restricted("127.255.255.255")).toBe(true);
    expect(restricted("::1")).toBe(true);
  });

  test("link-local 169.254/16 and fe80::/10 (cloud metadata)", () => {
    expect(restricted("169.254.169.254")).toBe(true);
    expect(restricted("fe80::1")).toBe(true);
  });

  test("CGNAT 100.64/10", () => {
    expect(restricted("100.64.0.1")).toBe(true);
    expect(restricted("100.127.255.255")).toBe(true);
    expect(restricted("100.128.0.1")).toBe(false);
  });

  test("reserved: 0/8, 240/4, 198.18/15", () => {
    expect(restricted("0.0.0.1")).toBe(true);
    expect(restricted("240.0.0.1")).toBe(true);
    expect(restricted("255.255.255.255")).toBe(true);
    expect(restricted("198.18.0.1")).toBe(true);
  });

  test("IPv6 unique-local fc00::/7 and site-local fec0::/10", () => {
    expect(restricted("fc00::1")).toBe(true);
    expect(restricted("fd12:3456::1")).toBe(true);
    expect(restricted("fec0::1")).toBe(true);
  });

  test("IPv6 multicast ff02::1", () => {
    expect(restricted("ff02::1")).toBe(true);
  });

  test("IPv4-mapped IPv6 carries the v4 verdict", () => {
    expect(restricted("::ffff:169.254.169.254")).toBe(true);
    expect(restricted("::ffff:93.184.216.34")).toBe(false);
  });

  test("6to4 wrapping a private v4 is restricted; wrapping public is not", () => {
    expect(restricted("2002:a00:1::")).toBe(true); // 2002:0a00:0001:: = 10.0.0.1
    expect(restricted("2002:5db8:d822::")).toBe(false); // 93.184.216.34
  });

  test("NAT64 well-known prefix carrying a private v4 is restricted", () => {
    expect(restricted("64:ff9b::0a00:001")).toBe(true); // ::10.0.0.1
  });

  test("public addresses pass", () => {
    expect(restricted("93.184.216.34")).toBe(false);
    expect(restricted("8.8.8.8")).toBe(false);
    expect(restricted("2606:2800:220:1::1")).toBe(false);
  });
});

describe("ssrfSafeDownload", () => {
  test("happy path returns bytes with content type", async () => {
    const fetchImpl = (async () =>
      new Response("hello", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as unknown as Parameters<typeof ssrfSafeDownload>[1] extends {
      fetchImpl?: infer F;
    }
      ? F
      : never;
    const out = await ssrfSafeDownload("https://example.com/doc.txt", {
      fetchImpl: fetchImpl as never,
      resolveDNS: publicDNS,
    });
    expect(new TextDecoder().decode(out.bytes)).toBe("hello");
    expect(out.contentType).toBe("text/plain");
  });

  test("redirect to a restricted target is blocked (per-hop validation)", async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      })) as never;
    await expect(
      ssrfSafeDownload("https://example.com/r", {
        fetchImpl,
        resolveDNS: publicDNS,
      }),
    ).rejects.toThrow(/redirect target rejected|direct IP/);
  });

  test("redirect chain beyond 5 hops is stopped", async () => {
    let hops = 0;
    const fetchImpl = (async (_url: string) => {
      hops += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `https://example.com/hop${hops}` },
      });
    }) as never;
    await expect(
      ssrfSafeDownload("https://example.com/start", {
        fetchImpl,
        resolveDNS: publicDNS,
      }),
    ).rejects.toThrow(/stopped after 5 redirects/);
  });

  test("oversize content-length is rejected (10MB limit)", async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 200,
        headers: { "content-length": String(11 * 1024 * 1024) },
      })) as never;
    await expect(
      ssrfSafeDownload("https://example.com/big", {
        fetchImpl,
        resolveDNS: publicDNS,
      }),
    ).rejects.toThrow(/size exceeds limit/);
  });

  test("non-2xx final response errors", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 404 })) as never;
    await expect(
      ssrfSafeDownload("https://example.com/missing", {
        fetchImpl,
        resolveDNS: publicDNS,
      }),
    ).rejects.toThrow("HTTP 404");
  });

  test("initial validation failure short-circuits before fetch", async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response("x");
    }) as never;
    await expect(
      ssrfSafeDownload("http://127.0.0.1:8080/admin", {
        fetchImpl,
        resolveDNS: publicDNS,
      }),
    ).rejects.toThrow(/SSRF policy|direct IP/);
    expect(fetched).toBe(false);
  });
});
