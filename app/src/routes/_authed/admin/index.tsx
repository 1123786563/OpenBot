import { TextInput } from "@astryxdesign/core/TextInput";
import { IconChevronRight } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef } from "react";
import { z } from "zod";
import { ADMIN_NAVIGATION } from "@/components/admin/admin-navigation";
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
  validateSearch: z.object({ q: z.string().optional().catch(undefined) }),
});

const searchWords = (value: string) =>
  value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

function RouteComponent() {
  const { q = "" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const firstResult = useRef<HTMLAnchorElement>(null);
  const terms = searchWords(q);
  const searching = terms.length > 0;
  const sections = ADMIN_NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter((item) => {
      const words = searchWords(
        `${item.title} ${item.description} ${section.title}`,
      );
      return terms.every((term) => words.some((word) => word.startsWith(term)));
    }),
  })).filter((section) => section.items.length > 0);
  const count = sections.reduce(
    (total, section) => total + section.items.length,
    0,
  );
  const setQuery = (value: string) =>
    void navigate({
      search: { q: value || undefined },
      replace: true,
      resetScroll: false,
    });

  return (
    <PageShell
      description="Manage settings that apply to everyone and every Bot in this deployment."
      title="Admin"
    >
      <section aria-label="Search admin settings" className="mt-6 space-y-2">
        <TextInput
          autoComplete="off"
          controlClassName="[&_button]:min-h-11 [&_button]:min-w-11"
          controlStyle={{
            minBlockSize: "var(--spacing-11)",
            paddingInlineStart: "var(--spacing-3)",
          }}
          hasAutoCorrect={false}
          hasClear
          hasSpellCheck={false}
          label="Find a setting"
          onChange={setQuery}
          onEnter={() => firstResult.current?.focus()}
          size="lg"
          type="search"
          value={q}
          width="100%"
        />
        <p className="text-muted-foreground text-sm" role="status">
          {searching
            ? count === 0
              ? "No matching settings. Try a setting name or a task."
              : `${count} ${count === 1 ? "setting" : "settings"} found.`
            : null}
        </p>
      </section>
      {sections.map((section, sectionIndex) => (
        <PageSection
          className={searching ? "mt-6" : undefined}
          description={searching ? undefined : section.description || undefined}
          key={section.title}
          title={section.title}
        >
          <PageRows>
            {section.items.map((item, index) => (
              <StaggerItem index={index} key={item.title}>
                {/*
                 * The whole row is the link, not a chevron somebody has to aim at: every row here
                 * goes exactly one place, so there is nothing else the row could mean.
                 */}
                <Item
                  render={(props) => (
                    <Link
                      {...item.linkOptions}
                      {...props}
                      ref={
                        sectionIndex === 0 && index === 0
                          ? firstResult
                          : undefined
                      }
                    />
                  )}
                  size="sm"
                >
                  <ItemMedia variant="icon">
                    <item.icon />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="line-clamp-none">
                      {item.title}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none text-sm">
                      {item.description}
                    </ItemDescription>
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
