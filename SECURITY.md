# Security

This mod handles sign-in tokens, so its behaviour is kept small enough to read.

## What it does

- All token handling is in one script, [`scripts/vault.ps1`](scripts/vault.ps1).
  The panel code passes it only account ids and folder paths.
- Saved sign-ins are encrypted with Windows DPAPI (`CurrentUser` scope) in
  `%USERPROFILE%\.claude-accounts\vault\`. Only your Windows user on this
  machine can decrypt them, so they cannot be moved to another computer.
- It makes no network calls, has no dependencies and collects no telemetry.
- Adding an account runs the official `claude auth login`. Your password goes
  only to the official sign-in page.
- `accounts.json` holds non-secret facts such as your email and account ids.

## What it cannot protect against

- **Programs running as your Windows user.** They can ask DPAPI to decrypt the
  vault. Claude Code's own sign-in file is readable by them as well.
- **Plain copies that Claude Code needs.** The active sign-in stays in Claude
  Code's own `.credentials.json`. An account opened in a separate window also
  has a plain copy in `%USERPROFILE%\.claude-accounts\profiles\<id>\`, because
  Claude Code reads that file directly. Removing the account deletes it.
- **An interrupted sign-in.** Adding an account signs in inside a temporary
  folder, which is deleted once the sign-in is encrypted. If that is interrupted,
  the folder is deleted at the first session start after 15 minutes.

## Why the script uses `-ExecutionPolicy Bypass`

Windows blocks local scripts by default. The flag applies to this one run of
this one file and changes no system setting. Please read the script.

## Reporting a problem

Use GitHub's private vulnerability reporting on this repository. Never post a
token, a `.credentials.json` or a vault file in an issue.
