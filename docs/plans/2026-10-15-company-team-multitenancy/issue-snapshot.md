# Issue #6 snapshot (initial)

Source: GitHub REST API for `1123786563/OpenBot`, read 2026-10-15 Asia/Shanghai.

Root: #6, “Spec: 公司与团队多租户整改（全功能隔离后统一上线）”, open, `ready-for-agent`.

Formal direct children:

- #187–#206: 20 multitenancy Epics, MT001–MT143, recursively 143 Tickets.
- #368: `[计费支付] 公司与个人购买交付闭环（BP01–BP07）`, recursively 7 Tickets.

The root body is the approved requirements source and includes user stories, implementation/testing decisions, out-of-scope constraints, the R1–R7/A1–A13 Spec pointer, and a requirement to preserve expand → migrate → contract ordering. It explicitly states that all existing business loops and Web/desktop/mobile clients must pass positive and privilege-escalation evidence before enablement.

Important ingestion caveat: a bulk read of `#204/sub_issues` received `TLS handshake timeout`; retry is required before declaring the tree complete. Ticket bodies use `Blocked by` tables and must be parsed into `depends_on`, separate from Epic containment.
