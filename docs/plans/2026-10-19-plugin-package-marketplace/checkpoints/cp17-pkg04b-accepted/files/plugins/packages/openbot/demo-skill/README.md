# Demo Skill

A trusted fixture package for the plugin-package marketplace. It contains one
Skill resource, `summarize`, and nothing else: no scripts, no endpoints and no
secrets.

Build and register it with:

```sh
bun scripts/plugin-packages/build.ts --catalog plugins/marketplace.json --out plugins/.artifacts
```
