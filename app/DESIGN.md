# OpenBot Web design

OpenBot Web uses Astryx Neutral for the unified interface. The app entry loads the reset, core component styles and Neutral theme. The root carries the Neutral theme, and the appearance preference sets the document color scheme. Deployment branding supplies the product name and mark. Keep the brand visible in the workspace header and reserve accent color for actions and state.

## Navigation and hierarchy

The workspace puts common destinations before conversation history. The Bots entry shows pending work and the roster opens with items that need attention. Search conversations in the sidebar and use Find a Bot on the roster. Admin and Settings each link back to the workspace. Settings groups preferences, access and devices, and workspace tools. Admin uses the same destination groups on the overview and in the sidebar. Links expose the active route, and the keyboard skip link moves focus into the main panel. On narrow screens navigation opens in a sheet and selecting a destination closes it.

A configuration page has one primary heading, a short description when it explains a decision, and at most one primary action. Use section headings to group related controls. Use rows for dense lists and put a count badge beside the destination or record it describes. The Bots pilot pairs a primary New Bot action with role-aware roster sections and Astryx List rows.

## System state

For the first roster load, use row-shaped skeletons and one accessible status. A successful empty list tells the person how to start. A failed read offers an in-place retry. A denied read explains access and links back to the workspace. Preserve readable cached data when background reads fail. Keep field values during a failed creation attempt. The creation dialog names the current step and returns focus to its opener on cancellation.

Check light and dark mode, long deployment names and narrow viewports. Record representative renders and evidence with the batch review. Keep saved links working through the unified interface.
