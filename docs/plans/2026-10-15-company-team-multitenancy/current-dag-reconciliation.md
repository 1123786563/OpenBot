# Current Issue #6 DAG reconciliation

This addendum supersedes the historical `dag-ledger.md` only where current GitHub ingestion or the current user authorization differs. The historical 26-task plan remains a file/interface reference; execution nodes are the 150 formal GitHub Tickets.

## Node inventory

| Set | Formal containment | Count | Execution rule |
| --- | --- | ---: | --- |
| MT001–MT143 | #187–#206 | 143 | Use each Ticket body as the vertical business slice; do not split into database/backend/frontend layers. |
| BP01–BP07 | #368 | 7 | Include as a separate billing/payment closure Epic; map to R6/R7/A9/A13 and sequence after the relevant payer/account interfaces. |

Total current formal implementation nodes: 150. The 20 Epic contains edges are not dependency edges. Every node remains `pending` until its Ticket-level Blocked by links, file ownership, interface contract, validation, independent review, and integrated checkpoint are recorded.

## Verified ready nodes and current Dispatches

| Ticket | Issue | Depends on | Owner | Dispatch | Status |
| --- | ---: | --- | --- | --- | --- |
| MT001 | #44 | none (Ticket body) | backend implementation Pi | `ctx_d3fe7c016e22` | running |
| MT002 | #45 | none (Ticket body) | backend implementation Pi | `ctx_00135101e84a` | running |
| MT103 | #146 | none (Ticket body) | research/documentation Pi | `ctx_e684a2a0bf27` | running |

These three have disjoint owned surfaces and no shared database/port/build state. Their Orca receipts show dedicated child worktrees and `launch.effective.agent=pi`.

## Explicit dependency examples

- #147/MT104 depends on #146/MT103 and #126/MT083; it is not ready.
- #148/MT105 depends on #147/MT104 and #68/MT025; it is not ready.
- #149/MT106 depends on #147/MT104 and #148/MT105; it is not ready.
- #150/MT107 depends on #149/MT106 and #109/MT066; it is not ready.

The full Ticket bodies remain the dependency source. A dependency is added only when a Ticket explicitly names `Blocked by` or when a code/interface/data prerequisite is evidenced and recorded; Epic containment alone never creates an edge.

## Acceptance coverage gate

The approved Spec defines R1–R7, A1–A13, and the §8 coverage matrix. The historical plan maps A1–A13 to T01–T26, but current completion additionally requires every MT/BP Ticket and every §8 surface to have positive and privilege-escalation evidence. A missing external credential, test database, native client, supplier verification, or submodule integration is a recorded gap and cannot be marked verified.

## Expand → migrate → contract

The DAG must keep compatibility seams during expand, perform historical migration/dry-run and manifest verification only after the new ownership/authz contracts are proven, and contract old fallback paths only after coverage and rollback evidence. No migration apply, deployment, release, or multitenancy enablement is authorized in this run.
