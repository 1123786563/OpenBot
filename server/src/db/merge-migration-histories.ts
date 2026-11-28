import type { AppliedMigration, FolderMigration } from "./migration-reach";

// The two histories that diverged immediately after 0089_direct_chat_runs.
// Pin hash and timestamp so the exception cannot authorize a modified SQL file.
const [
  intelligenceMigrations,
  skillMarketMigrations,
  corsairMigrations,
  bifrostMigrations,
] = [
  [
    [
      "0090_direct_chat_replay",
      "cbba5a36ec17c8cf7c2537e5f4fe23d9ed8c4f1c74035b0a7d731fec21d85282",
      1795161859942,
    ],
    [
      "0091_conversation_lifecycle",
      "db6deaa0737089f76120b0f53052bc44e3030cf6239ce97369d3af1c3a63b00e",
      1795172513486,
    ],
    [
      "0092_openbot_recordings",
      "15a8e55c0b45e41f95922e26c646d2023dcd713a185e8ef7c20dd62bd95ec9e3",
      1795173315650,
    ],
    [
      "0093_opik_runs",
      "814e8e741bd22e3753a15decd33e7af652df9b55d13bf5e60151f56f92a00b9a",
      1795174366772,
    ],
    [
      "0094_opik_evaluations",
      "11ab7ce2aa8827cb8d0a26f81553ffafd1767e152e86c24dc2ec13ba05787119",
      1795178687140,
    ],
    [
      "0095_direct_chat_learning",
      "c08ca2646a6159764d614eb5d937b7c5baaadf02d75bd0590abe4f672796cb1b",
      1795180537112,
    ],
    [
      "0096_direct_chat_recovery",
      "7c2ddc68949bbc95f8f39eafe0413451b859e4e6da5871f864f727ad802919d1",
      1795181168585,
    ],
    [
      "0097_hindsight_memory",
      "14a9540f1e14f660362f24fa5628153b3c71b2192c5ae9fbc25e38aef60698b2",
      1795181350092,
    ],
    [
      "0098_direct_chat_learning_publication",
      "c132301892ef03b79c777c8465cf268d8b70bf1b92f7fb73fd9bcb4745620370",
      1795181647838,
    ],
    [
      "0099_scheduled_direct_chat_learning",
      "b070cbf5356406dcb0fe20707b49a6d998b11a0594cf7a9751c2fd8fca0be771",
      1795183415159,
    ],
    [
      "0100_learning_evidence",
      "411bfc04c3a9ea2662a2ddb2228c69ddc0137407b50d9bf3382485d98f84ee24",
      1795183878647,
    ],
    [
      "0101_intelligence_deletion_cleanup",
      "e277913465710d6e401ac113d0e0214fb3bd88b00c15b4199c022e244a02b8ed",
      1795185919612,
    ],
    [
      "0102_background_conversation_runs",
      "05ce65d8b3948dd5d93493505e1c4973ebd7d960337e4345b3b87666047ffa85",
      1795228622495,
    ],
  ],
  [
    [
      "0090_skill_market_installations",
      "fb16bf4f38bfd898eed36cadd4e7d652dd521922081c6427e101166f83e408b9",
      1795183869296,
    ],
    [
      "0091_skill_market_version_disablements",
      "06ed0a58ff8629b76e8657f156851f83801029c5c8b792e41367d2c750ea0262",
      1795185049024,
    ],
    [
      "0092_skill_market_runs",
      "2262dc9c145e43bebb69d360789513ff2bb98c2d79fe973b585672373d7f2984",
      1795189760196,
    ],
  ],
  [
    [
      "0105_corsair_slack_personal",
      "76ca9115951d9864c7d112887d8f8c328469b5ee963090bdba6e8ee95f101d51",
      1795189761196,
    ],
    [
      "0106_corsair_slack_shared",
      "a600a5b4cbcda9db067ba15e1d0bba133949835c47a8235ba87dfb59eaf3a0a6",
      1795189761197,
    ],
    [
      "0107_corsair_shared_storage",
      "8e442eca323ba2a8fc393a7cdd4c5b3b87c98fb93731acfedf73d98be6590eb2",
      1795189761198,
    ],
    [
      "0108_corsair_revocation",
      "7423096bc674c740ef266699ed726f12677e8797912fc4f17209f47612951091",
      1795189761199,
    ],
  ],
  [
    [
      "0117_bifrost_market_reviews",
      "8b27189a3b516e22a7be0a9d56f89bb3b707a66824f8841f41241f14b729abe0",
      1795410635032,
    ],
    [
      "0118_skill_market_equivalences",
      "3ef8a33465c6a3813284e1c4a7a4cfc6b50690f0813815d9bed9a528618060a9",
      1795415414731,
    ],
  ],
] as const;

