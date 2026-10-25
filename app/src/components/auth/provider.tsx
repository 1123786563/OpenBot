import {
  AuthUIProvider,
  type AuthUIProviderProps,
} from "better-auth-ui";
import { Link as RouterLink, useNavigate } from "@tanstack/react-router";
import {
  createContext,
  useContext,
  useMemo,
  type ComponentType,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
} from "react";
import { authClient } from "@/lib/auth/client";
import type { UiSourceManifest } from "@/lib/auth/ui-provider";

/*
 * The fixed Better Auth UI provider, wired the OpenBot way (T01.08, #520).
 *
 * Everything the kit renders hangs off one pinned source (see
 * app/src/lib/auth/ui-source.json), and this file is the registry entry that
 * adapts its provider to this app: the same auth client the rest of the app
 * uses, navigation through the existing TanStack router — never a second one —
 * and no query client of its own, so the app's stays the only one.
 *
 * The organization components of the pinned source are not wired here: their
 * built-in reads hit the X-class native GETs, so each is declared in the
 * manifest as adapter-injected or not reused, and FixedUiOrganization is the
 * only door through which one may mount. Until T01.09 registers an adapter,
 * that door opens onto nothing.
 */

/**
 * How a pinned organization component may be used:
 * - `inject-openbot-adapter`: reusable only wrapped in the OpenBot adapter that
 *   feeds it OpenBot data instead of the native endpoints;
 * - `not-reused`: kept out of the tree entirely.
 */
export type OrganizationDeclaration = {
  reuse: "inject-openbot-adapter" | "not-reused";
  upstream: string;
  xClassDependencies?: string[];
  note?: string;
};

/** An OpenBot adapter wraps the pinned component and provides its data. */
export type OrganizationAdapter = ComponentType<{ children?: ReactNode }>;

type FixedUiValue = {
  declarations: UiSourceManifest["organization"];
  adapters: Partial<Record<string, OrganizationAdapter>>;
};

const FixedUiContext = createContext<FixedUiValue>({
  declarations: {},
  adapters: {},
});

/** The declarations and registered adapters of the fixed UI source. */
export function useFixedUi(): FixedUiValue {
  return useContext(FixedUiContext);
}

/**
 * The one door for a pinned organization component: undeclared or not-reused
 * components render nothing, and a declared one renders only inside its
 * registered OpenBot adapter — which is what keeps the X-class native GETs out
 * of the render tree.
 */
export function FixedUiOrganization({
  name,
  component: Component,
}: {
  name: string;
  component: ComponentType<Record<string, unknown>>;
}): ReactElement | null {
  const { declarations, adapters } = useFixedUi();
  const declaration = declarations[name];
  if (!declaration) {
    console.error(
      `OpenBot fixed UI: organization component "${name}" is not declared in ui-source.json and must not be rendered.`,
    );
    return null;
  }
  if (declaration.reuse !== "inject-openbot-adapter") return null;
  const Adapter = adapters[name];
  if (!Adapter) return null;
  return (
    <Adapter>
      <Component />
    </Adapter>
  );
}

/** The kit's links go through the app's router rather than plain <a> tags. */
function OpenBotLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <RouterLink to={href} className={className}>
      {children}
    </RouterLink>
  );
}

/** Toasts without a toast dependency: they stay console-visible until the app wires its own. */
const quietToast = ({
  variant = "default",
  message,
}: {
  variant?: string;
  message?: string;
}) => {
  if (variant === "error" || variant === "destructive") {
    console.error(message);
  } else {
    console.info(message);
  }
};

/**
 * The pinned kit's provider with OpenBot's wiring. Organization features stay
 * off here — they arrive with the adapter registration in T01.09, on the other
 * side of the declaration gate above.
 */
export function OpenBotAuthUIProvider({
  children,
  source,
  ...kitProps
}: PropsWithChildren<
  { source: UiSourceManifest } & Partial<AuthUIProviderProps>
>): ReactElement {
  const navigate = useNavigate();

  const kitNavigation = useMemo(
    () => ({
      navigate: (href: string) => void navigate({ to: href }),
      replace: (href: string) => void navigate({ to: href, replace: true }),
    }),
    [navigate],
  );

  const fixedUi = useMemo<FixedUiValue>(
    () => ({ declarations: source.organization, adapters: {} }),
    [source],
  );

  return (
    <AuthUIProvider
      authClient={authClient}
      navigate={kitNavigation.navigate}
      replace={kitNavigation.replace}
      Link={OpenBotLink}
      toast={quietToast}
      organization={false}
      {...kitProps}
    >
      <FixedUiContext.Provider value={fixedUi}>
        {children}
      </FixedUiContext.Provider>
    </AuthUIProvider>
  );
}
