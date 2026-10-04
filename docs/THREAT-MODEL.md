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
| Updates | Release packages | Velopack downloads over HTTPS from the project's GitHub releases and verifies SHA hashes from the release feed before applying. The installer is unsigned for now (see limitations). Updates never apply while a game runs. |
| WebView2 | Navigation, popups, downloads, permissions | Navigation outside the app origin is cancelled; new windows, downloads and permission requests are denied; host objects, dev tools, context menus, autofill and password saving are disabled in release; CSP `default-src 'self'` |

## Explicit non-goals (never implemented)

DLL injection, overlays inside game processes, memory reading, DRM or anti-cheat interaction, reading tokens/cookies/passwords, private or reverse-engineered APIs, overclocking/undervolting, fan or power-limit changes, killing Windows services, disabling security features, and administrator elevation (the app manifest is `asInvoker`).

## Residual risks

- **Unsigned binaries.** SmartScreen warns, and users must trust the GitHub release page. Mitigation: download only from Releases. Adding code signing is on the roadmap.
- **Update channel trust.** Updates trust the GitHub repository. If the repository or the owner's token were compromised, a malicious update could be published. Mitigations: repository two-factor authentication; releases are built only by CI from tags.
- **Process detection** reads image paths of same-user processes. This is read-only, but anti-cheat systems could theoretically flag handle opens. VYSTRAL uses the least-privileged right (`PROCESS_QUERY_LIMITED_INFORMATION`) and closes handles immediately.
- **Launch options** typed by the user are passed to the game as-is (validated for length and control characters). A user can still pass harmful options to their own game.
