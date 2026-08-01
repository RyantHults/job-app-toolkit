// Form Filler — content script (Firefox WebExtensions, Manifest V2).
// Discovers fillable form fields, matches them against the active profile,
// fills only empty fields (never overwrites existing values), and reports
// results back to the popup. Also serves the "add current field" flow.
(function () {
  "use strict";

  // Fillable <input> types. An <input> with no type defaults to "text" and is
  // included automatically; hidden/submit/button/reset/file/password/checkbox/
  // radio are excluded by not being in this set.
  const FILLABLE_INPUT_TYPES = new Set(["text", "email", "tel", "url", "number"]);

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

  function getLinkedLabelText(el) {
    if (!el.id) return "";
    const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    return label ? label.textContent : "";
  }

  function getParentLabelText(el) {
    const label = el.closest("label");
    return label ? label.textContent : "";
  }

  function getAriaLabelledbyText(el) {
    const ids = el.getAttribute("aria-labelledby");
    if (!ids) return "";
    const parts = [];
    for (const id of ids.split(/\s+/)) {
      const ref = document.getElementById(id);
      if (ref) parts.push(ref.textContent);
    }
    return parts.join(" ");
  }

  // Walk up to the enclosing <fieldset> and use its <legend>; otherwise scan
  // backwards in document order for the closest preceding heading / label-ish
  // element. The walker approach naturally covers preceding siblings, ancestors
  // and the preceding siblings of ancestors.
  function getHeaderLikeText(el) {
    const fieldset = el.closest("fieldset");
    if (fieldset) {
      const legend = fieldset.querySelector(":scope > legend");
      if (legend && legend.textContent.trim() !== "") return legend.textContent;
    }
    if (!document.body || !document.body.contains(el)) return "";
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
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
  function getCandidates(el) {
    const candidates = [];
    const add = (text) => {
      const norm = normalize(text);
      if (norm) candidates.push(norm);
    };
    add(el.name);
    add(el.id);
    add(el.getAttribute("placeholder"));
    add(getLinkedLabelText(el));
    add(getParentLabelText(el));
    add(el.getAttribute("aria-label"));
    add(getAriaLabelledbyText(el));
    add(getHeaderLikeText(el));
    // Deduplicate while preserving priority order.
    return Array.from(new Set(candidates));
  }

  function discoverFields() {
    const fields = [];
    const nodes = document.querySelectorAll("input, textarea, select");
    for (const el of nodes) {
      if (isFillable(el)) fields.push({ el, candidates: getCandidates(el) });
    }
    return fields;
  }

  // ------------------------------------------------------------------
  // Matching
  // ------------------------------------------------------------------

  // Match each profile key to at most one field, and each field to at most one
  // profile key. Exact candidate matches win over "contains" matches.
  function matchFields(fields, fieldList) {
    const profileKeys = Object.keys(fields)
      .map((raw) => ({ raw, norm: normalize(raw) }))
      .filter((k) => k.norm !== "");

    const matches = [];
    const usedFields = new Set();
    const usedKeys = new Set();

    // Pass 1 — exact matches (first field in document order wins).
    for (const pk of profileKeys) {
      for (const field of fieldList) {
        if (usedFields.has(field.el)) continue;
        if (field.candidates.includes(pk.norm)) {
          matches.push({ key: pk.raw, field });
          usedFields.add(field.el);
          usedKeys.add(pk.raw);
          break;
        }
      }
    }

    // Pass 2 — contains matches (profile key in candidate or vice versa).
    // Prefer the highest-priority candidate, then the longest candidate.
    for (const pk of profileKeys) {
      if (usedKeys.has(pk.raw)) continue;
      let best = null;
      for (const field of fieldList) {
        if (usedFields.has(field.el)) continue;
        for (let i = 0; i < field.candidates.length; i++) {
          const cand = field.candidates[i];
          if (cand.includes(pk.norm) || pk.norm.includes(cand)) {
            if (
              !best ||
              i < best.candIdx ||
              (i === best.candIdx && cand.length > best.cand.length)
            ) {
              best = { key: pk.raw, field, candIdx: i, cand };
            }
            break;
          }
        }
      }
      if (best) {
        matches.push({ key: best.key, field: best.field });
        usedFields.add(best.field.el);
        usedKeys.add(best.key);
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

  // Returns true if the field was filled, false if it was skipped (e.g. a
  // <select> with no matching option).
  function fillField(el, value) {
    if (el.tagName === "SELECT") {
      const norm = normalize(value);
      let option = null;
      for (const opt of el.options) {
        if (normalize(opt.textContent) === norm) {
          option = opt;
          break;
        }
      }
      if (!option) return false; // no matching option — leave untouched
      el.value = option.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    setNativeValue(el, String(value));
    return true;
  }

  // ------------------------------------------------------------------
  // Message handlers
  // ------------------------------------------------------------------

  function fillPage(activeProfile) {
    const profile = activeProfile && typeof activeProfile === "object" ? activeProfile : {};
    const fields =
      profile.fields && typeof profile.fields === "object" ? profile.fields : {};

    // Entries without a usable value cannot be filled — ignore them entirely.
    const usable = {};
    for (const key of Object.keys(fields)) {
      const v = fields[key];
      if (v !== undefined && v !== null && String(v) !== "") usable[key] = v;
    }

    const fieldList = discoverFields();
    const matches = matchFields(usable, fieldList);

    let filled = 0;
    let skipped = 0;
    const matchedKeys = new Set();

    for (const m of matches) {
      const el = m.field.el;
      // Hard rule: never overwrite. A non-empty value (or an existing
      // selection on a <select>) counts as skipped.
      if (el.value !== "") {
        skipped++;
        matchedKeys.add(m.key);
        continue;
      }
      if (fillField(el, usable[m.key])) {
        filled++;
        matchedKeys.add(m.key);
      }
    }

    const unmatched = Object.keys(usable).filter((k) => !matchedKeys.has(k));
    return { filled, skipped, unmatched };
  }

  function getFocusedField() {
    const el = document.activeElement;
    if (!isFillable(el)) return null;

    const candidates = getCandidates(el);
    const name = candidates[0] || el.name || el.id || "";

    // Most descriptive human-readable label: real label text first, then
    // placeholder, then name/id.
    const label =
      getLinkedLabelText(el) ||
      getParentLabelText(el) ||
      getAriaLabelledbyText(el) ||
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.name ||
      el.id ||
      "";
    let fieldLabel = String(label).trim().replace(/\s+/g, " ");
    if (fieldLabel.length > 120) fieldLabel = fieldLabel.slice(0, 120) + "\u2026";

    return { name, value: el.value, fieldLabel };
  }

  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== "string") return undefined;
    if (message.type === "fillPage") {
      return Promise.resolve(fillPage(message.activeProfile));
    }
    if (message.type === "getFocusedField") {
      return Promise.resolve(getFocusedField());
    }
    return undefined;
  });
})();
