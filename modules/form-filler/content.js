// Form Filler — content script module (Firefox WebExtensions, Manifest V2).
// Discovers fillable form fields, matches them against the active profile,
// fills only empty fields (never overwrites existing values), and reports
// results back to the caller (background or the module options page). Also
// serves the "add current field" capture flow. No-ops while the module is
// toggled off in the Job App Toolkit popup.
(function () {
  "use strict";

  const MODULE_ID = "form-filler";
  const STORAGE_KEY = "jobAppToolkit";

  // Modules can be toggled off from the popup. Keep a cached flag (refreshed on
  // load and via a broadcast from the background) so handlers no-op cheaply
  // when inactive. Absent data means the module is active by default.
  let moduleActive = true;

  function isActiveInStore(data) {
    const mod = data && data.modules && data.modules[MODULE_ID];
    return mod ? mod.active === true : true;
  }

  async function refreshActive() {
    try {
      const res = await browser.storage.sync.get(STORAGE_KEY);
      moduleActive = isActiveInStore(res[STORAGE_KEY]);
    } catch (err) {
      moduleActive = true;
    }
  }
  refreshActive();

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
    'h1, h2, h3, h4, h5, h6, [class*="label" i], [class*="title" i], b, strong';

  // ------------------------------------------------------------------
  // Normalisation
  // ------------------------------------------------------------------

  // Lowercase and collapse runs of underscores / hyphens / whitespace to a
  // single space, then trim, so "first_name", "firstName" and "First Name"
  // all compare equal.
  function normalize(str) {
    return String(str == null ? "" : str)
      .toLowerCase()
      .replace(/[_\-\s]+/g, " ")
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

  // Walk up to the enclosing <fieldset> and use its <legend>; otherwise scan
  // backwards in document order for the closest preceding heading / label-ish
  // element. The walker approach naturally covers preceding siblings, ancestors
  // and the preceding siblings of ancestors.
  function getHeaderLikeText(el, doc) {
    const root = doc || document;
    const fieldset = el.closest("fieldset");
    if (fieldset) {
      const legend = fieldset.querySelector(":scope > legend");
      if (legend && legend.textContent.trim() !== "") return legend.textContent;
    }
    if (!root.body || !root.body.contains(el)) return "";
    const walker = root.createTreeWalker(root.body, NodeFilter.SHOW_ELEMENT);
    walker.currentNode = el;
    let node;
    while ((node = walker.previousNode())) {
      if (node.matches && node.matches(HEADER_SELECTOR)) {
        const text = node.textContent.trim();
        if (text.length > 0 && text.length < 200) return text;
      }
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
  // one entry. Exact candidate matches win over "contains" matches.
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

    return matches;
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

    for (const m of matches) {
      const el = m.field.el;
      // Hard rule: never overwrite. For text-like fields a non-empty value
      // counts as filled; for checkboxes the current checked state is the
      // "value", so a box that already matches its target state is skipped.
      const isCheckbox = el.type === "checkbox";
      const target = m.entry.value;
      const isFilled = isCheckbox
        ? el.checked === isTruthyBoolean(target)
        : el.value !== "";
      if (isFilled) {
        skipped++;
        matchedKeys.add(m.key);
        continue;
      }
      if (fillField(el, target)) {
        filled++;
        matchedKeys.add(m.key);
      }
    }

    const unmatched = entries.filter((e) => !matchedKeys.has(e.key)).length;
    return { filled, skipped, unmatched, matched: matchedKeys.size };
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

  function getFocusedField(targetElementId) {
    const el = resolveFieldElement(targetElementId);
    if (!el) return null;

    const candidates = getCandidates(el);

    // Matching key: the element's actual name/id first (never placeholder
    // text), then the title above, then any remaining candidate.
    const rawName = String(el.name || el.id || "").trim();
    const name = rawName || getFieldTitle(el) || candidates[0] || "";

    let fieldLabel = getFieldTitle(el) || rawName || candidates[0] || "";
    if (fieldLabel.length > 120) fieldLabel = fieldLabel.slice(0, 120) + "\u2026";

    const value = el.type === "checkbox" ? String(el.checked) : el.value;
    return { name, value, fieldLabel };
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
      const rawName = String(el.name || el.id || "").trim();
      const name = rawName || getFieldTitle(el, root) || field.candidates[0] || "";
      if (!name) {
        skippedEmpty++;
        continue;
      }
      const value = el.type === "checkbox" ? String(el.checked) : el.value;
      if (value === undefined || value === null || String(value) === "") {
        skippedEmpty++;
        continue;
      }
      if (matchFields(entries, [field]).length > 0) {
        skippedExisting++;
        continue;
      }
      let fieldLabel = getFieldTitle(el, root) || rawName || field.candidates[0] || "";
      if (fieldLabel.length > 120) fieldLabel = fieldLabel.slice(0, 120) + "\u2026";
      results.push({ name, value, fieldLabel });
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
    const totals = { filled: 0, skipped: 0, unmatched: 0, docs: 0 };
    let matched = 0;
    forEachSameOriginDoc(
      (doc) => {
        totals.docs++;
        const r = fillPage(activeProfile, doc);
        totals.filled += r.filled;
        totals.skipped += r.skipped;
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

  // Fill only the right-clicked/focused field, if it matches a profile entry.
  // Skips non-empty fields unless overwrite is requested.
  function fillFocusedField(fields, overwrite, targetElementId) {
    const el = resolveFieldElement(targetElementId);
    if (!el) return { filled: 0, skipped: 0, unmatched: 0, noField: true };

    const entries = buildMatchEntries(fields);
    const matches = matchFields(entries, [{ el, candidates: getCandidates(el) }]);
    if (matches.length === 0) {
      return { filled: 0, skipped: 0, unmatched: entries.length };
    }
    const m = matches[0];
    const isCheckbox = el.type === "checkbox";
    const isFilled = isCheckbox
      ? el.checked === isTruthyBoolean(m.entry.value)
      : el.value !== "";
    if (!overwrite && isFilled) {
      return { filled: 0, skipped: 1, unmatched: 0 };
    }
    if (fillField(el, m.entry.value)) {
      return { filled: 1, skipped: 0, unmatched: 0, key: m.key };
    }
    return { filled: 0, skipped: 1, unmatched: 0, key: m.key };
  }

  // In-page confirmation toast, injected into the page so feedback never
  // depends on OS desktop notifications. A new toast replaces any previous one.
  let toastEl = null;
  function showToast(text) {
    if (!text) return;
    if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
    toastEl = document.createElement("div");
    toastEl.setAttribute("role", "status");
    toastEl.textContent = text;
    Object.assign(toastEl.style, {
      position: "fixed",
      top: "16px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      maxWidth: "80vw",
      boxSizing: "border-box",
      padding: "10px 16px",
      borderRadius: "8px",
      background: "#1f2937",
      color: "#ffffff",
      fontSize: "13px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      lineHeight: "1.4",
      boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
      pointerEvents: "none",
      opacity: "0",
      transition: "opacity 0.2s ease"
    });
    (document.body || document.documentElement).appendChild(toastEl);
    requestAnimationFrame(() => {
      toastEl.style.opacity = "1";
    });
    setTimeout(() => {
      if (!toastEl || !toastEl.parentNode) return;
      toastEl.style.opacity = "0";
      setTimeout(() => {
        if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
      }, 200);
    }, 3500);
  }

  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== "string") return undefined;

    // Activity toggle broadcast from the background — update the cached flag
    // without needing a storage read.
    if (message.type === "jtk:moduleActivityChanged") {
      if (message.id === MODULE_ID) moduleActive = Boolean(message.active);
      return undefined;
    }

    // In-page feedback from the background (works regardless of module state).
    if (message.type === "jtk:showToast") {
      const text = message.title ? message.title + ": " + message.message : message.message;
      showToast(text);
      return undefined;
    }

    // This content script only serves its own module's (prefixed) messages.
    if (!moduleActive || message.type.indexOf(MODULE_ID + ":") !== 0) return undefined;
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
    if (type === "fillFocusedField") {
      return Promise.resolve(
        fillFocusedField(message.fields, Boolean(message.overwrite), message.targetElementId)
      );
    }
    return undefined;
  });
})();
