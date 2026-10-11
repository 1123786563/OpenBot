/**
 * SSRF 防护：WeKnora `internal/utils/security.go`（ValidateURLForSSRF /
 * isSSRFSafeURL / isRestrictedIP ← internal/ipclass）+ 安全下载的直译。
 *
 * 层次：协议白名单（http/https）→ 受限主机名/后缀/端口 → 拒绝直连 IP 与
 * IP 样式主机（防混淆）→ DNS 解析后逐 IP 复查（防 rebinding）→ 重定向
 * 逐跳校验（≤5）→ 响应大小（10MB）/超时（10s）上限。
 * DNS 解析器可注入（测试不依赖网络）。
 */

export type SSRFError = { reason: string };

/** 受限主机名（localhost/云元数据/docker/k8s 内部名）。 */
const RESTRICTED_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "metadata.google.internal",
  "metadata.tencentyun.com",
  "metadata.aws.internal",
  "host.docker.internal",
  "gateway.docker.internal",
  "kubernetes.docker.internal",
  "kubernetes",
  "kubernetes.default",
  "kubernetes.default.svc",
  "kubernetes.default.svc.cluster.local",
]);

const RESTRICTED_HOST_SUFFIXES = [
  ".local",
  ".localhost",
  ".internal",
  ".corp",
  ".lan",
  ".home",
  ".localdomain",
  ".svc.cluster.local",
  ".pod.cluster.local",
];

/** 非 HTTP 服务端口（用户可控 URL 不得触达）。 */
const RESTRICTED_PORTS = new Set([
  "22",
  "23",
  "25",
  "445",
  "3389",
  "5432",
  "3306",
  "6379",
  "27017",
  "9200",
  "2379",
  "2380",
  "8500",
  "4001",
]);

const MAX_URL_LENGTH = 2048;

/** IP 混淆样式（八进制/十六进制/十进制整数/IPv6 变体）。 */
const IP_LIKE_PATTERNS: RegExp[] = [
  /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^\d{8,10}$/,
  /^0[0-7]+\./,
  /^0x[0-9a-f]+\./i,
  /^0x[0-9a-f]{6,8}$/i,
  /^[0-9a-f:]+::[0-9a-f:]*$/i,
  /^[0-9a-f]{1,4}(:[0-9a-f]{1,4}){7}$/i,
  /^::ffff:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i,
  /^\[[0-9a-f:]+\]$/i,
];

// ---- IPv4/IPv6 解析与受限判定（ipclass.go 的 JS 等价实现）----

type IPv4 = { kind: "v4"; bytes: [number, number, number, number] };
type IPv6 = { kind: "v6"; groups: number[] };
type IP = IPv4 | IPv6;

export function parseIP(host: string): IP | null {
  const h = host.replace(/^\[|\]$/g, "");
  if (h.includes(":")) return parseIPv6(h);
  const parts = h.split(".");
  if (parts.length !== 4) return null;
  const bytes: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i];
    if (part === "" || !/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes[i] = n;
  }
  return { kind: "v4", bytes };
}

function parseIPv6(s: string): IP | null {
  // 展开 "::" 缩写；拒绝双 "::"。
  const doubleColon = s.split("::");
  if (doubleColon.length > 2) return null;
  let head: string[] = [];
  let tail: string[] = [];
  if (doubleColon.length === 2) {
    head = doubleColon[0] === "" ? [] : doubleColon[0].split(":");
    tail = doubleColon[1] === "" ? [] : doubleColon[1].split(":");
  } else {
    head = s.split(":");
  }
  const headGroups: number[] = [];
  for (const part of head) {
    const g = parseIPv6Group(part, headGroups);
    if (g === null) return null;
  }
  const tailGroups: number[] = [];
  for (const part of tail) {
    const g = parseIPv6Group(part, tailGroups);
    if (g === null) return null;
  }
  const fill = 8 - headGroups.length - tailGroups.length;
  if (fill < 0) return null;
  if (doubleColon.length === 2 && fill === 0) return null; // "::" 必须至少吞一组
  const groups = [...headGroups, ...new Array(fill).fill(0), ...tailGroups];
  if (groups.length !== 8) return null;
  return { kind: "v6", groups };
}

function parseIPv6Group(part: string, acc: number[]): number | null {
  // IPv4 尾段（如 ::ffff:1.2.3.4）
  if (part.includes(".")) {
    const v4 = parseIP(part);
    if (v4 === null || v4.kind !== "v4") return null;
    acc.push((v4.bytes[0] << 8) | v4.bytes[1]);
    acc.push((v4.bytes[2] << 8) | v4.bytes[3]);
    return acc[acc.length - 1];
  }
  if (part === "" || !/^[0-9a-f]{1,4}$/i.test(part)) return null;
  const v = Number.parseInt(part, 16);
  acc.push(v);
  return v;
}

