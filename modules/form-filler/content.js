// Form Filler — content script module (Firefox WebExtensions, Manifest V2).
// Discovers fillable form fields, matches them against the active profile,
// fills only empty fields (never overwrites existing values), and reports
// results back to the caller (background or the module options page). Also
// serves the "add current field" capture flow. No-ops while the module is
// toggled off in the Job App Toolkit popup.
(function () {
  "use strict";

  const MODULE_ID = "form-filler";

  // Module activity and in-page toasts are provided by core/content.js (loaded
  // before this script). Refresh the cached active flag on load so handlers
  // no-op cheaply while the module is toggled off.
  window.jobAppToolkit.content.refreshActive(MODULE_ID);

  // Mark this document as carrying the content script so a parent frame's
  // same-origin iframe walk knows not to process it twice: frames with their
  // own script are reached by the background's per-frame messaging instead.
  try {
    if (document.documentElement) document.documentElement.dataset.jtkInjected = "1";
  } catch (err) {
    // Never fatal.
  }

  // Fillable <input> types. An <input> with no type defaults to "text" and is
  // included automatically; hidden/submit/button/reset/file/password/radio are
  // excluded by not being in this set. Checkboxes are boolean fields whose
  // profile value ("true"/"false", "yes"/"no", ...) controls the checked state.
  const FILLABLE_INPUT_TYPES = new Set(["text", "email", "tel", "url", "number", "checkbox"]);

  // Fallback hint elements when a field has no label/name/id.
  const HEADER_SELECTOR =
    'h1, h2, h3, h4, h5, h6, label, [class*="label" i], [class*="title" i], b, strong';

  // ------------------------------------------------------------------
  // Normalisation
  // ------------------------------------------------------------------

  // Lowercase, strip anything that isn't a letter or digit (so required-field
  // asterisks, dots, commas, underscores, hyphens, etc. never interfere with
  // matching), collapse whitespace runs to a single space, then trim. So
  // "First Name*", "first_name", "firstName" and "First Name" all compare
  // equal.
  function normalize(str) {
    return String(str == null ? "" : str)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  // ------------------------------------------------------------------
  // Field discovery
  // ------------------------------------------------------------------

  function isFillable(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.disabled || el.readOnly) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag !== "INPUT") return false;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return FILLABLE_INPUT_TYPES.has(type);
  }

  // ------------------------------------------------------------------
  // Candidate name extraction (priority order)
  // ------------------------------------------------------------------

  function getLinkedLabelText(el, doc) {
    if (!el.id) return "";
    const label = (doc || document).querySelector('label[for="' + CSS.escape(el.id) + '"]');
    return label ? label.textContent : "";
  }

  function getParentLabelText(el) {
    const label = el.closest("label");
    return label ? label.textContent : "";
  }

  function getAriaLabelledbyText(el, doc) {
    const ids = el.getAttribute("aria-labelledby");
    if (!ids) return "";
    const parts = [];
    for (const id of ids.split(/\s+/)) {
      const ref = (doc || document).getElementById(id);
      if (ref) parts.push(ref.textContent);
    }
    return parts.join(" ");
  }

  // Walk backwards in document order for the closest preceding heading /
  // label-ish element (covering preceding siblings, ancestors and the
  // preceding siblings of ancestors). Prefer that specific label over an
  // enclosing <fieldset> <legend>, which describes the group rather than the
  // field; only fall back to the legend when the walk finds nothing nearby
  // (nothing at all, or only elements outside the fieldset).
  function getHeaderLikeText(el, doc) {
    const root = doc || document;
    if (!root.body || !root.body.contains(el)) return "";
    const walker = root.createTreeWalker(root.body, NodeFilter.SHOW_ELEMENT);
    walker.currentNode = el;
    let node;
    while ((node = walker.previousNode())) {
      if (node.matches && node.matches(HEADER_SELECTOR)) {
        const text = node.textContent.trim();
        if (text.length > 0 && text.length < 200) {
          const fieldset = el.closest("fieldset");
          if (fieldset && !fieldset.contains(node)) {
            const legend = fieldset.querySelector(":scope > legend");
            if (legend && legend.textContent.trim() !== "") return legend.textContent;
          }
          return text;
        }
      }
    }
    const fieldset = el.closest("fieldset");
    if (fieldset) {
      const legend = fieldset.querySelector(":scope > legend");
      if (legend && legend.textContent.trim() !== "") return legend.textContent;
    }
    return "";
  }

  // Ordered candidate names for a field. First match wins, so priority is:
  // name, id, placeholder, linked label, parent label, aria-label,
  // aria-labelledby, header-like element.
  function getCandidates(el, doc) {
    const candidates = [];
    const add = (text) => {
      const norm = normalize(text);
      if (norm) candidates.push(norm);
    };
    add(el.name);
    add(el.id);
    add(el.getAttribute("placeholder"));
    add(getLinkedLabelText(el, doc));
    add(getParentLabelText(el));
    add(el.getAttribute("aria-label"));
    add(getAriaLabelledbyText(el, doc));
    add(getHeaderLikeText(el, doc));
    // Deduplicate while preserving priority order.
    return Array.from(new Set(candidates));
  }

  function discoverFields(doc) {
    const root = doc || document;
    const fields = [];
    const nodes = root.querySelectorAll("input, textarea, select");
    for (const el of nodes) {
      if (isFillable(el)) fields.push({ el, candidates: getCandidates(el, root) });
    }
    return fields;
  }

  // ------------------------------------------------------------------
  // Matching
  // ------------------------------------------------------------------

  // Each stored field can match on two identities: the element's name/id (the
  // profile key) and the human-readable title (label). Build one match entry
  // per usable field, carrying both normalized identities plus the fill value.
  function buildMatchEntries(fields) {
    const entries = [];
    for (const key of Object.keys(fields)) {
      const entry = fields[key];
      const isObj = entry && typeof entry === "object";
      const value = isObj ? entry.value : entry;
      if (value === undefined || value === null || String(value) === "") continue;
      const label = isObj && entry.label ? entry.label : key;
      const norms = [];
      const keyNorm = normalize(key);
      if (keyNorm) norms.push(keyNorm);
      const labelNorm = normalize(label);
      if (labelNorm && labelNorm !== keyNorm) norms.push(labelNorm);
      entries.push({ key, value, norms });
    }
    return entries;
  }

  // Match each profile entry to at most one field, and each field to at most
  // one entry. Exact candidate matches win over "contains" matches, which win
  // over word-overlap matches.
  function matchFields(entries, fieldList) {
    const matches = [];
    const usedFields = new Set();
    const usedEntries = new Set();

    // Pass 1 — exact matches (first field in document order wins).
    for (const entry of entries) {
      outer:
      for (const norm of entry.norms) {
        for (const field of fieldList) {
          if (usedFields.has(field.el)) continue;
          if (field.candidates.includes(norm)) {
            matches.push({ key: entry.key, entry, field });
            usedFields.add(field.el);
            usedEntries.add(entry);
            break outer;
          }
        }
      }
    }

    // Pass 2 — contains matches (identity in candidate or vice versa).
    // Prefer the highest-priority candidate, then the longest candidate.
    for (const entry of entries) {
      if (usedEntries.has(entry)) continue;
      let best = null;
      for (const field of fieldList) {
        if (usedFields.has(field.el)) continue;
        for (let i = 0; i < field.candidates.length; i++) {
          const cand = field.candidates[i];
          for (const norm of entry.norms) {
            if (cand.includes(norm) || norm.includes(cand)) {
              if (
                !best ||
                i < best.candIdx ||
                (i === best.candIdx && cand.length > best.cand.length)
              ) {
                best = { key: entry.key, entry, field, candIdx: i, cand };
              }
              break;
            }
          }
        }
      }
      if (best) {
        matches.push({ key: best.key, entry: best.entry, field: best.field });
        usedFields.add(best.field.el);
        usedEntries.add(best.entry);
      }
    }

    // Pass 3 — word-overlap matches. Handles phrasing that shares the same
    // significant words but in different order or with extra words, e.g.
    // "personal website portfolio" vs "website or portfolio". Requires enough
    // common words that the two are clearly the same field. Prefer the highest
    // overlap, then the highest-priority candidate.
    for (const entry of entries) {
      if (usedEntries.has(entry)) continue;
      let best = null;
      for (const field of fieldList) {
        if (usedFields.has(field.el)) continue;
        for (let i = 0; i < field.candidates.length; i++) {
          const cand = field.candidates[i];
          for (const norm of entry.norms) {
            const overlap = tokenOverlap(norm, cand);
            if (overlap > 0) {
              if (
                !best ||
                overlap > best.overlap ||
                (overlap === best.overlap && i < best.candIdx)
              ) {
                best = { key: entry.key, entry, field, candIdx: i, overlap };
              }
            }
          }
        }
      }
      if (best) {
        matches.push({ key: best.key, entry: best.entry, field: best.field });
        usedFields.add(best.field.el);
        usedEntries.add(best.entry);
      }
    }

    return matches;
  }

  // Fraction of the significant words of the shorter string that also appear
  // in the longer one, after dropping tiny/stop-like words ("a", "or", "the").
  // Returns 0 unless the two share at least two significant words AND every
  // significant word of the shorter string appears in the longer one. This
  // lets "personal website portfolio" match "website or portfolio" but stops
  // "legal first name" from matching "legal last name" (each has a
  // distinguishing word the other lacks).
  function tokenOverlap(a, b) {
    const wordsA = a.split(" ").filter(isSignificantWord);
    const wordsB = b.split(" ").filter(isSignificantWord);
    if (wordsA.length === 0 || wordsB.length === 0) return 0;
    const [small, large] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
    let common = 0;
    const used = new Set();
    for (const w of small) {
      if (used.has(w)) continue;
      if (large.indexOf(w) !== -1) {
        common++;
        used.add(w);
      }
    }
    if (common < 2 || common !== small.length) return 0;
    return (common / small.length + common / large.length) / 2;
  }

  // Words under three letters are too generic to carry identity ("or", "of").
  function isSignificantWord(word) {
    return word.length >= 3;
  }

  // ------------------------------------------------------------------
  // Filling
  // ------------------------------------------------------------------

  // Assign through the element's native value setter (from its own prototype,
  // since HTMLTextAreaElement does not inherit from HTMLInputElement) so
  // framework value-trackers observe the change, then dispatch user-like
  // events.
  function setNativeValue(el, value) {
    const proto =
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Interpret a profile value as a boolean for checkbox state.
  function isTruthyBoolean(value) {
    if (typeof value === "boolean") return value;
    const s = String(value).trim().toLowerCase();
    return s === "true" || s === "yes" || s === "1" || s === "checked" || s === "on" || s === "y";
  }

  // Conservative test for "this select option is a placeholder prompt rather
  // than a real choice". Only obvious prompts count: empty/disabled options,
  // sentinel ids, iCIMS-style "legacy" markers, all-punctuation text, and
  // explicit select/choose/pick wording. Real labels like "Selective Service"
  // must not match.
  function isPlaceholderOption(opt) {
    if (!opt) return false;
    if (opt.disabled) return true;
    const text = String(opt.textContent || "").trim();
    if (text === "") return true;
    if (opt.hasAttribute && opt.hasAttribute("legacy")) return true;
    if (String(opt.value).trim() === "-1") return true;
    if (/^[-–—_*•.\s]+$/.test(text)) return true;
    if (/^(select|choose|pick)([….\s:?]|$)/i.test(text)) return true;
    if (/^(please\s+(select|choose|pick)|make\s+a\s+selection)/i.test(text)) return true;
    return false;
  }

  // Does this field hold real data? Placeholder prompts do not count, so
  // fields still sitting at their default state are treated as empty. A
  // checkbox is never "empty" in this sense (both checked states are
  // meaningful); callers handle checkboxes separately.
  function fieldHasData(el) {
    if (el && el.tagName === "SELECT") {
      const opt = el.selectedOptions ? el.selectedOptions[0] : null;
      if (!opt) return false;
      return !isPlaceholderOption(opt);
    }
    if (!el) return false;
    const value = el.value;
    return value !== null && value !== undefined && String(value).trim() !== "";
  }

  // Returns true if the field was filled, false if it was skipped (e.g. a
  // <select> with no matching option). An option matches when the profile
  // value equals the option's value attribute OR its visible text, so selects
  // captured as their internal value (e.g. "US") also match options displayed
  // as labels (e.g. "United States") and vice versa.
  function fillField(el, value) {
    if (el.tagName === "SELECT") {
      const norm = normalize(value);
      let option = null;
      for (const opt of el.options) {
        if (normalize(opt.value) === norm || normalize(opt.textContent) === norm) {
          option = opt;
          break;
        }
      }
      if (!option) return false; // no matching option — leave untouched
      el.value = option.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    if (el.type === "checkbox") {
      const desired = isTruthyBoolean(value);
      if (el.checked !== desired) {
        el.checked = desired;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return true;
    }
    setNativeValue(el, String(value));
    return true;
  }

  // ------------------------------------------------------------------
  // Message handlers
  // ------------------------------------------------------------------

  function fillPage(activeProfile, doc) {
    const root = doc || document;
    const profile = activeProfile && typeof activeProfile === "object" ? activeProfile : {};
    const fields =
      profile.fields && typeof profile.fields === "object" ? profile.fields : {};

    const entries = buildMatchEntries(fields);
    const fieldList = discoverFields(root);
    const matches = matchFields(entries, fieldList);

    let filled = 0;
    let skipped = 0;
    const matchedKeys = new Set();
    const skippedNames = [];

    for (const m of matches) {
      const el = m.field.el;
      // Never overwrite data. A field "has data" when it holds a real value;
      // placeholder prompts (e.g. a dropdown showing "— Make a Selection —"
      // with an internal sentinel value) do not count. For checkboxes the
      // current checked state is the "value", so a box that already matches
      // its target state is skipped.
      const isCheckbox = el.type === "checkbox";
      const target = m.entry.value;
      const isFilled = isCheckbox
        ? el.checked === isTruthyBoolean(target)
        : fieldHasData(el);
      if (isFilled) {
        skipped++;
        matchedKeys.add(m.key);
        skippedNames.push(getFieldTitle(el, root) || el.name || el.id);
        continue;
      }
      if (fillField(el, target)) {
        filled++;
        matchedKeys.add(m.key);
      }
    }

    const unmatched = entries.filter((e) => !matchedKeys.has(e.key)).length;
    return { filled, skipped, skippedNames, unmatched, matched: matchedKeys.size };
  }

  // Human-readable title for a field: explicit label text and any title/heading
  // above the element first, then placeholder, then the element's name/id.
  function getFieldTitle(el, doc) {
    const title =
      getLinkedLabelText(el, doc) ||
      getParentLabelText(el) ||
      getAriaLabelledbyText(el, doc) ||
      el.getAttribute("aria-label") ||
      getHeaderLikeText(el, doc) ||
      el.getAttribute("placeholder") ||
      "";
    return String(title).trim().replace(/\s+/g, " ");
  }

  // Clean human-readable field text for storage: strip anything that isn't a
  // letter or digit so decorative punctuation (e.g. the required-field
  // asterisk in "Legal First Name*") never ends up saved in a profile key or
  // label. Real element name/id attributes are kept verbatim via `cleanFieldName`'s
  // callers, since those are stable identifiers that matching re-normalizes anyway.
  function cleanFieldName(str) {
    return String(str == null ? "" : str)
      .replace(/[^a-z0-9]+/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Custom drop-down pickers render a visible widget (a button / combobox) while
  // the real value lives in a native <select>, often visually hidden (display:
  // none / aria-hidden). Matches the container class/role of such widgets so
  // capture and fill act on the real control.
  const WIDGET_SELECTOR =
    '[role="combobox"], [role="listbox"], [aria-haspopup="listbox"], [class*="select" i], [class*="dropdown" i], [class*="picker" i]';

  // Find the nearest fillable field associated with an element. Covers styled
  // controls where the clickable part (e.g. a CSS switch or a custom dropdown
  // picker) is not the input itself: search the element's own subtree, a
  // `label[for]` target, then a couple of ancestor levels (bounded so we never
  // reach far-away fields).
  function findFieldNear(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    let node = el;
    for (let depth = 0; node && depth <= 2; depth++, node = node.parentElement) {
      const isPageRoot = node.tagName === "BODY" || node.tagName === "HTML";
      if (isFillable(node)) return node;
      if (!isPageRoot && typeof node.querySelector === "function") {
        // Prefer a native <select> backing a custom picker widget over any
        // stray search input the widget may also contain.
        if (node.matches && node.matches(WIDGET_SELECTOR)) {
          const widgetSelect = node.querySelector("select");
          if (widgetSelect && isFillable(widgetSelect)) return widgetSelect;
        }
        const inner = node.querySelector("input, textarea, select");
        if (inner && isFillable(inner)) return inner;
      }
      if (node.getAttribute && node.getAttribute("for")) {
        const target = document.getElementById(node.getAttribute("for"));
        if (target && isFillable(target)) return target;
      }
    }
    return null;
  }

  // Resolve the field a context-menu action refers to. Prefers the actual
  // right-clicked element (via targetElementId) since right-clicking does not
  // always move focus; falls back to the focused element when no target id was
  // provided (e.g. popup-driven flows).
  function resolveFieldElement(targetElementId) {
    if (targetElementId) {
      try {
        const el = browser.menus.getTargetElement(targetElementId);
        if (el) return findFieldNear(el);
      } catch (err) {
        // getTargetElement unavailable — fall through to activeElement.
      }
      return null; // the right-clicked element has no nearby fillable field
    }
    return findFieldNear(document.activeElement);
  }

  // Shared extraction of the { name, value, fieldLabel } triple for a field.
  // Used by the focused-field capture, the page-wide collect, and the in-page
  // save/up-arrow buttons so all three describe a field identically. A
  // checkbox's value is its checked state as a string.
  function describeField(el, doc) {
    const root = doc || document;
    const candidates = getCandidates(el, root);

    // Matching key: the element's actual name/id first (never placeholder
    // text), then the title above, then any remaining candidate. Real name/id
    // attributes are kept verbatim; title text is cleaned of punctuation.
    const rawName = String(el.name || el.id || "").trim();
    const name = rawName || cleanFieldName(getFieldTitle(el, root)) || candidates[0] || "";

    let fieldLabel = cleanFieldName(getFieldTitle(el, root)) || rawName || candidates[0] || "";
    if (fieldLabel.length > 120) fieldLabel = fieldLabel.slice(0, 120) + "\u2026";

    const value = el.type === "checkbox" ? String(el.checked) : el.value;
    return { name, value, fieldLabel };
  }

  function getFocusedField(targetElementId) {
    const el = resolveFieldElement(targetElementId);
    if (!el) return null;
    return describeField(el);
  }

  // Describe a field for the "Answer with AI" flow: everything describeField
  // captures (name, label, value) plus the constraints the prompt needs —
  // maxlength, single-line vs multiline, the element type/tag, and the page
  // title as extra context.
  function describeAIField(el) {
    return {
      ok: true,
      maxLength:
        typeof el.maxLength === "number" && el.maxLength > 0 ? el.maxLength : null,
      singleLine: el.tagName === "INPUT",
      type:
        el.tagName === "INPUT" ? el.getAttribute("type") || "text" : el.tagName.toLowerCase(),
      tagName: el.tagName,
      pageTitle: (el.ownerDocument || document).title || "",
      ...describeField(el, el.ownerDocument)
    };
  }

  // Collect every field on the page that has been filled out and is not yet
  // represented in the profile. A field counts as already in the profile when
  // it matches an existing entry under the same identity matching used to fill
  // (exact candidates, then contains) — existing entries are never overwritten.
  // Fields with no usable name or an empty value are skipped and counted.
  function collectFilledFields(profileFields, doc) {
    const root = doc || document;
    const entries = buildMatchEntries(profileFields || {});
    const results = [];
    let skippedExisting = 0;
    let skippedEmpty = 0;
    const fieldList = discoverFields(root);

    for (const field of fieldList) {
      const el = field.el;
      const desc = describeField(el, root);
      if (!desc.name) {
        skippedEmpty++;
        continue;
      }
      if (!(el.type === "checkbox") && !fieldHasData(el)) {
        skippedEmpty++;
        continue;
      }
      if (matchFields(entries, [field]).length > 0) {
        skippedExisting++;
        continue;
      }
      results.push(desc);
    }

    return {
      fields: results,
      skippedExisting,
      skippedEmpty,
      found: fieldList.length,
      frameTop: window === window.top
    };
  }

  // ------------------------------------------------------------------
  // Same-origin iframe walk
  // ------------------------------------------------------------------

  // Job portals render their forms in (same-origin) iframes that may not carry
  // a content script of their own (Firefox does not always inject scripts into
  // dynamically-created frames). Run a callback against this document and every
  // same-origin descendant iframe document, skipping frames that are already
  // marked as injected (those are reached by the background's per-frame
  // messaging) and any cross-origin or not-yet-loaded frame.
  function forEachSameOriginDoc(cb, doc, force) {
    const root = doc || document;
    try {
      cb(root);
    } catch (err) {
      // Carry on with descendants even if the root document failed.
    }
    const frames = root.querySelectorAll("iframe, frame");
    for (const frame of frames) {
      let inner;
      try {
        inner = frame.contentDocument;
      } catch (err) {
        continue;
      }
      if (!inner || !inner.documentElement || inner === root) continue;
      if (!force) {
        try {
          if (inner.documentElement.dataset.jtkInjected === "1") continue;
        } catch (err) {
          continue;
        }
      }
      forEachSameOriginDoc(cb, inner, force);
    }
  }

  // Collect filled fields from this document and all reachable same-origin
  // iframes, deduplicated by name (first document wins). The `force` flag also
  // walks iframes that carry their own content script; the background uses it
  // as a fallback when per-frame messaging reached nothing.
  function collectFilledFieldsAll(profileFields, force) {
    const all = {
      fields: [],
      skippedExisting: 0,
      skippedEmpty: 0,
      found: 0,
      docs: 0,
      frameTop: window === window.top
    };
    const seen = new Set();
    forEachSameOriginDoc(
      (doc) => {
        all.docs++;
        const r = collectFilledFields(profileFields, doc);
        all.skippedExisting += r.skippedExisting;
        all.skippedEmpty += r.skippedEmpty;
        all.found += r.found;
        for (const f of r.fields) {
          if (seen.has(f.name)) continue;
          seen.add(f.name);
          all.fields.push(f);
        }
      },
      undefined,
      force
    );
    return all;
  }

// Fill this document and all reachable same-origin iframes, summing results.
// "Unmatched" counts profile entries that matched no field anywhere, so the
// per-document tallies are merged (a wrapper page with no fields must not
// report every profile entry as unmatched).
function fillPageAll(activeProfile, force) {
    const totals = { filled: 0, skipped: 0, unmatched: 0, docs: 0, skippedNames: [] };
    let matched = 0;
    forEachSameOriginDoc(
      (doc) => {
        totals.docs++;
        const r = fillPage(activeProfile, doc);
        totals.filled += r.filled;
        totals.skipped += r.skipped;
        if (Array.isArray(r.skippedNames)) totals.skippedNames.push(...r.skippedNames);
        matched += r.matched;
      },
      undefined,
      force
    );
    const profile = activeProfile && typeof activeProfile === "object" ? activeProfile : {};
    const fields =
      profile.fields && typeof profile.fields === "object" ? profile.fields : {};
    const totalEntries = buildMatchEntries(fields).length;
    totals.unmatched = Math.max(0, totalEntries - matched);
    return totals;
  }

  // ------------------------------------------------------------------
  // In-page per-field buttons (save add / up-arrow fill)
  // ------------------------------------------------------------------
  //
  // On whitelisted sites every fillable field gets a small button pair beside
  // it: the save (floppy) icon captures the field's current value into the
  // active profile, the up arrow fills the field from the active profile
  // (unconditionally — this is a deliberate per-field override, unlike
  // fill-page which never overwrites existing data). The buttons replace the
  // old context-menu actions. They render only when the module is active AND
  // the current hostname is whitelisted.

  const STORAGE_KEY = "jobAppToolkit";
  const STYLE_ID = "jtk-form-filler-styles";
  const BTN_WRAPPER_CLASS = "jtk-ff-btns";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const SPINNER_STYLE_ID = "jtk-form-filler-spinner-styles";
  const SPINNER_CLASS = "jtk-ff-spinner";
  // Spinner diameter in px. Keep in sync with the .jtk-ff-spinner CSS rule
  // (width/height) — positionSpinner centers the ring on the field using this.
  const SPINNER_SIZE = 14;
  // Safety net only — the background hides the spinner first on its normal
  // paths (it aborts the whole AI flow at 90s and toasts "timed out"). This
  // catches a background that died before it could send the hide message.
  // Set slightly longer than the background's 90s deadline so the background
  // normally wins.
  const SPINNER_MAX_AGE_MS = 100000;

  let config = { whitelist: [], profileFields: {} };

  async function loadConfig() {
    try {
      const res = await browser.storage.sync.get(STORAGE_KEY);
      const store = res && res[STORAGE_KEY];
      const mod = store && store.modules && store.modules[MODULE_ID];
      let whitelist = [];
      if (mod && Array.isArray(mod.whitelist)) whitelist = mod.whitelist;
      let profileFields = {};
      const active = mod && mod.profiles && mod.profiles[mod.activeProfile];
      if (active && active.fields && typeof active.fields === "object") {
        profileFields = active.fields;
      }
      config = { whitelist: whitelist, profileFields: profileFields };
    } catch (err) {
      config = { whitelist: [], profileFields: {} };
    }
  }

  // Hostname normalisation for the whitelist. Entries are stored as bare
  // hostnames, but users may paste full URLs or append paths/ports, so run
  // anything URL-ish through the URL parser and keep the hostname. Both sides
  // are lowercased and stripped of a leading "www." and a trailing dot.
  function normalizeHost(host) {
    let value = String(host == null ? "" : host).trim().toLowerCase();
    if (!value) return "";
    if (value.includes("://") || /[/:?#]/.test(value)) {
      try {
        value = new URL(value.includes("://") ? value : "https://" + value).hostname;
      } catch (err) {
        // Not a URL — fall back to the raw (already lowercased) value.
      }
    }
    return value.replace(/^www\./, "").replace(/\.$/, "");
  }

  function isWhitelisted() {
    const host = normalizeHost(location.hostname);
    if (!host) return false;
    return config.whitelist.some((entry) => {
      const norm = normalizeHost(entry);
      if (!norm) return false;
      if (norm === host) return true;
      // An entry also whitelists its subdomains, but never a bare TLD: a
      // dotted entry like "example.com" matches "jobs.example.com", while a
      // dot-less entry ("com") can never match anything but itself.
      return norm.indexOf(".") !== -1 && host.endsWith("." + norm);
    });
  }

  function injectStyles(doc) {
    const root = doc || document;
    if (root.getElementById(STYLE_ID)) return;
    const style = root.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      // The wrapper is a zero-height block so its in-flow footprint is nothing:
      // the next sibling starts at the same line the field ended on. Only the
      // painted buttons overflow (overflow:visible), and position:relative +
      // the inline top set per-scan in ensureButtons lifts them so the pair is
      // centered on the field's row, overlapping its right edge (a password-
      // toggle style placement, since a full-width block field can never share
      // its line with a sibling). z-index keeps the buttons above the input.
      // Flex container: a height:0 flex box has no line box for its items, so
      // align-items:center centers the 18px pair EXACTLY on the wrapper's y=0
      // line (no baseline/line-height ambiguity) and justify-content:flex-end
      // right-aligns it.
      ".jtk-ff-btns{display:flex;justify-content:flex-end;align-items:center;height:0;overflow:visible;position:relative;z-index:1;}" +
      ".jtk-ff-btn{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:none;border-radius:4px;background:transparent;font-size:12px;line-height:1;cursor:pointer;opacity:.45;transition:opacity .15s ease,background .15s ease;position:relative;z-index:1;}" +
      ".jtk-ff-btns .jtk-ff-btn{color:inherit !important;}" +
      ".jtk-ff-btn:hover{opacity:1;background:rgba(0,0,0,.06);}" +
      ".jtk-ff-btn.jtk-ff-dim{opacity:.18;}" +
      // The icons are inline SVGs: fixed 12px inside the 18px buttons (a 3px
      // ring), display:block keeps flex centering exact, and
      // pointer-events:none routes every click — and every synthetic event —
      // to the button itself, never its icon.
      ".jtk-ff-btn svg{width:12px;height:12px;display:block;pointer-events:none;flex-shrink:0;}";
    (root.head || root.documentElement).appendChild(style);
  }

  // In-page toast via the core content runtime; falls back to the console
  // when the core runtime is unavailable (harness/edge cases).
  function toast(text) {
    try {
      if (typeof window.jobAppToolkit.content.showToast === "function") {
        window.jobAppToolkit.content.showToast(text);
        return;
      }
    } catch (err) {
      // Fall through to the console.
    }
    console.log("[Form Filler] " + text);
  }

  // Does the active profile hold a value matching this field, under the same
  // identity matching used by fill-page? Returns the match (with its profile
  // key) or null.
  function findProfileMatch(el) {
    const entries = buildMatchEntries(config.profileFields);
    const matches = matchFields(entries, [
      { el: el, candidates: getCandidates(el, el.ownerDocument) }
    ]);
    return matches.length > 0 ? matches[0] : null;
  }

  // Build an inline SVG icon in the host document. Must use createElementNS —
  // never innerHTML strings, which a page's CSP can block. fill="currentColor"
  // inherits the button's pinned color (the stylesheet sets it to inherit, and
  // the button's opacity dims the icon along with it). Sizing and
  // pointer-events come from the injected .jtk-ff-btn svg rule. Shapes are
  // [tag, attrs] pairs so both icons share the same construction path.
  function createIcon(root, shapes) {
    const svg = root.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 12 12");
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    for (let i = 0; i < shapes.length; i++) {
      const node = root.createElementNS(SVG_NS, shapes[i][0]);
      const attrs = shapes[i][1];
      for (const name in attrs) node.setAttribute(name, attrs[name]);
      svg.appendChild(node);
    }
    return svg;
  }

  function createButtons(el, doc) {
    // Buttons must be created in the field's own document — for fields inside
    // a same-origin iframe that is NOT this frame's document.
    const root = doc || el.ownerDocument || document;
    const wrapper = root.createElement("span");
    wrapper.className = BTN_WRAPPER_CLASS;

    const addBtn = root.createElement("button");
    addBtn.type = "button";
    addBtn.className = "jtk-ff-btn jtk-ff-add";
    // Save icon — a floppy disk: rounded shell, the shell's signature
    // diagonally cut bottom-right corner, and the square metal shutter
    // top-right cut out as a window (negative space, via fill-rule), so the
    // silhouette reads even at 12px in a single fill color.
    addBtn.appendChild(
      createIcon(root, [
        ["path", { "fill-rule": "evenodd", d: "M2 1h8a1 1 0 0 1 1 1v7.5L9.5 11H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zM6.5 1.75h2.5v2.5H6.5z" }]
      ])
    );
    addBtn.title = "Add this field to profile";
    addBtn.setAttribute("aria-label", "Add this field to profile");
    addBtn.addEventListener("click", (e) => onAddClick(e, el));

    const fillBtn = root.createElement("button");
    fillBtn.type = "button";
    fillBtn.className = "jtk-ff-btn jtk-ff-fill";
    // Up arrow — solid triangular head, notched neck, short shaft: reads as
    // "pull the profile value up into this field".
    fillBtn.appendChild(
      createIcon(root, [
        ["path", { d: "M6 1L10 5.5l-1 1.5L7 6v5H5V6L3 7l-1-1.5z" }]
      ])
    );
    fillBtn.title = "Fill this field from profile";
    fillBtn.setAttribute("aria-label", "Fill this field from profile");
    fillBtn.addEventListener("click", (e) => onFillClick(e, el));

    wrapper.appendChild(addBtn);
    wrapper.appendChild(fillBtn);
    return { wrapper: wrapper, addBtn: addBtn, fillBtn: fillBtn };
  }

  function onAddClick(e, el) {
    e.preventDefault();
    e.stopPropagation();
    const desc = describeField(el, el.ownerDocument);
    const display = desc.fieldLabel || desc.name;
    if (desc.value === "" || desc.value === null || desc.value === undefined) {
      toast('Field "' + display + '" is empty. Enter a value first.');
      return;
    }
    browser.runtime
      .sendMessage({
        type: "form-filler:addField",
        field: { name: desc.name, value: desc.value, fieldLabel: desc.fieldLabel }
      })
      .then((res) => {
        if (res && res.message) toast(res.message);
        else if (res && res.error) toast(res.error);
      })
      .catch((err) => {
        console.error("[Form Filler] addField failed:", err);
      });
  }

  function onFillClick(e, el) {
    e.preventDefault();
    e.stopPropagation();
    const desc = describeField(el, el.ownerDocument);
    const display = desc.fieldLabel || desc.name;
    const match = findProfileMatch(el);
    const entry = buttonMap.get(el);
    if (!match) {
      toast('No saved value matches "' + display + '".');
      if (entry) entry.fillBtn.classList.add("jtk-ff-dim");
      return;
    }
    // Deliberate unconditional overwrite (no isFilled guard): the per-field
    // fill is an explicit override, unlike fill-page. No toast on success —
    // the visible value change is the feedback.
    fillField(el, match.entry.value);
    if (entry) {
      entry.fillBtn.title = 'Fill from profile: "' + match.key + '"';
      entry.fillBtn.classList.remove("jtk-ff-dim");
    }
  }

  // Wrappers are tracked per element (form fields are stable elements, unlike
  // LinkedIn's recycled cards), so repeated scans reuse the same buttons.
  let buttonMap = new WeakMap();

  // Reflect the profile-match state on the fill button only (dim + tooltip
  // naming the matched profile key); the add button never changes.
  function updateButtonState(entry, el) {
    const match = findProfileMatch(el);
    if (match) {
      entry.fillBtn.classList.remove("jtk-ff-dim");
      entry.fillBtn.title = 'Fill from profile: "' + match.key + '"';
    } else {
      entry.fillBtn.classList.add("jtk-ff-dim");
      entry.fillBtn.title = "Fill this field from profile";
    }
  }

  // Vertically center the button pair on the field's row. The wrapper is a
  // zero-height FLEX container, so its top edge sits just below the field (at
  // the field's bottom edge, plus any bottom margin the field carries), and
  // align-items:center pins the 18px pair exactly on that y=0 line — no line
  // box, no baseline offset. A negative top of -(fieldH/2 + margin) lifts the
  // pair so it spans the field's vertical middle. Relative positioning only
  // moves painted content, so the wrapper's zero in-flow footprint is
  // unaffected and following fields are never pulled up or down.
  function positionButtons(entry, el) {
    // Layout measurement (browser only): jsdom reports 0, so fall back to a
    // nominal 40px field — the negative top must ALWAYS be applied.
    const measured = el.getBoundingClientRect().height;
    const fieldH = measured > 0 ? measured : 40;
    let marginBottom = 0;
    const view = el.ownerDocument ? el.ownerDocument.defaultView : null;
    if (view && typeof view.getComputedStyle === "function") {
      const mb = parseFloat(view.getComputedStyle(el).marginBottom);
      if (isFinite(mb) && mb > 0) marginBottom = Math.min(mb, 40);
    }
    entry.wrapper.style.top = -Math.round(fieldH / 2 + marginBottom) + "px";
  }

  function ensureButtons(el, doc) {
    let entry = buttonMap.get(el);
    if (entry && entry.wrapper && entry.wrapper.isConnected) {
      updateButtonState(entry, el);
      positionButtons(entry, el);
      return;
    }
    if (entry && entry.wrapper) {
      entry.wrapper.remove();
      buttonMap.delete(el);
    }
    entry = createButtons(el, doc);
    buttonMap.set(el, entry);
    updateButtonState(entry, el);
    const parent = el.parentNode;
    if (parent) parent.insertBefore(entry.wrapper, el.nextSibling);
    positionButtons(entry, el);
  }

  // ------------------------------------------------------------------
  // Scanning + page lifecycle
  // ------------------------------------------------------------------

  function scanPage() {
    if (!window.jobAppToolkit.content.isModuleActive(MODULE_ID) || !isWhitelisted()) {
      teardown();
      return;
    }
    // Walk same-origin iframe documents exactly like collectFilledFieldsAll
    // does, WITHOUT force: frames that carry their own content script are
    // marked data-jtk-injected and skipped (they render their own buttons),
    // while unmarked frames — where Firefox did not inject a script — are
    // rendered into by this frame. Each document gets its own stylesheet and
    // its own wrapper set.
    forEachSameOriginDoc((doc) => {
      injectStyles(doc);
      const fields = discoverFields(doc);
      for (const field of fields) ensureButtons(field.el, doc);
    });
  }

  function teardown() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(scanTimer);
    // Remove wrappers + stylesheet from every document this frame rendered
    // into (this document and unmarked same-origin iframes), since unmarked
    // frames have no content script of their own to clean up. Marked frames
    // tear down through their own script. forEachSameOriginDoc swallows
    // per-document errors, so the walk is safe even when a frame is gone.
    forEachSameOriginDoc((doc) => {
      const wrappers = doc.querySelectorAll("." + BTN_WRAPPER_CLASS);
      for (const w of wrappers) w.remove();
      const style = doc.getElementById(STYLE_ID);
      if (style) style.remove();
    });
    buttonMap = new WeakMap();
  }

  let observer = null;
  let scanTimer = null;

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanPage, 150);
  }

  function startObserving() {
    if (observer) observer.disconnect();
    const target = document.body || document.documentElement;
    if (!target) return;
    try {
      observer = new MutationObserver(scheduleScan);
      observer.observe(target, { childList: true, subtree: true });
    } catch (err) {
      observer = null;
    }
  }

  // Late-loading safety net: form iframes can be created after the initial
  // scan, and a top-document MutationObserver never crosses document
  // boundaries. A cheap periodic tick re-scans everything (scanPage
  // self-tears-down when the module is off or the page is not whitelisted).
  function pollTick() {
    try {
      scanPage();
    } catch (err) {
      // Never fatal.
    }
  }

  async function ensureActive() {
    if (!window.jobAppToolkit.content.isModuleActive(MODULE_ID)) {
      teardown();
      return;
    }
    await loadConfig();
    startObserving();
    scanPage();
  }

  // ------------------------------------------------------------------
  // AI spinner
  // ------------------------------------------------------------------
  //
  // While an "Answer with AI" request is pending, the background asks this
  // frame to show a small ring spinner on the field about to be filled (no
  // toast — the spinner IS the feedback). It is a single fixed-position
  // element, one per document, anchored to the field by getBoundingClientRect
  // so the field's own styles are never mutated. The element is created in the
  // field's OWNER document — which is also the frame the message landed in —
  // so the same code serves fields inside same-origin iframes (position:fixed
  // is viewport-relative, and the iframe's viewport moves with the iframe, so
  // the spinner stays glued to the field even when the parent page scrolls).
  //
  // The spinner is purely message-driven (show:true → render, show:false →
  // remove). teardown() deliberately does NOT touch it: the AI flow also runs
  // on non-whitelisted pages, where scanPage's 2s poll calls teardown() on
  // every tick, which would kill an in-flight spinner.
  //
  // Stable contract for the harness: element is div.jtk-ff-spinner with
  // aria-hidden="true", created in the target field's document with inline
  // left/top; the CSS lives in a #jtk-form-filler-spinner-styles <style> in
  // the same document (.jtk-ff-spinner rule + @keyframes jtk-ff-spin) and is
  // removed when the spinner hides.

  let spinnerEl = null;       // the visible ring, if any
  let spinnerField = null;    // the field the ring tracks
  let spinnerTimer = null;    // rAF id (or stub-safe timeout id) of the loop
  let spinnerLastTick = 0;    // clock of the last loop tick, for the rAF guard
  let spinnerPlaced = false;  // false until the first position is set
  let spinnerShownAt = 0;     // clock value when the ring appeared, for the max-age watchdog

  // Spinner CSS is its own <style> — not the button stylesheet — because the
  // AI flow also runs on non-whitelisted pages where the button styles are
  // never injected. It is created on demand in the field's document and
  // removed again on hide.
  function injectSpinnerStyles(doc) {
    const root = doc || document;
    if (root.getElementById(SPINNER_STYLE_ID)) return;
    const style = root.createElement("style");
    style.id = SPINNER_STYLE_ID;
    style.textContent =
      // Border-trick ring: a light full border with a colored arc on top that
      // rotates. position:fixed anchors it to the field's viewport; opacity
      // comes from the semi-transparent track + solid arc. pointer-events:none
      // keeps every interaction on the page underneath, and the z-index sits
      // just below the core toast layer (2147483647) so a toast can always
      // paint above it.
      ".jtk-ff-spinner{position:fixed;width:14px;height:14px;box-sizing:border-box;border:2px solid rgba(0,0,0,.18);border-top-color:#2563eb;border-radius:50%;pointer-events:none;z-index:2147483000;animation:jtk-ff-spin .7s linear infinite;}" +
      "@keyframes jtk-ff-spin{to{transform:rotate(360deg)}}";
    (root.head || root.documentElement).appendChild(style);
  }

  function positionSpinner() {
    if (!spinnerEl || !spinnerField) return;
    try {
      if (!spinnerField.isConnected) return; // field gone mid-flight: keep the last spot
      const rect = spinnerField.getBoundingClientRect();
      const view = spinnerEl.ownerDocument.defaultView || window;
      const vw = view.innerWidth || 0;
      const vh = view.innerHeight || 0;
      // Treat an unknown viewport size (0) as "everything is on-screen" so a
      // layout-less environment still gets a position; otherwise bail out and
      // keep the last on-screen position once the field scrolls away.
      const onScreen =
        (vw <= 0 || (rect.left < vw && rect.right > 0)) &&
        (vh <= 0 || (rect.top < vh && rect.bottom > 0));
      if (spinnerPlaced && !onScreen) return;
      spinnerPlaced = true;
      // Park the ring at the field's top-left corner, inset 6px from the
      // corner so the 14px ring sits fully inside the visible box (the input
      // caret and first characters start further in). pointer-events:none
      // keeps typing/interaction unaffected even though it overlays text.
      spinnerEl.style.left = Math.round(rect.left + 6) + "px";
      spinnerEl.style.top = Math.round(rect.top + 6) + "px";
    } catch (err) {
      // Never fatal.
    }
  }

  function trackSpinner() {
    if (!spinnerEl) return; // hidden while a callback was queued: loop ends
    positionSpinner();
    const view = spinnerEl.ownerDocument.defaultView || window;
    const now = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    // Max-age watchdog: if the ring has been up longer than the background's
    // whole AI flow could possibly last, the hide message is never coming
    // (background died, extension reloaded mid-flight). Clean up instead of
    // leaving a phantom spinner anchored to a field forever.
    if (now - spinnerShownAt > SPINNER_MAX_AGE_MS) {
      hideAiSpinner();
      return;
    }
    // Normal browsers fire rAF once per frame (~16ms), so the loop always
    // reschedules via rAF. If an environment fires rAF synchronously (some
    // test stubs), the elapsed time is tiny and we fall back to a macrotask
    // so the loop can never recurse synchronously.
    const viaRaf = now - spinnerLastTick >= 8;
    spinnerLastTick = now;
    spinnerTimer = viaRaf
      ? view.requestAnimationFrame(trackSpinner)
      : view.setTimeout(trackSpinner, 16);
  }

  function showAiSpinner(el) {
    hideAiSpinner(); // replace any spinner already showing
    const doc = el.ownerDocument || document;
    injectSpinnerStyles(doc);
    const holder = doc.body || doc.documentElement;
    if (!holder) return;
    spinnerEl = doc.createElement("div");
    spinnerEl.className = SPINNER_CLASS;
    spinnerEl.setAttribute("aria-hidden", "true");
    holder.appendChild(spinnerEl);
    spinnerField = el;
    positionSpinner();
    const view = doc.defaultView || window;
    view.addEventListener("scroll", positionSpinner, true);
    view.addEventListener("resize", positionSpinner, true);
    spinnerShownAt = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    trackSpinner();
  }

  function hideAiSpinner() {
    if (spinnerTimer !== null) {
      const view =
        (spinnerEl && spinnerEl.ownerDocument.defaultView) ||
        (spinnerField && spinnerField.ownerDocument && spinnerField.ownerDocument.defaultView) ||
        window;
      // One of the two is the right cancel for the stored id; the other is a
      // guaranteed no-op, so calling both is safe either way.
      view.cancelAnimationFrame(spinnerTimer);
      view.clearTimeout(spinnerTimer);
      spinnerTimer = null;
    }
    if (spinnerEl) {
      const doc = spinnerEl.ownerDocument;
      const view = doc.defaultView || window;
      view.removeEventListener("scroll", positionSpinner, true);
      view.removeEventListener("resize", positionSpinner, true);
      if (spinnerEl.parentNode) spinnerEl.parentNode.removeChild(spinnerEl);
      const style = doc.getElementById(SPINNER_STYLE_ID);
      if (style) style.remove();
      spinnerEl = null;
    }
    spinnerField = null;
    spinnerPlaced = false;
    spinnerShownAt = 0;
  }

  function handleAiSpinner(show, targetElementId) {
    if (!show) {
      hideAiSpinner();
      return { ok: true };
    }
    const el = resolveFieldElement(targetElementId);
    if (!el) return { ok: false };
    showAiSpinner(el);
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------

  try {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" || !changes[STORAGE_KEY]) return;
      ensureActive();
    });
  } catch (err) {
    // Never fatal (e.g. harness stubs without storage.onChanged).
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureActive);
  } else {
    ensureActive();
  }
  setInterval(pollTick, 2000);

  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== "string") return undefined;

    // Module activity broadcasts (jtk:*) are also handled by core/content.js
    // (it caches the active flag); here we attach or tear down the in-page
    // buttons in response to a toggle.
    if (message.type === "jtk:moduleActivityChanged") {
      if (message.id === MODULE_ID) {
        if (message.active) ensureActive();
        else teardown();
      }
      return undefined;
    }

    // Core message types (jtk:*) — activity broadcasts and toasts — are
    // handled by core/content.js. This content script only serves its own
    // module's (prefixed) messages.
    if (
      !window.jobAppToolkit.content.isModuleActive(MODULE_ID) ||
      message.type.indexOf(MODULE_ID + ":") !== 0
    ) {
      return undefined;
    }
    const type = message.type.slice(MODULE_ID.length + 1);

    if (type === "fillPage") {
      return Promise.resolve(fillPageAll(message.activeProfile, message.force === true));
    }
    if (type === "getFocusedField") {
      return Promise.resolve(getFocusedField(message.targetElementId));
    }
    if (type === "collectFields") {
      return Promise.resolve(collectFilledFieldsAll(message.profileFields, message.force === true));
    }
    if (type === "getAIFieldInfo") {
      const el = resolveFieldElement(message.targetElementId);
      if (!el) {
        return Promise.resolve({
          ok: false,
          error: "No fillable field at the right-clicked element."
        });
      }
      return Promise.resolve(describeAIField(el));
    }
    if (type === "fillAIField") {
      const el = resolveFieldElement(message.targetElementId);
      if (!el) {
        return Promise.resolve({
          ok: false,
          error: "The field is no longer available on this page."
        });
      }
      if (el.tagName === "SELECT" || el.type === "checkbox") {
        return Promise.resolve({ ok: false, error: "Not a text field." });
      }
      setNativeValue(el, String(message.value == null ? "" : message.value));
      return Promise.resolve({ ok: true });
    }
    if (type === "aiSpinner") {
      // Background signals the AI answer is in flight: show the ring on the
      // target field (or clear it once the answer lands).
      return Promise.resolve(handleAiSpinner(message.show !== false, message.targetElementId));
    }
    return undefined;
  });
})();
