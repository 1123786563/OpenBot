# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY-MAP.md`** at the repo root. It maps the domain contexts identified from the codebase.
- The `GLOSSARY.md` file for every context affected by the task under **`docs/domain/`**.
- **`docs/adr/`** for system-wide architectural decisions.
- Any context-specific ADR directory named by the map or by the affected context's documentation.

If a referenced glossary or ADR directory does not exist, proceed silently. Create domain documentation when a term or architectural decision has actually been resolved.

## File structure

This repository uses a multi-context layout:

```
/
├── GLOSSARY-MAP.md
├── docs/
│   ├── adr/                         ← system-wide decisions when present
│   └── domain/
│       ├── <context>/
│       │   └── GLOSSARY.md
│       └── ...
└── app/ server/ shared/ worker/ ...
```

`GLOSSARY-MAP.md` owns the context inventory, code locations, and cross-context relationships. Each context glossary owns domain vocabulary and relationships for that context. The glossaries should remain free of implementation details.

## Use the glossary's vocabulary

When your output names a domain concept in an issue title, refactor proposal, hypothesis, or test name, use the term defined by the relevant glossary. Do not drift to synonyms that change the concept's meaning.

If a needed concept is missing, record the gap for domain modeling and update the relevant glossary once the term is resolved from the code and product behavior.

## Cross-context changes

When a change crosses contexts, read every affected glossary and check the cross-context relationships in `GLOSSARY-MAP.md`. Keep ownership of each term with its context. If a concept is shared, document the relationship in the map instead of duplicating competing definitions.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding it:

> _Contradicts ADR-0007, but worth reopening because…_
