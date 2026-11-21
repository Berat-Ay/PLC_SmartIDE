export type GlobalShortcutAction =
  | 'new-project'
  | 'open-project'
  | 'save-project'
  | 'compile'
  | 'toggle-monitoring'
  | 'cross-reference'
  | 'toggle-left-dock'
  | 'toggle-right-dock'
  | 'toggle-bottom-dock'
  | 'toggle-split-view'

export interface ShortcutEventLike {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  target: EventTarget | null
}

/**
 * Returns true when focus is inside an editable form element, contentEditable region,
 * or embedded code editor (Monaco / CodeMirror) so IDE shortcuts do not hijack typing.
 */
export function isEditableElement(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false
  const el = target as {
    tagName?: string
    isContentEditable?: boolean
    getAttribute?: (name: string) => string | null
    closest?: (selector: string) => unknown
  }

  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true
  }

  if (el.isContentEditable === true) {
    return true
  }

  const contentEditableAttr = el.getAttribute?.('contenteditable')
  if (contentEditableAttr === 'true' || contentEditableAttr === '') {
    return true
  }

  if (
    typeof el.closest === 'function' &&
    el.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], .monaco-editor, .cm-editor')
  ) {
    return true
  }

  return false
}

/**
 * Maps a keyboard event to a global IDE command matching TopAppBar / BottomInspector hints.
 * Returns null if the event is suppressed by an active text input (except Ctrl+S save)
 * or belongs to a sub-editor chord such as Shift+F7 / Ctrl+Shift+B.
 */
export function resolveGlobalShortcut(e: ShortcutEventLike): GlobalShortcutAction | null {
  const mod = e.ctrlKey || e.metaKey
  const key = (e.key || '').toLowerCase()
  const editable = isEditableElement(e.target)

  // Save Project is always allowed, even while editing inside an input or Monaco/CodeMirror editor.
  if (mod && !e.altKey && !e.shiftKey && key === 's') {
    return 'save-project'
  }

  if (editable) {
    return null
  }

  if (mod && !e.altKey && !e.shiftKey && key === 'n') {
    return 'new-project'
  }
  if (mod && !e.altKey && !e.shiftKey && key === 'o') {
    return 'open-project'
  }
  if (
    (mod && !e.altKey && !e.shiftKey && key === 'b') ||
    (!mod && !e.altKey && !e.shiftKey && e.key === 'F7')
  ) {
    return 'compile'
  }
  if (mod && !e.altKey && !e.shiftKey && key === 'm') {
    return 'toggle-monitoring'
  }
  if (!mod && !e.altKey && !e.shiftKey && e.key === 'F11') {
    return 'cross-reference'
  }

  if (e.altKey && !mod && !e.shiftKey) {
    if (key === '1' || e.code === 'Digit1') return 'toggle-left-dock'
    if (key === '2' || e.code === 'Digit2') return 'toggle-right-dock'
    if (key === '3' || e.code === 'Digit3') return 'toggle-bottom-dock'
    if (key === 's' || e.code === 'KeyS') return 'toggle-split-view'
  }

  return null
}
