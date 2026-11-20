---
status: accepted
---

# Use SkillHub for the skill market

OpenBot uses a separately deployed instance of [iFLYTEK SkillHub](https://github.com/iflytek/skillhub) as its Skill registry. Administrators publish and review market Skills in SkillHub. Its versioned packages and review workflow give OpenBot a shared catalog without duplicating those workflows.

People browse and preview market Skills in OpenBot and install a specific published version on a Bot. Publishing a newer version leaves existing installations on their selected version until an explicit upgrade. OpenBot owns installations, Bot grants, and execution. Personal Skills and Learned skills retain their OpenBot publication and use workflows.

The first release serves one self-hosted enterprise deployment. All users of that deployment see the same administrator-curated catalog.

## Catalog access

People browse through their OpenBot session. The OpenBot server uses a dedicated read identity for the administrator-selected SkillHub catalog. Search, details, and downloads use the same catalog scope. The identity has no publishing or review privileges and cannot access unpublished versions. Administrators sign in to SkillHub for publishing and review.

## Installation and availability

Anyone in the deployment can browse the catalog. A person needs permission to manage the target Bot's Skills to install, upgrade, or uninstall a version. OpenBot verifies that the selected version is installable in SkillHub and saves its content and source at installation. Bot runs use the saved content and can invoke installed Skills during a SkillHub outage.

The first release installs self-contained `SKILL.md` instructions. A Skill can use tools under the Bot's existing grants. The publisher declares OpenBot compatibility for each version, and the reviewer confirms it. OpenBot allows people to preview a version with missing or unconfirmed compatibility and explains why they cannot install it. The preview also identifies requirements such as bundled scripts, supporting files, or a dedicated runtime.

Each market Skill has one slash command per deployment. Bots can use different versions under that command. If a command is taken, an administrator assigns an unused name before anyone can install the market Skill.

People with access to a shared Bot can invoke its installed Skills. Each tool call still follows the applicable authorization and approval rules.

Upgrading, rolling back, or uninstalling a Skill affects future invocations. An active run keeps the version it loaded, subject to emergency disablement. Rollback uses the same version selection as upgrade and requires a version that is still installable in SkillHub and enabled in OpenBot.

The first release provides browsing, preview, installation, version switching, uninstall, and disablement controls on Web. Clients that already support Skill invocation can use installed market Skills through the Bot.

## Withdrawal and disablement

Withdrawing a version from the market blocks new installations of that version. Existing installations can continue to run. An OpenBot administrator can disable a specific version to block new invocations from existing installations.

If a run has loaded a disabled version, OpenBot pauses it before its next model call or tool dispatch and explains why. This check also applies when a pending approval would otherwise release a tool call. For a request already accepted by an external service, OpenBot tracks the actual outcome.

An OpenBot administrator explicitly lifts disablement. Existing installations can then accept new invocations. Runs paused by disablement stay paused. A person can start a new run after checking the outcome of any earlier external requests.

## Release verification

- On the target SkillHub release, confirm that the OpenBot read identity can search, inspect, and download approved versions in the configured catalog. Check that direct detail and download requests cannot bypass the catalog scope or expose unpublished versions.
- Publish two versions of a Skill. Install each on a different Bot under the same command. Exercise a command collision, an explicit upgrade and rollback, and an uninstall during an active run.
- Use a shared Bot as a member with permission to invoke it and as a member with permission to manage its Skills. Verify that market installation does not add tool grants and that each member can take only the actions their permissions allow.
- Show a version whose compatibility is unconfirmed. Verify it can be previewed and installation is disabled with a reason.
- Stop SkillHub and invoke an installed Skill. Restore SkillHub, withdraw the version, and verify that existing installations work while new installations are blocked.
- Disable a version while a run is waiting for tool approval. Verify that approval cannot release the call and new invocations are blocked. Lift disablement and verify that a new invocation works and the paused run stays paused.