// Published migrations added on either parent after the first history reconciliation.
const personalSaasMigrations = [
  [
    "0093_personal_saas_entry",
    "4a64cab123b72eedff7d3e92ba3cb1f56e4a6abd2996c3dd4e97eb15efc73eec",
    1795189760197,
  ],
  [
    "0094_personal_saas_assistant_bot",
    "da934507b721c3d97095fe8fc7e21f903cd0275b665bfe40b949c6713ad418de",
    1795189760198,
  ],
  [
    "0095_personal_saas_native_codes",
    "c9428f61dc4e693fa1a0cffd9ed8ff28607ff5e700e1357c542b5a6c4d0be45f",
    1795189760199,
  ],
  [
    "0096_personal_saas_57_integration_grants",
    "e95a4b2bdc588eeeee82a85fde0d93421a42d26509927182e5c9612c30516cad",
    1795189760200,
  ],
  [
    "0097_personal_saas_account_cutoff",
    "1401a40e4c5e08e8acdcf25be7299b0667ac1ad30237c80762cbe61586195bd7",
    1795189760201,
  ],
  [
    "0098_personal_workspace_suspensions",
    "3a001d0b46c393587ac8a1f93467c9e21d990726c177b66c19d5e2e59bfa2d6e",
    1795189760202,
  ],
  [
    "0099_personal_saas_67_support_access",
    "fb1056496954232d06f64cf88c9737c9aa3bb06bab632e4414d07e18a1b85632",
    1795189760203,
  ],
  [
    "0100_personal_work_recovery",
    "095e88d04d6fe8e113588e47bcc990dced84720bee920f94a375324973d0bee9",
    1795189760204,
  ],
  [
    "0101_personal_saas_automation_resume",
    "8a4fea919b7e140ba7c4a2fa93db7169b20dc41ae692d27ef7216440257c526d",
    1795189760205,
  ],
  [
    "0102_personal_workspace_closure",
    "13ee9ae7c49b151f10db85342988c9c5d8a86032d68b109c7a5afdec6d7d3f27",
    1795189760206,
  ],
  [
    "0103_personal_workspace_cleanup",
    "0fcccfe3cd3a1ca3d96cd8f452c7e1179fd6b80dc32c38d98ee62a65c32ec21a",
    1795189760207,
  ],
  [
    "0104_personal_intelligence_cleanup",
    "d7bf6902a5dea204b7d941ad0681328aba08c56f5ec586062c14e6bd1cef5e7b",
    1795189760208,
  ],
  [
    "0109_personal_workspace_reprovision",
    "7253281269c88b7f0b314cb19fb2d2eeceabc1cf6a7ab972a224f7b2e78e4412",
    1795231535117,
  ],
  [
    "0110_test_credit",
    "1719112c1fe16df66b2164291536105ad9d88a08e9661c84df5d0bc4c6ff30ea",
    1795231535118,
  ],
  [
    "0111_test_credit_reconciliation",
    "08cbcaafa5bc92c3a119a021ae71a620e4b4185261a5a6442de47d435f9f811e",
    1795231535119,
  ],
  [
    "0112_test_credit_cutoff_index",
    "3325bf5b019841adb40cd1ec569daa39452bb194de83ea8a53f0f83154d611b2",
    1795231535120,
  ],
  [
    "0113_test_credit_one_time_grants",
    "cc950c9575867dc6bd26b767d78599d56b243a406282237dc4cb9f5364b2d811",
    1795231535121,
  ],
  [
    "0114_personal_workspace_cleanup_jsonb",
    "8273c7b20f30b887bc14f262412ec54c3b2691898ca6df9ea1c01b5a0575a5e3",
    1795271468046,
  ],
  [
    "0115_weknora_external_spending",
    "2777cead40c5f615e3ad16b118d121a53c0627f2c71b1ad41666b60ae6fedcc8",
    1795273407366,
  ],
  [
    "0116_test_credit_embedding_replay",
    "71c5f20c930d886ebce3bdefd979fe0808eb94880506909a2ba89146b789404a",
    1795275600000,
  ],
  [
    "0119_approval_team_rule_saves",
    "70e3f715230bc2bdd7adee874dd5c965fe37d498f6e8d74a53738cc0bef0bf8a",
    1795415414732,
  ],
] as const;

