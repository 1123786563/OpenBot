import type { QueryKey } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import type { Organization } from "better-auth/plugins/organization";
import type { AuthHooks } from "better-auth-ui";
import {
  type ComponentType,
  createContext,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useReducer,
} from "react";
import {
  FixedUiOrganization,
  OpenBotAuthUIProvider,
  type OrganizationAdapter,
  useFixedUi,
} from "@/components/auth/provider";
import type { UiSourceManifest } from "@/lib/auth/ui-provider";
import { authClient } from "./client";
import uiSourceJson from "./ui-source.json";

/*
 * The local organization plugin glue for the fixed Better Auth UI (T01.09, #521).
 *
 * The pinned kit's organization components read their data through AuthUIContext
 * hooks, and by default those hooks call four X-class native GETs —
 * /organization/list, /organization/list-user-teams, /organization/get-invitation,
 * /organization/list-user-invitations (interfaces §3.2). None of them may be
 * called: eligibility lives in the OpenBot workspace-scope listing, invitations
 * land through an OpenBot invitations adapter (T04.11), and the active
 * organization is a preference the server never treats as authority.
 *
 * So this module supplies the components' data instead:
 *
 * - `OpenBotOrganizationScopeProvider` carries the small `OrganizationScopeAdapter`
 *   the app composes — a listing read, the current company preference, and a
 *   selection-intent sink. Nothing here answers "may this person see that company";
 *   the server decides that per scoped request.
 * - `useOpenBotOrganizationHooks` replaces every organization read the pinned kit
 *   performs with either the adapter or an inert answer that fetches nothing. A read
 *   whose gated OpenBot adapter does not exist yet returns no data — it is never
 *   dressed up as an empty organization or an empty roster.
 * - `restrictedOrganizationClient` narrows the app's client for the adapted subtree:
 *   `organization` has exactly one action, `setActive`, and that one records the
 *   selection intent locally. Create-organization (self-service company or personal
 *   space), dynamic roles, bare delete, member/role writes and impersonation have no
 *   callable method at all — they arrive only with the server-side commands that own
 *   them (P04/P08/P12), never as a client passthrough.
 * - `ORGANIZATION_ADAPTERS` holds one adapter per component the manifest declares
 *   `inject-openbot-adapter`; `OpenBotOrganizationSlot` registers it with the
 *   T01.08 declaration gate and then mounts the pinned component inside it, so an
 *   organization component renders only after its adapter is registered.
 */

const uiSource = uiSourceJson as unknown as UiSourceManifest;

/** A company as the OpenBot side names it; the front channel is decided elsewhere. */
export type OpenBotOrganization = {
  id: string;
  name: string;
  /** The route-facing name; falls back to the id, which is stable and unique. */
  slug?: string;
  logo?: string | null;
};

/**
 * Everything an adapted organization component may ask of the app.
 *
 * Deliberately small: an eligibility read, the current selection preference, and a
 * sink for a selection intent. `activeCompanyId` is what this session is looking
 * at — not a capability, not a role, and not proof the server will answer.
 */
export type OrganizationScopeAdapter = {
  /** The signed-in person the selection belongs to; scopes the shared query cache. */
  userId: string;
  /** The app's React Query key for the listing read, so the one QueryClient owns it. */
  listingQueryKey: QueryKey;
  /** Reads this person's eligible companies. The server decides eligibility; none is preselected. */
  listCompanies: () => Promise<OpenBotOrganization[]>;
  /** The company this session currently works under, or null for no preference. */
  activeCompanyId: string | null;
  /** Records a selection intent. The server verifies every scoped request afterwards. */
  selectCompany: (companyId: string | null) => void;
};

/** The names of everything the adapted subtree can do. Enumeration, so a test can hold it still. */
export const ORGANIZATION_ADAPTER_ACTIONS = [
  "listCompanies",
  "activeCompany",
  "selectCompany",
] as const;

const OrganizationScopeContext = createContext<OrganizationScopeAdapter | null>(
  null,
);

export function OpenBotOrganizationScopeProvider({
  adapter,
  children,
}: PropsWithChildren<{ adapter: OrganizationScopeAdapter }>): ReactElement {
  return (
    <OrganizationScopeContext.Provider value={adapter}>
      {children}
    </OrganizationScopeContext.Provider>
  );
}

function useOrganizationScope(): OrganizationScopeAdapter {
  const adapter = useContext(OrganizationScopeContext);
  if (adapter === null) {
    throw new Error(
      "OpenBot organization components must render under OpenBotOrganizationScopeProvider.",
    );
  }
  return adapter;
}

/**
 * The pinned `Organization` shape from the server payload, built from a listing row.
 *
 * `createdAt` is the one field the workspace-scope listing does not carry and the
 * organization views do not render; it is a fixed epoch rather than a fabricated
 * timestamp.
 */
function toPinnedOrganization(company: OpenBotOrganization): Organization {
  return {
    id: company.id,
    name: company.name,
    slug: company.slug ?? company.id,
    logo: company.logo ?? null,
    createdAt: new Date(0),
  };
}

/** The read whose gated OpenBot adapter has not landed yet: no data, and no native call. */
function inertRead<T>() {
  return () => ({ data: null as T | null, isPending: false, error: null });
}

