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

export const ADMIN_NAVIGATION: {
  title: string;
  description: string;
  items: {
    description: string;
    icon: React.ComponentType<{ className?: string }>;
    linkOptions: LinkOptions;
    title: string;
  }[];
}[] = [
  {
    title: "Bot access",
    description: "Control what Bots can access outside OpenBot.",
    items: [
      {
        title: "Credentials",
        description: "Manage this deployment’s keys and tokens.",
        icon: IconKey,
        linkOptions: { to: "/admin/credentials" },
      },
      {
        title: "Boundaries",
        description: "Define actions that no Bot may take.",
        icon: IconShieldCheck,
        linkOptions: { to: "/admin/boundaries" },
      },
      {
        title: "Approvals",
        description: "Choose which actions require approval for members’ Bots.",
        icon: IconChecks,
        linkOptions: { to: "/admin/approvals" },
      },
      {
        title: "Computers",
        description:
          "Manage the computers that run Bot tools, when idle ones stop, and where they can connect.",
        icon: IconDeviceDesktop,
        linkOptions: { to: "/admin/computers" },
      },
    ],
  },
  {
    title: "Bot capabilities",
    description:
      "Configure the models, apps, skills, and UI components available to Bots.",
    items: [
      {
        title: "Plugins",
        description:
          "Connect services, choose which Bots can use them, and approve MCP servers.",
        icon: IconPuzzle,
        linkOptions: { to: "/admin/plugins" },
      },
      {
        title: "Providers",
        description:
          "See which provider serves your Bots' models, and choose which models they may use.",
        icon: IconBrain,
        linkOptions: { to: "/admin/providers" },
      },
      {
        title: "Skills",
        description: "Create reusable instructions people can run with /.",
        icon: IconFileText,
        linkOptions: { to: "/admin/skills" },
      },
      {
        title: "Automatic learning",
        description:
          "Learn from finished conversations, review the skills it proposes, and choose whether people may share theirs.",
        icon: IconFileText,
        linkOptions: { to: "/admin/learning" },
      },
      {
        title: "Check-ins",
        description:
          "Turn check-ins on or off, limit them, and see how often people start what Bots raise.",
        icon: IconRadar,
        linkOptions: { to: "/admin/proactive" },
      },
      {
        title: "UI components",
        description:
          "Manage custom components that Bots can display in conversations.",
        icon: IconLayoutGrid,
        linkOptions: { to: "/admin/components" },
      },
      {
        title: "Playground",
        description: "Write a component and watch it render as you type.",
        icon: IconCode,
        linkOptions: { to: "/admin/playground" },
      },
    ],
  },
  {
    title: "People and sign-in",
    description: "",
    items: [
      {
        title: "People",
        description: "Review members, manage admin roles, and remove access.",
        icon: IconUsers,
        linkOptions: { to: "/admin/people" },
      },
      {
        title: "Permissions",
        description:
          "Choose what people may do with Bots, for everybody and per role or group.",
        icon: IconLockAccess,
        linkOptions: { to: "/admin/permissions" },
      },
      {
        title: "Identity providers",
        description:
          "Configure your company’s sign-in provider for each email domain, and require SSO.",
        icon: IconBuildingBank,
        linkOptions: { to: "/admin/identity-providers" },
      },
    ],
  },
  {
    title: "Governance and audit",
    description: "",
    items: [
      {
        title: "Audit",
        description:
          "Review actions taken in OpenBot and who took them, and record Bots' commands.",
        icon: IconListDetails,
        linkOptions: { to: "/admin/audit" },
      },
      {
        title: "Test a policy",
        description:
          "Ask what OpenBot would do if a Bot took an action, and see which control decides.",
        icon: IconZoomQuestion,
        linkOptions: { to: "/admin/what-if" },
      },
    ],
  },
];
