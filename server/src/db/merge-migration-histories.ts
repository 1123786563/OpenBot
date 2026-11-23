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
      "0093_corsair_slack_personal",
      "76ca9115951d9864c7d112887d8f8c328469b5ee963090bdba6e8ee95f101d51",
      1795189761196,
    ],
    [
      "0094_corsair_slack_shared",
      "a600a5b4cbcda9db067ba15e1d0bba133949835c47a8235ba87dfb59eaf3a0a6",
      1795189761197,
    ],
    [
      "0095_corsair_shared_storage",
      "8e442eca323ba2a8fc393a7cdd4c5b3b87c98fb93731acfedf73d98be6590eb2",
      1795189761198,
    ],
    [
      "0096_corsair_revocation",
      "7423096bc674c740ef266699ed726f12677e8797912fc4f17209f47612951091",
      1795189761199,
    ],
  ],
  [
    [
      "0097_bifrost_market_reviews",
      "8b27189a3b516e22a7be0a9d56f89bb3b707a66824f8841f41241f14b729abe0",
      1795410635032,
    ],
    [
      "0098_skill_market_equivalences",
      "3ef8a33465c6a3813284e1c4a7a4cfc6b50690f0813815d9bed9a528618060a9",
      1795415414731,
    ],
  ],
] as const;

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
