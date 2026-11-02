import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Language, PanelState, SavedAccount } from '../types'
import {
  accountId,
  loadIndex,
  readSignedIn,
  resolvePaths,
  saveIndex,
  toSaved,
  vault,
  writeSignedIn,
} from './accounts'
import type { Paths } from './accounts'
import { strings } from './i18n'

type Engine = EngineInterface

const PANE = 'accounts'
const LOGIN_TIMEOUT_MS = 600_000
const REFRESH_MS = 30_000
const LANGUAGE_KEY = 'language'

const panel = atom(
  { plugin: 'account-switcher', key: 'panel' } as const,
  {
    accounts: [],
    busy: false,
    isPanePlaced: false,
    language: 'en',
    isSupported: true,
  } as PanelState,
  { shape: 'panel-2' },
)

/** Guards against a second press before the first has marked itself busy. */
let isRunning = false

const text = async ($: Engine) => strings((await read($, panel)).language)

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** Re-reads who is signed in from disk, so every window shows the truth. */
const refresh = async ($: Engine, paths: Paths) => {
  const accounts = await loadIndex($, paths)
  const signedIn = await readSignedIn($, paths.globalConfig)
  const activeId = signedIn ? await accountId(signedIn) : undefined
  const isSaved = accounts.some(account => account.id === activeId)

  await update($, panel, state => ({
    ...state,
    accounts,
    activeId,
    unsavedEmail:
      signedIn && !isSaved ? String(signedIn.emailAddress ?? '') : undefined,
    windowAccountId: paths.windowAccountId,
  }))
  const active = accounts.find(account => account.id === activeId)
  const shown = paths.windowAccountId
    ? accounts.find(account => account.id === paths.windowAccountId)
    : active
  $.ui.status(shown?.email)
}

/** Encrypts the shared sign-in under its own account before anything moves. */
const saveCurrent = async ($: Engine, paths: Paths) => {
  const signedIn = await readSignedIn($, paths.globalConfig)
  if (!signedIn) return undefined
  const saved = await toSaved(signedIn, await $.clock.now())
  await vault($, paths, 'capture', { Id: saved.id, ConfigDir: paths.configDir })
  const accounts = await loadIndex($, paths)
  const existing = accounts.find(account => account.id === saved.id)
  const merged: SavedAccount = existing
    ? { ...saved, addedAt: existing.addedAt }
    : saved
  await saveIndex($, paths, [
    ...accounts.filter(account => account.id !== saved.id),
    merged,
  ].sort((a, b) => a.addedAt - b.addedAt))

  return merged
}

const openPane = async ($: Engine) => {
  const { isPlaced } = await $.ui.open({ id: PANE, title: (await text($)).title })
  await update($, panel, state => ({ ...state, isPanePlaced: isPlaced }))
}

const syncPane = async ($: Engine) => {
  const isPlaced = (await $.ui.panes()).some(
    pane => pane.id === PANE && pane.isPlaced,
  )
  await update($, panel, state =>
    state.isPanePlaced === isPlaced ? state : { ...state, isPanePlaced: isPlaced },
  )
}

const perform = async (
  $: Engine,
  paths: Paths,
  action: () => Promise<string | undefined>,
) => {
  const t = await text($)
  await update($, panel, current => ({
    ...current,
    busy: true,
    notice: undefined,
    confirmRemoveId: undefined,
  }))
  let notice: PanelState['notice']
  try {
    const message = await action()
    notice = message ? { kind: 'info', text: message } : undefined
  } catch (error) {
    notice = { kind: 'error', text: t.failed(errorText(error)) }
  }
  await update($, panel, current => ({ ...current, busy: false, notice }))
  await refresh($, paths).catch(() => undefined)
}

/**
 * One action at a time, its outcome shown in the panel. It is not awaited: a
 * press must answer within its 10 seconds, and a sign-in takes longer.
 */
const run = (
  $: Engine,
  paths: Paths,
  action: () => Promise<string | undefined>,
) => {
  if (isRunning) return
  isRunning = true
  void perform($, paths, action).finally(() => {
    isRunning = false
  })
}

/** Deletes sign-in folders left by an interrupted sign-in, if there are any. */
const sweepLogins = async ($: Engine, paths: Paths) => {
  const folder = `${paths.root}\\tmp`
  if (!(await $.fs.exists(folder))) return
  if ((await $.fs.list(folder)).length > 0) await vault($, paths, 'sweep')
}

