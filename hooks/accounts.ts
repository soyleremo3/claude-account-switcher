import type { EngineInterface } from 'claude-code'

import type { SavedAccount } from '../types'

type Engine = EngineInterface

export type Paths = {
  /** Where this mod keeps its files. */
  root: string
  /** The folder holding the shared sign-in file. */
  configDir: string
  /** The file holding the signed-in account's non-secret facts. */
  globalConfig: string
  /** Set when this window was opened with its own account. */
  windowAccountId?: string
}

const ID_LENGTH = 16

/** A stable, path-safe id; one person in two organizations is two accounts. */
export async function accountId(oauthAccount: Record<string, unknown>) {
  const person = oauthAccount.accountUuid ?? oauthAccount.emailAddress
  // Without this, two different accounts could share one encrypted slot.
  if (typeof person !== 'string' || person === '') {
    throw new Error('The sign-in record names no account.')
  }
  const identity = `${person}/${String(oauthAccount.organizationUuid ?? '')}`
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(identity),
  )
  const hex = [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')

  return hex.slice(0, ID_LENGTH)
}

export async function resolvePaths($: Engine): Promise<Paths | undefined> {
  const home = await $.env.get('USERPROFILE')
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  if (!isWindows || !home) return undefined

  const root = `${home}\\.claude-accounts`
  const custom = await $.env.get('CLAUDE_CONFIG_DIR')
  const profiles = `${root}\\profiles\\`
  const isOwnWindow = custom?.toLowerCase().startsWith(profiles.toLowerCase())
  const windowAccountId = isOwnWindow
    ? custom?.slice(profiles.length).replace(/\\+$/, '')
    : undefined
  const configDir = custom && !isOwnWindow ? custom : `${home}\\.claude`
  const globalConfig =
    custom && !isOwnWindow ? `${custom}\\.claude.json` : `${home}\\.claude.json`

  return { root, configDir, globalConfig, windowAccountId }
}

async function readJson($: Engine, path: string) {
  return JSON.parse(await $.fs.read(path)) as Record<string, unknown>
}

/** The signed-in account's facts; never holds a token. */
export async function readSignedIn($: Engine, path: string) {
  if (!(await $.fs.exists(path))) return undefined
  const account = (await readJson($, path)).oauthAccount

  return account && typeof account === 'object'
    ? (account as Record<string, unknown>)
    : undefined
}

/** Changes only the account key, leaving every other setting as it stands. */
export async function writeSignedIn(
  $: Engine,
  path: string,
  oauthAccount: Record<string, unknown>,
) {
  const config = (await $.fs.exists(path)) ? await readJson($, path) : {}
  await $.fs.write(path, JSON.stringify({ ...config, oauthAccount }, null, 2))
}

export async function toSaved(
  oauthAccount: Record<string, unknown>,
  addedAt: number,
): Promise<SavedAccount> {
  return {
    id: await accountId(oauthAccount),
    email: String(oauthAccount.emailAddress ?? 'unknown'),
    organization:
      typeof oauthAccount.organizationName === 'string'
        ? oauthAccount.organizationName
        : undefined,
    oauthAccount,
    addedAt,
  }
}

export async function loadIndex($: Engine, paths: Paths) {
  const path = `${paths.root}\\accounts.json`
  if (!(await $.fs.exists(path))) return []
  const parsed = await readJson($, path)

  return Array.isArray(parsed.accounts)
    ? (parsed.accounts as SavedAccount[])
    : []
}

export async function saveIndex(
  $: Engine,
  paths: Paths,
  accounts: SavedAccount[],
) {
  await $.fs.write(
    `${paths.root}\\accounts.json`,
    JSON.stringify({ accounts }, null, 2),
  )
}

type VaultResult = { folder?: string; path?: string }

/** Runs the auditable vault script. Only ids and paths cross, never a token. */
export async function vault(
  $: Engine,
  paths: Paths,
  action: string,
  args: Record<string, string> = {},
  timeoutMs = 30_000,
): Promise<VaultResult> {
  const systemRoot = (await $.env.get('SystemRoot')) ?? 'C:\\Windows'
  const argv = [
    `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    `${$.plugin.root}\\scripts\\vault.ps1`,
    '-Action',
    action,
    '-Root',
    paths.root,
    ...Object.entries(args).flatMap(([name, value]) => [`-${name}`, value]),
  ]
  const { stdout, stderr, exitCode } = await $.process.run(argv, { timeoutMs })
  const line = stdout.trim().split('\n').pop() ?? ''
  let answer: { ok?: boolean; error?: string } & VaultResult = {}
  try {
    answer = JSON.parse(line)
  } catch {
    throw new Error(stderr.trim().split('\n')[0] || `vault exited ${exitCode}`)
  }
  if (!answer.ok) throw new Error(answer.error ?? `vault exited ${exitCode}`)

  return answer
}