function useOpenBotOrganizationHooks(
  adapter: OrganizationScopeAdapter,
): Partial<AuthHooks> {
  return useMemo<Partial<AuthHooks>>(() => {
    const useOrganizations = () => {
      const query = useQuery({
        queryKey: adapter.listingQueryKey,
        queryFn: () => adapter.listCompanies(),
        staleTime: 10_000,
      });
      const organizations = useMemo<Organization[] | null>(() => {
        if (query.data === undefined) return null;
        return query.data.map(toPinnedOrganization);
      }, [query.data]);
      return {
        data: organizations,
        isPending: query.isPending,
        isRefetching: query.isFetching,
        error: null,
        refetch: () => void query.refetch(),
      };
    };

    const useActiveOrganization = () => {
      const organizations = useOrganizations();
      const active = useMemo<Organization | null>(() => {
        if (adapter.activeCompanyId === null) return null;
        const found = organizations.data?.find(
          (candidate) => candidate.id === adapter.activeCompanyId,
        );
        return found ?? null;
      }, [organizations.data]);
      return {
        data: active,
        isPending: organizations.isPending,
        isRefetching: organizations.isRefetching,
        error: null,
        refetch: organizations.refetch,
      };
    };

    /*
     * Reads whose gated OpenBot adapters arrive with their own tasks keep returning no
     * data until then. An empty roster or an empty invitation list would read as a
     * server fact ("nobody is here") that this task has not verified; no data reads as
     * "not wired yet", which is the truth. Permission answers fail closed.
     */
    /*
     * The pinned atom types carry the native payload's nested members/invitations,
     * which an adapted read does not fetch; the views here read company fields only.
     * One documented assertion at the hook boundary rather than fabricating the
     * nested collections this task has not verified.
     */
    return {
      useListOrganizations: useOrganizations,
      useActiveOrganization,
      useHasPermission: () => ({ data: null, isPending: false, error: null }),
      useInvitation: inertRead(),
      useListInvitations: inertRead(),
      useListUserInvitations: inertRead(),
      useListMembers: inertRead(),
    } as unknown as Partial<AuthHooks>;
  }, [adapter]);
}

/**
 * The app's client, narrowed to what an organization component may call.
 *
 * `setActive` is the fixed UI's switch: here it records a selection intent through
 * the adapter and returns as if the preference were set. It reaches no endpoint and
 * grants nothing — the OpenBot selection coordinator (T03.05) owns the real switch,
 * and the server still verifies every scoped request. Every other organization
 * method is absent rather than a client passthrough.
 */
export function restrictedOrganizationClient(
  adapter: OrganizationScopeAdapter,
): typeof authClient {
  const organization = {
    setActive: async (input: { organizationId?: string | null } = {}) => {
      adapter.selectCompany(input.organizationId ?? null);
      return { data: null, error: null };
    },
  };

  return new Proxy(authClient, {
    get(target, property) {
      if (property === "organization") return organization;
      return Reflect.get(target, property, target);
    },
  });
}

/** The injected data seam every adapted organization component mounts inside. */
function AdaptedOrganizationData({
  children,
}: {
  children?: ReactNode;
}): ReactElement {
  const adapter = useOrganizationScope();
  const hooks = useOpenBotOrganizationHooks(adapter);
  const client = useMemo(
    () => restrictedOrganizationClient(adapter),
    [adapter],
  );

  return (
    <OpenBotAuthUIProvider
      source={uiSource}
      authClient={client}
      hooks={hooks}
      organization={false}
    >
      {children}
    </OpenBotAuthUIProvider>
  );
}

/**
 * One adapter per component ui-source.json declares `inject-openbot-adapter`.
 *
 * Declared components that are `not-reused` (create dialog, delete card, the native
 * refetcher, the native active-organization hook) deliberately have no adapter and
 * therefore cannot mount through the gate.
 */
export const ORGANIZATION_ADAPTERS: Record<string, OrganizationAdapter> =
  Object.fromEntries(
    Object.entries(uiSource.organization)
      .filter(
        ([, declaration]) => declaration.reuse === "inject-openbot-adapter",
      )
      .map(([name]) => [name, AdaptedOrganizationData]),
  );

/**
 * The OpenBot door onto a pinned organization component.
 *
 * T01.08's gate (`FixedUiOrganization`) is the only door: undeclared or not-reused
 * names render nothing, and a declared name renders only inside its registered
 * adapter. The provider holds that adapter map, so registration is what opens it.
 * provider.tsx owns the map and is hash-pinned in ui-source.json, so registration
 * happens from the consumer side: the assignment is an idempotent module constant,
 * and the re-render is what lets the gate see it.
 */
export function OpenBotOrganizationSlot({
  name,
  component,
}: {
  name: string;
  component: ComponentType<Record<string, unknown>>;
}): ReactElement | null {
  const fixedUi = useFixedUi();
  const adapter = ORGANIZATION_ADAPTERS[name];
  const [, rerender] = useReducer((tick: number) => tick + 1, 0);

  useLayoutEffect(() => {
    if (adapter === undefined) return;
    if (fixedUi.adapters[name] === adapter) return;
    fixedUi.adapters[name] = adapter;
    rerender();
  }, [adapter, fixedUi, name]);

  return <FixedUiOrganization name={name} component={component} />;
}
