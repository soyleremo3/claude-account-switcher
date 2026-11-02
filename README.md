# Claude Code Account Switcher

A side panel for Claude Code that switches between your own Claude accounts.
Sign in to each account once, then press a button to change account.

> **Unofficial.** This is a community project, not made or endorsed by Anthropic.
> It relies on Claude Code's early-access mod API and its local sign-in files,
> which can change in any release.

## Features

- **Switch all windows:** moves every open window to the chosen account.
- **Open in new window:** starts a new window on another account, while the
  current window stays where it is.
- **Add account:** signs in with the official `claude auth login`, without
  disturbing the account you are using.
- Saved sign-ins are encrypted with Windows DPAPI. There are no network calls,
  dependencies or telemetry. See [SECURITY.md](SECURITY.md).
- English and Turkish interface.

## Requirements

- Windows 10 or 11. macOS and Linux are not supported yet.
- A Claude Code version with mods (developed on 2.1.316).

## Install

At the prompt of a terminal session:

```
/plugin install account-switcher --marketplace soyleremo3/claude-account-switcher
```

From a shell:

```
claude plugin install account-switcher --marketplace soyleremo3/claude-account-switcher
```

In the desktop app: click **+** next to the prompt box, then **Plugins**,
**Add marketplace** with `soyleremo3/claude-account-switcher`, then **Add plugin**.

## Use

1. The panel opens by itself in every session. If it does not fit, a short line
   above the prompt shows your account with a button that opens the panel. You
   can also run `/accounts` (or `/hesap`).
2. Press **Save current account**.
3. Press **+ Add account** for each other account and finish the sign-in.
4. Press **Switch all windows** or **Open in new window** on any account.

The panel docks on the right in Claude Code's fullscreen terminal layout on a
wide window. Otherwise it appears above the prompt.

## Good to know

- An open window cannot change account alone, because all ordinary windows share
  one sign-in file. A separate account therefore opens in a new window.
- A window opened this way has its own folder under `.claude-accounts\profiles`.
  Conversation history, plugins, skills, commands and agents are shared with
  your main setup. Settings are copied when the window opens.
- Don't use one account in the main windows and a separate window at once. Both
  would try to renew the same sign-in, and you may have to sign in again.
- A message already being sent while you switch may fail. Send it again.
- The desktop app may keep its own sign-in, so a switch may not reach it.

## Account rules

Use this only with accounts that are your own, and never to share an account
between people. This mod never switches on its own to avoid usage limits. This
is not legal advice: read Anthropic's current terms yourself. You are
responsible for how you use your accounts.

## Development

```
powershell -NoProfile -ExecutionPolicy Bypass -File tests\vault.test.ps1
claude plugin test .
claude plugin validate .
```

The vault tests use throwaway folders and a fake sign-in file.

## Türkçe

Kendi Claude hesapların arasında geçiş yapan, resmi olmayan bir yan paneldir.
Yalnızca Windows'ta çalışır. Her sohbette kendiliğinden açılır; sığmazsa giriş
kutusunun üstündeki düğmeyi veya `/hesap` komutunu kullan. **Şu anki hesabı kaydet** ve
**+ Hesap ekle** ile hesaplarını gir, sonra **Tüm pencerelerde geç** veya
**Yeni pencerede aç** düğmesine bas. Girişler Windows şifrelemesiyle saklanır,
internete hiçbir şey gönderilmez. Yalnızca kendi hesaplarınla kullan, hesap paylaşma.

## License

[MIT](LICENSE)
