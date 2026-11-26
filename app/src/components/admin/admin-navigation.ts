import {
  IconBrain,
  IconBuildingBank,
  IconChecks,
  IconCode,
  IconDeviceDesktop,
  IconFileText,
  IconKey,
  IconLayoutGrid,
  IconListDetails,
  IconLockAccess,
  IconPuzzle,
  IconRadar,
  IconShieldCheck,
  IconUsers,
  IconZoomQuestion,
} from "@tabler/icons-react";
import type { LinkOptions } from "@tanstack/react-router";

/** Marks a message for extraction without translating it at module scope. `title` stays English: it is the search control data and the overview's own words. */
function navigationMessage(messageId: string, label: string) {
  return { messageId, label };
}

export const ADMIN_NAVIGATION: {
  title: string;
  /** The group heading's words, in the language in force (from `label` through `messageId`). */
  label: string;
  messageId: string;
  description: string;
  items: {
    description: string;
    icon: React.ComponentType<{ className?: string }>;
    linkOptions: LinkOptions;
    tasks: string[];
    /** Control data: the overview rows and the search control match on it. The sidebar row shows `label`. */
    title: string;
    /** The row's words, in the language in force (from `label` through `messageId`). */
    label: string;
    messageId: string;
  }[];
}[] = [
  {
    title: "Bot access",
    ...navigationMessage("admin.sidebar.groups.botAccess", "Bot access"),
    description: "Control what Bots can access outside OpenBot.",
    items: [
      {
        title: "Credentials",
        ...navigationMessage("admin.sidebar.credentials", "Credentials"),
        description: "Manage this deployment’s keys and tokens.",
        icon: IconKey,
        linkOptions: { to: "/admin/credentials" },
        tasks: ["revoke an API key", "rotate a secret"],
      },
      {
        title: "Boundaries",
        ...navigationMessage("admin.sidebar.boundaries", "Boundaries"),
        description: "Define actions that no Bot may take.",
        icon: IconShieldCheck,
        linkOptions: { to: "/admin/boundaries" },
        tasks: ["block an action", "try a boundary rule"],
      },
      {
        title: "Approvals",
        ...navigationMessage("admin.sidebar.approvals", "Approvals"),
        description: "Choose which actions require approval for members’ Bots.",
        icon: IconChecks,
        linkOptions: { to: "/admin/approvals" },
        tasks: ["require human review", "review a shared account request"],
      },
      {
        title: "Computers",
        ...navigationMessage("admin.sidebar.computers", "Computers"),
        description:
          "Manage the computers that run Bot tools, when idle ones stop, and where they can connect.",
        icon: IconDeviceDesktop,
        linkOptions: { to: "/admin/computers" },
        tasks: ["stop an idle computer", "reset a Bot computer"],
      },
    ],
  },
  {
    title: "Bot capabilities",
    ...navigationMessage(
      "admin.sidebar.groups.botCapabilities",
      "Bot capabilities",
    ),
    description:
      "Configure the models, apps, skills, and UI components available to Bots.",
    items: [
      {
        title: "Plugins",
        ...navigationMessage("admin.sidebar.plugins", "Plugins"),
        description:
          "Connect services, choose which Bots can use them, and approve MCP servers.",
        icon: IconPuzzle,
        linkOptions: { to: "/admin/plugins" },
        tasks: ["connect an app", "approve an MCP server"],
      },
      {
        title: "Providers",
        ...navigationMessage("admin.sidebar.providers", "Providers"),
        description:
          "See which provider serves your Bots' models, and choose which models they may use.",
        icon: IconBrain,
        linkOptions: { to: "/admin/providers" },
        tasks: ["choose an AI model", "configure a model provider"],
      },
      {
        title: "Skills",
        ...navigationMessage("admin.sidebar.skills", "Skills"),
        description: "Create reusable instructions people can run with /.",
        icon: IconFileText,
        linkOptions: { to: "/admin/skills" },
        tasks: ["write a workspace skill", "manage slash commands"],
      },
      {
        title: "Automatic learning",
        ...navigationMessage(
          "admin.sidebar.automaticLearning",
          "Automatic learning",
        ),
        description:
          "Learn from finished conversations, review the skills it proposes, and choose whether people may share theirs.",
        icon: IconFileText,
        linkOptions: { to: "/admin/learning" },
        tasks: ["review suggested skills", "manage knowledge sharing"],
      },
      {
        title: "Check-ins",
        ...navigationMessage("admin.sidebar.checkIns", "Check-ins"),
        description:
          "Turn check-ins on or off, limit them, and see how often people start what Bots raise.",
        icon: IconRadar,
        linkOptions: { to: "/admin/proactive" },
        tasks: ["turn off proactive suggestions", "limit check-ins"],
      },
      {
        title: "UI components",
        ...navigationMessage("admin.sidebar.uiComponents", "UI components"),
        description:
          "Manage custom components that Bots can display in conversations.",
        icon: IconLayoutGrid,
        linkOptions: { to: "/admin/components" },
        tasks: ["manage interactive widgets"],
      },
      {
        title: "Playground",
        ...navigationMessage("admin.sidebar.playground", "Playground"),
        description: "Write a component and watch it render as you type.",
        icon: IconCode,
        linkOptions: { to: "/admin/playground" },
        tasks: ["preview a UI component"],
      },
    ],
  },
  {
    title: "People and sign-in",
    ...navigationMessage(
      "admin.sidebar.groups.peopleSignIn",
      "People and sign-in",
    ),
    description: "",
    items: [
      {
        title: "People",
        ...navigationMessage("admin.sidebar.people", "People"),
        description: "Review members, manage admin roles, and remove access.",
        icon: IconUsers,
        linkOptions: { to: "/admin/people" },
        tasks: ["grant admin access", "remove a member"],
      },
      {
        title: "Permissions",
        ...navigationMessage("admin.sidebar.permissions", "Permissions"),
        description:
          "Choose what people may do with Bots, for everybody and per role or group.",
        icon: IconLockAccess,
        linkOptions: { to: "/admin/permissions" },
        tasks: ["change what a role can do", "control member capabilities"],
      },
      {
        title: "Identity providers",
        ...navigationMessage(
          "admin.sidebar.identityProviders",
          "Identity providers",
        ),
        description:
          "Configure your company’s sign-in provider for each email domain, and require SSO.",
        icon: IconBuildingBank,
        linkOptions: { to: "/admin/identity-providers" },
        tasks: ["single sign-on", "configure SAML or OpenID Connect"],
      },
    ],
  },
  {
    title: "Governance and audit",
    ...navigationMessage(
      "admin.sidebar.groups.governanceAudit",
      "Governance and audit",
    ),
    description: "",
    items: [
      {
        title: "Audit",
        ...navigationMessage("admin.sidebar.audit", "Audit"),
        description:
          "Review actions taken in OpenBot and who took them, and record Bots' commands.",
        icon: IconListDetails,
        linkOptions: { to: "/admin/audit" },
        tasks: ["find an activity log", "see who took an action"],
      },
      {
        title: "Test a policy",
        ...navigationMessage("admin.sidebar.testPolicy", "Test a policy"),
        description:
          "Ask what OpenBot would do if a Bot took an action, and see which control decides.",
        icon: IconZoomQuestion,
        linkOptions: { to: "/admin/what-if" },
        tasks: ["simulate a policy", "check whether an action is allowed"],
      },
    ],
  },
];

