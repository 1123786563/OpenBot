# MT011 execution plan (TDD)

- [x] prereq-manifest 49/49 hash recompute OK (claim time; 47/49 post-impl by design — the 2 deltas are MT011's authorized edits)
- [x] dedicated container mt011-impl-pg (55482) + 2 DBs + migrate + 7 tasks (MT004→008→112→012→014→010→009)
- [x] baseline full suite: 458 pass / 0 fail / 0 skip / 16 files
- [x] RED-1: not-found-semantics module tests → Cannot find module (archived RED-1-module-missing.txt)
- [x] GREEN-1: implement canonical semantics (verdict / guard / serializer / HTTP face)
- [x] GREEN-2: implement inventory service (list/count/batch) reusing frozen registry
- [x] shared invariant tests over 3 closed loops (byte-identical deny + statement-count parity)
- [x] scenarios.ts append domain; index.ts pure-append assembly
- [x] full regression 477/0/0 (17 files) + typecheck 0 + biome clean (own files; index A/B zero-new)
- [x] mutation tests 6/6 captured (MUT6 first-round survived → test strengthened → captured) + restore-green sha256-verified
- [x] checkpoints (red-green, verification, mutation, hashes, changes.diff, sha256-manifest, review-package.json)
- [x] reports/MT011.md + worker_done --report-path