const intelligenceSkillMigrations = [
  [
    "0160_direct_chat_credit_request",
    "7798db1d942c0ee3a5426abe4c2a5c50fa02e129ed769ce80d1dceb3878349d8",
    1795511248832,
  ],
  [
    "0112_direct_chat_skill_shares",
    "3ef664cc44b84a6ff20a3a532b629218ce15d6617486ee980e03dc5e425c8928",
    1795444185213,
  ],
  [
    "0113_direct_chat_dispatched_skill_versions",
    "51b9f4636b47ee64c81bba5d9680bb239d0cbf448ca5d488bf686c89cd8646b4",
    1795445478392,
  ],
] as const;

const billingMigrations = [
  [
    "0120_test_credit_execution_budgets",
    "4a2d8ec221556b8a646eafd3ec5dbd9b1b430d06ebd3f236333e59e27576fd7b",
    1795415414735,
  ],
  [
    "0121_lago_usage_events",
    "312cae12c893c36010415bd52520e105a6bbc3625e8ee115ece30f581417fc7f",
    1795415414736,
  ],
  [
    "0122_pilot_provider_cost_limits",
    "b3700385f22f0545007d22db1de4cf841e85c02fd66eb20dc5b89a8289f82596",
    1795415414737,
  ],
  [
    "0123_paid_credit_ledger",
    "e625831e9b6f83f76f494899f2f2e51575528895847ab2335221bae75bf4b414",
    1795415414738,
  ],
  [
    "0124_paid_credit_allocations",
    "cf9cd92d84ded23fae4574d96cd1dd545a324b0907ae51f17d7d066c51b42f9b",
    1795415414739,
  ],
  [
    "0125_operation_paid_shares",
    "34014c8765c4a0b41af93b6aedbba27a24b4817024337353d7ca7210aa55bb13",
    1795415414740,
  ],
  [
    "0126_allocation_consumed_amounts",
    "304d2eaa4827ee514ab7124e4729a7093e12237ad805881d95be75a744eff1de",
    1795415414741,
  ],
  [
    "0127_paid_refunds_and_suspension",
    "0a9ce1001c2314b140920a81af66a75d075245d4b9dbc7fc5326c347dcdb0ec5",
    1795415414742,
  ],
  [
    "0128_dispute_manual_review",
    "ffac7473e9a7dd03938123a6ed1245add8ad56d0509f0b01b7313783bbde66c0",
    1795415414743,
  ],
  [
    "0129_paid_corrections",
    "a89bba0abdd3eef5bfd8a22bd5482e52b19b350ecbd6d0e6dabeac5612765cc8",
    1795415414744,
  ],
  [
    "0130_pilot_closure_and_budget_types",
    "c2a36e11e71af75010320a4ba28292565c034bc3dca0362d7d6ba89d1a0ff221",
    1795415414745,
  ],
  [
    "0131_resume_points_and_app",
    "7c3ac130341cedd7b1088e596c6208dab0e071d36a49cba44718812504f8d0e8",
    1795415414746,
  ],
  [
    "0132_app_paths_restore_and_channel_evidence",
    "8dbd83ab042f0677e3ed9b1daf7f049ca858ee4fad9ccbd0d6e87872056d4874",
    1795415414747,
  ],
  [
    "0133_direct_chat_test_credit",
    "c26f68803aa03394470689682b0121c12d87ef5cac5e7f1d120dd939020f375e",
    1795415414748,
  ],
  [
    "0134_bifrost_reconciliation",
    "fb6581d8b833199f33c8335d7478a2c1e41ea8f9030f534872642e3887f7ffb8",
    1795415414749,
  ],
  [
    "0135_background_model_budget_quote",
    "ffa7724ea82fb5309e4ad26371a684c903c4e08c515d62317cf9f0f99baab939",
    1795415414750,
  ],
  [
    "0136_coordination_budget_ancestry",
    "9bb4ba72a4d4aa287a0d7c02413992fbb94dbe55a55cc54efe4af5c75db101fb",
    1795415414751,
  ],
  [
    "0137_shared_pilot_provider_cost",
    "86f5c942795d2106ecf41e281982eca5e56175f2e4bf49d000f3a9ff792925fc",
    1795415414752,
  ],
  [
    "0138_credit_pack_checkout",
    "9088686cea4d7c054cc0592d91b79aeab16c7b1eabeb960eed457c3d6961defb",
    1795418391864,
  ],
  [
    "0139_paid_order_disputes",
    "c27d5d2858a8236c18a80bf576bd0a0a61e0e83fe66b1a72627f863e8780f8d2",
    1795422552671,
  ],
  [
    "0140_checkout_switch_and_suspension_history",
    "873e7178b43d9168d0e292c6bb7574b3faf7af76a98650254a535409afb2f2bf",
    1795424497937,
  ],
  [
    "0141_paid_correction_balance",
    "43c5db9e5e1bd1622e4aefb7645ba89d1a6b4a3186f5ffb4f31e0d25a7e4ebdf",
    1795424551038,
  ],
  [
    "0142_billing_pilot_signoffs",
    "86635b0451ac30a5c6211ef179d1d86ccf8b229ec5d03647216a6537d1ea2e42",
    1795431037811,
  ],
  [
    "0143_background_tool_results",
    "6176620b0ce3651075b184cd2eeb0fc4dd39ef2bbc114e2d8eb678768ac431f0",
    1795435400991,
  ],
  [
    "0144_billing_paid_path_policy",
    "67fd31bfc11491cd310a056b8c8ad763d705a562b6523c4e5094065e9f73968e",
    1795443105536,
  ],
] as const;

