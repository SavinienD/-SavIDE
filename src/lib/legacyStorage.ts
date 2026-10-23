// axe:migration — localStorage keys of before the rename.
//
// The app used to keep its settings under `axe-<old name>:…` and
// `<old name>.…` keys (zoom, recent folders, terminal tabs, fast mode…). At the
// first start of the renamed app each of those keys is copied ONCE under the
// same key with the new prefix, when that key is absent: nothing is removed or
// overwritten and only the prefix changes (the rest of a key, a project path
// for instance, is kept as it is). A marker key stops any later copy, so a key
// that the app removes on purpose (sign-out, closed terminal) never comes back.
// Keep in sync with the copy in remote/public/app.js.

/** Marker of a finished migration (date and number of keys copied). */
export const STORAGE_MIGRATION_MARKER = "axecode:storage-migration";

// rebrand:keep-begin (old prefixes, read only)
const LEGACY_PREFIX = /^(?:(?:axe|Axe|AXE)[-_.: ]?)?(?:atelier|Atelier|ATELIER)(?![a-z])/;
// rebrand:keep-end

/** New name of an old key, or `null` when the key is not an old key. */
export function legacyStorageKey(key: string): string | null {
  const match = LEGACY_PREFIX.exec(key);
  if (!match) return null;
  const old = match[0];
  const letters = old.replace(/[^A-Za-z]/g, "");
  const name = letters === letters.toUpperCase() ? "AXECODE" : /^[a-z]/.test(old) ? "axecode" : "Axecode";
  return name + key.slice(old.length);
}

type KeyValueStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem">;

/**
 * Copies every old key missing under its new name, once. Never throws
 * (storage disabled, quota): the app starts anyway. Returns the new keys.
 */
export function migrateLegacyStorage(getStorage: () => KeyValueStorage | null | undefined): string[] {
  const copied: string[] = [];
  try {
    const storage = getStorage();
    if (!storage || storage.getItem(STORAGE_MIGRATION_MARKER) !== null) return copied;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null) keys.push(key);
    }
    let failed = false;
    for (const key of keys) {
      const next = legacyStorageKey(key);
      if (next === null) continue;
      try {
        const value = storage.getItem(key);
        if (value === null || storage.getItem(next) !== null) continue;
        storage.setItem(next, value);
        copied.push(next);
      } catch {
        failed = true; // quota: tried again at the next start
      }
    }
    if (!failed) {
      storage.setItem(STORAGE_MIGRATION_MARKER, JSON.stringify({ dateMs: Date.now(), copied: copied.length }));
    }
  } catch {
    // storage unavailable: nothing to migrate
  }
  return copied;
}
