import type { Key } from "ink"

type ShortcutKey = Pick<Key, "ctrl" | "meta" | "super" | "hyper" | "eventType">

export function allowsShortcut(key: ShortcutKey): boolean {
  if (key.ctrl || key.meta || key.super || key.hyper) {
    return false
  }

  return key.eventType === undefined || key.eventType === "press"
}

export function matchesShortcut(input: string, key: ShortcutKey, shortcut: string): boolean {
  return input === shortcut && allowsShortcut(key)
}
