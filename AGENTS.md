# AGENTS.md

Firefox WebExtension (Manifest V2), plain classic scripts — **no build system, no bundler, no package.json, no lint/typecheck in the repo**. Read `README.md` and `ARCHITECTURE.md` first; both are kept current with the code.

**Keep `README.md` and `ARCHITECTURE.md` current whenever you add a new module or feature** (new adapters, matching passes, storage shapes, wiring, user-visible behavior). Do **not** update them for bug fixes unless the fix changes the app's form or function.

## Verify via the external jsdom harnesses

There is no test runner in this repo. Verification is `node` scripts in `/tmp/opencode/jtk-test/` (jsdom), which load repo files **by absolute path** (`/home/ryan/dev/job-app-toolkit/...`). From the README:

```sh
node /tmp/opencode/jtk-test/harness.js          # form-filler: real iCIMS form
node /tmp/opencode/jtk-test/overlap-test.js     # form-filler: word-overlap matching
node /tmp/opencode/jtk-test/site-settings.js    # site-settings: content side (LinkedIn)
node /tmp/opencode/jtk-test/site-settings-bg.js # site-settings: background wiring
node /tmp/opencode/jtk-test/ai-content.js       # form-filler: AI field capture/fill
node /tmp/opencode/jtk-test/ai-bg.js            # form-filler: AI answer flow (background)
node /tmp/opencode/jtk-test/options-ai-entry.js # form-filler: options AI background editor
```

Never "fix" a harness path by copying files into the repo; the harnesses deliberately load the live source.

## Wiring is manual and order-sensitive

Everything is stitched together by `manifest.json` and script load order; there is no import system.

- Content scripts: `core/content.js` **must** be listed before any module content script (it defines `window.jobAppToolkit.content`). `core/content.js` is global (`<all_urls>`); `modules/site-settings/content.js` is LinkedIn-only.
- Background: `core/storage.js` → `core/background.js` → module background scripts (in that order). `storage.js` defines `window.jobAppToolkit.storage`; `background.js` defines the registry.
- Adding a new module requires: new `modules/<id>/` files, registration via `window.jobAppToolkit.registerModule({ id, name, optionsUrl, handleMessage, createContextMenu, quickActions })` in its background script, and new entries in `manifest.json` (background script + content script). `core/content.js` and `core/storage.js` are loaded by the popup/options pages too.

## Conventions that matter

- **Message routing**: `jtk:*` is core-reserved. Module messages must be namespaced `<moduleId>:*` (e.g. `site-settings:setCompanyState`); the router dispatches by prefix. `handleMessage(message, sender, moduleApi())` receives the real `sender` (carries the originating tab/frame) and `moduleApi()` (`getModuleData`, `setModuleData`, `isModuleActive`, `notify`, `lastWebTabId`).
- **Context menus**: background is an event page (`persistent: false`) that can be re-created at any time. Every menu click is dispatched to **every** module, which must no-op unless `info.menuItemId` is its own. Do not rely on cached menu state across wake-ups.
- **Storage**: single `jobAppToolkit` sync key → `{ modules: { "<id>": { active, ...payload } } }`. `setModuleData(id, data)` merges and preserves the `active` flag. Modules default to **active** when unset (content-side `isModuleActive` treats missing as active, so fresh installs work out of the box). Firefox's `storage.sync` quota is a hard 100 KiB and **not raisable by any permission** (`unlimitedStorage` only affects `storage.local`); bulky per-module payloads go in `browser.storage.local` instead — e.g. the form-filler AI background entries (`jtk-form-filler-ai-context`) and API key (`jtk-form-filler-ai-key`).
- **Content scripts**: module content scripts must call `window.jobAppToolkit.content.refreshActive(MODULE_ID)` on load and gate work on `isModuleActive(MODULE_ID)` — they no-op cheaply when a module is toggled off. Toasts come from `core/content.js` via `jtk:showToast`.
- **Form Filler iframes**: the module marks each doc `data-jtk-injected` and walks same-origin iframes via `contentDocument`; there's a force-pass fallback where the top frame walks even marked frames when per-frame messaging finds nothing. Match results are deduped/merged in the background.

## Site Settings specifics

- Adapter pattern: `currentAdapter()` matches on `location.pathname`; new job boards = new adapter (`{ siteId, isTargetPage, findJobCards, companyFromCard }`).
- LinkedIn selectors (`CARD_SELECTORS`, `COMPANY_SELECTORS`) are centralized at the top of `modules/site-settings/content.js` — **this is the first thing to update when LinkedIn reworks its markup** (it does so often).
- Blocks are applied as class **and** inline `display:none !important` because LinkedIn rewrites `className` on re-render; a class-only hide gets silently dropped. Button clicks must stop propagation or they bubble into the card's navigation handler and undo the hide.
- Re-scans run on load, `storage.onChanged`, a 2s poll, and a MutationObserver watching `childList` + `class` attributes.

## Running inside limux

Sessions run inside **limux** (`/home/ryan/dev/limux`, sibling repo), a Ghostty-based Linux terminal that exposes its running instance to agents via a Unix control socket. You can drive the host app — it is **not required**, but it's available:

- **`limux-cli`** is the easiest way in; it auto-resolves the socket from `$LIMUX_SOCKET` (`--socket PATH` to override, global `--json` flag). Subcommands (clap kebab-case): `ping`, `version`, `list-surfaces`, `workspace new-workspace|workspace-count|list-workspaces|select-workspace|close-workspace|current-workspace|rename-workspace|workspace-pin|workspace-set-color|list-panes|focus-pane|toggle-sidebar`, `split split-right|split-down`, `browser open-browser|navigate|browser-back|browser-forward|browser-reload|get-url|js-eval`, `metadata set-status|clear-status|set-progress|clear-progress|log|clear-log|notify-enable|notify-disable|notify-status`, `terminal send|read-screen`, `remote remote-connect|remote-disconnect|remote-reconnect|remote-status`.
- **Command reference**: `limux/docs/commands.md` is the friendly overview for users and agents. The authoritative list is `limux/app/src/socket.rs`; `limux/tests_v2/limux.py` is a reference client. Note the raw socket is a line-based text protocol (`cmd args\n` → `OK payload\n`, length-prefixed `OK+<byte_count>\n<raw>`, or `ERROR msg\n`) and `send`/`navigate`/`js_eval` take the *rest of the line* as their value, so spaces are fine unquoted.
- **Browser panels are WebKitGTK, not Firefox** — you can `open-browser <url>` / `navigate <id> <url>` / `get-url <id>` to view pages and run `js-eval <id> <script>`, but the extension cannot be loaded there. Extension testing still needs real Firefox via `about:debugging`. `js-eval` is **fire-and-forget**: it returns `OK`, not the script's result.
- **D-Bus** mirrors a subset of the socket methods: interface `com.limuxapp.Limux1` at `/com/limuxapp/Limux`.
- For limux's own build/test conventions (`cargo build`, `scripts/run-tests-linux.sh`), see `limux/CLAUDE.md`.

## Loading the add-on

`about:debugging` → Load Temporary Add-on → `manifest.json`. Firefox-only (MV2); no Chrome/MV3 support.
