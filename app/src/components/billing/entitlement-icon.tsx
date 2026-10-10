import {
  IconBolt,
  IconDatabase,
  IconDeviceDesktopAnalytics,
  IconPlug,
  IconRobot,
  IconShieldCheck,
  IconSparkles,
} from "@tabler/icons-react";
import type * as React from "react";

const RULES: readonly (readonly [RegExp, React.ComponentType<{ className?: string }>])[] = [
  [/agent|bot/i, IconRobot],
  [/model|llm|token/i, IconSparkles],
  [/skill|tool/i, IconBolt],
  [/connector|integration|link/i, IconPlug],
  [/computer|browser|sandbox|run/i, IconDeviceDesktopAnalytics],
  [/data|storage|knowledge/i, IconDatabase],
];

/** A code's own words pick its icon; an unrecognized code earns the shield. */
export function entitlementIconFor(code: string): React.ComponentType<{ className?: string }> {
  for (const [pattern, icon] of RULES) {
    if (pattern.test(code)) return icon;
  }
  return IconShieldCheck;
}
