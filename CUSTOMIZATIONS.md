# John's customizations (fork-specifiek)

Dit document beschrijft de aanpassingen die John (met Claude) op deze OpenWhispr-fork
heeft gemaakt bovenop upstream, plus de operationele valkuilen bij bouwen/installeren.
`CLAUDE.md` is de upstream technische referentie; dit bestand is fork-specifiek.

## Eigen feature-branches

- `feat/local-live-transcription` — offline live preview + correctie op de achtergrond.
- `feat/voice-screenshot-annotation` — stem + screenshot + drag-annotatie de chat in.
  Bevat ook (commit `be6f780a`) de twee features hieronder.

## 1. Harde correctie-laag (deterministische find/replace)

**Probleem:** de leer-van-edit sloeg alleen het gecorrigeerde wóórd op als Whisper-bias
(probabilistisch). De misheard→correct kennis werd weggegooid, dus dezelfde mishoring
kwam terug.

**Oplossing:** de wrong→right paren worden bewaard en gegarandeerd toegepast.

- `src/utils/correctionLearner.js`
  - `extractCorrectionPairs()` — geeft `{from, to}` paren (i.p.v. alleen `to`).
  - `extractCorrections()` — afgeleid hiervan (woord-only, voor de bestaande bias).
  - `applyReplacements(text, replacements)` — pure functie, hele woorden,
    hoofdletterongevoelig, Unicode-grenzen, idempotent.
- `src/helpers/database.js` — tabel `correction_replacements (heard UNIQUE, replacement)`
  met `getReplacements()`, `addReplacements(pairs)`, `removeReplacementsByValue()`.
- `src/helpers/ipcHandlers.js` — leert paren bij elke edit (`_processCorrections`),
  past ze toe bij `paste-text` én `db-save-transcription` via `_applyReplacements()`
  (in-process cache, geïnvalideerd bij leren/undo). Undo verwijdert ook de regel.

**Bekende beperking:** een mishoring van twee woorden naar één leert het losse woord
(bv. "company kick" → leert `kick`→`CompanyKick`). Raakt alleen losse "kick", niet
"kickboks". Undo vangt uitzonderingen op.

## 2. Type-fallback (macOS) voor apps die Cmd+V slikken

**Probleem:** sommige apps (o.a. **Claude desktop**) slikken de gesimuleerde Cmd+V stil:
geen fout, maar de tekst landt niet.

**Oplossing:** `src/helpers/clipboard.js`
- `typeTextMacOS(text)` — typt tekst rechtstreeks via System Events keystroke
  (newlines → Return, lange regels gechunkt, AppleScript-escaping). Synthetiseert
  echte key-events die Chromium-apps niet negeren.
- In `pasteText` (macOS): valt automatisch terug op typen als Cmd+V twee keer faalt.
- Force-type (typt altijd i.p.v. plakken): zet `options.forceType` of de env-var
  `OPENWHISPR_FORCE_TYPE=1`. Nodig voor de stille-slik-apps, want daar faalt Cmd+V
  niet zichtbaar en springt de auto-fallback niet aan.

**Let op:** force-type is globaal — ook apps waar plakken werkt (Cursor) typen dan,
iets trager. Per-app maken is een mogelijke vervolgstap. Secure Input (wachtwoordvelden)
blokkeert ook typen, daar is niets aan te doen.

## Hotkeys (John's opzet)

Persistente waarden in `~/Library/Application Support/open-whispr/.env`
(env-keys `DICTATION_KEY`, `SCREENSHOT_KEY`, `DRAG_KEY`):

| Functie | Toets | Env-key |
|---|---|---|
| Opnemen / dicteren | rechter Command | `DICTATION_KEY=RightCommand` |
| Printscreen (region capture naar tray) | Cmd + Option + 2 | `SCREENSHOT_KEY=CommandOrControl+Alt+2` |
| Screenshot + pijlen (freeze + drag-annotatie) | Cmd + Option + 1 | `DRAG_KEY=CommandOrControl+Alt+1` |

**Waarom niet rechter-Option-combinaties (oorspronkelijke wens):** de native laag
ondersteunt alleen *losse* rechter-modifiers (zoals `RightCommand` voor opnemen), geen
combinaties met een rechter-modifier. De screenshot/drag-sloten draaien op standaard
Electron-accelerators, die geen links/rechts-onderscheid kennen. En `Option+pijl` /
`Cmd+Option+pijl` zijn al door macOS/browsers bezet (woord-navigatie, tab-wisselen),
dus die zijn vermeden. Vandaar Option + cijfer.

Aanpassen kan in-app via Instellingen → hotkeys (schrijft dezelfde env-keys en
registreert live), of door bovenstaande regels in `.env` te zetten en te herstarten.

## Operationele valkuilen (hard geleerd)

- **Bron vs gebouwde app.** De dagelijkse app is `/Applications/OpenWhispr.app`
  (gebruikt `app.asar`). Code-wijzigingen draaien daar pas na een nieuwe build.
  `npm run dev` test de bron direct; `npm run pack` maakt een unsigned build in
  `dist/mac-arm64/OpenWhispr.app`.
- **Toegankelijkheidsrechten gelden per binary.**
  - `npm run dev` draait als "**Electron**" (`node_modules/electron/.../Electron.app`),
    dus die moet apart in Systeeminstellingen → Toegankelijkheid aan.
  - Een nieuwe gebouwde app heeft een nieuwe handtekening: oude toegankelijkheids-entry
    verversen (min-knop, opnieuw toevoegen), anders faalt plakken stil.
- **Ad-hoc build + Gatekeeper.** `npm run pack` is unsigned (ad-hoc). Eerste start
  mogelijk via rechtsklik → Open. Quarantine-vlag verwijderen: `xattr -dr com.apple.quarantine`.
- **GUI starten vanuit een headless shell kan niet.** Claude Code kan de app niet
  starten (geen GUI-sessie): hij sluit meteen af op de single-instance-lock (`main.js`
  rond regel 215, `app.exit(0)`, geen log). John moet zelf starten via Spotlight/Finder.
- **Installeren = back-up eerst.** Oude app hernoemd naar `/Applications/OpenWhispr.app.old`
  vóór `ditto` van de nieuwe. Rollback = `.old` terugzetten.
- **`OPENWHISPR_FORCE_TYPE` in `.env`.** Staat in `~/Library/Application Support/open-whispr/.env`.
  Risico: de app kan `.env` herschrijven bij een settings-wijziging (`saveAllKeysToEnvFile`)
  en de regel droppen. Stopt force-type ineens → regel opnieuw toevoegen of als echte
  setting verankeren.
