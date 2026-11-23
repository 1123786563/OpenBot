import { WEB_HARNESSES } from "@openbot/shared/harnesses";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { HarnessMark } from "@/components/agents/harness-mark";
import { appConfig } from "@/lib/generated/application-config";
import { DemoStage } from "../demo-stage";
import { LaptopIllustration } from "../laptop-illustration";
import { OrganizationFlow } from "../organization-flow";

/** Every framework the New Bot wizard offers by name; "an agent you already run" is the sentence. */
export const FRAMEWORKS = WEB_HARNESSES.filter(
  (harness) => harness.id !== "byo-url",
);

const PRODUCT = appConfig.brand.productName;

/** The three things somebody running OpenBot themselves is deciding, one picture each. */
const PANELS: Array<{ id: string; caption: string; picture: () => ReactNode }> =
  [
    {
      id: "local",
      caption: "On this computer",
      picture: () => <LaptopIllustration />,
    },
    {
      id: "agents",
      caption: "With the agents you already have",
      picture: () => (
        <div className="flex flex-wrap justify-center gap-2">
          {FRAMEWORKS.map((harness) => (
            <span
              className="text-xs flex items-center gap-2 rounded-full bg-card px-3 py-1.5 ring-1 ring-border shadow-sm"
              key={harness.id}
            >
              <HarnessMark id={harness.mark} name={harness.name} />
              {harness.name}
            </span>
          ))}
        </div>
      ),
    },
    {
      id: "organization",
      caption: "For your organization",
      picture: () => <OrganizationFlow />,
    },
  ];

function Panel({ panel }: { panel: (typeof PANELS)[number] }) {
  return (
    <div className="flex flex-col items-center gap-5" data-panel={panel.id}>
      <p className="text-xs font-medium text-muted-foreground">
        {panel.caption}
      </p>
      {panel.picture()}
    </div>
  );
}

/**
 * Running it yourself: on this computer, with the agents you already have, and for your
 * organization. The three local-evaluation slides as one picture that turns through them.
 * Reduced motion holds the local setup illustration.
 */
export function SelfHostDemo() {
  return (
    <DemoStage
      beats={PANELS.length}
      beatMs={3200}
      className="flex min-h-64 flex-col justify-center px-4 py-6 sm:px-6 lg:min-h-88 lg:py-8"
      kind="self-host"
      label={`${PRODUCT} on a laptop; frameworks that work as Bots: ${FRAMEWORKS.map((harness) => harness.name).join(", ")}; and your organization signing in with Google, Microsoft or Okta`}
      rest={0}
    >
      {({ beat, reduced }) =>
        reduced ? (
          <Panel panel={PANELS[0]} />
        ) : (
          <AnimatePresence initial={false} mode="wait">
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              initial={{ opacity: 0, y: 8 }}
              key={PANELS[beat]?.id}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              {PANELS[beat] ? <Panel panel={PANELS[beat]} /> : null}
            </motion.div>
          </AnimatePresence>
        )
      }
    </DemoStage>
  );
}
