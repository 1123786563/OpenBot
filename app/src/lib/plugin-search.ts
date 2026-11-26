import { z } from "zod";

const query = z.string().max(200).optional().catch(undefined);

/** The list query travels with drill-down links. Each subpage can also have its own filter. */
export const pluginSearch = z.object({ q: query });
export const pluginSubpageSearch = pluginSearch.extend({ filter: query });

declare module "@tanstack/react-router" {
  interface HistoryState {
    returnPlugin?: string;
  }
}
