/** Non-secret facts about a saved account. Tokens are never part of this. */
export type SavedAccount = {
  id: string
  email: string
  organization?: string
  oauthAccount: Record<string, unknown>
  addedAt: number
}

export type Language = 'en' | 'tr'

export type Notice = { kind: 'info' | 'error'; text: string }

export type PanelState = {
  accounts: SavedAccount[]
  /** The account the shared sign-in file belongs to. */
  activeId?: string
  /** Email of a signed-in account that is not saved yet. */
  unsavedEmail?: string
  /** Set in a window opened with its own account: it never follows a switch. */
  windowAccountId?: string
  busy: boolean
  /** False when the window is too narrow: a one-line band stands in for it. */
  isPanePlaced: boolean
  confirmRemoveId?: string
  notice?: Notice
  language: Language
  isSupported: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'account-switcher': { panel: Shaped<PanelState> }
  }
}
