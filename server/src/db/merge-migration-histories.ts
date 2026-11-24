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
    1795520000000,
  ],
] as const;

const intelligenceSkillMigrations = [
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

const intelligenceTags: ReadonlySet<string> = new Set(
  [...intelligenceMigrations, ...intelligenceSkillMigrations].map(
    ([tag]) => tag,
  ),
);

export const isIntelligenceMigration = ({ tag }: FolderMigration) =>
  intelligenceTags.has(tag);

export function canMergeMigrationHistories(
  folder: readonly FolderMigration[],
  applied: readonly AppliedMigration[],
  skipped: readonly FolderMigration[],
): boolean {
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
    [
      ...skillMarketMigrations,
      ...corsairMigrations,
      ...bifrostMigrations,
      ...personalSaasMigrations,
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
