import type admin from "../../locales/en/admin.json";
import type agents from "../../locales/en/agents.json";
import type approvals from "../../locales/en/approvals.json";
import type channels from "../../locales/en/channels.json";
import type common from "../../locales/en/common.json";
import type computer from "../../locales/en/computer.json";
import type craft from "../../locales/en/craft.json";
import type errors from "../../locales/en/errors.json";
import type knowledge from "../../locales/en/knowledge.json";
import type market from "../../locales/en/market.json";
import type nav from "../../locales/en/nav.json";
import type obsAdmin from "../../locales/en/obs-admin.json";
import type obsDatasets from "../../locales/en/obs-datasets.json";
import type obsEvaluations from "../../locales/en/obs-evaluations.json";
import type obsRuns from "../../locales/en/obs-runs.json";
import type routines from "../../locales/en/routines.json";
import type settings from "../../locales/en/settings.json";
import type skills from "../../locales/en/skills.json";
import type tenant from "../../locales/en/tenant.json";
import type workshop from "../../locales/en/workshop.json";

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
      knowledge: typeof knowledge;
      market: typeof market;
      errors: typeof errors;
      tenant: typeof tenant;
      workshop: typeof workshop;
      craft: typeof craft;
      "obs-runs": typeof obsRuns;
      "obs-datasets": typeof obsDatasets;
      "obs-evaluations": typeof obsEvaluations;
      "obs-admin": typeof obsAdmin;
    };
  }
}
