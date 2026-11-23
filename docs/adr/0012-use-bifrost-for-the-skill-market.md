---
status: accepted
---

# Use Bifrost for the skill market

Use Bifrost Skills Repository as the registry for the enterprise skill market, replacing SkillHub as described in [ADR 0010](./0010-use-skillhub-for-the-skill-market.md). Reusing the Bifrost deployment gives administrators one place to manage skill packages and versions. OpenBot retains the market and owns Bot installations, slash commands, tool grants, and execution. Personal and learned skills keep their existing workflows.

## Catalog access and installation

Upgrade the existing Bifrost deployment to a verified stable release. Keep Bifrost's native serving routes private. Signed-in users browse and download through OpenBot. The OpenBot server uses a dedicated read path limited to the catalog, while administrators publish through Bifrost.

Bifrost stores complete Agent Skills packages. The first OpenBot release installs only versions that can run from a self-contained `SKILL.md`. OpenBot records administrator approval against the exact version and its content fingerprint. Approval, compatibility, and withdrawal determine installation eligibility independently of Bifrost's currently served version. Withdrawal blocks future installations. OpenBot retains emergency disablement for installed and running versions.

## Migration

Import published versions that remain available for installation and verify their contents against the source packages. Retain the installation snapshots and history for withdrawn versions. Preserve each existing installation's selected version and slash command, and carry forward its disablement state, active runs, and pending approvals. Preserve the connection between old and new registry records so an explicit upgrade can use the existing command and a registry ID change cannot bypass a disablement.

Verify existing model calls after the Bifrost upgrade and before switching the skill catalog. During the catalog switch, pause publishing and new installations. Keep installed skill invocations and emergency disablement available. Verify catalog access, exact-version downloads, existing installations, and approval continuations before reopening writes.

Keep SkillHub available for catalog fallback until writes reopen. After writes reopen, any recovery must preserve installations, disablements, and approval records written after the switch. Mark ADR 0010 as superseded after the catalog switch and SkillHub retirement are complete.