export type AdminSetting = (typeof ADMIN_NAVIGATION)[number]["items"][number];

function searchWords(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function isSingleTypo(term: string, word: string): boolean {
  if (term.length < 4 || Math.abs(term.length - word.length) > 1) return false;
  const firstDifference = term
    .split("")
    .findIndex((letter, index) => letter !== word[index]);
  if (firstDifference === -1) return term.length + 1 === word.length;
  const left = term.slice(firstDifference);
  const right = word.slice(firstDifference);
  if (left.length > right.length) return left.slice(1) === right;
  if (left.length < right.length) return left === right.slice(1);
  return (
    left.slice(1) === right.slice(1) ||
    (left[0] === right[1] &&
      left[1] === right[0] &&
      left.slice(2) === right.slice(2))
  );
}

function rankSettings(terms: string[], spelling: boolean): AdminSetting[] {
  const exact = terms.join(" ");
  const matches = (words: string[]) => {
    const unmatched = terms.filter(
      (term) => !words.some((word) => word.startsWith(term)),
    );
    if (!unmatched.length) return true;
    const [typo] = unmatched;
    return (
      spelling &&
      unmatched.length === 1 &&
      typo !== undefined &&
      words.some((word) => isSingleTypo(typo, word))
    );
  };
  return ADMIN_NAVIGATION.flatMap((section) => {
    const group = searchWords(section.title);
    return section.items.flatMap((item) => {
      const title = searchWords(item.title);
      const tasks = item.tasks.map(searchWords);
      const description = searchWords(item.description);
      const rank =
        title.join(" ") === exact
          ? 0
          : matches(title)
            ? 1
            : tasks.some((task) => task.join(" ") === exact)
              ? 2
              : tasks.some(matches)
                ? 3
                : matches(group)
                  ? 4
                  : matches([...title, ...group, ...description])
                    ? 5
                    : null;
      if (rank === null) return [];
      return [{ item, rank }];
    });
  })
    .sort((left, right) => left.rank - right.rank)
    .map(({ item }) => item);
}

/** Exact and prefix results keep their existing order. Spelling is a fallback for an empty list. */
export function searchAdminSettings(
  query: string,
): { items: AdminSetting[]; spelling: boolean } | null {
  const terms = searchWords(query);
  if (!terms.length) return null;
  const exact = rankSettings(terms, false);
  if (exact.length) return { items: exact, spelling: false };
  const close = rankSettings(terms, true);
  return { items: close, spelling: close.length > 0 };
}
