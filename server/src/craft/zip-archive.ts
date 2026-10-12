/**
 * The ZIP output contract — the port of onyx's download face:
 * `manager.py:1273-1290` (`_zip_files`: deflate, file entries only, unreadable skipped)
 * plus `manager.py:159-163` (`_sanitize_zip_basename`) and `file_store/serving.py:103-115`
 * (`build_content_disposition`: ASCII fallback + RFC 5987 `filename*`).
 *
 * Zero new dependencies: deflate is node:zlib's `deflateRawSync` (exactly the raw DEFLATE
 * stream a ZIP record carries), CRC-32 is the standard table below, and the container
 * framing (local headers + central directory + EOCD) is written by hand — the same
 * minimal-writer approach the ustar writer took, now in onyx's format instead of tar.gz.
 *
 * onyx zipfile shape kept: FILE entries only (no directory placeholder records — the
 * writestr-per-file loop), deflate method, and the UTF-8 name flag set only when a name
 * carries non-ASCII bytes (python's `_encodeFilenameFlags`). Bounded like the ustar writer
 * it replaces: no ZIP64 — one archive may hold at most 65,535 files under 4GB each, which
 * a workspace download never approaches; a tree that large fails honestly rather than
 * emitting a silently truncated directory.
 */

import { deflateRawSync } from "node:zlib";

// ── onyx manager.py:159-163 — the download filename stem ───────────────────────

/**
 * Replace filesystem-unsafe characters in a download filename stem. `allowDots` keeps
 * version-suffixed directory names like `my.lib` intact (onyx's own docstring). Unicode
 * letters and digits survive — python's `str.isalnum` is unicode-aware, and
 * `[\p{L}\p{N}]` is its JS match.
 */
export function sanitizeZipBasename(
  name: string,
  options: { allowDots: boolean },
): string {
  let out = "";
  for (const character of name) {
    const safe =
      /[\p{L}\p{N}]/u.test(character) ||
      character === "-" ||
      character === "_" ||
      (options.allowDots && character === ".");
    out += safe ? character : "_";
  }
  return out;
}

// ── onyx file_store/serving.py:103-115 — the Content-Disposition value ────────

// biome-ignore lint/suspicious/noControlCharactersInRegex: serving.py:49's ranges, verbatim — control chars are exactly what gets scrubbed.
const UNSAFE_FILENAME_CHARS = /[\x00-\x1f\x7f"\\/]/g;
const NON_ASCII_CHARS = /[^\x20-\x7e]/g; // serving.py:50 — printable ASCII, kept

/**
 * urllib's `quote(s, safe="")`: percent-encode every byte outside its always-safe set
 * `[A-Za-z0-9_.~-]`, uppercase hex — the exact `filename*` payload onyx emits.
 */
function percentEncode(input: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(input)) {
    const safe =
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      byte === 0x5f || // _
      byte === 0x2e || // .
      byte === 0x2d || // -
      byte === 0x7e; // ~
    out += safe
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * Build the header value that names a file safely: `filename` is the ASCII fallback for
 * old clients, `filename*` (RFC 5987) carries the full UTF-8 name current browsers prefer
 * — onyx's own docstring, byte-for-byte its algorithm.
 */
export function buildContentDisposition(
  filename: string,
  dispositionType = "attachment",
): string {
  const cleaned =
    filename.replace(UNSAFE_FILENAME_CHARS, "_").trim() || "download";
  const ascii = cleaned.replace(NON_ASCII_CHARS, "_");
  const encoded = percentEncode(cleaned);
  return `${dispositionType}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// ── the ZIP writer — onyx manager.py:1273-1290 `_zip_files` ────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** DOS date/time pair for `new Date()` — zipfile's writestr default (local time). */
function dosDateTime(now: Date): { time: number; date: number } {
  const time =
    (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date =
    (Math.max(now.getFullYear() - 1980, 0) << 9) |
    ((now.getMonth() + 1) << 5) |
    now.getDate();
  return { time, date };
}

/**
 * Build a deflate-compressed ZIP from `(arcname, bytes)` pairs — file entries only,
 * unreadable files already skipped by the caller (onyx's `_zip_files` contract).
 */
export function zipEntries(
  entries: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
): Uint8Array {
  if (entries.length > 0xffff) {
    throw new RangeError(
      "zip writer is not ZIP64: at most 65,535 entries per archive",
    );
  }

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the non-ASCII test IS a control-range test — zipfile's _encodeFilenameFlags.
    const utf8Flag = /[^\x00-\x7f]/.test(entry.path) ? 0x0800 : 0;
    const data = deflateRawSync(entry.bytes);
    const crc = crc32(entry.bytes);
    const { time, date } = dosDateTime(new Date());

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true); // local file header signature
    localView.setUint16(4, 20, true); // version needed: 2.0 (deflate)
    localView.setUint16(6, utf8Flag, true);
    localView.setUint16(8, 8, true); // method: deflate
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, entry.bytes.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    chunks.push(local, data);

    const record = new Uint8Array(46 + name.length);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, 0x02014b50, true); // central directory signature
    recordView.setUint16(4, 0x0314, true); // made by: unix host, spec 2.0
    recordView.setUint16(6, 20, true); // version needed: 2.0
    recordView.setUint16(8, utf8Flag, true);
    recordView.setUint16(10, 8, true); // method: deflate
    recordView.setUint16(12, time, true);
    recordView.setUint16(14, date, true);
    recordView.setUint32(16, crc, true);
    recordView.setUint32(20, data.length, true);
    recordView.setUint32(24, entry.bytes.length, true);
    recordView.setUint16(28, name.length, true);
    recordView.setUint32(38, 0o600 << 16, true); // external attrs: writestr's default
    recordView.setUint32(42, offset, true); // local header offset
    record.set(name, 46);
    central.push(record);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((total, chunk) => total + chunk.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); // end of central directory signature
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  chunks.push(...central, end);

  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
