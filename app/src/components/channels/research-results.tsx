import { Button } from "@astryxdesign/core/Button";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { IconArrowUpRight, IconWorld } from "@tabler/icons-react";
import { useState } from "react";
import type { ResearchSource } from "@/lib/plugins/research-results";

/** Enough to see what came back without the list taking over the conversation. */
const FIRST_SHOWN = 5;

/** An excerpt longer than this is cut to a few lines until the person asks for the rest. */
const LONG_EXCERPT = 240;
/** How many lines a long excerpt shows until it is opened: `maxLines={4}` below. */
const CLAMP_LINES = 4;

/**
 * What a web search found, or what a page read returned: one entry per page, its title a link that
 * opens in a new tab, its site and date under it, and a few lines from the page.
 *
 * Stacked, never side by side, because the chat column is narrow. Drawn the same way live and after a
 * reload, since both read the same result.
 */
export function ResearchResults({
  sources,
  label,
}: {
  sources: readonly ResearchSource[];
  /** What the list is, for a screen reader: "Search results", "Pages read". */
  label: string;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? sources : sources.slice(0, FIRST_SHOWN);
  const hidden = sources.length - shown.length;
  return (
    <Stack
      as="section"
      aria-label={label}
      className="min-w-0 overflow-hidden rounded-md border border-border bg-background"
    >
      <ul className="divide-y divide-border">
        {shown.map((source) => (
          <SourceEntry key={source.url} source={source} />
        ))}
      </ul>
      {hidden > 0 || all ? (
        <Button
          className="w-full justify-start rounded-none border-t border-border text-xs"
          label={all ? "Show fewer" : `Show ${hidden} more`}
          onClick={() => setAll(!all)}
          size="sm"
          variant="ghost"
        />
      ) : null}
    </Stack>
  );
}

function SourceEntry({ source }: { source: ResearchSource }) {
  const [open, setOpen] = useState(false);
  const excerpt = source.excerpt ?? "";
  const long =
    excerpt.length > LONG_EXCERPT || excerpt.split("\n").length > CLAMP_LINES;
  const date = publishedOn(source.published);
  return (
    <li className="min-w-0 px-3 py-2.5">
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex min-w-0 items-start gap-1 text-sm font-medium text-foreground"
      >
        <Text
          className="min-w-0 break-words underline decoration-transparent underline-offset-2 group-hover:decoration-current"
          type="inherit"
        >
          {source.title ?? source.site}
        </Text>
        <IconArrowUpRight
          aria-hidden
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground"
          stroke={2}
        />
      </a>
      <Stack
        as="p"
        direction="horizontal"
        align="center"
        gap={1.5}
        className="mt-0.5 min-w-0 text-xs text-muted-foreground"
      >
        <IconWorld aria-hidden className="size-3.5 shrink-0" stroke={2} />
        <Text as="span" className="truncate" color="inherit" type="inherit">
          {source.site}
        </Text>
        {date ? (
          <>
            <Text as="span" aria-hidden color="inherit" type="inherit">
              ·
            </Text>
            <Text as="span" className="shrink-0" color="inherit" type="inherit">
              {date}
            </Text>
          </>
        ) : null}
      </Stack>
      {source.excerpt ? (
        <>
          <Stack className="text-foreground/80">
            <Text
              as="p"
              className="mt-1.5 whitespace-pre-line break-words"
              color="inherit"
              maxLines={long && !open ? 4 : 0}
              size="sm"
              type="inherit"
            >
              {source.excerpt}
            </Text>
          </Stack>
          {long ? (
            <Button
              className="mt-1"
              label={open ? "Show less" : "Show all"}
              onClick={() => setOpen(!open)}
              size="sm"
              variant="ghost"
            />
          ) : null}
        </>
      ) : null}
    </li>
  );
}

/** "Apr 1, 2025", or nothing when the provider's date can't be read. */
function publishedOn(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00Z`)
    : new Date(value);
  if (Number.isNaN(day.getTime())) return undefined;
  return day.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
