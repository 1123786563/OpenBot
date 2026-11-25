// Browser preferences remain usable for this visit when storage is unavailable.
export function getStoredValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setStoredValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Persistence is optional; the caller still owns the in-session state.
  }
}
