# Job App Toolkit

A Firefox WebExtension (Manifest V2) for job application workflows. Ships **Form Filler** and **Site Settings**, with the architecture in place for more.

## Form Filler

Save form fields to named profiles and autofill job application forms. Built for the hostile reality of job portals: same-origin iframes, dynamic fields, required-field asterisks, and verbose labels like "LinkedIn* This question is required".

### Features

- **Profiles** — save fields into named profiles and switch between them (e.g. one per job board).
- **Fill page** — fills every field it can from the active profile, never overwriting data already present.
- **Per-field buttons** — on whitelisted sites, every fillable field gets an in-page save (floppy-disk) button to add the field to the profile and an up-arrow button to fill it from the profile, styled like Site Settings'. The up-arrow button fills the field from the profile even when it already has a value. Buttons render in the top document **and** in same-origin form iframes the content script never reached, so portal forms get them even when Firefox skips frame injection.
- **Button sites** — the whitelist of domains that get per-field buttons is managed on the options page; filling a page from the popup, options, or context menu auto-adds that domain. Each entry also covers its subdomains (so `acme.example` covers `jobs.acme.example`).
- **Add current field** — popup quick action that captures the focused field's name and value.
- **Add all fields** — collects every filled-out field on the page in one go.
- **Context menu** — right-click any form page for *Add all fields to profile* and *Fill page from profile*; the per-field actions live in the in-page buttons.
- **Options page search** — filter saved fields with a percentage-scored match, highlighting green by match quality.
- **AI answers** — right-click a text field and choose *Form Filler ▸ Answer with AI*: the field's label becomes the question, your saved experience/project entries become the background, and a model writes an answer that respects the field's character limit and single-line/multiline nature, then fills it in (overwriting). Each answer is self-checked — deterministic rules, then a strict LLM judge — with one automatic corrective retry, and a spinner sits on the field while the AI works. Works with any OpenAI-compatible endpoint — OpenAI, Groq, Ollama, LM Studio, and more — configured on the options page; the API key and your background entries are stored locally and never synced, and the agent's instructions (tone/format rules) are editable on the options page with a reset-to-default.

### How matching works

Fields are matched against the profile in three passes:

1. **Exact** — normalized identity equals a field candidate.
2. **Contains** — one string is a substring of the other.
3. **Word overlap** — the shorter string's significant words (≥3 chars, stop words dropped) all appear in the longer one, so "personal website portfolio" matches "website or portfolio" while "legal first name" does **not** match "legal last name".

Normalization lowercases and strips anything that isn't a letter or digit, so required-field asterisks, dots, underscores and hyphens never interfere. Real element `name`/`id` attributes are saved verbatim; title-derived names are cleaned before storing.

### iframe handling

Job portals render forms in (same-origin) iframes that Firefox does not always inject content scripts into. The module:

- Marks each document the content script runs in (`data-jtk-injected`).
- Walks same-origin iframes directly via `contentDocument`, skipping already-marked frames.
- Falls back to a **force pass**: when per-frame messaging finds nothing, the background asks the top frame to walk even marked iframes.
- Renders the per-field buttons into this document **and** every unmarked same-origin form iframe (a frame with its own script renders its own buttons); a 2-second re-scan poll catches form iframes that appear after the initial scan.

### AI answers

Right-click a text field on any form and choose **Form Filler ▸ Answer with AI**. The module captures the field — its label (or name/id) becomes the question, its `maxlength` a hard limit — builds a prompt from the **AI background** entries on the options page (one per experience or project) and sends it to an OpenAI-compatible `chat/completions` endpoint. A small spinner sits at the top-left of the field while the AI works. Before filling, the answer is self-checked — first against the field's constraints (empty, over `maxlength`, newlines in a single-line field), then by a strict LLM judge — and a failed check triggers one corrective retry that feeds the critique back to the model; a judge error never blocks a usable answer. Each call is capped at 60 seconds and the whole flow at 90, so a dead endpoint can't leave the spinner hanging: you get a clear "AI answer timed out" toast instead. The answer is truncated to fit the field and filled in, overwriting whatever was there; single-line inputs are asked for a short, one-sentence answer, and the page title is passed as weak context so answers can be tailored to the company.

