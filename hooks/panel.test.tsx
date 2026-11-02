import { expect, mock, test } from 'claude-code/testing'

import * as accounts from './accounts'

const PANE = {
  plugin: 'account-switcher',
  component: 'Pane',
  requestId: 'accounts',
  props: {
    title: 'Accounts',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode'] as const

const ACCOUNT_A = {
  accountUuid: 'a',
  organizationUuid: 'org-a',
  emailAddress: 'a@example.com',
}
const ACCOUNT_B = {
  accountUuid: 'b',
  organizationUuid: 'org-b',
  emailAddress: 'b@example.com',
}
const HOME = 'C:\\Users\\Test'
const GLOBAL = `${HOME}\\.claude.json`
const INDEX = `${HOME}\\.claude-accounts\\accounts.json`

/** A fake machine: files in memory, and a record of each vault call. */
const machine = (
  on: any,
  files: Record<string, string>,
  failingAction?: string,
  isNarrow = false,
) => {
  const vaultCalls: string[][] = []
  on('fs.read', (_: unknown, e: { path: string }) => {
    const text = files[e.path]
    if (text === undefined) throw new Error('missing ' + e.path)

    return { value: text }
  })
  on('fs.exists', (_: unknown, e: { path: string }) => ({
    value: e.path in files,
  }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    files[e.path] = e.text

    return { value: undefined }
  })
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    vaultCalls.push([...e.argv])
    const isFailing = failingAction && e.argv.includes(failingAction)

    return {
      value: {
        exitCode: isFailing ? 1 : 0,
        stdout: isFailing
          ? '{"ok":false,"error":"This account has no saved sign-in."}'
          : '{"ok":true}',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('command.register', () => ({ value: {} }))
  on('ui.open', () =>
    isNarrow
      ? { value: { isPlaced: false, reason: 'narrow' } }
      : { value: { isPlaced: true } },
  )
  on('ui.panes', () => ({ value: [] }))
  on('fs.list', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:\\work' }))
  on('settings.read', () => ({ value: {} }))

  return vaultCalls
}

const start = async ($: any, on: any) => {
  mock.env(on, { USERPROFILE: HOME, OS: 'Windows_NT', SystemRoot: 'C:\\Windows' })
  mock.store(on)
  mock.clock(on)
  await $.session.start({ cwd: 'C:\\work', surface: 'terminal', isInteractive: true })
}

const savedIndex = async () =>
  JSON.stringify({
    accounts: [
      await accounts.toSaved(ACCOUNT_A, 1),
      await accounts.toSaved(ACCOUNT_B, 2),
    ],
  })

test('a saved account switches: current saved first, then activated', async ($, on) => {
  const files = {
    [GLOBAL]: JSON.stringify({ theme: 'dark', oauthAccount: ACCOUNT_A }),
    [INDEX]: await savedIndex(),
  }
  const calls = machine(on, files)
  await start($, on)
  const targetId = await accounts.accountId(ACCOUNT_B)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /a@example.com/ }))?.text).toContain('a@example.com')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `switch-${targetId}` })
  const actions = calls.map(argv => argv[argv.indexOf('-Action') + 1])
  expect(actions).toEqual(['capture', 'activate'])
  const written = JSON.parse(files[GLOBAL]!)
  expect(written.oauthAccount.emailAddress).toBe('b@example.com')
  expect(written.theme).toBe('dark')
  await ui.unmount()
})

test('no argument passed to the vault can carry a token', async ($, on) => {
  const files = {
    [GLOBAL]: JSON.stringify({ oauthAccount: ACCOUNT_A }),
    [INDEX]: await savedIndex(),
  }
  const calls = machine(on, files)
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `switch-${await accounts.accountId(ACCOUNT_B)}` })
  for (const argv of calls) {
    expect(argv.join(' ')).not.toMatch(/token|sk-ant/i)
    expect(argv[0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  }
  await ui.unmount()
})

