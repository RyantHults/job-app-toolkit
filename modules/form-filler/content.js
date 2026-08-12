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
  // included automatically; hidden/submit/button/reset/file/password are
  // excluded by not being in this set. Checkboxes and radios are choice
  // controls: a checkbox is a boolean field whose profile value
  // ("true"/"false", "yes"/"no", ...) controls the checked state — or, when
  // part of a multi-answer question group, one option of an array-valued
  // answer — and radios belong to same-named groups filled as one question.
  const FILLABLE_INPUT_TYPES = new Set(["text", "email", "tel", "url", "number", "checkbox", "radio"]);

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
  // (nothing at all, or only elements outside the fieldset). Returns the
  // matched ELEMENT (a <legend> included); both the text form (getFieldTitle /
  // getHeaderLikeText) and the element form (getTitleElement) share this walk.
  function walkHeaderLike(el, doc) {
    const root = doc || document;
    if (!root.body || !root.body.contains(el)) return null;
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
            if (legend && legend.textContent.trim() !== "") return legend;
          }
          return node;
        }
      }
    }
    const fieldset = el.closest("fieldset");
    if (fieldset) {
      const legend = fieldset.querySelector(":scope > legend");
      if (legend && legend.textContent.trim() !== "") return legend;
    }
    return null;
  }

  function getHeaderLikeText(el, doc) {
    const node = walkHeaderLike(el, doc);
    return node ? node.textContent.trim() : "";
  }

  // Title elements flagged as SECTION HEADERS — a title covering more than one
  // question (an <h2> above several unrelated fields, a shared <fieldset>
  // <legend> spanning several distinct questions). Computed per document by
  // the kind-aware pre-pass (computeSectionHeaderTitles) and consulted by the
  // SAVE side so a section header is never stored as a question's key/label.
  // Fill-side matching deliberately does NOT consult it — previously-saved
  // section-header-keyed entries must keep filling.
  let currentSectionHeaders = new Set();

  // The RAW title-element resolution (no section-header suppression): linked
  // label[for], parent <label>, aria-labelledby element, then the header-like
  // walk (which falls back to a <fieldset> <legend> when the walk finds
  // nothing usable). The section-header pre-pass uses this so it can compute
  // the suppression set without circularity. An aria-label attribute has no
  // element, so it contributes nothing here.
  function rawTitleElement(el, doc) {
    const root = doc || document;
    if (el.id) {
      const label = root.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label) return label;
    }
    const parentLabel = el.closest("label");
    if (parentLabel) return parentLabel;
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      for (const id of labelledby.split(/\s+/)) {
        const ref = root.getElementById(id);
        if (ref) return ref;
      }
    }
    return walkHeaderLike(el, root);
  }

  // The actual DOM element that reads as a field's question title (used to
  // place the in-page buttons), mirroring getFieldTitle's priority but
  // returning the element instead of its text. Identical to rawTitleElement
  // except an element flagged as a section header resolves to null — its text
  // is never a single question's own title. Returns null when no title element
  // exists — button placement then falls back to the field itself.
  function getTitleElement(el, doc) {
    const t = rawTitleElement(el, doc);
    return t && currentSectionHeaders.has(t) ? null : t;
  }

  // Kind-aware section-header pre-pass. A title element that reads as covering
  // MORE THAN ONE question is a section header — never a valid single-question
  // key/label. Singles each form their own question, so a title resolving for
  // ≥2 fields with ANY single-answer resolver is flagged; a title resolving
  // only for radio/multiChoice fields is flagged iff those resolvers carry ≥2
  // DISTINCT non-empty `name`s (same-named or all-nameless choice controls are
  // ONE question — their title is a real question title and stays usable).
  function computeSectionHeaderTitles(root) {
    const flags = new Set();
    const byTitle = new Map();
    for (const f of discoverFields(root)) {
      const t = rawTitleElement(f.el, root);
      if (!t) continue;
      if (!byTitle.has(t)) byTitle.set(t, []);
      byTitle.get(t).push(f);
    }
    for (const [t, resolvers] of byTitle) {
      if (resolvers.length < 2) continue;
      let hasSingle = false;
      let hasChoice = false;
      const names = new Set();
      for (const f of resolvers) {
        const kind = classifyField(f.el);
        if (kind === "single") hasSingle = true;
        else hasChoice = true;
        const n = String(f.el.name || "").trim();
        if (n) names.add(n);
      }
      if (hasSingle) {
        flags.add(t);
      } else if (hasChoice && names.size >= 2) {
        flags.add(t);
      }
    }
    return flags;
  }

  // Lazy section-header ensure for save-side paths that do not run
  // discoverGroups (the focused-capture flow). Recomputes when the cached set
  // is empty or holds elements from a different document (the same-origin
  // iframe walk covers several documents, and the set is reset per scan).
  function ensureSectionHeaders(root) {
    let valid = true;
    for (const t of currentSectionHeaders) {
      if (!root.contains(t)) {
        valid = false;
        break;
      }
    }
    if (currentSectionHeaders.size === 0 || !valid) {
      currentSectionHeaders = computeSectionHeaderTitles(root);
    }
    return currentSectionHeaders;
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
  // Question grouping
  // ------------------------------------------------------------------
  //
  // A question is either one single-answer control or a set of choice controls
  // (checkboxes, same-named radios, a multiple select) that together answer
  // one question. Groups let the in-page buttons render once per question and
  // let multi-answer questions save/fill an ARRAY of selected options. A group
  // carries: kind ("single" | "radio" | "multiChoice"), inputs (the fillable
  // elements), titleEl (the title ELEMENT for button placement, may be null),
  // titleText (whitespace-collapsed question text), key (cleaned storage-key
  // candidate), container (fieldset/shared container, may be null) and anchor
  // (the stable element the button map is keyed by).

  // Classify a fillable element: single-answer controls vs the choice controls
  // that participate in question grouping.
  function classifyField(el) {
    if (el.tagName === "SELECT") return el.multiple ? "multiChoice" : "single";
    if (el.tagName === "TEXTAREA") return "single";
    if (el.tagName === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "radio") return "radio";
      if (type === "checkbox") return "multiChoice";
      return "single";
    }
    return "single";
  }

  // The option label for a choice control: its linked label, else its wrapping
  // label, else "" (callers fall back to the value attribute).
  function getInputLabelText(el) {
    const doc = el.ownerDocument || document;
    return getLinkedLabelText(el, doc) || getParentLabelText(el) || "";
  }

  function collapseWs(str) {
    return String(str == null ? "" : str).trim().replace(/\s+/g, " ");
  }

  // Is this header-like element an OPTION label rather than a question title:
  // a <label> that wraps a fillable control (its own or a sibling option's),
  // or whose `for` points at a control inside the container, OR a non-LABEL
  // element (Ashby renders option labels as <span class="_label_...">) that
  // is a sibling of a fillable control under a parent holding exactly one
  // fillable — it titles that option, never a question.
  function isOptionLabel(node, container) {
    if (!node) return false;
    if (node.tagName === "LABEL") {
      if (node.querySelector("input, textarea, select")) return true;
      const forId = node.getAttribute && node.getAttribute("for");
      if (forId && container.querySelector("#" + CSS.escape(forId))) return true;
      return false;
    }
    // Non-LABEL option label: shares a parent with exactly one fillable
    // control (Ashby's <span class="_label_132c8_93"> sits next to its radio
    // inside <span class="_container_132c8_28">). Question titles sit above
    // several fillables, so a parent with a single fillable is an option row.
    const parent = node.parentElement;
    if (!parent || !parent.querySelectorAll) return false;
    const fillables = parent.querySelectorAll("input, textarea, select");
    return fillables.length === 1;
  }

  // The closest preceding title element for a field, walking backward in
  // document order within `container` (the walk never leaves it). For
  // multiChoice AND radio fields option labels do NOT count as a closer title
  // (they title the options, including a sibling option's); only single fields
  // count any closer title (including their own label).
  function closestPrecedingTitle(el, container) {
    const root = container.ownerDocument || document;
    const walker = root.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    walker.currentNode = el;
    let node;
    while ((node = walker.previousNode())) {
      if (node === container) continue;
      if (node.matches && node.matches(HEADER_SELECTOR)) {
        const text = node.textContent.trim();
        if (!text || text.length >= 200) continue;
        if (classifyField(el) !== "single" && isOptionLabel(node, container)) continue;
        return node;
      }
    }
    return null;
  }

  // A shared container is only a valid QUESTION container when the multi-choice
  // fields it holds all share ONE non-empty name or are all nameless — a
  // container holding 2+ distinct-name questions is a section, not a question,
  // and its fields fall through to name-based grouping instead.
  function containerHoldsOneQuestion(container) {
    if (!container || typeof container.querySelector !== "function") return false;
    const names = new Set();
    let count = 0;
    const nodes = container.querySelectorAll("input, textarea, select");
    for (const el of nodes) {
      if (!isFillable(el)) continue;
      if (classifyField(el) !== "multiChoice") continue;
      count++;
      const n = String(el.name || "").trim();
      if (n) names.add(n);
    }
    if (count === 0) return false;
    return names.size <= 1;
  }

  // A header-like element inside a container that reads as the container's
  // QUESTION title (for the shared-container grouping fallback). Per-option
  // labels — labels wrapping a fillable input, or <label for> pointing at one
  // inside the container — title the options, not the question, and are
  // skipped, as are section headers (a candidate explicitly flagged by the
  // pre-pass, or one with ≥2 fillable fields beneath it that resolve to a
  // closer title inside the container). First match in document order wins.
  function findContainerTitle(container) {
    if (!container || typeof container.querySelector !== "function") return null;
    const root = container.ownerDocument || document;
    const fillables = [];
    const all = root.querySelectorAll("input, textarea, select");
    for (const el of all) {
      if (isFillable(el) && container.contains(el)) fillables.push(el);
    }
    const nodes = container.querySelectorAll(HEADER_SELECTOR);
    for (const node of nodes) {
      const text = node.textContent.trim();
      if (!text || text.length >= 200) continue;
      if (node.tagName === "LABEL") {
        if (node.querySelector("input, textarea, select")) continue;
        const forId = node.getAttribute && node.getAttribute("for");
        if (forId && container.querySelector("#" + CSS.escape(forId))) continue;
      }
      if (currentSectionHeaders.has(node)) continue;
      // Section-header guard: if ≥2 fillable fields in the container have a
      // closer title than this candidate (a title inside the container that is
      // not this candidate), the candidate reads as a section header covering
      // several questions — skip it and keep scanning.
      let coveredElsewhere = 0;
      for (const el of fillables) {
        const closer = closestPrecedingTitle(el, container);
        if (closer && closer !== node && container.contains(closer)) coveredElsewhere++;
        if (coveredElsewhere >= 2) break;
      }
      if (coveredElsewhere >= 2) continue;
      return node;
    }
    return null;
  }

  // Nearest ancestor of `inputs[0]` that contains every input, holds a single
  // multi-choice question (one shared non-empty name, or all nameless) AND has
  // a question title of its own (a header-like/label element that is not a
  // per-option label).
  function findSharedContainer(inputs) {
    if (!inputs || inputs.length < 2) return null;
    const first = inputs[0];
    for (
      let node = first.parentElement;
      node && node.tagName !== "BODY" && node.tagName !== "HTML";
      node = node.parentElement
    ) {
      if (
        inputs.every((el) => node.contains(el)) &&
        containerHoldsOneQuestion(node) &&
        findContainerTitle(node)
      ) {
        return node;
      }
    }
    return null;
  }

  // Resolve a multi-choice group's title, in priority order: fieldset legend,
  // then a shared title element (identical resolved element), then a shared
  // container with a question title of its own. Returns { titleEl, container }
  // (both may be null). No branch may return a section-header title: the
  // fieldset-legend branch rejects flagged legends, getTitleElement already
  // suppresses flagged elements for the shared-title branch, and the container
  // branch nulls a flagged title (findContainerTitle already skips them).
  function resolveGroupTitle(inputs, doc) {
    const root = doc || document;
    const firstFieldset = inputs[0].closest("fieldset");
    if (firstFieldset && inputs.every((el) => el.closest("fieldset") === firstFieldset)) {
      const legend = firstFieldset.querySelector(":scope > legend");
      if (legend && legend.textContent.trim() !== "" && !currentSectionHeaders.has(legend)) {
        return { titleEl: legend, container: firstFieldset };
      }
      // No (usable) legend: a fieldset with a question title of its own is ONE
      // question even when every option carries a distinct `name` (Ashby names
      // options by their label text). findContainerTitle skips per-option
      // labels, flagged section headers, and titles covering 2+ closer-titled
      // fields, so a titled fieldset that really holds several questions still
      // falls through to name-based grouping.
      const fsTitle = findContainerTitle(firstFieldset);
      if (fsTitle) return { titleEl: fsTitle, container: firstFieldset };
    }
    const firstTitle = getTitleElement(inputs[0], root);
    if (
      firstTitle &&
      !currentSectionHeaders.has(firstTitle) &&
      inputs.every((el) => getTitleElement(el, root) === firstTitle)
    ) {
      return { titleEl: firstTitle, container: firstTitle };
    }
    const container = findSharedContainer(inputs);
    if (container) {
      const titleEl = findContainerTitle(container);
      return {
        titleEl: titleEl && !currentSectionHeaders.has(titleEl) ? titleEl : null,
        container
      };
    }
    return { titleEl: null, container: null };
  }

  // Build a question group object from its member inputs. Single groups resolve
  // their title exactly as before (linked/parent label, then the header walk)
  // via getTitleElement; multi-choice groups use the group-title priority
  // (fieldset legend → shared title element → shared container). Radio groups
  // key the button map by their first radio so two radio groups sharing one
  // fieldset legend never collide; single groups key by the input element as
  // before; other multi-choice groups key by the title element when one exists
  // (the post-pass in discoverGroups clears section-header titles, after which
  // the anchor falls back to the group's first input).
  function makeGroup(kind, inputs, doc) {
    const root = doc || document;
    const first = inputs[0];
    let titleEl;
    let container;
    if (kind === "single") {
      titleEl = getTitleElement(first, root);
    } else {
      const title = resolveGroupTitle(inputs, root);
      titleEl = title.titleEl;
      container = title.container || null;
    }
    const titleText = titleEl ? collapseWs(titleEl.textContent) : "";
    const key = cleanFieldName(titleText) || String(first.name || first.id || "").trim();
    return {
      kind,
      inputs,
      titleEl,
      titleText,
      key,
      container,
      anchor: kind === "single" || kind === "radio" ? first : titleEl || first
    };
  }

  // Partition a document's fillable fields into question groups: one group per
  // single-answer control, and one group per set of choice controls answering
  // the same question. Multi-choice grouping priority: nearest <fieldset>,
  // then a shared question title element, then a shared container holding 2+
  // choice inputs and a question title of its own. Radios group by their
  // shared `name` — a radio group is one question; different names are
  // different questions.
  function discoverGroups(doc) {
    const root = doc || document;
    // Section-header pre-pass FIRST: every title resolution below (and the
    // save-side text fallback) consults this set.
    currentSectionHeaders = computeSectionHeaderTitles(root);
    const fields = discoverFields(root);
    const groups = [];
    const singles = [];
    const radios = [];
    const multi = [];

    for (const f of fields) {
      const kind = classifyField(f.el);
      if (kind === "radio") radios.push(f);
      else if (kind === "multiChoice") multi.push(f);
      else singles.push(f);
    }

    // Single-answer controls: each is its own group.
    for (const f of singles) groups.push(makeGroup("single", [f.el], root));

    // Radios: same name = one question; nameless radios stand alone.
    const radioByName = new Map();
    for (const f of radios) {
      const name = f.el.name;
      if (!name) {
        groups.push(makeGroup("radio", [f.el], root));
        continue;
      }
      if (!radioByName.has(name)) radioByName.set(name, []);
      radioByName.get(name).push(f.el);
    }
    for (const els of radioByName.values()) groups.push(makeGroup("radio", els, root));

    // Checkboxes + multiple selects: nearest <fieldset> ancestor first. A
    // fieldset that reads as ONE question — it has a question title of its own
    // (e.g. Ashby renders every "select all that apply" option with a DISTINCT
    // `name` equal to its label text under one question-title <label>) — groups
    // ALL its multi inputs together, regardless of names. A fieldset without
    // such a title can hold several DISTINCT questions (different `name`s, or
    // nameless controls), so its multi inputs are bucketed by non-empty name —
    // one group per distinct name plus one group for the nameless remainder.
    const assigned = new Set();
    const byFieldset = new Map();
    for (const f of multi) {
      const fs = f.el.closest("fieldset");
      if (fs) {
        if (!byFieldset.has(fs)) byFieldset.set(fs, []);
        byFieldset.get(fs).push(f.el);
      }
    }
    for (const [fs, els] of byFieldset.entries()) {
      if (findContainerTitle(fs)) {
        groups.push(makeGroup("multiChoice", els, root));
        for (const el of els) assigned.add(el);
        continue;
      }
      const byName = new Map();
      const nameless = [];
      for (const el of els) {
        const name = String(el.name || "").trim();
        if (name) {
          if (!byName.has(name)) byName.set(name, []);
          byName.get(name).push(el);
        } else {
          nameless.push(el);
        }
      }
      const buckets = Array.from(byName.values());
      if (nameless.length > 0) buckets.push(nameless);
      for (const bucket of buckets) {
        groups.push(makeGroup("multiChoice", bucket, root));
        for (const el of bucket) assigned.add(el);
      }
    }

    // Then a shared question title element (identical resolved element).
    for (const f of multi) {
      if (assigned.has(f.el)) continue;
      const titleEl = getTitleElement(f.el, root);
      if (!titleEl) continue;
      const members = multi.filter(
        (x) => !assigned.has(x.el) && getTitleElement(x.el, root) === titleEl
      );
      if (members.length >= 2) {
        groups.push(makeGroup("multiChoice", members.map((x) => x.el), root));
        for (const x of members) assigned.add(x.el);
      }
    }

    // Then a shared container holding 2+ choice inputs and a question title of
    // its own (e.g. <div class="question"><span class="label">Skills</span>
    // <label><input type=checkbox>Java</label> ... </div>). Only containers
    // whose unassigned multi fields form ONE question (one shared non-empty
    // name, or all nameless) qualify — a container holding 2+ distinct-name
    // questions is a section, not a question, and its fields fall through.
    for (const f of multi) {
      if (assigned.has(f.el)) continue;
      let container = null;
      for (
        let node = f.el.parentElement;
        node && node.tagName !== "BODY" && node.tagName !== "HTML";
        node = node.parentElement
      ) {
        let count = 0;
        for (const x of multi) {
          if (!assigned.has(x.el) && node.contains(x.el)) count++;
        }
        if (count >= 2 && containerHoldsOneQuestion(node) && findContainerTitle(node)) {
          container = node;
          break;
        }
      }
      if (!container) continue;
      const members = multi.filter((x) => !assigned.has(x.el) && container.contains(x.el));
      groups.push(makeGroup("multiChoice", members.map((x) => x.el), root));
      for (const x of members) assigned.add(x.el);
    }

    // Leftover choice controls that share a non-empty `name` still answer one
    // question together (e.g. same-named checkboxes sitting directly under a
    // section header): group them by shared name — one group per name. The
    // standalone loop below then handles only nameless leftovers.
    const multiByName = new Map();
    for (const f of multi) {
      if (assigned.has(f.el)) continue;
      const name = String(f.el.name || "").trim();
      if (!name) continue;
      if (!multiByName.has(name)) multiByName.set(name, []);
      multiByName.get(name).push(f.el);
    }
    for (const els of multiByName.values()) {
      groups.push(makeGroup("multiChoice", els, root));
      for (const el of els) assigned.add(el);
    }

    // Leftover choice controls with no name and no group context: each its own
    // group (a lone checkbox stays a scalar boolean field, exactly as before).
    for (const f of multi) {
      if (assigned.has(f.el)) continue;
      groups.push(makeGroup("multiChoice", [f.el], root));
    }

    // POST-PASS: a title element shared by ≥2 groups is a section header the
    // save path must not key by (e.g. one fieldset legend above two distinct
    // checkbox questions, or two radio groups under one legend). Clear the
    // title on every group that shares it and recompute the storage key from
    // the group's first input (and re-anchor at that input) so identical
    // legend-derived keys can never collide — the buildMatchEntries dedup
    // would silently drop one, and shared anchors would share one button map
    // entry.
    const groupsByTitle = new Map();
    for (const g of groups) {
      if (!g.titleEl) continue;
      if (!groupsByTitle.has(g.titleEl)) groupsByTitle.set(g.titleEl, []);
      groupsByTitle.get(g.titleEl).push(g);
    }
    for (const groupList of groupsByTitle.values()) {
      if (groupList.length < 2) continue;
      for (const g of groupList) {
        g.titleEl = null;
        g.titleText = "";
        g.key = cleanFieldName(String(g.inputs[0].name || g.inputs[0].id || "").trim());
        g.anchor = g.inputs[0];
      }
    }

    return groups;
  }

  // ------------------------------------------------------------------
  // Matching
  // ------------------------------------------------------------------

  // Each stored field can match on two identities: the element's name/id (the
  // profile key) and the human-readable title (label). Build one match entry
  // per usable field, carrying both normalized identities plus the fill value.
  // Values may be scalars (single-answer fields) or ARRAYS (multi-answer
  // questions) — empty scalars carry no data, but an empty array is meaningful
  // (a saved multi-answer question with nothing selected) and must survive.
  function buildMatchEntries(fields) {
    const entries = [];
    for (const key of Object.keys(fields)) {
      const entry = fields[key];
      const isObj = entry && typeof entry === "object" && !Array.isArray(entry);
      const value = isObj ? entry.value : entry;
      if (
        value === undefined ||
        value === null ||
        (!Array.isArray(value) && String(value) === "")
      ) {
        continue;
      }
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
  // as labels (e.g. "United States") and vice versa. An ARRAY value applied to
  // a checkbox or select means "checked/selected iff the array contains this
  // option's value or label" (used for multi-answer questions); scalar values
  // keep their historical behavior.
  function fillField(el, value) {
    if (el.tagName === "SELECT") {
      if (Array.isArray(value)) {
        const norms = value.map(normalize);
        let changed = false;
        for (const opt of el.options) {
          const on =
            norms.indexOf(normalize(opt.value)) !== -1 ||
            norms.indexOf(normalize(opt.textContent)) !== -1;
          if (opt.selected !== on) {
            opt.selected = on;
            changed = true;
          }
        }
        if (changed) el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
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
      let desired;
      if (Array.isArray(value)) {
        const norms = value.map(normalize);
        desired =
          norms.indexOf(normalize(el.value)) !== -1 ||
          norms.indexOf(normalize(getInputLabelText(el))) !== -1;
      } else {
        desired = isTruthyBoolean(value);
      }
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

  // Does a choice-control group already hold the stored state? For an array
  // value: every checkbox/option must already be checked iff its value or
  // label is in the stored array (so a full override is a no-op). For a scalar
  // on a lone checkbox: the box already matches the boolean. Radio groups: the
  // checked radio already matches the stored scalar.
  function groupMatchesStoredState(group, value) {
    if (group.kind === "radio") {
      const norm = normalize(value);
      const checked = group.inputs.find((x) => x.checked);
      if (!checked) return false;
      return (
        normalize(checked.value) === norm || normalize(getInputLabelText(checked)) === norm
      );
    }
    if (group.kind === "multiChoice") {
      if (Array.isArray(value)) {
        const norms = new Set(value.map(normalize));
        const inSet = (text) => norms.has(normalize(text));
        for (const el of group.inputs) {
          if (el.tagName === "SELECT") {
            for (const opt of el.options) {
              if (opt.selected !== (inSet(opt.value) || inSet(opt.textContent))) return false;
            }
          } else if (el.type === "checkbox") {
            if (el.checked !== (inSet(el.value) || inSet(getInputLabelText(el)))) return false;
          }
        }
        return true;
      }
      // Scalar value: only meaningful for a lone checkbox (boolean encoding).
      return (
        group.inputs.length === 1 &&
        group.inputs[0].type === "checkbox" &&
        group.inputs[0].checked === isTruthyBoolean(value)
      );
    }
    return true;
  }

  // Apply a stored value to a whole question group (used by the group fill
  // button and by fillPage). Arrays fully override every checkbox/option:
  // options in the array are selected, everything else is deselected. Radios
  // check the one radio whose value/label matches the scalar. Single groups
  // fall through to fillField.
  function fillGroup(group, value) {
    if (group.kind === "radio") {
      const norm = normalize(value);
      for (const el of group.inputs) {
        const on =
          normalize(el.value) === norm || normalize(getInputLabelText(el)) === norm;
        if (el.checked !== on) {
          el.checked = on;
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      return;
    }
    if (group.kind === "multiChoice") {
      if (Array.isArray(value)) {
        const norms = new Set(value.map(normalize));
        const inSet = (text) => norms.has(normalize(text));
        for (const el of group.inputs) {
          if (el.tagName === "SELECT") {
            let changed = false;
            for (const opt of el.options) {
              const on = inSet(opt.value) || inSet(opt.textContent);
              if (opt.selected !== on) {
                opt.selected = on;
                changed = true;
              }
            }
            if (changed) el.dispatchEvent(new Event("change", { bubbles: true }));
          } else if (el.type === "checkbox") {
            const on = inSet(el.value) || inSet(getInputLabelText(el));
            if (el.checked !== on) {
              el.checked = on;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }
        }
        return;
      }
      // Scalar on a multi group: only a lone checkbox (backward-compatible
      // boolean fill) can consume it.
      if (group.inputs.length === 1 && group.inputs[0].type === "checkbox") {
        fillField(group.inputs[0], value);
      }
      return;
    }
    fillField(group.inputs[0], value);
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

    // Choice controls are matched individually but filled as their question
    // group: an array-valued entry applies to every checkbox/option at once
    // (full override, like the per-question fill button), and a radio entry
    // checks the one matching radio. Matching stays per-element, so each
    // member of a radio/multiChoice group also carries the group's question
    // title identities (that is how a title-keyed multi-answer entry finds the
    // group). Map each fillable element to its group so a group fill runs
    // exactly once.
    const fieldByEl = new Map(fieldList.map((f) => [f.el, f]));
    const groups = discoverGroups(root);
    const groupByEl = new Map();
    for (const g of groups) {
      const titleCands = [];
      for (const t of [g.key, g.titleText]) {
        const n = normalize(t);
        if (n && titleCands.indexOf(n) === -1) titleCands.push(n);
      }
      for (const el of g.inputs) {
        groupByEl.set(el, g);
        if (g.kind === "single") continue;
        const field = fieldByEl.get(el);
        if (!field) continue;
        for (const cand of titleCands) {
          if (field.candidates.indexOf(cand) === -1) field.candidates.push(cand);
        }
      }
    }
    const matches = matchFields(entries, fieldList);
    const handledGroups = new Set();

    let filled = 0;
    let skipped = 0;
    const matchedKeys = new Set();
    const skippedNames = [];

    for (const m of matches) {
      const el = m.field.el;
      const target = m.entry.value;
      const group = groupByEl.get(el);
      const isGroupQuestion = group && (group.kind === "radio" || group.kind === "multiChoice");

      if (isGroupQuestion) {
        matchedKeys.add(m.key);
        if (handledGroups.has(group)) continue;
        handledGroups.add(group);
        // Mismatched value shapes (an array on a radio group, a scalar on a
        // real multi-answer question) cannot be mapped — leave untouched.
        if (
          (group.kind === "radio" && Array.isArray(target)) ||
          (group.kind === "multiChoice" &&
            !Array.isArray(target) &&
            !(group.inputs.length === 1 && group.inputs[0].type === "checkbox"))
        ) {
          continue;
        }
        if (groupMatchesStoredState(group, target)) {
          skipped++;
          skippedNames.push(group.titleText || group.key);
        } else {
          fillGroup(group, target);
          filled++;
        }
        continue;
      }

      // An array value landing on a plain single-answer field cannot be applied
      // (never stringify it) — leave untouched.
      if (Array.isArray(target)) continue;

      // Never overwrite data. A field "has data" when it holds a real value;
      // placeholder prompts (e.g. a dropdown showing "— Make a Selection —"
      // with an internal sentinel value) do not count.
      if (fieldHasData(el)) {
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

  // Save-side-only header-like text: identical to getHeaderLikeText (which fill
  // MATCHING still uses so legacy section-header-keyed entries keep filling)
  // except a walked element flagged as a section header contributes NOTHING —
  // so an unnamed field whose only title is a section header falls through to
  // its placeholder/aria-label instead of being keyed by the section header.
  function getHeaderLikeTextIfLocal(el, doc) {
    const node = walkHeaderLike(el, doc);
    if (!node) return "";
    if (currentSectionHeaders.has(node)) return "";
    return node.textContent.trim();
  }

  // Save-side field title: getFieldTitle's priority, but the header-like-text
  // step is section-header-suppressed (so placeholder wins for a field whose
  // only title is a section header). Only the SAVE side uses this.
  function saveFieldTitle(el, doc) {
    const root = doc || document;
    const title =
      getLinkedLabelText(el, root) ||
      getParentLabelText(el) ||
      getAriaLabelledbyText(el, root) ||
      el.getAttribute("aria-label") ||
      getHeaderLikeTextIfLocal(el, root) ||
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
    // The focused-capture flow does not run discoverGroups, so make sure the
    // section-header set is computed for this document before resolving the
    // save-side title.
    ensureSectionHeaders(root);
    const candidates = getCandidates(el, root);

    // Matching key: the element's actual name/id first (never placeholder
    // text), then the save-side title (section-header-suppressed), then the
    // first candidate that is not the suppressed section-header text — a field
    // whose only title is a section header is never keyed by it. Real name/id
    // attributes are kept verbatim; title text is cleaned of punctuation.
    const rawName = String(el.name || el.id || "").trim();
    const headerNorm = normalize(getHeaderLikeText(el, root));
    const firstNonHeader = candidates.find((c) => c !== headerNorm) || "";
    const saveTitle = cleanFieldName(saveFieldTitle(el, root));

    const name = rawName || saveTitle || firstNonHeader || "";

    let fieldLabel = saveTitle || rawName || firstNonHeader || "";
    if (fieldLabel.length > 120) fieldLabel = fieldLabel.slice(0, 120) + "\u2026";

    const value = el.type === "checkbox" ? String(el.checked) : el.value;
    return { name, value, fieldLabel };
  }

  // Describe a QUESTION GROUP for the save flow: the storage key (cleaned
  // group title for multi-answer questions; the element name/id for singles,
  // exactly as describeField does) and the value — an ARRAY of the selected
  // options' labels (falling back to their value attributes) for multi-answer
  // questions, the checked radio's label/value for radio groups, and the
  // current scalar value for singles. A lone checkbox keeps its historical
  // scalar String(checked) encoding.
  function describeGroup(group) {
    if (group.kind === "single") {
      return describeField(group.inputs[0], group.inputs[0].ownerDocument);
    }
    const titleText = group.titleText;
    const name =
      cleanFieldName(titleText) ||
      String(group.inputs[0].name || group.inputs[0].id || "").trim() ||
      "";
    let fieldLabel = cleanFieldName(titleText) || name;
    if (fieldLabel.length > 120) fieldLabel = fieldLabel.slice(0, 120) + "\u2026";

    let value;
    if (group.kind === "radio") {
      const checked = group.inputs.find((x) => x.checked);
      value = checked ? collapseWs(getInputLabelText(checked)) || checked.value : "";
    } else if (group.inputs.length === 1 && group.inputs[0].type === "checkbox") {
      value = String(group.inputs[0].checked);
    } else {
      value = [];
      for (const el of group.inputs) {
        if (el.tagName === "SELECT") {
          for (const opt of el.selectedOptions) {
            value.push(collapseWs(opt.textContent) || opt.value);
          }
        } else if (el.type === "checkbox" && el.checked) {
          value.push(collapseWs(getInputLabelText(el)) || el.value);
        }
      }
    }
    return { name, value, fieldLabel };
  }

  function getFocusedField(targetElementId) {
    const el = resolveFieldElement(targetElementId);
    if (!el) return null;
    return describeField(el);
  }

  // Subtitle/description copy near the field's question title (e.g. Ashby's
  // .ashby-application-form-question-description) that tells the AI agent what
  // the question is really asking. Scans the title element's container for
  // description/subtitle/hint-styled text positioned AFTER the title, so a
  // container holding several questions can't leak another question's copy
  // into this field's context. Returns collapsed text ("" when none), capped
  // at 800 chars to bound prompt size.
  function fieldSubtitle(el, doc) {
    const root = doc || document;
    const titleEl = getTitleElement(el, root);
    if (!titleEl || !titleEl.parentElement) return "";
    const nodes = titleEl.parentElement.querySelectorAll(
      '[class*="description"], [class*="subtitle"], [class*="hint"], small, em'
    );
    const AFTER = Node.DOCUMENT_POSITION_FOLLOWING;
    for (const node of nodes) {
      if (node.querySelector("input, textarea, select")) continue;
      if (!(titleEl.compareDocumentPosition(node) & AFTER)) continue;
      const text = collapseWs(node.textContent);
      if (text) return text.length > 800 ? text.slice(0, 800).trim() : text;
    }
    return "";
  }

  // Describe a field for the "Answer with AI" flow: everything describeField
  // captures (name, label, value) plus the constraints the prompt needs —
  // maxlength, single-line vs multiline, the element type/tag, the page
  // title as extra context, and any subtitle/description text near the
  // question title.
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
      subtitle: fieldSubtitle(el, el.ownerDocument),
      ...describeField(el, el.ownerDocument)
    };
  }

  // Collect every QUESTION on the page that has been filled out and is not yet
  // represented in the profile, one entry per question — a checkbox/radio group
  // or select[multiple] is a single multi-answer entry with an ARRAY value, a
  // lone checkbox stays a scalar boolean, and singles keep their element value
  // exactly as before. A question counts as already in the profile when an
  // existing entry matches its identity under the same matching used to fill —
  // existing entries are never overwritten. Questions with no usable name, or
  // with an empty single/radio answer, are skipped and counted.
  function collectFilledFields(profileFields, doc) {
    const root = doc || document;
    const entries = buildMatchEntries(profileFields || {});
    const results = [];
    let skippedExisting = 0;
    let skippedEmpty = 0;
    const groups = discoverGroups(root);

    for (const group of groups) {
      const desc = describeGroup(group);
      if (!desc.name) {
        skippedEmpty++;
        continue;
      }
      // Empty-answer rules. Multi-answer questions store [] — a meaningful,
      // storable value — so they are always collectible (and a lone checkbox's
      // checked state is always meaningful, mirroring today's exemption):
      //   - singles: skip unless the control holds real data (placeholder
      //     detection lives in fieldHasData).
      //   - radio groups: nothing checked → scalar "" cannot be stored → skip.
      if (group.kind === "single") {
        if (!fieldHasData(group.inputs[0])) {
          skippedEmpty++;
          continue;
        }
      } else if (group.kind === "radio") {
        if (desc.value === "" || desc.value === null || desc.value === undefined) {
          skippedEmpty++;
          continue;
        }
      }
      // Already in the profile? Match the group's question identity: every
      // member field carries its own candidates plus the group's title
      // identities, and any member match counts the whole question as existing
      // (existing entries are never overwritten).
      const memberFields = group.inputs.map((el) => ({
        el,
        candidates: getCandidates(el, root)
      }));
      const titleCands = [];
      for (const t of [group.key, group.titleText]) {
        const n = normalize(t);
        if (n && titleCands.indexOf(n) === -1) titleCands.push(n);
      }
      for (const field of memberFields) {
        for (const cand of titleCands) {
          if (field.candidates.indexOf(cand) === -1) field.candidates.push(cand);
        }
      }
      if (matchFields(entries, memberFields).length > 0) {
        skippedExisting++;
        continue;
      }
      results.push(desc);
    }

    return {
      fields: results,
      skippedExisting,
      skippedEmpty,
      found: groups.length,
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

  let config = { whitelist: [], profileFields: {}, debug: false };

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
      config = {
        whitelist: whitelist,
        profileFields: profileFields,
        debug: mod && mod.debug === true
      };
    } catch (err) {
      config = { whitelist: [], profileFields: {}, debug: false };
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
  // when the core runtime is unavailable (harness/edge cases). When debug is
  // enabled, toast text is also mirrored to the console.
  function toast(text) {
    try {
      if (typeof window.jobAppToolkit.content.showToast === "function") {
        window.jobAppToolkit.content.showToast(text);
        if (config.debug) console.log("[Form Filler] " + text);
        return;
      }
    } catch (err) {
      // Fall through to the console.
    }
    console.log("[Form Filler] " + text);
  }

  // Stage logging for the AI flow (page console). The background sends a short
  // flow id in every AI message; content logs under the same id so the two
  // consoles line up. No id (direct harness calls) falls back to "?".
  function aiLog(flowId, text) {
    console.log(
      "[Form Filler AI #" + (flowId || "?") + " " + new Date().toISOString().slice(11, 23) + "] " + text
    );
  }

  // Log form of a captured subtitle: the picked-up text in quotes (never the
  // full 800-char cap), truncated to 200 chars with a total-count suffix.
  function subtitleLog(sub) {
    const s = String(sub || "").trim();
    if (!s) return "none";
    return s.length > 200
      ? '"' + s.slice(0, 200) + "…\" (" + s.length + " chars total)"
      : '"' + s + '"';
  }

  // Does the active profile hold a value matching this question group, under
  // the same identity matching used by fill-page? Returns the match (with its
  // profile key) or null.
  function findProfileMatch(group) {
    const entries = buildMatchEntries(config.profileFields);
    const matches = matchFields(entries, [
      { el: group.anchor, candidates: groupCandidates(group) }
    ]);
    return matches.length > 0 ? matches[0] : null;
  }

  // Matching identities for a question group: the cleaned title/key first,
  // then every member input's own candidates, so previously-saved scalar
  // entries (e.g. a lone checkbox or a radio group saved under its shared
  // name) keep matching alongside the new title-keyed entries.
  function groupCandidates(group) {
    const cands = [];
    const add = (text) => {
      const norm = normalize(text);
      if (norm && cands.indexOf(norm) === -1) cands.push(norm);
    };
    add(group.key);
    add(group.titleText);
    for (const el of group.inputs) {
      const doc = el.ownerDocument || document;
      for (const c of getCandidates(el, doc)) add(c);
    }
    return cands;
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

  function createButtons(group, doc) {
    // Buttons must be created in the question's own document — for fields
    // inside a same-origin iframe that is NOT this frame's document.
    const root = doc || group.inputs[0].ownerDocument || document;
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
    addBtn.addEventListener("click", (e) => onAddClick(e, group));

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
    fillBtn.addEventListener("click", (e) => onFillClick(e, group));

    wrapper.appendChild(addBtn);
    wrapper.appendChild(fillBtn);
    return { wrapper: wrapper, addBtn: addBtn, fillBtn: fillBtn };
  }

  // Save the whole question group: multi-answer questions store an ARRAY of
  // the selected options' labels/values (possibly []), radio groups store the
  // checked radio's label/value as a scalar, singles keep their current scalar
  // behavior. Empty scalars (including an unchecked radio group) are rejected
  // with a toast exactly like empty single fields.
  function onAddClick(e, group) {
    e.preventDefault();
    e.stopPropagation();
    const desc = describeGroup(group);
    const display = desc.fieldLabel || desc.name;
    const isEmptyScalar =
      !Array.isArray(desc.value) &&
      (desc.value === "" || desc.value === null || desc.value === undefined);
    if (isEmptyScalar) {
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

  // Fill the whole question group from the active profile (unconditional
  // override, matching today's single-field semantics): arrays select exactly
  // the stored options, radio scalars check the matching radio, singles use
  // fillField. No stored entry → dim + toast as before.
  function onFillClick(e, group) {
    e.preventDefault();
    e.stopPropagation();
    const display =
      group.titleText || group.key || group.inputs[0].name || group.inputs[0].id;
    const match = findProfileMatch(group);
    const entry = buttonMap.get(group.anchor);
    if (!match) {
      toast('No saved value matches "' + display + '".');
      if (entry) entry.fillBtn.classList.add("jtk-ff-dim");
      return;
    }
    // Deliberate unconditional overwrite (no isFilled guard): the per-question
    // fill is an explicit override, unlike fill-page. No toast on success —
    // the visible value change is the feedback.
    fillGroup(group, match.entry.value);
    if (entry) {
      entry.fillBtn.title = 'Fill from profile: "' + match.key + '"';
      entry.fillBtn.classList.remove("jtk-ff-dim");
    }
  }

  // Wrappers are tracked per question GROUP (via its anchor element — the
  // title element, group container or first input; single inputs key by the
  // input element as before). Form controls are stable elements, unlike
  // LinkedIn's recycled cards, so repeated scans reuse the same buttons.
  let buttonMap = new WeakMap();

  // Reflect the profile-match state on the fill button only (dim + tooltip
  // naming the matched profile key); the add button never changes.
  function updateButtonState(entry, group) {
    const match = findProfileMatch(group);
    if (match) {
      entry.fillBtn.classList.remove("jtk-ff-dim");
      entry.fillBtn.title = 'Fill from profile: "' + match.key + '"';
    } else {
      entry.fillBtn.classList.add("jtk-ff-dim");
      entry.fillBtn.title = "Fill this field from profile";
    }
  }

  // Vertically center the button pair on the question title's row (or the
  // first input's row when no title element exists). The wrapper is a
  // zero-height FLEX container, so its top edge sits just below the title (at
  // the title's bottom edge, plus any bottom margin it carries), and
  // align-items:center pins the 18px pair exactly on that y=0 line — no line
  // box, no baseline offset. A negative top of -(titleH/2 + margin) lifts the
  // pair so it spans the title's vertical middle. Relative positioning only
  // moves painted content, so the wrapper's zero in-flow footprint is
  // unaffected and following fields are never pulled up or down.
  function positionButtons(entry, group) {
    // Layout measurement (browser only): jsdom reports 0, so fall back to a
    // nominal 40px — the negative top must ALWAYS be applied.
    const target = group.titleEl || group.inputs[0];
    const measured = target.getBoundingClientRect().height;
    const fieldH = measured > 0 ? measured : 40;
    let marginBottom = 0;
    const view = target.ownerDocument ? target.ownerDocument.defaultView : null;
    if (view && typeof view.getComputedStyle === "function") {
      const mb = parseFloat(view.getComputedStyle(target).marginBottom);
      if (isFinite(mb) && mb > 0) marginBottom = Math.min(mb, 40);
    }
    entry.wrapper.style.top = -Math.round(fieldH / 2 + marginBottom) + "px";
  }

  // One button set PER QUESTION, rendered at the question title when one
  // exists (next sibling of the legend/label/heading), else at the group's
  // first input — today's placement.
  function ensureButtons(group, doc) {
    const keyEl = group.anchor;
    let entry = buttonMap.get(keyEl);
    if (entry && entry.wrapper && entry.wrapper.isConnected) {
      updateButtonState(entry, group);
      positionButtons(entry, group);
      return;
    }
    if (entry && entry.wrapper) {
      entry.wrapper.remove();
      buttonMap.delete(keyEl);
    }
    entry = createButtons(group, doc);
    buttonMap.set(keyEl, entry);
    updateButtonState(entry, group);
    const titleEl = group.titleEl;
    if (titleEl && titleEl.parentNode) {
      titleEl.parentNode.insertBefore(entry.wrapper, titleEl.nextSibling);
    } else {
      const first = group.inputs[0];
      const parent = first.parentNode;
      if (parent) parent.insertBefore(entry.wrapper, first.nextSibling);
    }
    positionButtons(entry, group);
  }

  // ------------------------------------------------------------------
  // Application submit logging
  // ------------------------------------------------------------------
  //
  // On whitelisted sites, watch submit-capable controls and report an
  // application submission to the background (form-filler:logApplication) as
  // the user activates one — before the page navigates away. Fire-and-forget:
  // no user-visible effect, never throws.

  // A submit-capable control: <input type=submit|image>, <button
  // type=submit>, a <button> without a type that belongs to a form (its
  // default type is submit), or a <button> whose collapsed text reads like a
  // progression action ("Submit Application", "Save & Continue", ...) — the
  // JS-button ATS portals. Anchors are never submissions ("Apply" links point
  // at the posting), and text like "Cancel"/"Save for later"/"Back"/"Delete"
  // does not match the progression regex.
  function isSubmitCandidate(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.disabled) return false;
    if (el.tagName === "A") return false;
    if (el.tagName === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return type === "submit" || type === "image";
    }
    if (el.tagName !== "BUTTON") return false;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "submit") return true;
    if (type === "button" || type === "reset") return false;
    if (el.form) return true; // typeless button in a form defaults to submit
    const text = collapseWs(el.textContent);
    if (!text) return false;
    return /^(submit|apply|applying|continue|next|save\s*&?\s*(and|&)?\s*continue|finish|complete|confirm|proceed)\b/i.test(
      text
    );
  }

  // Best-effort company extraction, in priority order:
  // 1. the first filled form field whose candidates read as a company question
  //    (Company / Employer / Organization ...);
  // 2. JobPosting structured data -> hiringOrganization.name (the employer,
  //    exactly as the ATS marked it up for crawlers);
  // 3. the "at <Company>" phrase in the page title (job-board titles read
  //    "Senior Engineer at Acme Corp | Workday");
  // 4. the page's og:site_name meta (a real company on company-careers sites,
  //    the ATS brand on aggregate portals);
  // else "".
  function findCompanyOnPage(doc) {
    const root = doc || document;
    const hints = ["company", "employer", "organization", "organisation"];
    const exact = ["companyname", "employername", "organizationname", "organisationname"];
    try {
      for (const field of discoverFields(root)) {
        const hit = field.candidates.some((cand) => {
          if (exact.indexOf(cand) !== -1) return true;
          return hints.some(
            (h) => cand === h || cand.startsWith(h + " ") || cand.endsWith(" " + h)
          );
        });
        if (!hit) continue;
        const value = String(field.el.value == null ? "" : field.el.value).trim();
        if (value) return value;
      }
    } catch (err) {
      // Fall through to the structured-data sources.
    }
    const jsonLd = companyFromJsonLd(root);
    if (jsonLd) return jsonLd;
    const titleCompany = companyFromTitle(root);
    if (titleCompany) return titleCompany;
    try {
      const meta = root.querySelector(
        'meta[property="og:site_name"], meta[name="og:site_name"]'
      );
      if (meta && meta.content) return String(meta.content).trim();
    } catch (err) {
      // Ignore.
    }
    return "";
  }

  // JobPosting structured data -> hiringOrganization.name. The ATS emits this
  // for crawlers, so it is the most accurate company source on job boards.
  // Handles a single node, an array of nodes, and @type arrays.
  function companyFromJsonLd(root) {
    try {
      const scripts = root.querySelectorAll('script[type="application/ld+json"]');
      for (const script of scripts) {
        let data;
        try {
          data = JSON.parse(script.textContent);
        } catch (err) {
          continue; // malformed block — try the next one
        }
        const nodes = Array.isArray(data) ? data : [data];
        for (const node of nodes) {
          if (!node || typeof node !== "object") continue;
          const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
          if (types.indexOf("JobPosting") === -1) continue;
          const org = node.hiringOrganization;
          if (org && typeof org.name === "string") {
            const name = collapseWs(org.name);
            if (name) return name;
          }
        }
      }
    } catch (err) {
      // Ignore.
    }
    return "";
  }

  // The page title often reads "Senior Engineer at Acme Corp | Workday" on job
  // boards. Take the text after " at " up to the first spaced title delimiter
  // (| – — : -) or the end. Only fires when the " at " phrase is actually
  // present, so a bare "Company - Title" page falls through to og:site_name.
  function companyFromTitle(root) {
    try {
      const title = String((root && root.title) || "").trim();
      const m = /\bat\s+(.+)$/i.exec(title);
      if (!m) return "";
      const name = m[1].replace(/\s+[-–—|:]\s+.*$/, "").trim();
      return name ? collapseWs(name) : "";
    } catch (err) {
      return "";
    }
  }

  // Capture the log message from the document the submission happened in:
  // the top frame's URL (a cross-origin top throws -> the submitting
  // document's own URL), the submitting document's title (else the top
  // document's, else ""), and the best-effort company.
  function logApplicationFromDoc(doc) {
    try {
      let url;
      try {
        url = window.top.location.href;
      } catch (err) {
        url = doc.location.href;
      }
      let title = doc.title;
      if (!title) {
        try {
          title = window.top.document.title;
        } catch (err) {
          title = "";
        }
      }
      const company = findCompanyOnPage(doc);
      browser.runtime
        .sendMessage({
          type: "form-filler:logApplication",
          title: title,
          url: url,
          company: company
        })
        .catch(() => {});
    } catch (err) {
      // Never throw.
    }
  }

  // Monitored documents: Map<Document, { click, submit, lastLogAt }> so
  // teardown() can detach exactly the listeners this frame attached. The
  // per-document lastLogAt guard stops click+submit double-firing within the
  // same second (Enter-key and form.requestSubmit() submits carry no click of
  // their own and are caught by the submit listener alone).
  const submitMonitors = new Map();

  function handleSubmitClick(e, root) {
    try {
      if (!isSubmitCandidate(e.target)) return;
      const doc = (e.target && e.target.ownerDocument) || root;
      logApplicationFromDoc(doc);
      const entry = submitMonitors.get(doc);
      if (entry) entry.lastLogAt = Date.now();
    } catch (err) {
      // Never throw.
    }
  }

  function handleSubmitEvent(e, root) {
    try {
      const doc = (e.target && e.target.ownerDocument) || root;
      const entry = submitMonitors.get(doc);
      if (entry && entry.lastLogAt && Date.now() - entry.lastLogAt < 1000) return;
      logApplicationFromDoc(doc);
      if (entry) entry.lastLogAt = Date.now();
    } catch (err) {
      // Never throw.
    }
  }

  // Attach the click (capture phase — fires before the button's own handlers
  // and before navigation) and submit listeners to one document. Called from
  // scanPage for every document in the same-origin walk: each document with
  // its own content script monitors itself, unmarked same-origin iframes are
  // monitored by the top frame.
  function ensureSubmitMonitor(doc) {
    const root = doc || document;
    if (submitMonitors.has(root)) return;
    const click = (e) => handleSubmitClick(e, root);
    const submit = (e) => handleSubmitEvent(e, root);
    try {
      root.addEventListener("click", click, true);
      root.addEventListener("submit", submit);
      submitMonitors.set(root, { click: click, submit: submit, lastLogAt: 0 });
    } catch (err) {
      // Roll back a partial attach so nothing leaks, then never throw.
      try {
        root.removeEventListener("click", click, true);
      } catch (e2) {
        // Ignore.
      }
      try {
        root.removeEventListener("submit", submit);
      } catch (e2) {
        // Ignore.
      }
    }
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
      ensureSubmitMonitor(doc);
      const groups = discoverGroups(doc);
      for (const group of groups) ensureButtons(group, doc);
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
    // Detach the submit-monitoring listeners this frame attached (its own
    // document and any unmarked same-origin iframes). forEachSameOriginDoc
    // swallows per-document errors, so the walk is safe when a frame is gone.
    for (const [doc, fns] of submitMonitors) {
      try {
        doc.removeEventListener("click", fns.click, true);
      } catch (err) {
        // Ignore.
      }
      try {
        doc.removeEventListener("submit", fns.submit);
      } catch (err) {
        // Ignore.
      }
    }
    submitMonitors.clear();
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
    // Core message types (jtk:*) — activity broadcasts and toasts — are
    // handled by core/content.js for rendering. Mirror Form Filler toasts to
    // the console when debug is enabled, so page-console users see in-page
    // feedback for background-toasted messages too.
    if (message.type === "jtk:showToast" && message.module === MODULE_ID && config.debug) {
      console.log(
        "[Form Filler] " +
          (message.title ? message.title + ": " + message.message : message.message)
      );
      return undefined;
    }

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
        aiLog(message.flowId, "capture: no fillable field at target " + message.targetElementId);
        return Promise.resolve({
          ok: false,
          flowId: message.flowId,
          error: "No fillable field at the right-clicked element."
        });
      }
      const desc = describeAIField(el);
      aiLog(
        message.flowId,
        "captured: " + desc.tagName + " " + (desc.type || "") +
          " name=" + (desc.name || "-") +
          " label=" + (desc.fieldLabel || "-") +
          " subtitle=" + subtitleLog(desc.subtitle) +
          " maxLength=" + (desc.maxLength == null ? "none" : desc.maxLength) +
          " singleLine=" + (desc.singleLine === true)
      );
      return Promise.resolve(Object.assign({ flowId: message.flowId }, desc));
    }
    if (type === "fillAIField") {
      const value = String(message.value == null ? "" : message.value);
      const el = resolveFieldElement(message.targetElementId);
      if (!el) {
        aiLog(message.flowId, "fill: target " + message.targetElementId + " no longer available");
        return Promise.resolve({
          ok: false,
          flowId: message.flowId,
          error: "The field is no longer available on this page."
        });
      }
      if (el.tagName === "SELECT" || el.type === "checkbox") {
        aiLog(
          message.flowId,
          "fill: rejected, not a text field (" + el.tagName + "/" + (el.type || "") + ")"
        );
        return Promise.resolve({ ok: false, flowId: message.flowId, error: "Not a text field." });
      }
      aiLog(message.flowId, "fill: applying " + value.length + " chars to target " + message.targetElementId);
      setNativeValue(el, value);
      aiLog(
        message.flowId,
        "fill applied: " + value.length + " chars -> " + el.tagName +
          (el.id ? "#" + el.id : el.name ? "[name=" + el.name + "]" : "")
      );
      return Promise.resolve({ ok: true, flowId: message.flowId });
    }
    if (type === "aiSpinner") {
      // Background signals the AI answer is in flight: show the ring on the
      // target field (or clear it once the answer lands).
      aiLog(
        message.flowId,
        "spinner " + (message.show !== false ? "show" : "hide") + " target " + message.targetElementId
      );
      return Promise.resolve(handleAiSpinner(message.show !== false, message.targetElementId));
    }
    return undefined;
  });
})();
