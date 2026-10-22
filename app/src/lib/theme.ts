export const THEME_STORAGE_KEY = "openbot-theme";

export function parseStoredDarkTheme(value: string | null) {
  return value === "dark";
}

type ThemeEffects = {
  setStoredValue: (key: string, value: string) => void;
  toggleRootClass: (name: string, force: boolean) => void;
  setRootColorScheme: (scheme: "dark" | "light") => void;
  /**
   * The same boolean also lands in `data-theme`, which is what HeroUI's own `[data-theme="dark"]`
   * selectors read. The class remains the source of truth for OpenBot's CSS; both are written from
   * this one function, never stored separately. Required so a caller cannot let them drift.
   */
  setRootTheme: (theme: "dark" | "light") => void;
};

export function applyDarkTheme(dark: boolean, effects: ThemeEffects) {
  effects.setStoredValue(THEME_STORAGE_KEY, dark ? "dark" : "light");
  effects.toggleRootClass("dark", dark);
  effects.setRootTheme(dark ? "dark" : "light");
  // `index.html` sets this inline before paint, and an inline style outranks the palette.
  effects.setRootColorScheme(dark ? "dark" : "light");
}
