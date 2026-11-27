import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { IconPlus } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { astryxScope } from "@/components/astryx-pilot/theme";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { newId } from "@/lib/new-id";
import { addCustomServerMutationOptions } from "@/lib/plugins/mutations";

export function AddCustomMcp() {
  const queryClient = useQueryClient();
  const add = useMutation(addCustomServerMutationOptions(queryClient));
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const draft = useRef<{ id: string; url: string } | null>(null);
  const submitting = useRef(false);

  const setDialogOpen = (next: boolean) => {
    if (submitting.current) return;
    setOpen(next);
    if (!next) {
      setTitle("");
      setUrl("");
      draft.current = null;
      add.reset();
    }
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !title.trim() || !url.trim()) return;
    const endpoint = url.trim();
    const id =
      draft.current?.url === endpoint ? draft.current.id : `mcp-${newId()}`;
    draft.current = { id, url: endpoint };
    submitting.current = true;
    try {
      await add.mutateAsync({ id, title: title.trim(), url: endpoint });
    } catch {
      return; // The mutation error is shown in the form.
    } finally {
      submitting.current = false;
    }
    setDialogOpen(false);
    toast.add({ title: "MCP server added", type: "success" });
  }

  return (
    <Dialog open={open} onOpenChange={setDialogOpen}>
      <DialogTrigger
        render={
          <Button
            label="Add custom MCP"
            icon={<IconPlus aria-hidden />}
            size="sm"
            variant="ghost"
          />
        }
      />
      <DialogContent {...astryxScope}>
        <DialogHeader>
          <DialogTitle>Add custom MCP</DialogTitle>
          <DialogDescription>
            Register an MCP server for this workspace.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <VStack gap={4}>
            <TextInput
              label="Name"
              isRequired
              isDisabled={add.isPending}
              value={title}
              onChange={setTitle}
            />
            <TextInput
              label="Server URL"
              type="url"
              isRequired
              isDisabled={add.isPending}
              value={url}
              onChange={setUrl}
            />
            {add.error ? (
              <Text as="p" role="alert">
                {add.error.message}
              </Text>
            ) : null}
            <HStack gap={2} justify="end">
              <Button
                label="Cancel"
                variant="ghost"
                type="button"
                isDisabled={add.isPending}
                onClick={() => setDialogOpen(false)}
              />
              <Button
                label="Add server"
                type="submit"
                isDisabled={!title.trim() || !url.trim() || add.isPending}
                isLoading={add.isPending}
              />
            </HStack>
          </VStack>
        </form>
      </DialogContent>
    </Dialog>
  );
}