function ipv4InCIDR(
  bytes: [number, number, number, number],
  cidr: string,
): boolean {
  const [base, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const baseIP = parseIP(base);
  if (baseIP === null || baseIP.kind !== "v4") return false;
  let addr = 0;
  let _b = 0;
  for (const byte of bytes) {
    addr = (addr << 8) | byte;
    _b += 1;
  }
  let baseAddr = 0;
  for (const byte of baseIP.bytes) {
    baseAddr = (baseAddr << 8) | byte;
  }
  if (bits === 0) return true;
  const mask = bits >= 32 ? -1 : ~((1 << (32 - bits)) - 1);
  return (addr & mask) === (baseAddr & mask);
}

function _ipv6GroupsWithCIDR(groups: number[], cidr: string): boolean {
  const [baseStr, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const baseIP = parseIP(baseStr);
  if (baseIP === null || baseIP.kind !== "v6") return false;
  if (bits === 0) return true;
  let total = bits;
  for (let i = 0; i < 8; i += 1) {
    const gBits = Math.min(16, total);
    total -= gBits;
    if (gBits === 0) break;
    const mask = gBits === 16 ? 0xffff : (0xffff << (16 - gBits)) & 0xffff;
    if ((groups[i] & mask) !== (baseIP.groups[i] & mask)) return false;
  }
  return true;
}

/** v4 前缀（如 127.、10.）快速判断。 */
function v4StartsWith(ip: IPv4, prefix: string): boolean {
  const parts = prefix.split(".").filter((p) => p !== "");
  for (let i = 0; i < parts.length && i < 4; i += 1) {
    if (String(ip.bytes[i]) !== parts[i]) return false;
  }
  return true;
}

/**
 * ipclass.Classify 的等价判定（除 Public 外全部受限）。
 * 覆盖：RFC1918、环回、链路本地（含云元数据 169.254/16）、CGNAT 100.64/10、
 * 保留段（0/8、240/4、198.18/15、192.0.0/24）、组播、未指定、
 * fc00::/7、fe80::/10、fec0::/10、::1、IPv6 组播、NAT64/6to4/Teredo 内嵌受限 v4。
 */
export function isRestrictedIP(ip: IP): {
  restricted: boolean;
  reason: string;
} {
  if (ip.kind === "v4") {
    const b = ip.bytes;
    if (ipv4InCIDR(b, "10.0.0.0/8"))
      return { restricted: true, reason: "private IP address" };
    if (ipv4InCIDR(b, "172.16.0.0/12"))
      return { restricted: true, reason: "private IP address" };
    if (ipv4InCIDR(b, "192.168.0.0/16"))
      return { restricted: true, reason: "private IP address" };
    if (ipv4InCIDR(b, "127.0.0.0/8"))
      return { restricted: true, reason: "loopback address" };
    if (ipv4InCIDR(b, "169.254.0.0/16"))
      return { restricted: true, reason: "link-local address" };
    if (ipv4InCIDR(b, "100.64.0.0/10"))
      return { restricted: true, reason: "CGNAT address" };
    if (ipv4InCIDR(b, "0.0.0.0/8"))
      return { restricted: true, reason: "reserved range 0.0.0.0/8" };
    if (ipv4InCIDR(b, "240.0.0.0/4"))
      return { restricted: true, reason: "reserved range 240.0.0.0/4" };
    if (ipv4InCIDR(b, "198.18.0.0/15"))
      return { restricted: true, reason: "reserved range 198.18.0.0/15" };
    if (ipv4InCIDR(b, "192.0.0.0/24"))
      return { restricted: true, reason: "reserved range 192.0.0.0/24" };
    if (b[0] >= 224 && b[0] <= 239)
      return { restricted: true, reason: "multicast address" };
    if (b[0] === b[1] && b[2] === b[3] && b[0] === 255)
      return { restricted: true, reason: "broadcast address" };
    if (
      v4StartsWith(ip, "192.0.2.") ||
      v4StartsWith(ip, "198.51.100.") ||
      v4StartsWith(ip, "203.0.113.")
    ) {
      return { restricted: true, reason: "documentation range" };
    }
    return { restricted: false, reason: "" };
  }

  const g = ip.groups;
  // IPv4-mapped ::ffff:a.b.c.d（groups[5]=0xffff）：判定跟随内嵌 v4。
  // （WHATWG URL 已把 hostname 里的该形态折成 v4 字面量，此处兜底直接 parseIP 调用。）
  if (g[5] === 0xffff && g.slice(0, 5).every((v) => v === 0)) {
    const mapped: IPv4 = {
      kind: "v4",
      bytes: [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff],
    };
    return isRestrictedIP(mapped);
  }
  // ::1 环回 / :: 未指定
  if (g.every((v, i) => (i === 7 ? v === 1 : v === 0)))
    return { restricted: true, reason: "loopback address" };
  if (g.every((v) => v === 0))
    return { restricted: true, reason: "unspecified address" };
  // fc00::/7 唯一本地
  if ((g[0] & 0xfe00) === 0xfc00)
    return { restricted: true, reason: "unique local IPv6 address" };
  // fe80::/10 链路本地
  if ((g[0] & 0xffc0) === 0xfe80)
    return { restricted: true, reason: "link-local address" };
  // fec0::/10 废弃站点本地
  if ((g[0] & 0xffc0) === 0xfec0)
    return { restricted: true, reason: "site-local IPv6 address" };
  // 组播 ff00::/8
  if ((g[0] & 0xff00) === 0xff00)
    return { restricted: true, reason: "multicast address" };
  // 64:ff9b:1::/48 本地用途 NAT64
  if (
    g[0] === 0x0064 &&
    g[1] === 0xff9b &&
    g[2] === 0x0000 &&
    g[3] === 0x0001
  ) {
    return { restricted: true, reason: "local-use NAT64 translation address" };
  }
  // Teredo 2001::/32
  if (
    g[0] === 0x2001 &&
    g[1] === 0x0000 &&
    g[2] === 0x0000 &&
    g[3] === 0x0000
  ) {
    return { restricted: true, reason: "Teredo tunneling address" };
  }
  // 内嵌 IPv4 的受限判定：6to4 2002::/16、NAT64 64:ff9b::/96、IPv4-compatible ::/96
  const embedded = embeddedIPv4(ip);
  if (embedded !== null) {
    const inner = isRestrictedIP(embedded);
    if (inner.restricted) return { restricted: true, reason: inner.reason };
  }
  return { restricted: false, reason: "" };
}

function embeddedIPv4(ip: IPv6): IP | null {
  const g = ip.groups;
  // 6to4 2002::/16：bit 16-47 是 v4 地址。
  if (g[0] === 0x2002) {
    return {
      kind: "v4",
      bytes: [g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff],
    };
  }
  // NAT64 64:ff9b::/96（RFC 6052）。
  if (
    g[0] === 0x0064 &&
    g[1] === 0xff9b &&
    g.slice(2, 6).every((v) => v === 0)
  ) {
    return {
      kind: "v4",
      bytes: [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff],
    };
  }
  // IPv4-compatible ::a.b.c.d（::/96，已废弃；::ffff: 已被 parse 展开为 v4 mapped）。
  if (g.slice(0, 6).every((v) => v === 0) && !(g[6] === 0xffff)) {
    return {
      kind: "v4",
      bytes: [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff],
    };
  }
  return null;
}

// ---- DNS 解析注入点 ----

export type DNSResolver = (hostname: string) => Promise<string[]>;

/** 默认解析器：Node/Bun 的 dns/promises lookup（all:true，含 v6）。 */
export const defaultDNSResolver: DNSResolver = async (hostname) => {
  const dns = await import("node:dns/promises");
  const results = await dns.lookup(hostname, { all: true });
  return results.map((r) => r.address);
};

// ---- URL 校验主入口 ----

export type SSRFOptions = {
  /** DNS 解析器（测试注入）。 */
  resolveDNS?: DNSResolver;
};

function fail(reason: string): SSRFError {
  return { reason };
}

/**
 * isSSRFSafeURL + ValidateURLForSSRF 的合并直译（kb-mastra 无白名单 env 需求，
 * 主理人裁剪基线只要求私网/环回/链路本地防护）。
 * 返回 null = 安全；SSRFError = 拒绝原因。
 */
export async function validateURLForSSRF(
  rawURL: string,
  options?: SSRFOptions,
): Promise<SSRFError | null> {
  // 空 URL 返回 null：与 Go 版一致（要求非空的调用方自行校验）。
  if (rawURL === "") return null;
  if (rawURL.length > MAX_URL_LENGTH) return fail("URL exceeds maximum length");

  let parsed: URL;
  try {
    parsed = new URL(rawURL);
  } catch {
    return fail(`invalid URL format: ${rawURL}`);
  }

  const scheme = parsed.protocol.replace(":", "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return fail(`invalid scheme: ${scheme} (only http/https allowed)`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "") return fail("URL has no hostname");

  if (RESTRICTED_HOSTNAMES.has(hostname)) {
    return fail(`hostname ${hostname} is restricted`);
  }
  for (const suffix of RESTRICTED_HOST_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return fail(`hostname suffix ${suffix} is restricted`);
    }
  }

  // 拒绝一切直连 IP（v4/v6 字面量）——IP 类 SSRF（含混淆/隧道）从源头断。
  const ip = parseIP(hostname);
  if (ip !== null) {
    return fail("direct IP address access is not allowed, use a domain name");
  }
  if (isIPLikeHostname(hostname)) {
    return fail("IP-like hostname format is not allowed");
  }

  // DNS 解析后逐 IP 复查（防 rebinding：解析结果可能指向内网）。
  const resolver = options?.resolveDNS ?? defaultDNSResolver;
  let ips: string[];
  try {
    ips = await resolver(hostname);
  } catch {
    return fail(
      `DNS resolution failed for hostname ${hostname}: cannot verify if it resolves to safe IP`,
    );
  }
  for (const addr of ips) {
    const resolved = parseIP(addr);
    if (resolved === null) continue;
    const verdict = isRestrictedIP(resolved);
    if (verdict.restricted) {
      return fail(
        `hostname ${hostname} resolves to restricted IP ${addr}: ${verdict.reason}`,
      );
    }
  }

  const port = parsed.port;
  if (port !== "" && RESTRICTED_PORTS.has(port)) {
    return fail(`port ${port} is blocked for security reasons`);
  }

  return null;
}

function isIPLikeHostname(hostname: string): boolean {
  for (const pat of IP_LIKE_PATTERNS) {
    if (pat.test(hostname)) return true;
  }
  return false;
}

// ---- 安全下载（URL 型文档摄取入口）----

export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024; // 10MB
export const DOWNLOAD_TIMEOUT_MS = 10_000; // 10s
export const MAX_REDIRECTS = 5;

export type FetchLike = (
  url: string,
  init?: { redirect?: "manual" | "follow" | "error"; signal?: AbortSignal },
) => Promise<Response>;

/**
 * SSRF 安全下载：入口校验 → 手动跟随重定向（每跳重新校验，≤5 跳）→
 * 大小/超时上限。fetch 可注入（测试）；跟随重定向由本函数自己驱动，
 * 不依赖 fetch 的自动 redirect（自动跟随无法逐跳校验）。
 */
export async function ssrfSafeDownload(
  rawURL: string,
  options?: { fetchImpl?: FetchLike; resolveDNS?: DNSResolver },
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const doFetch =
    options?.fetchImpl ??
    ((u: string, init?: { redirect?: "manual"; signal?: AbortSignal }) =>
      fetch(u, init));
  const validate = (u: string) =>
    validateURLForSSRF(u, { resolveDNS: options?.resolveDNS });

  const firstError = await validate(rawURL);
  if (firstError !== null)
    throw new Error(`URL rejected by SSRF policy: ${firstError.reason}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    let current = rawURL;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await doFetch(current, {
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null)
          throw new Error(
            `redirect without Location header (HTTP ${response.status})`,
          );
        const next = new URL(location, current).toString();
        if (hop === MAX_REDIRECTS)
          throw new Error(`stopped after ${MAX_REDIRECTS} redirects`);
        const redirectError = await validate(next);
        if (redirectError !== null) {
          throw new Error(
            `redirect target rejected by SSRF policy: ${redirectError.reason}`,
          );
        }
        current = next;
        continue;
      }
      if (!response.ok)
        throw new Error(`HTTP ${response.status} for ${current}`);

      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > MAX_DOWNLOAD_BYTES) {
        throw new Error(
          `download size exceeds limit of ${MAX_DOWNLOAD_BYTES} bytes`,
        );
      }
      const buf = await response.arrayBuffer();
      if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
        throw new Error(
          `download size exceeds limit of ${MAX_DOWNLOAD_BYTES} bytes`,
        );
      }
      return {
        bytes: new Uint8Array(buf),
        contentType:
          response.headers.get("content-type") ?? "application/octet-stream",
      };
    }
    throw new Error(`stopped after ${MAX_REDIRECTS} redirects`);
  } finally {
    clearTimeout(timer);
  }
}