const sandboxMigrations = [
  [
    "0119_personal_workspace_agent_sandbox",
    "126d1ddb93d2a6d430b32362afcb6943da9414be057b74dd030c16260d21dd45",
    1795441880621,
  ],
  [
    "0120_agent_sandbox_flash",
    "8ecc7f717b6e3f669a93f975c0c4031cc7e977a7f711ed7b154fad3617d2eb1a",
    1795441880622,
  ],
  [
    "0121_workspace_agentic_spaces",
    "08ab50db2916eb7a2a4262208cddcb4b6051cfe1aae0b434157ecb9f4ab3cd86",
    1795441880623,
  ],
] as const;

const directChatCreditRequest = [
  "0160_direct_chat_credit_request",
  "7798db1d942c0ee3a5426abe4c2a5c50fa02e129ed769ce80d1dceb3878349d8",
  1795511248832,
] as const;

const sandboxTags: ReadonlySet<string> = new Set(
  sandboxMigrations.map(([tag]) => tag),
);

export const isSandboxMigration = ({ tag }: FolderMigration) =>
  sandboxTags.has(tag);

const intelligenceTags: ReadonlySet<string> = new Set(
  [...intelligenceMigrations, ...intelligenceSkillMigrations].map(
    ([tag]) => tag,
  ),
);

export const isIntelligenceMigration = ({ tag }: FolderMigration) =>
  intelligenceTags.has(tag);

