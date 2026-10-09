import type approvals from "../../locales/en/approvals.json";
import type admin from "../../locales/en/admin.json";
import type agents from "../../locales/en/agents.json";
import type channels from "../../locales/en/channels.json";
import type common from "../../locales/en/common.json";
import type computer from "../../locales/en/computer.json";
import type errors from "../../locales/en/errors.json";
import type routines from "../../locales/en/routines.json";
import type settings from "../../locales/en/settings.json";
import type skills from "../../locales/en/skills.json";
import type nav from "../../locales/en/nav.json";

/**
 * Compile-time key checking for `t(...)`: the en bundle is the source of truth, and a key that
 * does not exist there is a type error rather than a runtime fallback nobody noticed.
 */
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: {
      common: typeof common;
      nav: typeof nav;
      channels: typeof channels;
      agents: typeof agents;
      computer: typeof computer;
      settings: typeof settings;
      admin: typeof admin;
      approvals: typeof approvals;
      routines: typeof routines;
      skills: typeof skills;
      errors: typeof errors;
    };
  }
}
