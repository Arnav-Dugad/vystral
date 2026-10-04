# Installing VYSTRAL

1. Download **`Vystral-win-Setup.exe`** from the [latest release](https://github.com/Arnav-Dugad/vystral/releases/latest). The direct link `https://github.com/Arnav-Dugad/vystral/releases/latest/download/Vystral-win-Setup.exe` always gives the newest version.
2. Run it. VYSTRAL installs for your Windows user only, into `%LOCALAPPDATA%\Vystral`, with no administrator prompt. It adds Desktop and Start-menu shortcuts and starts automatically.
3. If **Windows protected your PC** appears: VYSTRAL isn't code-signed yet. Choose **More info → Run anyway**, but only for files downloaded from the official Releases page.

**Requirements:** Windows 10 version 21H2 or newer, or Windows 11, on 64-bit x64. Everything else is bundled. If the Microsoft Edge WebView2 Runtime is missing (rare on Windows 10), the installer adds it.

## Updating

Automatic: VYSTRAL checks GitHub shortly after starting, shows a download progress viewer (title-bar pill or Settings → Updates), and installs on restart. If you don't restart, it installs quietly after you close VYSTRAL. Updates never install while a game is running. Turn checks off in Settings → Updates.

## Portable use

`Vystral-win-Portable.zip` runs from any folder. It doesn't auto-update.

## Uninstalling

Settings → Apps → Installed apps → VYSTRAL → Uninstall. Your library database, notes and history remain in `%LOCALAPPDATA%\VYSTRAL.Data`; delete that folder to remove them too. Uninstalling VYSTRAL never affects your games or store apps.