const switchTo = (
  $: Engine,
  paths: Paths,
  target: SavedAccount,
  t: ReturnType<typeof strings>,
) =>
  run($, paths, async () => {
    const previous = await saveCurrent($, paths)
    await vault($, paths, 'activate', {
      Id: target.id,
      ConfigDir: paths.configDir,
    })
    try {
      await writeSignedIn($, paths.globalConfig, target.oauthAccount)
    } catch (error) {
      // Tokens and account facts must agree: put the old sign-in back.
      if (previous) {
        await vault($, paths, 'activate', {
          Id: previous.id,
          ConfigDir: paths.configDir,
        })
      }
      throw error
    }

    return t.switched(target.email)
  })

const openWindow = (
  $: Engine,
  paths: Paths,
  target: SavedAccount,
  cwd: string,
  t: ReturnType<typeof strings>,
) =>
  run($, paths, async () => {
    await writeSignedIn(
      $,
      `${paths.root}\\profiles\\${target.id}\\.claude.json`,
      target.oauthAccount,
    )
    await vault($, paths, 'launch', {
      Id: target.id,
      ConfigDir: paths.configDir,
      Cwd: cwd,
    })

    return t.opened(target.email)
  })

const addAccount = (
  $: Engine,
  paths: Paths,
  t: ReturnType<typeof strings>,
) =>
  run($, paths, async () => {
    await update($, panel, state => ({
      ...state,
      notice: { kind: 'info' as const, text: t.signInOpened },
    }))
    // Signing in against an empty folder leaves the current sign-in untouched.
    const { folder, path } = await vault($, paths, 'login', {}, LOGIN_TIMEOUT_MS)
    if (!folder || !path) throw new Error(t.noAccount)
    const signedIn = await readSignedIn($, `${path}\\.claude.json`)
    if (!signedIn) {
      await vault($, paths, 'discard', { Folder: folder })
      throw new Error(t.noAccount)
    }
    const saved = await toSaved(signedIn, await $.clock.now())
    await vault($, paths, 'adopt', { Id: saved.id, Folder: folder })
    const accounts = await loadIndex($, paths)
    await saveIndex($, paths, [
      ...accounts.filter(account => account.id !== saved.id),
      saved,
    ])

    return t.added(saved.email)
  })

