# Issue #6 recursive intake and dependency DAG

Retrieved 2026-10-15T04:25:31Z from authenticated GitHub API (`1123786563/OpenBot`).

## Verified hierarchy

- #6 → 20 formal Epic children: #187–#206.
- Epics → 143 formal implementation Tickets: #44–#186, MT001–MT143.
- Snapshot contains 164 unique issues (root + Epics + Tickets); all issue bodies and comments were fetched.
- All 143 Ticket Blocked by sections parsed. GitHub GraphQL native `blockedBy` query checked 163 descendants; none recorded native edges. Therefore execution edges below are Ticket-body dependencies, never parent containment.

## Validation

- Dependency edges: 274; all refs exist; self-edges: 0; cycles: 0.
- Ready roots from dependency graph: MT001, MT002, MT103.
- Acceptance coverage extracted from the explicit Ticket `覆盖验收` field:
  - A1: 55 Tickets
  - A2: 96 Tickets
  - A3: 36 Tickets
  - A4: 30 Tickets
  - A5: 40 Tickets
  - A6: 36 Tickets
  - A7: 19 Tickets
  - A8: 38 Tickets
  - A9: 19 Tickets
  - A10: 37 Tickets
  - A11: 33 Tickets
  - A12: 22 Tickets
  - A13: 22 Tickets

## Ticket DAG

