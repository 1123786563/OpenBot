import type admin from "../../locales/en/admin.json";
import type agents from "../../locales/en/agents.json";
import type aiObservabilityAdmin from "../../locales/en/ai-observability-admin.json";
import type aiObservabilityDatasets from "../../locales/en/ai-observability-datasets.json";
import type aiObservabilityEvaluations from "../../locales/en/ai-observability-evaluations.json";
import type aiObservabilityRuns from "../../locales/en/ai-observability-runs.json";
import type approvals from "../../locales/en/approvals.json";
import type channels from "../../locales/en/channels.json";
import type common from "../../locales/en/common.json";
import type computer from "../../locales/en/computer.json";
import type craft from "../../locales/en/craft.json";
import type errors from "../../locales/en/errors.json";
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
      market: typeof market;
      errors: typeof errors;
      tenant: typeof tenant;
      workshop: typeof workshop;
      craft: typeof craft;
      "ai-observability-runs": typeof aiObservabilityRuns;
      "ai-observability-datasets": typeof aiObservabilityDatasets;
      "ai-observability-evaluations": typeof aiObservabilityEvaluations;
      "ai-observability-admin": typeof aiObservabilityAdmin;
      "obs-runs": typeof obsRuns;
      "obs-datasets": typeof obsDatasets;
      "obs-evaluations": typeof obsEvaluations;
      "obs-admin": typeof obsAdmin;
    };
  }
}