test('an unsaved sign-in offers to be saved', async ($, on) => {
  const files = { [GLOBAL]: JSON.stringify({ oauthAccount: ACCOUNT_A }) }
  const calls = machine(on, files)
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'save-current' })
  expect(calls.length).toBe(1)
  expect(JSON.parse(files[INDEX]!).accounts[0].email).toBe('a@example.com')
  expect(files[INDEX]).not.toMatch(/accessToken|refreshToken/)
  await ui.unmount()
})

test('removing asks first and never offers to remove the active account', async ($, on) => {
  const files = {
    [GLOBAL]: JSON.stringify({ oauthAccount: ACCOUNT_A }),
    [INDEX]: await savedIndex(),
  }
  const calls = machine(on, files)
  await start($, on)
  const idA = await accounts.accountId(ACCOUNT_A)
  const idB = await accounts.accountId(ACCOUNT_B)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: `remove-${idA}` })).toBeUndefined()
  await ui.press({ key: `remove-${idB}` })
  expect(calls.length).toBe(0)
  await ui.press({ key: `confirm-${idB}` })
  expect(JSON.parse(files[INDEX]!).accounts.length).toBe(1)
  await ui.unmount()
})

test('a failed activation leaves the account file unchanged', async ($, on) => {
  const original = JSON.stringify({ oauthAccount: ACCOUNT_A })
  const files = { [GLOBAL]: original, [INDEX]: await savedIndex() }
  machine(on, files, 'activate')
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `switch-${await accounts.accountId(ACCOUNT_B)}` })
  expect(files[GLOBAL]).toBe(original)
  expect((await ui.find({ type: 'Text', text: /no saved sign-in/ }))?.text).toContain('Failed')
  await ui.unmount()
})

test('a record naming no account is never given an encrypted slot', async ($, on) => {
  const files = { [GLOBAL]: JSON.stringify({ oauthAccount: { theme: 'x' } }) }
  const calls = machine(on, files)
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'save-current' })).toBeUndefined()
  expect(calls.length).toBe(0)
  await ui.unmount()
})

test('the active account offers no second live window', async ($, on) => {
  const files = {
    [GLOBAL]: JSON.stringify({ oauthAccount: ACCOUNT_A }),
    [INDEX]: await savedIndex(),
  }
  machine(on, files)
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: `window-${await accounts.accountId(ACCOUNT_A)}` })).toBeUndefined()
  expect(await ui.find({ key: `window-${await accounts.accountId(ACCOUNT_B)}` })).toBeDefined()
  await ui.unmount()
})

const BAND = {
  plugin: 'account-switcher',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, bodyColumns: 80 },
} as const

test('a window too narrow for the panel still shows the account, on every surface', async ($, on) => {
  const files = {
    [GLOBAL]: JSON.stringify({ oauthAccount: ACCOUNT_A }),
    [INDEX]: await savedIndex(),
  }
  machine(on, files, undefined, true)
  await start($, on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /a@example.com/ }))?.text).toContain('a@example.com')
    expect(await ui.find({ key: 'open-panel' })).toBeDefined()
    await ui.unmount()
  }
})

test('the band steps aside once the panel is showing', async ($, on) => {
  const files = { [GLOBAL]: JSON.stringify({ oauthAccount: ACCOUNT_A }) }
  machine(on, files)
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  await start($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // The opening at session start is not awaited, so it may not have landed yet.
  if (await ui.find({ key: 'open-panel' })) await ui.press({ key: 'open-panel' })
  expect(await ui.find({ key: 'open-panel' })).toBeUndefined()
  await ui.unmount()
})

test('other systems get a plain notice and no vault calls', async ($, on) => {
  const calls = machine(on, {})
  mock.env(on, { HOME: '/home/test' })
  mock.store(on)
  mock.clock(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Windows only/ }))?.text).toContain('Windows')
  expect(calls.length).toBe(0)
  await ui.unmount()
})
