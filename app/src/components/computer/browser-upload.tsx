import { Button } from "@astryxdesign/core/Button";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import {
  browserUploadInput,
  browserUploadResult,
} from "@openbot/shared/browser-upload";
import { useState } from "react";
import { tryClient } from "@/lib/client";

const UNKNOWN_OUTCOME =
  "The site may have received the file. Check the site before retrying.";

export function BrowserUpload({ botId }: { botId: string }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [url, setUrl] = useState("");
  const [field, setField] = useState("file");
  const [message, setMessage] = useState("");
  const [unknown, setUnknown] = useState(false);
  const input = browserUploadInput.safeParse({ path, url, field });

  if (!open)
    return (
      <Button label="Upload workspace file" onClick={() => setOpen(true)} />
    );

  async function upload() {
    if (!input.success) return;
    setMessage("");
    try {
      const response = await tryClient(
        `/api/computers/${encodeURIComponent(botId)}/human/browser-upload`,
        {
          method: "POST",
          body: input.data,
        },
      );
      const body: unknown = await response.json();
      const parsed = browserUploadResult.safeParse(body);
      if (parsed.success) {
        setUnknown(parsed.data.status === "unknown");
        setMessage(
          parsed.data.status === "accepted"
            ? "The site accepted the upload."
            : parsed.data.status === "unknown"
              ? UNKNOWN_OUTCOME
              : parsed.data.reason,
        );
        return;
      }
      if (
        response.status >= 400 &&
        response.status < 500 &&
        body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string"
      ) {
        setUnknown(false);
        setMessage(body.error);
        return;
      }
    } catch {
      // A lost response can follow successful receipt.
    }
    setUnknown(true);
    setMessage(UNKNOWN_OUTCOME);
  }

  return (
    <VStack gap={2} as="section" aria-label="Upload workspace file">
      <TextInput label="Workspace file path" value={path} onChange={setPath} />
      <TextInput
        label="HTTPS upload endpoint"
        type="url"
        value={url}
        onChange={setUrl}
      />
      <TextInput
        label="Multipart field name"
        value={field}
        onChange={setField}
      />
      <Button
        label={unknown ? "Confirm retry" : "Upload file"}
        isDisabled={!input.success}
        clickAction={upload}
      />
      {message && (
        <Text as="p" role="status">
          {message}
        </Text>
      )}
    </VStack>
  );
}
