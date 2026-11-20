import {
  type RecordingDetail,
  type RecordingRow,
  type RecordingsPage,
  recorderPaths,
} from "@openbot/shared/recorder-api";
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { client } from "@/lib/client";
import { recorderKeys } from "@/lib/recorder/queries";

export function RecordingDetails({ row }: { row: RecordingRow }) {
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const path = recorderPaths.recording(row.id);
  const queryClient = useQueryClient();
  const queryKey = ["recorder", "recording-detail", row.id];
  const detail = useInfiniteQuery({
    queryKey,
    enabled: open,
    gcTime: 0,
    initialPageParam: 0,
    getNextPageParam: (last: RecordingDetail) => last.nextSeq ?? undefined,
    queryFn: async ({ pageParam, signal }): Promise<RecordingDetail> => {
      const response = await client(`${path}?after=${pageParam}`, {
        signal,
        fallback: "Couldn't load this recording.",
      });
      return response.json();
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      client(path, {
        method: "DELETE",
        fallback: "Couldn't delete this recording.",
      }),
    onSuccess: async () => {
      setOpen(false);
      const listKey = recorderKeys.recordings();
      await Promise.all([
        queryClient.cancelQueries({ queryKey }),
        queryClient.cancelQueries({ queryKey: listKey }),
      ]);
      queryClient.removeQueries({ queryKey });
      queryClient.setQueryData<InfiniteData<RecordingsPage>>(
        listKey,
        (data) =>
          data && {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              recordings: page.recordings.filter(({ id }) => id !== row.id),
            })),
          },
      );
      await queryClient.invalidateQueries({ queryKey: listKey });
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setConfirmDelete(false);
        remove.reset();
      }}
    >
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        View recording
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{row.title ?? "Untitled recording"}</DialogTitle>
          <DialogDescription>
            {new Date(row.recordedAt).toLocaleString()}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {detail.isPending ? <p role="status">Loading recording…</p> : null}
          {detail.error ? <p role="alert">{detail.error.message}</p> : null}
          {detail.data && !detail.error ? (
            <ol className="divide-y divide-border">
              {detail.data.pages
                .flatMap(({ events }) => events)
                .map((event) => (
                  <li className="py-2" key={event.value.seq}>
                    <details>
                      <summary className="cursor-pointer">
                        {event.name} ·{" "}
                        {new Date(event.timestamp).toLocaleTimeString()}
                      </summary>
                      <pre className="mt-1 whitespace-pre-wrap break-all text-xs">
                        {JSON.stringify(
                          event.value,
                          (key, value) => (key === "seq" ? undefined : value),
                          2,
                        )}
                      </pre>
                    </details>
                  </li>
                ))}
            </ol>
          ) : null}
          {detail.hasNextPage && !detail.error ? (
            <Button
              variant="outline"
              disabled={detail.isFetchingNextPage}
              onClick={() => detail.fetchNextPage()}
            >
              Show more events
            </Button>
          ) : null}
          {confirmDelete ? (
            <p>Delete this recording and remove it from future learning?</p>
          ) : null}
          {remove.error ? <p role="alert">{remove.error.message}</p> : null}
        </DialogBody>
        <DialogFooter>
          {confirmDelete ? (
            <>
              <Button
                variant="outline"
                disabled={remove.isPending}
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                {remove.isPending ? "Deleting…" : "Delete permanently"}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => setConfirmDelete(true)}>
              Delete recording
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
