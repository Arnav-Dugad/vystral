# Security threat model

## Assets

1. The user's games, saves and store installations. These must never be modified or broken.
2. Store accounts and credentials. VYSTRAL never touches them.
3. The local library database, notes, sessions and media folders.
4. The PC's integrity: no elevation, no arbitrary code execution, no hardware changes.

## Trust boundaries

| Boundary | Untrusted input | Controls |
|---|---|---|
| Web UI → native bridge | Every message (the UI could be compromised by malicious metadata) | Allow-listed methods; typed params with unknown members rejected; ID regex; length and control-character limits; no paths from the UI (native pickers only); 256 KB message cap; source-origin check (`https://app.vystral.example` only) |
| Store manifests & registry | Malformed or hostile VDF/JSON/XML, odd paths | Tolerant parsers that throw only `FormatException`; VDF depth limit; XML with DTD processing disabled; `..` path escapes rejected; read-only registry interface |
| Launch targets | URIs and exe paths from manifests and user launch options | Per-platform URI scheme allow-list; no whitespace or control characters in URIs; AUMID regex; `.exe` only; must be inside the game's install folder (store games); no UNC paths; CreateProcess with an argument list (no shell parsing) |
| Network metadata/artwork | Steam store JSON, images | HTTPS only; 12 MB cap; content-type and magic-byte checks (JPEG/PNG/WebP); atomic writes into a private cache; HTML stripped and entities decoded; rendered as React text (never `innerHTML`) |
| Media folders | User-chosen folders, crafted URLs | Served only via a filtered handler: path normalized and required to stay under an approved root, image/video extensions only, feature off by default |
| Local AI (Ollama) | Model output | The model cannot call anything. Structured output is validated against a whitelist schema. Suggested actions still require a user click through the normal bridge. |
| Steam Web API key | User-provided key | Stored only in Windows Credential Manager (generic credential `VYSTRAL/SteamWebApiKey`), never in SQLite, logs or bridge responses; requests go only to `api.steampowered.com`; stored only after Steam accepts it |
| Trailers | Steam HLS playlists and segments | Filtered proxy: HTTPS Steam video CDN only, the exact appid's folder, fixed file-name patterns, size caps, VYSTRAL-set content types, no redirects, nothing written to disk |
| Live tiles (`https://media.vystral.example/live/{gameId}/{key}.mp4`) | Steam micro-trailer files; crafted proxy paths from a compromised page | The page can only name a game id and a 16-hex key (`^/live/[0-9a-f]{32}/[0-9a-f]{16}\.mp4$`); the upstream URL is never taken from the page but derived natively from the stored, already-validated HLS trailer (same allow-listed HTTPS host, same appid folder, fixed file name `microtrailer.mp4`) and must hash to the requested key. Dedicated client with no redirects and no decompression; 6 MB cap (Content-Length and streamed); body must start with an MP4 `ftyp` box; written atomically into `cache\live` under a VYSTRAL-chosen name (`{gameId}-{key}.mp4`), LRU-capped at 160 MB; served with a fixed `video/mp4` type and `nosniff`. No download in Offline mode, Data saver or while a game runs; nothing served at all while a game runs or with the setting off. The page never hot-links Steam (CSP `media-src` allows only the media host and `blob:`). |
| Other processes (background-app report) | Process names and counters of everything running | Read with one handle-free `NtQuerySystemInformation(SystemProcessInformation)` call every ~30 s of a session: no process is opened, so protected and anti-cheat processes are never touched. Only executable file names (no paths, titles or command lines) and memory/CPU figures are kept; names hidden by the user are filtered on read; `insights.hideBackgroundApp` accepts only a file-name-shaped string (≤ 128 chars, no path characters) |
| GPU driver identity | NVML strings, display-adapter registry values | Read-only NVML (`nvmlSystemGetDriverVersion`, `nvmlDeviceGetName`) or the read-only registry interface; values are trimmed, stripped of control characters and length-capped (64/128) before storage; shown as React text |
| Updates | Release packages | Velopack downloads over HTTPS from the project's GitHub releases and verifies SHA hashes from the release feed before applying. The installer is unsigned for now (see limitations). Updates never apply while a game runs. |
| URI scheme / notification activation | `vystral:` URIs (any app or web page can launch a registered scheme; browsers ask first) and the command line they produce | Navigation only: a URI can open one of seven pages and nothing else; it never launches a game, runs a fix, changes a setting or reads a path. Parsed by hand (no unescaping or normalisation): fixed `vystral://open?…` shape, 512-character cap, printable ASCII only, no percent-escapes, no duplicate or unknown parameters, route name allow-list, `id`/`sessionId` must be 32 lowercase hex, `section` 1–24 lowercase letters, each parameter only on its own route. The registered command is `"<exe>" --uri "%1"`; the process accepts it only when the command line is exactly those two arguments, so quote-injected extras (including `--safe-mode` or Velopack hook switches, which must be the first argument) are ignored. Rejected URIs are logged by length only and treated as a plain launch (bring the window forward). Registry writes are per-user (`HKCU\Software\Classes`) and repaired on start; uninstall removes them only if they still point at that copy. |
| WebView2 | Navigation, popups, downloads, permissions | Navigation outside the app origin is cancelled; new windows, downloads and permission requests are denied; host objects, dev tools, context menus, autofill and password saving are disabled in release; CSP `default-src 'self'` |

## Explicit non-goals (never implemented)

DLL injection, overlays inside game processes, memory reading, DRM or anti-cheat interaction, reading tokens/cookies/passwords, private or reverse-engineered APIs, overclocking/undervolting, fan or power-limit changes, killing Windows services, disabling security features, and running elevated (the app manifest is `asInvoker`).

**The one elevated action:** if the user turns on frame-rate capture, VYSTRAL can, on an explicit button press, add the signed-in account to Windows' *Performance Log Users* group (`net localgroup … /add`, one UAC prompt). That group is what Windows requires for ETW frame tracing. VYSTRAL itself never runs elevated, and PresentMon is downloaded only on request and SHA-256-verified against a pinned hash before every run.

## Residual risks

- **Unsigned binaries.** SmartScreen warns, and users must trust the GitHub release page. Mitigation: download only from Releases. Adding code signing is on the roadmap.
- **Update channel trust.** Updates trust the GitHub repository. If the repository or the owner's token were compromised, a malicious update could be published. Mitigations: repository two-factor authentication; releases are built only by CI from tags.
- **Process detection** reads image paths of same-user processes. This is read-only, but anti-cheat systems could theoretically flag handle opens. VYSTRAL uses the least-privileged right (`PROCESS_QUERY_LIMITED_INFORMATION`) and closes handles immediately.
- **URI scheme nuisance.** A web page or another program can open VYSTRAL, or bring it forward on one of its own pages, through `vystral:` links. That is the whole effect (no data leaves, nothing runs), and browsers ask before opening external apps.
- **Launch options** typed by the user are passed to the game as-is (validated for length and control characters). A user can still pass harmful options to their own game.
