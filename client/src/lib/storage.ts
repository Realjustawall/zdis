// Safari can deny Web Storage access in private/embedded contexts. Keep the
// interface usable with an in-memory fallback instead of failing during boot.
const memoryStorage = new Map<string, string>();

export function storageGet(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key);
    return value ?? memoryStorage.get(key) ?? null;
  } catch {
    return memoryStorage.get(key) ?? null;
  }
}

export function storageSet(key: string, value: string) {
  memoryStorage.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The in-memory value remains available for this tab.
  }
}

export function storageRemove(key: string) {
  memoryStorage.delete(key);
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage was unavailable; the fallback has still been cleared.
  }
}