Endpoint and model are configured on the options page and sync across devices; the AI agent's instructions — the tone and format rules it follows when answering — are editable there too, and blanking them restores the built-in default. The API key and the AI background entries are stored in `browser.storage.local` and never synced — Firefox's `storage.sync` quota is a hard 100 KiB that bulky entry text would blow through (and it cannot be raised by any permission).

### Storage

Single `jobAppToolkit` key in `browser.storage.sync` → `{ modules: { "form-filler": { active, profiles, activeProfile, whitelist, aiEndpoint, aiModel, aiInstructions } } }`. `whitelist` is the array of hostnames (lowercase, no `www.`) that show per-field buttons; an entry matches its exact hostname or any of its subdomains (never a bare TLD). `aiEndpoint`/`aiModel` configure the AI call; `aiInstructions` is the editable instruction block sent as the system prompt (blank falls back to the built-in default). The AI background entries (`aiContext`, the array of `{ title, body }`) and the API key are **not** in sync storage — they live in `browser.storage.local` under `jtk-form-filler-ai-context` and `jtk-form-filler-ai-key`, because entry text is bulky and the sync quota is a fixed 100 KiB that no permission can raise. A legacy `aiContext` still sitting in module data is migrated to local on the next options-page load, and its stale sync copy is dropped so it stops occupying the quota.

## Site Settings

Per-site company controls for job search listings. Ships a LinkedIn adapter that adds two buttons — `★` highlight and `⊘` block — to each company name on `/jobs/search` results.

### Features

- **Block** — hides every posting from a company. Applied as both a class and an inline `display:none !important`, so the hide survives LinkedIn's SPA re-renders (React rewrites `className` on card nodes, which would silently drop a class-only hide).
- **Highlight** — tints matching postings amber for quick scanning.
- **Mutually exclusive** — blocking a company clears its highlight and vice-versa.
- **Title keywords** — a per-site keyword list; any posting whose title contains one of the keywords is hidden like a blocked company (matching is case/punctuation-insensitive substring matching on the job title).
- **Filter button** — every job title gets a small funnel button (styled like the block/highlight buttons) that opens an in-page prompt prefilled with that posting's title; confirming adds the keyword to the filter list.
- **Hide applied** — an options toggle that hides postings LinkedIn marks as already applied to. Detection uses centralized applied-markers selectors plus a guarded short-badge text fallback, so titles/companies like "Applied Scientist" or "Applied Materials" never trigger it.
- **Glassdoor ratings** — an options toggle (off by default) that adds a small `★ 4.4` badge beside each company name. The badge shows the company's overall Glassdoor rating with the review count on hover; clicking it opens the company's Glassdoor page in a new tab. Ratings are fetched in the background, cached aggressively (90 days on success, 7 days on failure), and silently skip hidden cards. A failed fetch shows a `?` badge instead — click it to retry.
- **Undo toast** — blocking raises a toast with an Undo button; tapping it unblocks and restores the card immediately.
- **Options page** — global on/off toggle, Blocked and Highlighted company lists, the Hidden title keywords list, a Hide-applied switch, and the Show Glassdoor ratings toggle.
- **Sync + live** — per-site lists and the Glassdoor toggle live under `sites.linkedin` in sync storage; the rating cache lives in `browser.storage.local` and changes apply to all open tabs instantly via `storage.onChanged`.

### How it works

- **Adapter pattern** — `currentAdapter()` matches the page (LinkedIn: `location.pathname` starts with `/jobs/search`) and exposes `findJobCards()` / `companyFromCard()`; adding a site means adding another adapter.
- **Scan + observe** — cards are rescanned on load, storage change, a 2s poll, and DOM mutations (`childList` *and* `class` attribute changes, so re-renders re-apply within ~150ms).
- **Click safety** — LinkedIn job cards are fully clickable, so button clicks call `preventDefault()`/`stopPropagation()` and the buttons are raised with `z-index`; otherwise clicking `⊘` (or the title filter funnel) bubbles into the card's own navigation handler and the hide is undone. The filter prompt is an overlay on `document.body`, outside any card, so its events never reach the card handlers. The Glassdoor badge uses the same z-index + stop-propagation pattern and opens the company page in a new tab on click.
- **Glassdoor rating pipeline** — when the toggle is on, the content script debounces (250 ms) the unique on-screen company names and sends one `site-settings:glassdoor:getRatings` batch to the background. The background resolves each company against `api.glassdoor.com` (the API host is not behind Cloudflare — no cookie, no cold-start, no glassdoor tab required) via the typeahead → BFF → Overview-HTML pipeline, throttled (≥ 2 s gap, 15 per session) and cached (90 d success, 7 d failure). As each fetch completes, the background broadcasts `site-settings:glassdoor:updated` and the badge appears in-flow. A failed or zero-reviews result renders a `?` badge; clicking it sends `site-settings:glassdoor:retryRating` and the badge swaps to a spinner until the next broadcast resolves it. Cards that are already hidden (blocked company, title keyword, or hide-applied) are skipped entirely. Toggle off = zero requests and no badges.

