/**
 * The vendored brand marks, inlined at build time as data URIs.
 *
 * The same files the desktop setup window draws, read from `shared/marks/` so there is one copy of
 * each vendor's artwork rather than two to keep in step. See `shared/marks/README.md` before
 * adding, renaming or drawing anything here: the rules in it are the reason a brand with no mark
 * shows its name alone instead of a monogram we invented.
 *
 * As URIs rather than SVG source on purpose: an `<img>` cannot execute anything, so drawing these
 * needs no `dangerouslySetInnerHTML` and what is in the file never becomes a security question.
 */
// ponytail: import.meta.glob is Vite's; the node collector and plain `bun test` have no Vite
// transform, so an empty table keeps the module loadable there. That is a real state — every
// brand then draws its name alone, the same branch a maintained set with no mark takes.
const files = (
  typeof import.meta.glob === "function"
    ? import.meta.glob("../../../shared/marks/*.svg", {
        eager: true,
        query: "?inline",
        import: "default",
      })
    : {}
) as Record<string, string>;

const byId = new Map<string, string>(
  Object.entries(files).map(([path, uri]) => [
    path.replace(/^.*\/marks\//, "").replace(".svg", ""),
    uri,
  ]),
);

/** The mark for a brand id, or null where no maintained set has one. */
export function markFor(id: string | null | undefined): string | null {
  return (id && byId.get(id)) ?? null;
}
