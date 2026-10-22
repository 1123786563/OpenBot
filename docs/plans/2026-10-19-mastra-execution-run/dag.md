# Execution DAG (native relationships, read 2026-10-19)

Source: GitHub `1123786563/OpenBot` API `issues/{n}/dependencies/blocked_by` (paginated) and sub-issue `contains` relation.

## contains (parent -> child)

- 472 -> 473,474,475,476,477,478,479,480,481,482,483,484,485,486,487,488

`contains` is a hierarchy link only. It is not an execution dependency.

## depends_on (native blocked_by)

| Issue | Blocked by |
| --- | --- |
| 473 ME01 | - |
| 474 ME02 | 473 |
| 475 ME03 | 474 |
| 476 ME04 | 475 |
| 477 ME05 | 476 |
| 478 ME06 | 477 |
| 479 ME07 | 476, 395 |
| 480 ME08 | 477 |
| 481 ME09 | 478, 479, 480 |
| 482 ME10 | 481 |
| 483 ME11 | 482 |
| 484 ME12 | 481 |
| 485 ME13 | 475, 477 |
| 486 ME14 | 483, 484, 485 |
| 487 ME15 | 486 |
| 488 ME16 | 487 |

External: 395 (Hindsight personal-memory exit) gates ME07. Open at read; implementation must be audited in code before ME07 is released.

## Topological order

ME01, ME02, ME03, ME04, ME05, ME06, ME07, ME08, ME09, ME10, ME11, ME12, ME13, ME14, ME15, ME16

Serial implementation by default. Shared files (`execution-contracts.ts`, `execution.ts`, `copilot.ts`, `index.ts`, schema, test DB) are never edited by two tickets concurrently.

## Ready set at start

- ME01 only.
- ME07 also externally blocked by #395.
