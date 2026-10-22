import { useTranslation } from "react-i18next";

/**
 * The skip link, for the three shells that hang a sidebar left of their content.
 *
 * The app roster can hold sixty links ahead of `main`; a keyboard user crossing between screens
 * paid for every one of them on every Tab. This link is the first focusable thing in the DOM, it
 * says where it goes, and it takes focus to the content when used. It renders inline in each
 * shell (app/admin/settings) rather than inside `SidebarShell`, because the shell's children are
 * the sidebar itself — the link has to come BEFORE the sidebar to be the first stop.
 */
export function SkipToContent({
  targetId = "main-content",
}: {
  targetId?: string;
}) {
  const { t } = useTranslation("nav");
  return (
    <a
      href={`#${targetId}`}
      className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-100 focus:rounded-lg focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-md focus:outline-none"
    >
      {t("skipToContent")}
    </a>
  );
}

/**
 * What the link points at. Each shell puts this on its `<main>`; keeping the target as a prop
 * costs nothing and leaves room for a second pane (say, a chat transcript) to host its own
 * target later.
 */
export const MAIN_CONTENT_ID = "main-content";
