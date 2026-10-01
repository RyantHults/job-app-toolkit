# Job App Toolkit - Current State

## Completed Features

### 1. Application History (Application Tracking)
- **Files**: `modules/form-filler/applications.{html,js,css}`, `modules/form-filler/background.js`, `modules/form-filler/content.js`
- **Storage**: `browser.storage.local` key `jtk-form-filler-applications`
- **Messages**: `form-filler:logApplication`, `getApplications`, `setApplicationStage`, `deleteApplication`, `setApplicationCompany`
- **Company extraction priority**: field → JSON-LD → title "at X" → og:site_name
- **UI**: History page accessible from popup/options, per-row Edit/Delete/Open, Edit button moved to leftmost in `.app-buttons` group
- **Verified**: All harnesses pass, node --check clean

### 2. Site Settings: People-Search Company Toggle Bug Fix
- **Root cause**: `scanPeople()` (content.js:2148) inserted/rendered company wrappers unconditionally; the toggle only gated fetches, style injection, summary, and forced IO fire
- **Fix**: Added per-card gate `if (!config.showPeopleSearchCompany) continue;` before cached-render/`ensurePeopleCompanyLine` at content.js ~2215
- **Harness updates**: `/tmp/opencode/jtk-test/site-settings-people.js` — A.10/A.14/A.15 storage stubs return `{ jobAppToolkit: stored.jobAppToolkit }`; A.16 (fresh load toggle off → no `.jtk-ss-ppl` lines) + A.16a (no `getCompany` messages)
- **Verified**: All site-settings harnesses pass, node --check clean

### 3. Form Filler: Radio-Group Button Placement Fix (Ashby)
- **Root cause**: Ashby option labels are `<span class="_label_...">` matching `HEADER_SELECTOR` via `[class*="label"]` — `closestPrecedingTitle` counted them as "closer titles", tripping `coveredElsewhere >= 2` guard in `findContainerTitle`, rejecting the real question-title label → `titleEl: null` → `ensureButtons` fallback inserted wrapper after first radio inside its `_container` span
- **Fix** (`modules/form-filler/content.js`):
  1. `isOptionLabel`: recognizes non-LABEL header-like elements sharing a parent with exactly one fillable (Ashby's `._label_` span pattern)
  2. `closestPrecedingTitle`: option-label skip widened from `=== "multiChoice"` to `!== "single"` (radio fields now skip option labels too)
- **Verified**: All form-filler harnesses pass (138/138 buttons-test, harness.js, overlap-test.js, ai-content.js), node --check clean

### 4. Form Filler: Debug Toast Logging
- **Feature**: Module-specific "Enable debug" checkbox on Form Filler options page mirrors every Form Filler toast to the page console
- **Bug found on audit**: all 21 `api.notify(...)` calls passed `"form-filler"` as the **4th** arg (`action`), but `notify(tabId, title, message, action, moduleId)` expects module id as the **5th**. Result: `jtk:showToast.module` was always `""`, so content-side debug filtering never matched background toasts (content-local `toast()` still worked).
- **Fix**: every Form Filler notify is now `api.notify(tabId, title, msg, null, "form-filler")`
- **Implementation**:
  - **core/background.js**: `notify()` accepts optional `moduleId` (5th param), includes `module` field in `jtk:showToast` message
  - **modules/form-filler/background.js**: All 21 `api.notify()` calls pass `null, "form-filler"`
  - **modules/form-filler/options.html**: New "Debug" section with toggle checkbox
  - **modules/form-filler/options.js**: `debugToggle` wired — loads from module payload, saves immediately via `storage.setModuleData(MODULE_ID, { debug })`
  - **modules/form-filler/content.js**:
    - `loadConfig()` reads `mod.debug` into `config.debug` (reloaded via `storage.onChanged` → `ensureActive`)
    - `jtk:showToast` listener logs when `config.debug && message.module === "form-filler"`
    - `toast()` helper logs when `config.debug`
  - **Docs**: README.md (feature bullet + Storage `debug` key), ARCHITECTURE.md (jtk:showToast module field + options description)
- **Verification harnesses**:
  - `/tmp/opencode/jtk-test/form-filler-debug.js` — content-side debug off/on + module filter
  - `buttons-bg.js` / `ai-bg.js` — assert `jtk:showToast.module === "form-filler"` and `action == null`
- **Verified**: form-filler-debug, buttons-bg, ai-bg, applications-bg pass; node --check clean

## File Changes Summary

### Core
- `core/background.js`: notify() moduleId param

### Form Filler Module
- `modules/form-filler/background.js`: 21 notify calls + module id
- `modules/form-filler/content.js`: debug flag, jtk:showToast listener, toast() logging
- `modules/form-filler/options.html`: Debug section
- `modules/form-filler/options.js`: debug toggle load/save
- `modules/form-filler/applications.{html,js,css}`: History page

### Site Settings Module
- `modules/site-settings/content.js`: People-search toggle gate fix

### Documentation
- `README.md`: Debug feature + Storage `debug` key
- `ARCHITECTURE.md`: jtk:showToast module field + Form Filler options description

### Harnesses (external, /tmp/opencode/jtk-test/)
- `site-settings-people.js`: People toggle regression (A.16, A.16a)
- `form-filler-debug.js`: Debug toast logging verification

## Pending
- None for the debug feature — complete.
- Uncommitted working tree still has the above changes plus Application History / people toggle / Ashby radio work; commit when ready.

## Next Steps
1. Manual smoke in Firefox (`about:debugging`): enable Debug on Form Filler options, trigger a fill/save toast, confirm `[Form Filler]` lines in the page console
2. Commit when asked
