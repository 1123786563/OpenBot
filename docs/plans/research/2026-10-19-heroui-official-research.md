# HeroUI official research

Evidence date: 2026-10-19 (Asia/Shanghai). Scope: planning research only; no application code or remote issues changed. Sources are HeroUI’s official documentation/repository and the npm registry metadata exposed by npm.

## Verified facts

### Version line and prerequisites

- `@heroui/react` npm metadata reports `latest: 3.2.6`, version `3.2.6`; `rc` is `3.0.0-rc.1`, `alpha` is `3.0.0-beta.2`, and `canary` is `0.0.0-canary-20260306161133`. Command used: `npm view @heroui/react version dist-tags --json`. Primary registry page: <https://www.npmjs.com/package/%40heroui/react?activeTab=versions>.
- The v3 Quick Start requires React 19+ and Tailwind CSS v4. Install `@heroui/styles @heroui/react`; import `tailwindcss` before `@heroui/styles`. <https://heroui.com/en/docs/react/getting-started/quick-start>
- The v3 GitHub `v3` package manifest records package version `3.2.6`, Node `>=22.x`, pnpm `>=10.x`, and package manager `pnpm@10.26.2`. This is repository development metadata; verify the application’s own Node/package-manager policy before adopting those engine requirements. <https://github.com/heroui-inc/heroui/blob/v3/package.json>
- Vite setup is provided by `npx heroui-cli@latest init -t vite`; React Router setup by `npx heroui-cli@latest init -t react-router`. HeroUI v3 itself does not require a provider. <https://heroui.com/en/docs/react/getting-started/frameworks>
- HeroUI v2 and v3 are separate doc lines: the npm README links “Latest (v3): heroui.com” and “v2: v2.heroui.com.” <https://www.npmjs.com/package/%40heroui/react?activeTab=versions>

### CSS, themes, dark mode, routing and locale

- v3 separates behavior (`@heroui/react`) from framework-agnostic styles (`@heroui/styles`). Full Tailwind v4 setup is `@import "tailwindcss"; @import "@heroui/styles";`; import order matters. Prebuilt CSS/CDN bundles contain HeroUI classes/tokens but not Tailwind utility classes. <https://heroui.com/en/docs/react/getting-started/quick-start>, <https://heroui.com/en/docs/react/getting-started/frameworks>
- v3 uses CSS variables and BEM classes. Global overrides can be placed in `@layer components`; selective imports are available for base, themes, and individual component CSS. <https://heroui.com/en/docs/react/releases/v3-0-0>
- Dark mode/themeing is CSS based: `.dark` or `[data-theme="dark"]` overrides tokens; custom themes use a token set under `[data-theme="..."]`. No JavaScript theme object or global HeroUI provider is required for this. <https://heroui.com/en/docs/react/releases/v3-0-0>
- Router integration is an explicit `RouterProvider` export for React Aria links when needed. Locale is handled with React Aria’s `I18nProvider`; official framework guidance recommends matching server/client `lang` and `dir`, using `isRTL(lang)` for direction. <https://heroui.com/en/docs/react/getting-started/frameworks>, <https://heroui.com/en/docs/react/releases/v3-0-0-beta-4>
- “No provider” means no required global HeroUI provider. Feature providers still exist: Toast requires rendering `<Toast.Provider />`; locale can use `<I18nProvider>`. <https://heroui.com/en/docs/react/components/toast>, <https://heroui.com/en/docs/react/getting-started/frameworks>

### Requested component coverage