const removeAccount = (
  $: Engine,
  paths: Paths,
  target: SavedAccount,
  t: ReturnType<typeof strings>,
) =>
  run($, paths, async () => {
    await vault($, paths, 'remove', { Id: target.id })
    const accounts = await loadIndex($, paths)
    await saveIndex(
      $,
      paths,
      accounts.filter(account => account.id !== target.id),
    )

    return t.removed(target.email)
  })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'accounts',
      description: 'Show the panel that switches between your Claude accounts',
    })
    await $.command.register({
      name: 'hesap',
      description: 'Claude hesaplari arasinda gecis panelini ac',
    })
    const stored = await $.store.get(LANGUAGE_KEY)
    const setting = await $.settings.read({ key: 'language' })
    const language: Language =
      stored === 'tr' || stored === 'en'
        ? stored
        : /^(tr|turk)/i.test(String(setting ?? ''))
          ? 'tr'
          : 'en'
    const paths = await resolvePaths($)
    await update($, panel, state => ({
      ...state,
      language,
      // A reload may have ended an action that was marked busy.
      busy: false,
      isSupported: paths !== undefined,
    }))
    if (paths) {
      await refresh($, paths).catch(() => undefined)
      void sweepLogins($, paths).catch(() => undefined)
      $.clock.every(REFRESH_MS, () => {
        void refresh($, paths).catch(() => undefined)
        void syncPane($).catch(() => undefined)
      })
    }
    void openPane($).catch(() => undefined)

    return next(e)
  })

  for (const name of ['accounts', 'hesap'] as const) {
    on('command.run', { command: name }, async $ => {
      await openPane($)

      return { text: (await text($)).commandText }
    })
  }

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) {
      await update($, panel, state => ({ ...state, isPanePlaced: false }))
    }

    return result
  })

  // Always in view: stands in for the panel whenever the panel is not shown.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, panel)
    if (!state.isSupported || state.isPanePlaced || e.props.hasSurvey) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)
    const t = strings(state.language)
    const shownId = state.windowAccountId ?? state.activeId
    const email =
      state.accounts.find(account => account.id === shownId)?.email ??
      state.unsavedEmail

    return (
      <Box>
        {email && <Text dimColor>{email} </Text>}
        <Button key="open-panel" label={t.title} onPress={() => openPane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const state = await read($, panel)
    const t = strings(state.language)
    if (!state.isSupported) return <Text>{t.unsupported}</Text>

    const paths = await resolvePaths($)
    if (!paths) return <Text>{t.unsupported}</Text>
    const cwd = await $.session.cwd()
    const isOwnWindow = state.windowAccountId !== undefined

    return (
      <Box flexDirection="column" gap={1}>
        {state.accounts.length === 0 && !state.unsavedEmail && (
          <Text dimColor>{t.none}</Text>
        )}
        {state.unsavedEmail && !isOwnWindow && (
          <Box flexDirection="column">
            <Text bold>{state.unsavedEmail}</Text>
            <Text dimColor>{t.unsaved}</Text>
            <Button
              key="save-current"
              variant="primary"
              onPress={() =>
                run($, paths, async () => {
                  const saved = await saveCurrent($, paths)

                  return saved ? t.saved(saved.email) : undefined
                })
              }
            >
              {t.saveCurrent}
            </Button>
          </Box>
        )}
        {state.accounts.map(account => {
          const isThisWindow = state.windowAccountId === account.id
          const isActive = !isOwnWindow && state.activeId === account.id
          const isConfirming = state.confirmRemoveId === account.id

          return (
            <Box flexDirection="column">
              <Text bold={isActive || isThisWindow}>
                {isActive || isThisWindow ? '● ' : '○ '}
                {account.email}
              </Text>
              {account.organization && (
                <Text dimColor>{account.organization}</Text>
              )}
              {isActive && <Text color="success">{t.active}</Text>}
              {isThisWindow && <Text color="success">{t.thisWindow}</Text>}
              {!state.busy && !isConfirming && (
                <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                  {!isActive && !isOwnWindow && (
                    <Button
                      key={`switch-${account.id}`}
                      variant="primary"
                      onPress={() => switchTo($, paths, account, t)}
                    >
                      {t.switch}
                    </Button>
                  )}
                  {/* One sign-in in two live places would fight over its refresh. */}
                  {!isThisWindow && state.activeId !== account.id && (
                    <Button
                      key={`window-${account.id}`}
                      onPress={() => openWindow($, paths, account, cwd, t)}
                    >
                      {t.newWindow}
                    </Button>
                  )}
                  {!isThisWindow && !isActive && (
                    <Button
                      key={`remove-${account.id}`}
                      dimColor
                      onPress={() =>
                        update($, panel, current => ({
                          ...current,
                          confirmRemoveId: account.id,
                        }))
                      }
                    >
                      {t.remove}
                    </Button>
                  )}
                </Box>
              )}
              {!state.busy && isConfirming && (
                <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                  <Button
                    key={`confirm-${account.id}`}
                    onPress={() => removeAccount($, paths, account, t)}
                  >
                    {t.confirmRemove}
                  </Button>
                  <Button
                    key={`cancel-${account.id}`}
                    onPress={() =>
                      update($, panel, current => ({
                        ...current,
                        confirmRemoveId: undefined,
                      }))
                    }
                  >
                    {t.cancel}
                  </Button>
                </Box>
              )}
            </Box>
          )
        })}
        {state.busy ? (
          <Text dimColor>{t.working}</Text>
        ) : (
          <Button key="add" onPress={() => addAccount($, paths, t)}>
            {t.add}
          </Button>
        )}
        {state.notice && (
          <Text color={state.notice.kind === 'error' ? 'error' : undefined}>
            {state.notice.text}
          </Text>
        )}
        {isOwnWindow && <Text dimColor>{t.windowNote}</Text>}
        {e.surface === 'desktop' && <Text dimColor>{t.desktopNote}</Text>}
        <Button
          key="language"
          plain
          dimColor
          onPress={async () => {
            const language: Language = state.language === 'tr' ? 'en' : 'tr'
            await $.store.set(LANGUAGE_KEY, language)
            await update($, panel, current => ({ ...current, language }))
          }}
        >
          {t.language}
        </Button>
      </Box>
    )
  })
}
