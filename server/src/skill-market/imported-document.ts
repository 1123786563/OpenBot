import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import { z } from "zod";

const originalHeader = "openbot-migration-original-header-v1";
const frontmatter = z
  .object({
    name: z.string(),
    description: z.string().min(1).max(1024),
    license: z.string().optional(),
    compatibility: z.string().optional(),
    metadata: z.record(z.string(), z.json()).optional(),
    "allowed-tools": z.string().optional(),
  })
  .catchall(z.json());

export function encodeImportedSkillDocument(bytes: Buffer, slug: string) {
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const header = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*\r?\n/m.exec(text);
  if (header?.index !== 0 || !header[1])
    throw new Error("SKILL.md needs YAML frontmatter");
  const body = text.slice(header[0].length);
  if (!body.trim() || text.includes("\0"))
    throw new Error("SKILL.md needs a nonempty PostgreSQL-compatible body");

  const parsed = frontmatter.parse(parse(header[1]));
  const {
    name,
    description,
    license,
    compatibility,
    metadata,
    "allowed-tools": allowedTools,
    ...extra
  } = parsed;
  if (name !== slug || Object.hasOwn(extra, originalHeader))
    throw new Error("SKILL.md name or reserved migration key conflicts");
  if (Buffer.byteLength(description) > 1024)
    throw new Error("SKILL.md description exceeds the Bifrost limit");

  // Bifrost's native metadata field is map[string]string.
  const nativeMetadata = Object.fromEntries(
    Object.entries(metadata ?? {}).map(([key, value]) => [
      key,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );
  const storedExtra = {
    ...extra,
    [originalHeader]: Buffer.from(header[0]).toString("base64"),
  };
  const snapshot = {
    ...storedExtra,
    description,
    ...(license === undefined ? {} : { license }),
    ...(compatibility === undefined ? {} : { compatibility }),
    ...(allowedTools === undefined ? {} : { "allowed-tools": allowedTools }),
    ...(Object.keys(nativeMetadata).length ? { metadata: nativeMetadata } : {}),
  };
  return {
    body,
    snapshot,
    request: {
      description,
      license,
      compatibility,
      allowed_tools: allowedTools,
      metadata: nativeMetadata,
      extra_frontmatter: storedExtra,
      skill_md_body: body,
    },
  };
}

export function decodeImportedSkillDocument(
  slug: string,
  body: string,
  snapshot: Record<string, unknown>,
) {
  if (!Object.hasOwn(snapshot, originalHeader)) return undefined;
  const encoded = snapshot[originalHeader];
  if (typeof encoded !== "string")
    throw new Error("Invalid imported frontmatter");
  const header = Buffer.from(encoded, "base64");
  const original = Buffer.concat([header, Buffer.from(body)]);
  const expected = encodeImportedSkillDocument(original, slug);
  if (expected.body !== body || !isDeepStrictEqual(expected.snapshot, snapshot))
    throw new Error("Imported frontmatter differs from the Bifrost snapshot");
  return original;
}