- Modal provides dialog overlays, backdrop variants (`opaque`, `blur`, `transparent`), focus trapping, ESC/backdrop dismissal controls, placement, size, scroll behavior, controlled state, custom portal, and compound anatomy (`Modal.Trigger`, `Modal.Backdrop`, `Modal.Container`, `Modal.Dialog`, `Modal.Header`, `Modal.Body`, `Modal.Footer`, `Modal.CloseTrigger`). <https://heroui.com/en/docs/react/components/modal>
- Select is a compound accessible field built from `Select`, `Select.Trigger`, `Select.Value`, `Select.Indicator`, `Select.Popover`, and React Aria `ListBox` items; supports single/multiple selection, controlled open/value, disabled keys, required/invalid states, and placement. <https://heroui.com/docs/react/components/select>
- Toast is available through `Toast.Provider` plus a global `toast()` queue API, with variants, placement, auto-dismiss, promise/loading states, actions, custom queues, and keyboard interaction. <https://heroui.com/en/docs/react/components/toast>
- Table is available as `Table`, `Table.ScrollContainer`, and `Table.Content`, inherits React Aria Table behavior, and supports selection modes. Official release notes also document virtualizer and editable-cell/typeahead behavior. <https://heroui.com/en/docs/react/components/table>, <https://heroui.com/en/docs/react/releases/v3-2-5>
- The official component index lists the complete React catalog; the requested overlay/select/toast/table capabilities are therefore documented v3 components rather than inferred from a marketing list. <https://heroui.com/en/docs/react/components>

### Migration and composition gotchas

- The v2→v3 migration guide calls out React 19+, Tailwind v4, removal of Framer Motion, removal of the required `HeroUIProvider`, and gradual component-by-component migration. Running v2 and v3 together is documented as possible but increases styling/version complexity. <https://heroui.com/en/docs/react/migration>
- v3 replaces many v2 black-box components and hooks with compound components. Modal uses `useOverlayState` instead of `useDisclosure`; props move to the relevant compound parts; `onClose` becomes a `close` render prop; `motionProps` is removed; size/backdrop/scroll options move to `Modal.Container`/`Modal.Backdrop`. <https://heroui.com/en/docs/react/migration/modal>
- Select migration requires compound structure and separate `Label`/`Description`/`FieldError`; `selectedKeys`/`onSelectionChange` become `value`/`onChange`; `renderValue` becomes a `Select.Value` render prop; `isClearable` is removed in favor of `Select.ClearButton`; item `id` and `textValue` are distinct from React’s reconciliation `key`. <https://heroui.com/en/docs/react/migration/select>
- HeroUI web v3 removed the `asChild` prop during beta development; the release notes explicitly call this a breaking change. Do not assume Radix/shadcn `asChild` composition patterns transfer to web v3. The current web docs show direct compound parts such as `Modal.Trigger`, while `asChild` examples on HeroUI’s site are for the separate React Native package. <https://heroui.com/en/docs/react/releases/v3-0-0-beta-3>, <https://heroui.com/en/docs/react/migration/modal>, <https://heroui.com/en/docs/native/getting-started/composition>
- v3’s React 19 migration includes using `ref` as a normal prop and React’s `use()` API in the source/release history; integrations that depend on older ref-forwarding or context assumptions should be checked during migration. <https://heroui.com/en/docs/react/releases/v3-2-2>
- Toast migration is materially different: v2’s `ToastProvider`/`useToast().toast.show()` becomes v3’s `<Toast.Provider />` plus imported global `toast()`. <https://heroui.com/cn/docs/react/migration/toast>

## Inference for planning

- For a new React/Vite desktop/web surface, target v3.2.6 and install both `@heroui/react` and `@heroui/styles`, assuming the project can meet React 19 and Tailwind v4. This follows the current `latest` tag and official quick-start requirements; it is a recommendation, not a project compatibility finding.
- Treat HeroUI v3 as a CSS-first, compound-component system. Existing Radix/shadcn code that relies on `asChild`, `Slot`, monolithic component props, `classNames`, or v2 hooks should be mapped component by component rather than mechanically renamed.
- Plan a small root integration layer for `Toast.Provider`, optional `I18nProvider`, and optional `RouterProvider`; there is no blanket `HeroUIProvider` requirement.

## Unresolved items

- The brief does not specify this repository’s current React, Tailwind, bundler, router, CSP, or Node versions; compatibility must be checked against the application before implementation.
- The exact component subset and desktop/web target are still TBD, so the research does not claim that every HeroUI v3 component is production-ready for this product’s workflows.
- HeroUI release notes are time-sensitive. Recheck npm `latest`, peer dependencies, and the relevant component migration page immediately before implementation.
