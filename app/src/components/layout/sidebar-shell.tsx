import { HStack } from "@astryxdesign/core/HStack";
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useState,
} from "react";
import { AstryxNavigationToggle } from "@/components/astryx-pilot/navigation-toggle";
import { astryxScope } from "@/components/astryx-pilot/theme";
import {
  SidebarProvider,
  SidebarResizeProvider,
} from "@/components/ui/sidebar";
import { useTranslation } from "@/i18n";
import { getStoredValue, setStoredValue } from "@/lib/browser-storage";
import {
  applySidebarOpen,
  parseStoredSidebarOpen,
  parseStoredSidebarWidth,
  SIDEBAR_STORAGE_KEY,
  SIDEBAR_WIDTH_STORAGE_PREFIX,
} from "@/lib/sidebar";
import { cn } from "@/lib/utils";

/**
 * The sidebar's gutters: the header, content and footer already sit 8px in from the edge; every
 * item inside them starts 10px further in, so the search icon, the avatars, the nav icons and the
 * person's avatar share one left edge.
 */
const SIDEBAR_GUTTER = "[&_[data-sidebar=menu-button]]:px-2.5";

/**
 * The frame the three shells — app, admin, settings — hang their sidebar in.
 *
 * It exists for one reason: the open/closed state has to outlive a reload, and the primitive's
 * `SidebarProvider` cannot do that on its own (it writes a cookie nothing reads and hardcodes
 * `defaultOpen` to true). Driving it as controlled state is a dozen lines, and three copies of a
 * dozen lines is three chances for one shell to forget the preference the other two remember.
 *
 * `width` is what differs between the shells before anybody resizes one. The app's roster earns
 * 340px because its rows are two-line message previews; admin and settings hold short nav labels and
 * earn 300px. Dragging the sidebar's edge (`SidebarRail`) changes it, and each shell remembers its
 * own under its `name`.
 */
export function SidebarShell({
  children,
  className,
  name,
  pageToggle,
  width: defaultWidth,
}: {
  children: ReactNode;
  className?: string;
  /** Whose width this is: each shell remembers its own, under this name. */
  name: string;
  pageToggle?: boolean;
  /** The width before anybody drags the sidebar's edge. */
  width: string;
}) {
  // Read before the first paint, so a shell somebody left collapsed never flashes open.
  const [open, setOpen] = useState(() =>
    parseStoredSidebarOpen(getStoredValue(SIDEBAR_STORAGE_KEY)),
  );
  const widthKey = `${SIDEBAR_WIDTH_STORAGE_PREFIX}${name}`;
  const [width, setWidth] = useState(() =>
    parseStoredSidebarWidth(getStoredValue(widthKey), defaultWidth),
  );
  // While the edge is dragged, the sidebar follows the pointer instead of easing after it.
  const [resizing, setResizing] = useState(false);
  const resize = useMemo(
    () => ({
      setWidth: (pixels: number) => setWidth(`${pixels}px`),
      commitWidth: (pixels: number) => setStoredValue(widthKey, String(pixels)),
      setResizing,
    }),
    [widthKey],
  );

  useEffect(() => {
    applySidebarOpen(open, {
      setStoredValue,
    });
  }, [open]);

  const { t } = useTranslation();
  return (
    <SidebarProvider
      className={cn(SIDEBAR_GUTTER, className)}
      data-resizing={resizing ? "" : undefined}
      onOpenChange={setOpen}
      open={open}
      pageToggle={pageToggle}
      /*
       * `--sidebar-width-mobile` is set for the shape's sake and currently goes unread: the
       * primitive's mobile branch styles its Sheet from a hardcoded 18rem. Below 768px the sidebar
       * is that Sheet, which is also why the stored preference never reaches it — a panel that
       * covers the screen it overlays has no business being open before anybody asked for it.
       */
      style={
        {
          "--sidebar-width": width,
          "--sidebar-width-mobile": "20rem",
        } as CSSProperties
      }
    >
      {/* #main-content carries tabIndex={-1}, so the browser's own anchor navigation moves focus to it. */}
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:z-50 focus:inset-s-4 focus:top-4 focus:rounded-md focus:bg-background focus:p-3 focus:text-foreground focus:outline focus:outline-ring"
        href="#main-content"
      >
        {t("frame.skipToContent", "Skip to content")}
      </a>
      <SidebarResizeProvider value={resize}>{children}</SidebarResizeProvider>
    </SidebarProvider>
  );
}

/**
 * The shell's one navigation opener, in a header row above the content.
 *
 * Below 768px the sidebar is a sheet that starts closed, and the shadcn `SidebarToggle` only draws
 * through `PageShell`'s bar. This header is the workspace shell's own header row, minus the brand:
 * one opener per shell, in the same place, whatever page is open.
 *
 * `astryxScope` is required: the Astryx Button renders unstyled outside `[data-astryx-pilot]`.
 */
export function ShellNavigationHeader({
  navId,
  trigger,
}: {
  /** Passed to the shell's sidebar so its mobile sheet answers this header's `aria-controls`. */
  navId: string;
  /** The toggle's own button, so the sidebar can hand focus back to it when it closes. */
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <HStack
      {...astryxScope}
      as="header"
      align="center"
      gap={2}
      paddingInline={3}
      minHeight="var(--spacing-12)"
      className="shrink-0 border-be border-(--color-border)"
    >
      <AstryxNavigationToggle navId={navId} trigger={trigger} />
    </HStack>
  );
}
