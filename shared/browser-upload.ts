import { z } from "zod";

export const BROWSER_UPLOAD_LIMIT = 4 * 1024 * 1024;
export const BROWSER_UPLOAD_DESCRIPTION =
  "Ask the person to approve one attempt to upload a workspace file up to 4 MiB. Open the destination site first. Supply its same-origin HTTPS multipart POST endpoint and the file field name. If the outcome is unknown, check the site and get a fresh human approval before any retry.";

function safeName(value: string): boolean {
  return (
    !value.includes("\\") &&
    Array.from(value).every(
      (character) => character >= " " && character !== "\x7f",
    )
  );
}

const endpoint = z
  .string()
  .max(2048)
  .transform((value, ctx) => {
    try {
      const url = new URL(value);
      if (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.hash
      )
        return url.href;
    } catch {
      // Fall through to the same validation error.
    }
    ctx.addIssue({
      code: "custom",
      message: "An HTTPS upload endpoint is required.",
    });
    return z.NEVER;
  });

export const browserUploadToolInput = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(1024)
    .refine(safeName)
    .refine(
      (path) =>
        path.trim() === path &&
        path.split("/").every((part) => part && part !== "." && part !== ".."),
    ),
  url: z.string().min(1).max(2048),
  field: z.string().regex(/^[A-Za-z0-9_.[\]-]{1,128}$/),
});

export const browserUploadInput = browserUploadToolInput.extend({
  url: endpoint,
});

export type BrowserUploadInput = z.input<typeof browserUploadInput>;

const content = z
  .string()
  .max(Math.ceil(BROWSER_UPLOAD_LIMIT / 3) * 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/)
  .refine((value) => value.length % 4 === 0);

export const browserUploadIdentity = z.object({
  identity: z.string().min(1).max(256),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const browserUploadFile = browserUploadIdentity.extend({ content });

export const browserUploadDispatch = browserUploadInput
  .omit({ path: true })
  .extend({
    name: z
      .string()
      .min(1)
      .max(255)
      .refine((name) => safeName(name) && !name.includes("/")),
    content,
  });

export const browserUploadResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("accepted"),
    httpStatus: z.number().int().min(200).max(299),
  }),
  z.object({ status: z.enum(["not_sent", "unknown"]), reason: z.string() }),
]);

export type BrowserUploadResult = z.infer<typeof browserUploadResult>;

export function unknownBrowserUpload(): BrowserUploadResult {
  return {
    status: "unknown",
    reason:
      "The site may have received the file. Check the site and get a new human approval before retrying.",
  };
}