### Storage

`{ modules: { "site-settings": { active, sites: { linkedin: { blockedCompanies: [], highlightedCompanies: [], titleBlockedKeywords: [], hideApplied: false, showGlassdoorRatings: false } } } } }` plus `browser.storage.local` key `jtk-site-settings-glassdoor` → `{ [normalizedName]: { ok: true, rating, count, countText, pageUrl, employerId, schemaVersion, fetchedAt } | { ok: false, reason: "blocked" | "fetch_error" | "no_match" | "parse_error" | "no_reviews", schemaVersion, fetchedAt } }`. Companies and keywords are stored verbatim and matched case/punctuation-insensitively; blocked and highlighted are mutually exclusive per company, the title keyword list is an independent filter (a match hides the card regardless of company state), `hideApplied` is a per-site on/off that hides applied-marked cards like a block, and `showGlassdoorRatings` (default `false`) gates the optional Glassdoor rating badge. The rating cache is keyed by normalized company name and lives in `storage.local` (the sync quota is a fixed 100 KiB). The `count` field is the K/M-abbreviated review count (e.g. `"70.7K"`); `countText` is `count + " reviews"`. `schemaVersion` lets future fetcher changes evict stale entries automatically.

## Architecture

- `core/` — framework: storage, background router, UI helpers, popup, and the shared content runtime.
- `core/content.js` — content-side runtime (module-active cache, toast with optional action button) exposed as `window.jobAppToolkit.content`. Must be listed **before** module content scripts in `manifest.json`.
- `modules/<id>/` — self-contained modules registered via `window.jobAppToolkit.registerModule(...)`. Messages are namespaced (`form-filler:*`, `site-settings:*`), and context-menu items are dispatched to every module, which filters its own.
- `manifest.json` — lists background scripts and content scripts; all module files are wired in here.

## Roadmap

Ideas discussed but not yet built:

- **Application tracking** — track applications and their statuses (core module, beyond autofill).
- **Better field-type coverage** — e.g. the select-with-linked-free-text combo pattern found on some job boards.
- **Legacy profile migration** — existing stored profiles may not have survived the storage restructure; add a migration path.
- **Smoke-test suite** — promote the jsdom harnesses (`/tmp/opencode/jtk-test/`) into the repo as a regression suite.
- **Chrome/Manifest V3 support** — currently Firefox-only (MV2).
- **AI answer refinement** — an interactive feedback loop or interview-style chat to clarify and refine generated answers (today only the automatic self-check retry exists).

## Dev

Run the jsdom regression harnesses in `/tmp/opencode/jtk-test/` (real iCIMS form + iframe + placeholder + matching scenarios):

```sh
node /tmp/opencode/jtk-test/harness.js
node /tmp/opencode/jtk-test/linkedin-variants.js
node /tmp/opencode/jtk-test/overlap-test.js
node /tmp/opencode/jtk-test/site-settings.js
node /tmp/opencode/jtk-test/site-settings-bg.js
node /tmp/opencode/jtk-test/glassdoor-bg.js
node /tmp/opencode/jtk-test/glassdoor-content.js
node /tmp/opencode/jtk-test/glassdoor-options.js
node /tmp/opencode/jtk-test/buttons-test.js
node /tmp/opencode/jtk-test/buttons-bg.js
node /tmp/opencode/jtk-test/ai-content.js
node /tmp/opencode/jtk-test/ai-bg.js
node /tmp/opencode/jtk-test/options-ai-entry.js
```

Load via `about:debugging` → Load Temporary Add-on (manifest.json).