| Ticket | Issue | Epic | Depends on | Owner / validator | Acceptance | Status |
|---|---:|---:|---|---|---|---|
| MT001 | #44 | #187 | — | backend_implementer / backend_validator | A6, A11 | verified |
| MT002 | #45 | #187 | — | backend_implementer / backend_validator | A6 | verified |
| MT003 | #46 | #187 | MT001 | backend_implementer / backend_validator | A6, A12 | running |
| MT004 | #47 | #188 | MT003 | backend_implementer / backend_validator | A1, A3 | blocked |
| MT005 | #48 | #188 | MT002, MT004 | backend_implementer / backend_validator | A1, A2, A5, A6 | blocked |
| MT006 | #49 | #188 | MT005 | backend_implementer / backend_validator | A1, A3, A6 | blocked |
| MT007 | #50 | #188 | MT005, MT006 | backend_implementer / backend_validator | A5, A2 | blocked |
| MT008 | #51 | #189 | MT005 | backend_implementer / backend_validator | A4, A2 | blocked |
| MT009 | #52 | #189 | MT008 | backend_implementer / backend_validator | A4, A2, A3 | blocked |
| MT010 | #53 | #189 | MT008 | backend_implementer / backend_validator | A1, A2, A3, A4 | blocked |
| MT011 | #54 | #189 | MT009, MT010 | backend_implementer / backend_validator | A2, A1 | blocked |
| MT012 | #55 | #189 | MT002, MT008 | backend_implementer / backend_validator | A6, A1, A2 | blocked |
| MT013 | #56 | #190 | MT001, MT005 | backend_implementer / backend_validator | A6, A11 | blocked |
| MT014 | #57 | #190 | MT013, MT006 | backend_implementer / backend_validator | A1, A6, A8 | blocked |
| MT015 | #58 | #190 | MT014 | backend_implementer / backend_validator | A8, A10, A1 | blocked |
| MT016 | #59 | #191 | MT014, MT009 | backend_implementer / backend_validator | A1, A2, A3 | blocked |
| MT017 | #60 | #191 | MT016 | backend_implementer / backend_validator | A2, A3, A4 | blocked |
| MT018 | #61 | #191 | MT017, MT009 | backend_implementer / backend_validator | A4, A2, A1 | blocked |
| MT019 | #62 | #191 | MT016, MT017 | backend_implementer / backend_validator | A2, A4, A5 | blocked |
| MT020 | #63 | #191 | MT016, MT017 | backend_implementer / backend_validator | A1, A2, A4 | blocked |
| MT021 | #64 | #192 | MT016, MT014 | backend_implementer / backend_validator | A1, A2, A3 | blocked |
| MT022 | #65 | #192 | MT021 | backend_implementer / backend_validator | A2, A3, A4 | blocked |
| MT023 | #66 | #192 | MT022, MT018 | backend_implementer / backend_validator | A1, A2, A3 | blocked |
| MT024 | #67 | #192 | MT022 | backend_implementer / backend_validator | A2, A5, A8 | blocked |
| MT025 | #68 | #192 | MT022 | backend_implementer / backend_validator | A2, A5, A10 | blocked |
| MT026 | #69 | #193 | MT007, MT014 | backend_implementer / backend_validator | A1, A5, A7 | blocked |
| MT027 | #70 | #193 | MT014, MT010 | backend_implementer / backend_validator | A1, A2, A5 | blocked |
| MT028 | #71 | #193 | MT027 | backend_implementer / backend_validator | A7, A1, A5 | blocked |
| MT029 | #72 | #193 | MT027, MT018 | backend_implementer / backend_validator | A2, A5, A4 | blocked |
| MT030 | #73 | #193 | MT027, MT013 | backend_implementer / backend_validator | A6, A11 | blocked |
| MT031 | #74 | #194 | MT027, MT016 | backend_implementer / backend_validator | A1, A2, A4 | blocked |
| MT032 | #75 | #194 | MT031, MT018 | backend_implementer / backend_validator | A2, A5 | blocked |
| MT033 | #76 | #194 | MT031, MT009 | backend_implementer / backend_validator | A2, A4, A3 | blocked |
| MT034 | #77 | #194 | MT031, MT029 | backend_implementer / backend_validator | A2, A5, A1 | blocked |
| MT035 | #78 | #194 | MT034 | backend_implementer / backend_validator | A2, A5, A8 | blocked |
| MT036 | #79 | #195 | MT012, MT014 | backend_implementer / backend_validator | A1, A2, A4 | blocked |
| MT037 | #80 | #195 | MT036 | backend_implementer / backend_validator | A2, A4, A8 | blocked |
| MT038 | #81 | #195 | MT036 | backend_implementer / backend_validator | A2, A5, A8 | blocked |
| MT039 | #82 | #195 | MT038, MT010 | backend_implementer / backend_validator | A4, A2, A1 | blocked |
| MT040 | #83 | #195 | MT036, MT014 | backend_implementer / backend_validator | A2, A8, A1 | blocked |
| MT041 | #84 | #196 | MT005, MT014 | backend_implementer / backend_validator | A2, A8, A5 | blocked |
| MT042 | #85 | #196 | MT041 | backend_implementer / backend_validator | A8, A6, A2 | blocked |
| MT043 | #86 | #196 | MT042 | backend_implementer / backend_validator | A8, A5, A2 | blocked |
| MT044 | #87 | #196 | MT042, MT028 | backend_implementer / backend_validator | A7, A8, A6 | blocked |
| MT045 | #88 | #196 | MT042 | backend_implementer / backend_validator | A8, A2 | blocked |
| MT046 | #89 | #197 | MT042, MT029 | backend_implementer / backend_validator | A1, A2, A5, A8 | blocked |
| MT047 | #90 | #197 | MT046 | backend_implementer / backend_validator | A1, A2, A8, A5 | blocked |
| MT048 | #91 | #197 | MT042, MT046 | backend_implementer / backend_validator | A8, A7, A2 | blocked |
| MT049 | #92 | #197 | MT048 | backend_implementer / backend_validator | A8, A7, A2 | blocked |
| MT050 | #93 | #197 | MT049 | backend_implementer / backend_validator | A8, A1, A2 | blocked |
| MT051 | #94 | #197 | MT047, MT050 | backend_implementer / backend_validator | A8, A5 | blocked |
| MT052 | #95 | #197 | MT046, MT018 | backend_implementer / backend_validator | A4, A2, A8 | blocked |
| MT053 | #96 | #198 | MT022, MT046 | backend_implementer / backend_validator | A1, A2, A4 | blocked |
| MT054 | #97 | #198 | MT053, MT041 | backend_implementer / backend_validator | A8, A2, A5 | blocked |
| MT055 | #98 | #198 | MT053 | backend_implementer / backend_validator | A2, A8, A1 | blocked |
| MT056 | #99 | #198 | MT055, MT010 | backend_implementer / backend_validator | A5, A2, A1 | blocked |
| MT057 | #100 | #198 | MT053, MT047 | backend_implementer / backend_validator | A1, A2, A8 | blocked |
| MT058 | #101 | #198 | MT056, MT010 | backend_implementer / backend_validator | A3, A2, A5 | blocked |
| MT059 | #102 | #199 | MT016, MT014 | backend_implementer / backend_validator | A1, A2, A4 | blocked |
| MT060 | #103 | #199 | MT059, MT041 | backend_implementer / backend_validator | A1, A2, A8 | blocked |
| MT061 | #104 | #199 | MT060, MT055 | backend_implementer / backend_validator | A1, A2, A5 | blocked |
| MT062 | #105 | #199 | MT060, MT039 | backend_implementer / backend_validator | A2, A4, A1 | blocked |
| MT063 | #106 | #199 | MT060, MT028 | backend_implementer / backend_validator | A7, A1, A2, A5 | blocked |
| MT064 | #107 | #199 | MT063, MT034 | backend_implementer / backend_validator | A2, A5, A7 | blocked |
| MT065 | #108 | #199 | MT064 | backend_implementer / backend_validator | A2, A5, A7 | blocked |
| MT066 | #109 | #199 | MT060, MT065 | backend_implementer / backend_validator | A2, A10, A9 | blocked |
| MT067 | #110 | #199 | MT060, MT026 | backend_implementer / backend_validator | A5, A1, A2 | blocked |
| MT068 | #111 | #199 | MT067 | backend_implementer / backend_validator | A5, A12, A2 | blocked |
| MT069 | #112 | #200 | MT014, MT008 | backend_implementer / backend_validator | A9, A13, A12 | blocked |
| MT070 | #113 | #200 | MT069, MT041 | backend_implementer / backend_validator | A9, A13, A1 | blocked |
| MT071 | #114 | #200 | MT070 | backend_implementer / backend_validator | A9, A13, A12 | blocked |
| MT072 | #115 | #200 | MT070 | backend_implementer / backend_validator | A7, A9, A13 | blocked |
| MT073 | #116 | #200 | MT070, MT010 | backend_implementer / backend_validator | A9, A13, A2 | blocked |
| MT074 | #117 | #200 | MT069, MT003 | backend_implementer / backend_validator | A12, A13 | blocked |
| MT075 | #118 | #201 | MT006, MT013 | backend_implementer / backend_validator | A1, A2, A5 | blocked |
| MT076 | #119 | #201 | MT075, MT026 | backend_implementer / backend_validator | A5, A1, A2 | blocked |
| MT077 | #120 | #201 | MT075, MT014 | backend_implementer / backend_validator | A1, A2, A8 | blocked |
| MT078 | #121 | #201 | MT075, MT073 | backend_implementer / backend_validator | A2, A5, A9 | blocked |
| MT079 | #122 | #201 | MT075, MT015 | backend_implementer / backend_validator | A2, A10, A1 | blocked |
| MT080 | #123 | #202 | MT006, MT009 | frontend_implementer / frontend_validator | A3, A6, A10 | blocked |
| MT081 | #124 | #202 | MT080, MT056 | frontend_implementer / frontend_validator | A10, A6, A3 | blocked |
| MT082 | #125 | #202 | MT081, MT025 | frontend_implementer / frontend_validator | A10, A6, A3 | blocked |
| MT083 | #126 | #202 | MT082 | frontend_implementer / frontend_validator | A10, A3, A6 | blocked |
| MT084 | #127 | #202 | MT083, MT017, MT019 | frontend_implementer / frontend_validator | A2, A3, A4, A10 | blocked |
| MT085 | #128 | #202 | MT084 | frontend_implementer / frontend_validator | A2, A3, A4, A10 | blocked |
| MT086 | #129 | #202 | MT085, MT046, MT034 | frontend_implementer / frontend_validator | A2, A3, A4, A10 | blocked |
| MT087 | #130 | #202 | MT083, MT023 | frontend_implementer / frontend_validator | A2, A3, A10, A11 | blocked |
| MT088 | #131 | #202 | MT087, MT033, MT027 | frontend_implementer / frontend_validator | A2, A3, A10, A11 | blocked |
| MT089 | #132 | #202 | MT088, MT039, MT041 | frontend_implementer / frontend_validator | A2, A3, A10, A11 | blocked |
| MT090 | #133 | #202 | MT089, MT079 | frontend_implementer / frontend_validator | A2, A3, A10, A11 | blocked |
| MT091 | #134 | #202 | MT083, MT057 | frontend_implementer / frontend_validator | A2, A3, A4, A10 | blocked |
| MT092 | #135 | #202 | MT091, MT058 | frontend_implementer / frontend_validator | A2, A3, A4, A10 | blocked |
| MT093 | #136 | #202 | MT083, MT038 | frontend_implementer / frontend_validator | A2, A4, A10 | blocked |
| MT094 | #137 | #202 | MT093, MT033 | frontend_implementer / frontend_validator | A2, A4, A10 | blocked |
| MT095 | #138 | #202 | MT083, MT076 | frontend_implementer / frontend_validator | A2, A5, A9, A10 | blocked |
| MT096 | #139 | #202 | MT095, MT078 | frontend_implementer / frontend_validator | A2, A5, A9, A10 | blocked |
| MT097 | #140 | #202 | MT083, MT073 | frontend_implementer / frontend_validator | A9, A13, A10, A2 | blocked |
| MT098 | #141 | #203 | MT028 | frontend_implementer / frontend_validator | A7, A10, A13 | blocked |
| MT099 | #142 | #203 | MT098, MT069 | frontend_implementer / frontend_validator | A7, A10, A13 | blocked |
| MT100 | #143 | #203 | MT099 | frontend_implementer / frontend_validator | A10, A7, A5 | blocked |
| MT101 | #144 | #203 | MT099, MT082 | frontend_implementer / frontend_validator | A3, A7, A10 | blocked |
| MT102 | #145 | #203 | MT100, MT101 | frontend_implementer / frontend_validator | A10, A3, A13 | blocked |
| MT103 | #146 | #204 | — | frontend_implementer / frontend_validator | A11 | verified |
| MT104 | #147 | #204 | MT103, MT083 | frontend_implementer / frontend_validator | A3, A10, A2 | blocked |
| MT105 | #148 | #204 | MT104, MT025 | frontend_implementer / frontend_validator | A10, A2, A7 | blocked |
| MT106 | #149 | #204 | MT104, MT105 | frontend_implementer / frontend_validator | A2, A3, A10, A11 | blocked |
| MT107 | #150 | #204 | MT106, MT066 | frontend_implementer / frontend_validator | A2, A3, A10, A11 | blocked |
| MT108 | #151 | #205 | MT050, MT065 | backend_implementer / backend_validator | A8, A9, A13, A2 | blocked |
| MT109 | #152 | #205 | MT108, MT069 | backend_implementer / backend_validator | A8, A9, A13, A2 | blocked |
| MT110 | #153 | #205 | MT109, MT078 | backend_implementer / backend_validator | A1, A2, A9 | blocked |
| MT111 | #154 | #205 | MT109, MT072 | backend_implementer / backend_validator | A13, A9, A11 | blocked |
| MT112 | #155 | #206 | MT003, MT004 | backend_implementer / backend_validator | A12, A1, A2 | blocked |
| MT113 | #156 | #206 | MT112, MT074 | backend_implementer / backend_validator | A12, A1, A2 | blocked |
| MT114 | #157 | #206 | MT113, MT016, MT021, MT027, MT031 | backend_implementer / backend_validator | A12, A1, A6 | blocked |
| MT115 | #158 | #206 | MT114, MT039, MT041, MT053, MT057, MT060, MT069, MT077, MT109 | backend_implementer / backend_validator | A12, A1, A6 | blocked |
| MT116 | #159 | #206 | MT113, MT036 | backend_implementer / backend_validator | A12, A1, A6 | blocked |
| MT117 | #160 | #206 | MT114, MT115, MT116 | backend_implementer / backend_validator | A12, A1, A6 | blocked |
| MT118 | #161 | #206 | MT117, MT055, MT061 | backend_implementer / backend_validator | A12, A8, A6 | blocked |
| MT119 | #162 | #206 | MT118, MT037, MT052 | backend_implementer / backend_validator | A12, A8, A6 | blocked |
| MT120 | #163 | #206 | MT119 | backend_implementer / backend_validator | A12, A8, A6 | blocked |
| MT121 | #164 | #206 | MT120 | backend_implementer / backend_validator | A12, A11 | blocked |
| MT122 | #165 | #206 | MT014, MT005, MT041 | backend_implementer / backend_validator | A6, A1, A8, A11 | blocked |
| MT123 | #166 | #206 | MT122 | backend_implementer / backend_validator | A6, A1, A8, A11 | blocked |
| MT124 | #167 | #206 | MT123 | backend_implementer / backend_validator | A2, A5, A6, A11 | blocked |
| MT125 | #168 | #206 | MT124, MT066 | backend_implementer / backend_validator | A2, A5, A6, A11 | blocked |
| MT126 | #169 | #206 | MT123, MT025 | backend_implementer / backend_validator | A10, A2, A6 | blocked |
| MT127 | #170 | #206 | MT125, MT030 | backend_implementer / backend_validator | A6, A11, A13 | blocked |
| MT128 | #171 | #206 | MT127, MT069 | backend_implementer / backend_validator | A6, A11, A13 | blocked |
| MT129 | #172 | #206 | MT123, MT128, MT013, MT012 | backend_implementer / backend_validator | A6, A8, A11 | blocked |
| MT130 | #173 | #206 | MT129, MT042 | backend_implementer / backend_validator | A6, A8, A11 | blocked |
| MT131 | #174 | #206 | MT001, MT002 | backend_implementer / backend_validator | A11, A1, A2, A6 | running |
| MT132 | #175 | #206 | MT131, MT128 | backend_implementer / backend_validator | A11, A1, A2, A6 | blocked |
| MT133 | #176 | #206 | MT132, MT019, MT024 | backend_implementer / backend_validator | A1, A2, A3, A4, A11 | blocked |
| MT134 | #177 | #206 | MT133, MT035, MT040 | backend_implementer / backend_validator | A1, A2, A3, A4, A11 | blocked |
| MT135 | #178 | #206 | MT132, MT045, MT051 | backend_implementer / backend_validator | A2, A5, A8, A11, A12 | blocked |
| MT136 | #179 | #206 | MT135, MT058, MT068 | backend_implementer / backend_validator | A2, A5, A8, A11, A12 | blocked |
| MT137 | #180 | #206 | MT132, MT073 | backend_implementer / backend_validator | A7, A9, A12, A13, A11 | blocked |
| MT138 | #181 | #206 | MT137, MT079, MT111 | backend_implementer / backend_validator | A7, A9, A12, A13, A11 | blocked |
| MT139 | #182 | #206 | MT132, MT097 | backend_implementer / backend_validator | A3, A10, A11, A13 | blocked |
| MT140 | #183 | #206 | MT139, MT102, MT107 | backend_implementer / backend_validator | A3, A10, A11, A13 | blocked |
| MT141 | #184 | #206 | MT121, MT130, MT134, MT136, MT138, MT140 | backend_implementer / backend_validator | A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13 | blocked |
| MT142 | #185 | #206 | MT141 | backend_implementer / backend_validator | A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13 | blocked |
| MT143 | #186 | #206 | MT142 | backend_implementer / backend_validator | A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13 | blocked |

## Constraints and gaps

- Each node preserves source Issue acceptance criteria verbatim in `dag.json`; complete Issue bodies, labels, state, updates, URLs and comments are in `github-intake.json`.
- Owner roles are initial routing by surface family only; exact file ownership remains unassigned because Ticket bodies define behavioral scope, not file lists. Before dispatch, inspect current code and freeze non-overlapping paths/interfaces in that Task Brief.
- Dependencies retain expand → migrate → contract order where explicit Ticket `Blocked by` links require it; no compatibility contraction is allowed ahead of those edges.
- Statuses in this table carry the execution overlay as of 2026-10-15 ~05:02 UTC: `running` = dispatched worker active (MT001 implementer; MT002 implementation done but settlement held for credential-redaction repair plus pending independent review), `verified` = independently reviewed (MT103); all other roots' original `ready` was dependency-only and never implied DB environment or interface readiness. Exact per-worker states, dispatch/receipt IDs and evidence are recorded in `progress.md`; `dag.json` mirrors the same node statuses.
- Full graph and audit files: `dag.json`, `intake-validation.json`, `native-blocked-by.json`, `github-intake.json`.
