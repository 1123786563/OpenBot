---
status: accepted
---

# Use Astryx for OpenBot UI and CopilotKit for agent integration

ADR 0003 established Astryx as the OpenBot Web design system. Astryx also governs the UI users interact with during agent runs, giving these interactions the same component and theme conventions as the rest of OpenBot Web.

- This decision applies to OpenBot Web in Personal and Team, including Settings and the administration UI.
- OpenBot uses Astryx for the visible chat UI on `/bot` and Conversation pages, including the transcript, composer, tool cards, and approval controls. CopilotKit providers and hooks continue to handle agent integration over AG-UI, including message streaming, tool calls, and approval responses.
- CopilotKit interprets A2UI payloads and handles their interactions. OpenBot maps user-visible A2UI controls, including generated form fields and buttons, to Astryx components.
- Published HTML, CSS, and JavaScript components retain their published presentation inside the CopilotKit sandbox. OpenBot uses Astryx for the surrounding title, loading and error states, and host controls.

## Migration and acceptance

Start with `/bot` in an isolated preview and verify the full chat flow, including recovering an existing thread, starting a new chat, streaming replies, reporting failed turns, and submitting approvals. Reuse the verified transcript, composer, and approval controls in Conversation, then complete the migration of component previews and administration.

Keep the `openbot/ui@1` catalog ID and preserve its component names, properties, value types, and events when changing renderers. Previously generated forms must still display and submit using their existing contract.

If an A2UI form fails to render, show an Astryx error state, disable submission for that form, and preserve the rest of the message.

Remove the global CopilotKit UI stylesheet after verifying that Conversation, component previews, administration, and all other Web surfaces no longer depend on it. Run the Web acceptance checks again on the bundle with the stylesheet removed.

Before switching the Web release, run a real Bot turn in both Personal and Team. Check streaming replies, tool cards, continuation after approval, and editing and submitting an A2UI form. Verify keyboard operation and both light and dark appearance.

Verify an approval across the Web release switch. Start a Bot run that pauses for approval on the previous build. Switch builds, reopen the same Conversation, and submit the pending approval. Verify that the original run resumes exactly once.

Begin the production canary once the full Web migration is complete, the global CopilotKit UI stylesheet has been removed, and the release candidate passes acceptance in both editions. Use the same release candidate in one Personal deployment and one Team deployment before expanding rollout. Archive the previous compatible Web build, its digest, and its hashed assets. If chat, approvals, or A2UI regress, restore the previous build and its asset routing at the same origin.
