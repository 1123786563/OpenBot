import {
  type Icon,
  IconBolt,
  IconBox,
  IconClock,
  IconPlug,
  IconSettings,
  IconShieldLock,
  IconTarget,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { OpenBotLogo } from "@/components/edition/openbot-logo";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/** Marks a message for extraction without translating it at module scope. */
function navigationMessage(messageId: string, label: string) {
  return { messageId, label };
}

/** Shared destinations for the Web sidebar and account menu. */
export type NavigationItem =
  | {
      kind?: undefined;
      id:
        | "bots"
        | "routines"
        | "goals"
        | "capabilities"
        | "connections"
        | "admin"
        | "settings";
      label: string;
      messageId: string;
      to:
        | "/bots"
        | "/routines"
        | "/responsibilities"
        | "/capabilities"
        | "/connections"
        | "/admin"
        | "/settings";
      search?: { view: "goals" };
      icon: Icon;
      section: "primary" | "account";
      /** Admin routes are guarded on the server; the entry is hidden from people who cannot open them. */
      adminOnly?: boolean;
    }
  | {
      /**
       * Not a page: the personal edition's list of team features, opened as a dialog where Admin
       * would be. See `components/edition/team-features-dialog.tsx`, which every frame draws it
       * through.
       */
      kind: "dialog";
      id: "team-features";
      label: string;
      messageId: string;
      icon: Icon;
      section: "account";
    };

/** An entry that is a page. Bots, Capabilities, Connections and Settings always are. */
export type NavigationLink = Extract<NavigationItem, { to: string }>;

export function isNavigationLink(item: NavigationItem): item is NavigationLink {
  return item.kind !== "dialog";
}

const TEAM_FEATURES_ITEM: NavigationItem = {
  kind: "dialog",
  id: "team-features",
  ...navigationMessage("nav.teamFeatures", "OpenBot for Business"),
  icon: OpenBotLogo,
  section: "account",
};

export const NAVIGATION: readonly NavigationItem[] = [
  {
    id: "bots",
    ...navigationMessage("nav.bots", "Bots"),
    to: "/bots",
    icon: IconBolt,
    section: "primary",
  },
  {
    id: "routines",
    ...navigationMessage("nav.routines", "Routines"),
    to: "/routines",
    icon: IconClock,
    section: "primary",
  },
  {
    id: "goals",
    ...navigationMessage("nav.goals", "Goals"),
    to: "/responsibilities",
    search: { view: "goals" },
    icon: IconTarget,
    section: "primary",
  },
  {
    id: "capabilities",
    ...navigationMessage("nav.capabilities", "Capabilities"),
    to: "/capabilities",
    icon: IconBox,
    section: "primary",
  },
  {
    id: "connections",
    ...navigationMessage("nav.connections", "Connections"),
    to: "/connections",
    icon: IconPlug,
    section: "primary",
  },
  {
    id: "admin",
    ...navigationMessage("nav.admin", "Admin"),
    to: "/admin",
    icon: IconShieldLock,
    section: "account",
    adminOnly: true,
  },
  {
    id: "settings",
    ...navigationMessage("nav.settings", "Settings"),
    to: "/settings",
    icon: IconSettings,
    section: "account",
  },
];

/**
 * The destinations this person may open, in order. The personal edition has no Admin: the team
 * features entry takes its place, for everybody, since nobody there administers anybody else. It has
 * no Capabilities either: a person's skills and what their Bots remember are on the Bots page, so
 * there is one place fewer to go.
 */
export function navigationFor(
  role: string | undefined,
  edition: "team" | "personal" = "team",
): readonly NavigationItem[] {
  if (edition === "personal") {
    return NAVIGATION.filter((item) => item.id !== "capabilities").map(
      (item) => (item.id === "admin" ? TEAM_FEATURES_ITEM : item),
    );
  }
  return NAVIGATION.filter(
    (item) => item.kind === "dialog" || !item.adminOnly || role === "admin",
  );
}

/** `navigationFor` the signed-in person, on this deployment's edition. */
export function useNavigationItems(): readonly NavigationItem[] {
  const { data: user } = useQuery(currentUserQueryOptions());
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  return navigationFor(user?.role, capabilities?.edition ?? "team");
}
