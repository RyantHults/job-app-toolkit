# Job App Toolkit

A Firefox WebExtension (Manifest V2) for job application workflows. Currently ships one module, **Form Filler**, with the architecture in place for more.

## Form Filler

Save form fields to named profiles and autofill job application forms. Built for the hostile reality of job portals: same-origin iframes, dynamic fields, required-field asterisks, and verbose labels like "LinkedIn* This question is required".

### Features

- **Profiles** — save fields into named profiles and switch between them (e.g. one per job board).
- **Fill page** — fills every field it can from the active profile, never overwriting data already present.
- **Add current field** — right-click a focused field to capture its name and value.
- **Add all fields** — collects every filled-out field on the page in one go.
- **Fill focused field** — right-click any field to fill just that one from the profile.
- **Options page search** — filter saved fields with a percentage-scored match, highlighting green by match quality.

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

### Storage

Single `jobAppToolkit` key in `browser.storage.sync` → `{ modules: { "form-filler": { active, profiles, activeProfile } } }`.

## Architecture

- `core/` — framework: storage, background router, UI helpers, popup.
- `modules/<id>/` — self-contained modules registered via `window.jobAppToolkit.registerModule(...)`. Messages are namespaced (`form-filler:*`), and context-menu items are dispatched to every module, which filters its own.
- `manifest.json` — lists background scripts and content scripts; all module files are wired in here.

## Roadmap

Ideas discussed but not yet built:

- **Application tracking** — track applications and their statuses (core module, beyond autofill).
- **Better field-type coverage** — e.g. the select-with-linked-free-text combo pattern found on some job boards.
- **Legacy profile migration** — existing stored profiles may not have survived the storage restructure; add a migration path.
- **Smoke-test suite** — promote the jsdom harnesses (`/tmp/opencode/jtk-test/`) into the repo as a regression suite.
- **Chrome/Manifest V3 support** — currently Firefox-only (MV2).

## Dev

Run the jsdom regression harnesses in `/tmp/opencode/jtk-test/` (real iCIMS form + iframe + placeholder + matching scenarios):

```sh
node /tmp/opencode/jtk-test/harness.js
node /tmp/opencode/jtk-test/linkedin-variants.js
node /tmp/opencode/jtk-test/overlap-test.js
```

Load via `about:debugging` → Load Temporary Add-on (manifest.json).
