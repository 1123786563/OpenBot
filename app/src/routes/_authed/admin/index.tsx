import {
  IconBuildingBank,
  IconChecks,
  IconChevronRight,
  IconCode,
  IconDeviceDesktop,
  IconFileText,
  IconKey,
  IconLayoutGrid,
  IconListDetails,
  IconPuzzle,
  IconRobot,
  IconShieldCheck,
  IconUsers,
} from "@tabler/icons-react";
import {
  createFileRoute,
  Link,
  type LinkOptions,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";

export const Route = createFileRoute("/_authed/admin/")({
  component: RouteComponent,
});

/**
 * Grouped by what the decision is about rather than by how the code is organised.
 *
 * "What Bots can reach" is the group an administrator arrives worrying about, so it goes first.
 * Everything in it either grants a capability or fences one in.
 */
const SECTIONS = [
  {
    title: "overview.reach.title",
    description: "overview.reach.description",
    items: [
      {
        title: "overview.reach.credentials.title",
        description: "overview.reach.credentials.description",
        icon: IconKey,
        linkOptions: { to: "/admin/credentials" },
      },
      {
        title: "overview.reach.boundaries.title",
        description: "overview.reach.boundaries.description",
        icon: IconShieldCheck,
        linkOptions: { to: "/admin/boundaries" },
      },
      {
        title: "overview.reach.approvals.title",
        description: "overview.reach.approvals.description",
        icon: IconChecks,
        linkOptions: { to: "/admin/approvals" },
      },
      {
        title: "overview.reach.computers.title",
        description: "overview.reach.computers.description",
        icon: IconDeviceDesktop,
        linkOptions: { to: "/admin/computers" },
      },
    ],
  },
  {
    title: "overview.do.title",
    description: "overview.do.description",
    items: [
      {
        title: "overview.do.plugins.title",
        description: "overview.do.plugins.description",
        icon: IconPuzzle,
        linkOptions: { to: "/admin/plugins" },
      },
      {
        title: "overview.do.skills.title",
        description: "overview.do.skills.description",
        icon: IconFileText,
        linkOptions: { to: "/admin/skills" },
      },
      {
        title: "overview.do.learning.title",
        description: "overview.do.learning.description",
        icon: IconFileText,
        linkOptions: { to: "/admin/learning" },
      },
      {
        title: "overview.do.components.title",
        description: "overview.do.components.description",
        icon: IconLayoutGrid,
        linkOptions: { to: "/admin/components" },
      },
      {
        title: "overview.do.playground.title",
        description: "overview.do.playground.description",
        icon: IconCode,
        linkOptions: { to: "/admin/playground" },
      },
    ],
  },
  {
    title: "overview.access.title",
    description: "",
    items: [
      {
        title: "overview.access.people.title",
        description: "overview.access.people.description",
        icon: IconUsers,
        linkOptions: { to: "/admin/people" },
      },
      {
        title: "overview.access.enterprise.title",
        description: "overview.access.enterprise.description",
        icon: IconShieldCheck,
        linkOptions: { to: "/admin/enterprise" },
      },
      {
        title: "overview.access.identityProviders.title",
        description: "overview.access.identityProviders.description",
        icon: IconBuildingBank,
        linkOptions: { to: "/admin/identity-providers" },
      },
      {
        title: "overview.access.botServices.title",
        description: "overview.access.botServices.description",
        icon: IconRobot,
        linkOptions: { to: "/admin/bot-services" },
      },
    ],
  },
  {
    title: "overview.history.title",
    description: "",
    items: [
      {
        title: "overview.history.audit.title",
        description: "overview.history.audit.description",
        icon: IconListDetails,
        linkOptions: { to: "/admin/audit" },
      },
    ],
  },
] as const satisfies readonly {
  title: string;
  description: string;
  items: readonly {
    description: string;
    icon: React.ComponentType<{ className?: string }>;
    linkOptions: LinkOptions;
    title: string;
  }[];
}[];

function RouteComponent() {
  const { t } = useTranslation("admin");
  return (
    <PageShell
      description={t("overview.description")}
      title={t("overview.title")}
    >
      {SECTIONS.map((section) => (
        <PageSection
          description={section.description ? t(section.description) : undefined}
          key={section.title}
          title={t(section.title)}
        >
          <PageRows>
            {section.items.map((item, index) => (
              <StaggerItem index={index} key={item.title}>
                {/*
                 * The whole row is the link, not a chevron somebody has to aim at: every row here
                 * goes exactly one place, so there is nothing else the row could mean.
                 */}
                <Item
                  render={(props) => <Link {...item.linkOptions} {...props} />}
                  size="sm"
                >
                  <ItemMedia>
                    <item.icon className="size-4 text-muted-foreground" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{t(item.title)}</ItemTitle>
                    <ItemDescription>{t(item.description)}</ItemDescription>
                  </ItemContent>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </Item>
                {index !== section.items.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        </PageSection>
      ))}
    </PageShell>
  );
}