function matchesPersaasFlexpriceJournal(
  folder: readonly FolderMigration[],
  applied: readonly AppliedMigration[],
  skipped: readonly FolderMigration[],
): boolean {
  const [missing] = skipped;
  if (
    skipped.length !== 1 ||
    missing?.tag !== "0165_direct_chat_prompt_attachments" ||
    missing.when !== 1795785352191 ||
    missing.hash !==
      "c650b1d620109489b51283f1ce8bcb7a37068d16cc1cb2062d9c846e895bd810"
  )
    return false;

  const deployed = folder.find(
    ({ tag, when, hash }) =>
      tag === "0166_flexprice_usage_deliveries" &&
      when === 1795843484377 &&
      hash ===
        "b9f1a7f151c44fdc8c941ac6b317cfdf81a0d0f01881f882749b53eaf0645d4d",
  );
  if (!deployed) return false;

  // Persaas applied the Flexprice table on top of main's 0164 before main shipped
  // prompt attachments. The shared history and the deployed entry must match.
  const expected = folder.filter(
    ({ when }) => when <= deployed.when && when !== missing.when,
  );
  const recorded = new Map(
    applied.map(({ createdAt, hash }) => [createdAt, hash]),
  );
  return (
    applied.length === expected.length &&
    recorded.size === applied.length &&
    expected.every(({ when, hash }) => recorded.get(when) === hash)
  );
}

export function canMergeMigrationHistories(
  folder: readonly FolderMigration[],
  applied: readonly AppliedMigration[],
  skipped: readonly FolderMigration[],
): boolean {
  if (matchesPersaasFlexpriceJournal(folder, applied, skipped)) return true;

  const baseIndex = folder.findIndex(
    ({ tag }) => tag === "0089_direct_chat_runs",
  );
  if (baseIndex < 0) return false;
  const base = folder.slice(0, baseIndex + 1);
  const diverged = [
    ...intelligenceMigrations,
    ...skillMarketMigrations,
    ...corsairMigrations,
    ...bifrostMigrations,
    ...personalSaasMigrations,
    ...intelligenceSkillMigrations,
    ...billingMigrations,
    ...sandboxMigrations,
    directChatCreditRequest,
  ].map(([tag, hash, when]) => ({ tag, hash, when }));
  const byTag = new Map(folder.map((entry) => [entry.tag, entry]));
  if (
    !diverged.every(({ tag, hash, when }) => {
      const entry = byTag.get(tag);
      return entry?.hash === hash && entry.when === when;
    })
  )
    return false;

  const identity = ({ hash, when }: FolderMigration) => `${when}:${hash}`;
  const recorded = new Set(
    applied.map(({ hash, createdAt }) => `${createdAt}:${hash}`),
  );
  if (recorded.size !== applied.length) return false;
  const mainWithBilling = [
    ...skillMarketMigrations,
    ...corsairMigrations,
    ...bifrostMigrations,
    ...personalSaasMigrations,
    ...billingMigrations,
  ];
  const histories = [
    intelligenceMigrations,
    skillMarketMigrations,
    [...skillMarketMigrations, ...corsairMigrations, ...bifrostMigrations],
    [...intelligenceMigrations, ...skillMarketMigrations],
    [
      ...intelligenceMigrations,
      ...skillMarketMigrations,
      ...corsairMigrations,
      ...bifrostMigrations,
      ...intelligenceSkillMigrations,
    ],
    mainWithBilling,
    [
      ...mainWithBilling,
      ...intelligenceMigrations,
      ...intelligenceSkillMigrations,
      directChatCreditRequest,
    ],
    [
      ...skillMarketMigrations,
      ...corsairMigrations,
      ...bifrostMigrations,
      // Pre-merge sandbox deployments forked before main published 0119_approval.
      ...personalSaasMigrations.filter(
        ([tag]) => tag !== "0119_approval_team_rule_saves",
      ),
      ...sandboxMigrations,
    ],
  ];
  const prefixLength = applied.length - base.length;
  if (prefixLength <= 0) return false;
  const knownPrefix = histories.some((history) => {
    if (prefixLength > history.length) return false;
    const prefix = [...history]
      .sort((a, b) => a[2] - b[2])
      .slice(0, prefixLength)
      .map(([tag, hash, when]) => ({ tag, hash, when }));
    return [...base, ...prefix].every((entry) => recorded.has(identity(entry)));
  });
  if (!knownPrefix) return false;

  const allowedGaps = new Set(diverged.map(identity));
  return skipped.every((entry) => {
    const id = identity(entry);
    return allowedGaps.has(id) && !recorded.has(id);
  });
}
