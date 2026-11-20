---
status: accepted
---

# Pilot Astryx for OpenBot Web

Use Astryx as OpenBot Web’s design system to unify presentation and reduce the cost of maintaining UI components across four skins. Keep OpenBot branding, light and dark appearance, and the existing features, entry points, permissions, and workflows.

Start with a working Bots list and Create Bot flow. Verify behavior, visuals, basic accessibility, and the production build. User approval of the pilot visuals gates migration of the remaining Web surfaces in feature batches, followed by retirement of the four legacy skins.

The isolated preview covers `/bots` and both callers of the shared Create Bot sheet. The list opens the new Bot’s profile. The new conversation adds the Bot to its recipients and keeps the draft. Chat proposals and Bot duplication stay in their respective feature batches. Existing routes and server authorization are part of the behavior baseline.

Start from Astryx Neutral and preserve the appearance preference. Adapt the deployment name, mark, and accent colors. Validate the default and a custom brand in both appearances. Check desktop and narrow layouts, keyboard and focus behavior, form errors and contrast, Personal and Team permissions, and the production build.

This decision replaces the previous direction to keep alternate skins. Before retiring a skin, map its navigation and dedicated screens to the unified Web UI and preserve working destinations for existing links.
