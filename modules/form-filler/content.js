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

  // Coarse control type for a fillable element, used by type-aware matching:
  // "text" (any non-choice input), "textarea", "checkbox", "radio", "select".
  // Non-control elements (e.g. a group's title anchor) fall back to "text" —
  // callers pass a real control when the type matters.
  function elementType(el) {
    if (!el) return "text";
    if (el.type === "checkbox") return "checkbox";
    if (el.type === "radio") return "radio";
    if (el.tagName === "SELECT") return "select";
    if (el.tagName === "TEXTAREA") return "textarea";
    return "text";
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
    // Bounded proximity first: a short text-only element sitting just before
    // one of the field's nearby ancestors reads as THIS question's title.
    // Trying it before the document-order walk keeps the walk from reaching
    // past the question and latching onto a distant section heading (which
    // the section-header pre-pass would then suppress, leaving the field
    // unnamed). Boards like Gem render titles as plain hashed-class spans
    // invisible to HEADER_SELECTOR, so without this the whole page's fields
    // resolve to the last <h2> above the form.
    const near = nearestPrecedingTextSibling(el, root);
    if (near) return near;
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

  // Last-resort title heuristic for boards whose question titles are plain
  // <span>/<div> elements with hashed utility classes (e.g. Gem's
  // `bodyImportant-47`) — invisible to HEADER_SELECTOR and to every label
  // mechanism. Walks up a few ancestor levels from the field and takes the
  // nearest PRECEDING SIBLING that holds short plain text and no form
  // controls; that reads as the question title. Only reached when the
  // header-selector walk and any fieldset legend both found nothing, so it
  // never displaces a real heading, label, or legend. The section-header
  // pre-pass still guards against one sibling being shared by several
  // questions.
  function nearestPrecedingTextSibling(el, root) {
    let node = el;
    for (let depth = 0; node && depth < 5 && node !== root.body; depth++) {
      let sib = node.previousElementSibling;
      while (sib) {
        if (!sib.querySelector("input, select, textarea, button")) {
          const text = String(sib.textContent || "").trim();
          if (text.length > 0 && text.length < 200) return sib;
        }
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
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
      const entryType = isObj && entry.type ? entry.type : "";
      const norms = [];
      const keyNorm = normalize(key);
      if (keyNorm) norms.push(keyNorm);
      const labelNorm = normalize(label);
      if (labelNorm && labelNorm !== keyNorm) norms.push(labelNorm);
      entries.push({ key, value, norms, type: entryType });
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
          // Type compatibility: an entry that specifies a type only matches
          // elements of that type. Empty/missing entry type means "any type"
          // (backward compatible with old profiles).
          if (entry.type && entry.type !== elementType(field.el)) continue;
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
        if (entry.type && entry.type !== elementType(field.el)) continue;
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
        if (entry.type && entry.type !== elementType(field.el)) continue;
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

  // Find the best single option in a <select> for a saved scalar value.
  // Real (non-placeholder) options only. Exact normalized match wins; if none,
  // fall back to the closest option by token-overlap (same fuzziness used for
  // field matching) above a threshold; below it, no option is returned so the
  // caller skips the field rather than filling a wrong answer.
  var SELECT_OVERLAP_THRESHOLD = 0.3;
  function findBestSelectOption(el, value) {
    var norm = normalize(value);
    var best = null;
    var bestOverlap = 0;
    for (var i = 0; i < el.options.length; i++) {
      var opt = el.options[i];
      if (isPlaceholderOption(opt)) continue;
      if (normalize(opt.value) === norm || normalize(opt.textContent) === norm) {
        return opt; // exact match — always preferred
      }
      var candVal = normalize(opt.value);
      var candText = normalize(opt.textContent);
      var overlap = tokenOverlap(norm, candVal);
      if (overlap < tokenOverlap(norm, candText)) overlap = tokenOverlap(norm, candText);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = opt;
      }
    }
    if (best && bestOverlap >= SELECT_OVERLAP_THRESHOLD) return best;
    return null;
  }

  // Detect whether a fillable element is the hidden text input of a custom
  // combobox/listbox drop-down (e.g. React Select, which renders a visually
  // hidden <input type="text"> with role="combobox" and a sibling div showing
  // the selected option's label). Native <select> elements are always handled
  // by their own code path, so this only applies to widget-style inputs.
  function isComboboxInput(el) {
    if (!el || el.tagName !== "INPUT") return false;
    if (el.type && el.type.toLowerCase() !== "text") return false;
    var role = el.getAttribute("role");
    if (role === "combobox" || role === "listbox") return true;
    if (!role) return false;
    // Own-attribute signals first: cheaper than walking and they cannot
    // accidentally match an unrelated wrapper.
    var haspopup = collapseWs(el.getAttribute("aria-haspopup") || "").toLowerCase();
    if (haspopup && haspopup !== "false") return true;
    if (collapseWs(el.getAttribute("autocomplete") || "").toLowerCase().indexOf("list") !== -1) return true;
    // Also catch the common class-based pattern when no explicit role. The walk
    // MUST start at el.parentElement, never el: WIDGET_SELECTOR contains
    // `[class*="select" i]` and react-select's hidden input carries the class
    // `select__input`, so el.closest(".select-shell," + WIDGET_SELECTOR)
    // self-matches the input itself and the real widget container is never
    // reached. Same trap as getComboboxValue below.
    for (var node = el.parentElement, depth = 0; node && depth <= 6; depth++, node = node.parentElement) {
      if (node.matches && node.matches(".select-shell," + WIDGET_SELECTOR)) return true;
    }
    return false;
  }

  // Extract the visible selected value(s) from a custom combobox widget.
  // React Select stores single selections in a .select__single-value div and
  // multi-selections in .select__multi-value__label divs. Returns "" when no
  // selection is displayed (placeholder state).
  function getComboboxValue(el) {
    if (!el) return "";
    // Ancestor walk for the widget's display node. It MUST start at
    // el.parentElement, never el: WIDGET_SELECTOR contains `[class*="select" i]`
    // and the hidden react-select input's own class is `select__input`, so
    // el.closest(".select-shell," + WIDGET_SELECTOR) matches the INPUT ITSELF
    // (which has no children) and never reaches the real container — that
    // self-match is the bug this whole walk exists to avoid, so don't
    // "simplify" it back into a closest() call.
    //
    // Do not bail out on the first widget-ish ancestor that has no display
    // node: `.select__input-container` matches `[class*="select" i]` but holds
    // nothing, and the `.select__single-value` / `.select__multi-value`
    // markup only appears further up (`.select__control` / `.select-shell`).
    // Keep walking and stop at the first ancestor that yields a value.
    for (var node = el.parentElement, depth = 0; node && depth <= 6; depth++, node = node.parentElement) {
      if (!node.matches || !node.matches(".select-shell," + WIDGET_SELECTOR)) continue;
      var found = comboboxDisplayValue(node);
      if (found) return found;
    }
    // Some widgets (e.g. Greenhouse's country picker) render no display node at
    // all and keep the answer in the input's own value / its wrapper's
    // data-value instead. Fall back to the raw input value.
    return collapseWs(el.value || "");
  }

  // Pull the visible selection out of one widget container. Single selections
  // live in a .select__single-value div, multi selections in N
  // .select__multi-value__label divs (the sibling .select__multi-value__remove
  // is a different class and never matched). Returns "" when the container
  // shows no selection (placeholder state) so the caller keeps walking.
  function comboboxDisplayValue(container) {
    if (!container || typeof container.querySelector !== "function") return "";
    // Single-value display div (React Select / Remix CSS).
    var single = container.querySelector(".select__single-value");
    if (single) {
      var text = collapseWs(single.textContent);
      if (text) return text;
    }
    // Multi-value labels: join all selected labels.
    var labels = container.querySelectorAll(".select__multi-value__label");
    if (labels && labels.length > 0) {
      var arr = [];
      for (var i = 0; i < labels.length; i++) {
        var t = collapseWs(labels[i].textContent);
        if (t) arr.push(t);
      }
      if (arr.length > 0) return arr.join(", ");
    }
    return "";
  }

  // Drop the selection of a React-Select style widget by clicking the widget's
  // own clear affordance ("Clear selections"). Clearing the hidden search
  // input is useless on its own: its value is "" whether or not a selection is
  // displayed, so setNativeValue would leave "Yes" sitting on screen while
  // pretending to have cleared the field. Returns true when a button was
  // clicked, false when the widget has none (caller falls back to
  // setNativeValue). Never throws — a broken widget must not block clearing.
  function clearComboboxWidget(el) {
    try {
      // .select-shell is an exact class match, so unlike WIDGET_SELECTOR it
      // cannot self-match the `select__input` search box.
      var scope = (el.closest && el.closest(".select-shell")) || el.parentElement;
      if (!scope || typeof scope.querySelector !== "function") return false;
      var btn = scope.querySelector(
        'button[data-testid="clear-selection"], .select__clear, [aria-label="Clear selections"]'
      );
      if (!btn || typeof btn.click !== "function") return false;
      btn.click();
      return true;
    } catch (e) {
      return false;
    }
  }

  // Does this field hold real data? Placeholder prompts do not count, so
  // fields still sitting at their default state are treated as empty. A
  // checkbox is never "empty" in this sense (both checked states are
  // meaningful); callers handle checkboxes separately.
   function fieldHasData(el) {
    if (el && el.tagName === "SELECT") {
      // Prefer the actually-selected option. If none is reported (some
      // browsers don't populate selectedOptions when no option carries an
      // explicit `selected` attribute), fall back to el.value against the
      // option with that value. A select "has data" when its current option
      // is a real (non-placeholder) choice.
      const opt = (el.selectedOptions && el.selectedOptions[0]) || null;
      if (opt) return !isPlaceholderOption(opt);
      const val = String(el.value || "").trim();
      if (val === "") return false;
      for (const o of el.options) {
        if (normalize(o.value) === normalize(val)) return !isPlaceholderOption(o);
      }
      return true;
    }
    // Custom combobox widget (e.g. React Select): a hidden text input whose
    // real selected value is displayed in a sibling div. Treat the widget as
    // "has data" when that visible value is non-empty.
    if (isComboboxInput(el)) {
      const val = getComboboxValue(el);
      return String(val || "").trim() !== "";
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
       const option = findBestSelectOption(el, value);
       if (!option) return false; // no good-matching option — leave untouched
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
               // Exact value/text match first; fall back to a fuzzy token-
               // overlap check against any stored value (same threshold as
               // single-select) so "US" lands on the "United States" option.
               let on = inSet(opt.value) || inSet(opt.textContent);
               if (!on) {
                 const optNormVal = normalize(opt.value);
                 const optNormText = normalize(opt.textContent);
                 for (const norm of norms) {
                   if (
                     tokenOverlap(norm, optNormVal) >= SELECT_OVERLAP_THRESHOLD ||
                     tokenOverlap(norm, optNormText) >= SELECT_OVERLAP_THRESHOLD
                   ) {
                     on = true;
                     break;
                   }
                 }
               }
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

    // Page template check: if a saved template matches this page's field
    // shape, fill from it (positional overwrite) and return immediately — the
    // normal profile-based matching below is never reached. No match → the
    // profile fill runs exactly as before.
    const _shape = computePageShape(root);
    const _tmpl = findMatchingTemplate(_shape);
    if (_tmpl) {
      return fillFromTemplate(_tmpl, root);
    }

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

      // Wrong-autofill correction: a stored exclusion for this profile-entry ↔
      // field pairing skips the fill. The entry DID match a field, so it counts
      // as skipped, never unmatched. Ungrouped singles (no group object) check
      // the matched element's own candidates via a group-less pseudo identity.
      if (
        group
          ? isExcluded(m.key, group)
          : isExcluded(m.key, { key: null, titleText: null, inputs: [el] })
      ) {
        matchedKeys.add(m.key);
        if (isGroupQuestion) {
          if (handledGroups.has(group)) continue;
          handledGroups.add(group);
        }
        skipped++;
        skippedNames.push(
          group ? group.titleText || group.key : getFieldTitle(el, root) || el.name || el.id
        );
        continue;
      }

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
          showClearButton(group);
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
        showClearButton(group);
      }
    }

    const unmatched = entries.filter((e) => !matchedKeys.has(e.key)).length;
    return { filled, skipped, skippedNames, unmatched, matched: matchedKeys.size, matchedKeys: Array.from(matchedKeys) };
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

  // Resolve the field for an AI-flow message. Tries the live menu target
  // first; if that weak reference has died (the AI wait can outlive it), falls
  // back to the element snapshot cached under the flow's id at capture time.
  // The cache entry is consumed on first use so a stale snapshot can never
  // outlive its flow.
  function resolveAiField(targetElementId, flowId) {
    const el = resolveFieldElement(targetElementId);
    if (el) {
      if (flowId) aiFieldCache.delete(flowId);
      return el;
    }
    if (!flowId) return null;
    const cached = aiFieldCache.get(flowId);
    aiFieldCache.delete(flowId);
    if (cached && cached.isConnected) return cached;
    return null;
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

    let value;
    if (el.type === "checkbox") {
      value = String(el.checked);
    } else if (isComboboxInput(el)) {
      // Custom combobox widget (React Select etc.): the visible selection lives
      // in the widget's display div(s), not in el.value.
      value = getComboboxValue(el);
    } else {
      value = el.value;
    }
    return { name, value, fieldLabel, type: elementType(el) };
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
    return { name, value, fieldLabel, type: elementType(group.inputs[0]) };
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
      tagName: el.tagName,
      pageTitle: (el.ownerDocument || document).title || "",
      subtitle: fieldSubtitle(el, el.ownerDocument),
      ...describeField(el, el.ownerDocument),
      // The AI flow's own raw type (the input's type attribute, or the tag
      // name lowercased) must win over describeField's coarse normalized type
      // — the background uses it to reject non-text fields and log captures.
      type:
        el.tagName === "INPUT" ? el.getAttribute("type") || "text" : el.tagName.toLowerCase()
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

  // ------------------------------------------------------------------
  // Page templates (save / fill by page shape)
  // ------------------------------------------------------------------
  //
  // A saved template records the ordered, normalized identity of every
  // question group on a page plus the values captured at save time. When
  // "Autofill page" runs, the current page's shape is compared against saved
  // templates first: an exact shape match triggers a POSITIONAL overwrite fill
  // (the i-th template entry fills the i-th group, by document order), unlike
  // the profile-based fillPage which never overwrites existing data. No match
  // → the normal profile matching runs unchanged.

  let savedTemplates = []; // Array of { id, name, shape, fields, savedUrl, createdAt }

  async function reloadTemplates() {
    try {
      const res = await browser.storage.local.get(TEMPLATES_LOCAL);
      const map = res && res[TEMPLATES_LOCAL];
      savedTemplates = [];
      if (map && typeof map === "object") {
        for (const id of Object.keys(map)) {
          const t = map[id];
          if (!t || typeof t.name !== "string" || !Array.isArray(t.shape) || !Array.isArray(t.fields)) continue;
          savedTemplates.push({
            id: id,
            name: t.name,
            shape: t.shape,
            fields: t.fields,
            savedUrl: t.savedUrl || "",
            createdAt: t.createdAt || 0
          });
        }
      }
    } catch (err) {
      savedTemplates = [];
    }
  }

  // The identity a question group contributes to a page shape: normalized
  // title text first, then the cleaned storage key, then the first input's
  // name/id. The same resolution is used when saving and when matching, so a
  // template recorded on one site matches the same-shaped page on another.
  function groupIdentity(g) {
    return normalize(
      g.titleText || g.key || (g.inputs[0] && (g.inputs[0].name || g.inputs[0].id)) || ""
    );
  }

  // Ordered normalized identities — one per question group in document order.
  // Groups with an empty identity are skipped (they contribute nothing to the
  // shape, exactly as when saving).
  function computePageShape(root) {
    const groups = discoverGroups(root || document);
    const shape = [];
    for (const g of groups) {
      const identity = groupIdentity(g);
      if (!identity) continue;
      shape.push(identity);
    }
    return shape;
  }

  // First saved template whose shape matches the given shape exactly (same
  // length, same value at every index). Null when nothing matches.
  function findMatchingTemplate(shape) {
    if (!shape.length) return null;
    for (const t of savedTemplates) {
      if (t.shape.length !== shape.length) continue;
      let match = true;
      for (let i = 0; i < shape.length; i++) {
        if (t.shape[i] !== shape[i]) {
          match = false;
          break;
        }
      }
      if (match) return t;
    }
    return null;
  }

  // Positional overwrite fill: the i-th identifiable group receives the i-th
  // template entry's value. Returns a fillPageAll-compatible result; the extra
  // templateUsed field lets fillPageAll report the template name to the caller
  // (so the background can toast "Filled from template: X").
  function fillFromTemplate(template, root) {
    const groups = discoverGroups(root || document);
    // Same empty-identity filter as computePageShape, so each group's position
    // here matches its identity's position in the shape.
    const identifiable = [];
    for (const g of groups) {
      if (groupIdentity(g)) identifiable.push(g);
    }
    let filled = 0;
    for (let i = 0; i < template.fields.length && i < identifiable.length; i++) {
      fillGroup(identifiable[i], template.fields[i].value);
      filled++;
    }
    return {
      filled: filled,
      skipped: 0,
      unmatched: Math.max(0, template.fields.length - identifiable.length),
      matchedKeys: template.fields.map(function (f) {
        return f.identity;
      }),
      skippedNames: [],
      templateUsed: template.name
    };
  }

  // One-off naming dialog for "Save page template". Built with DOM APIs and
  // inline styles only (this is a transient overlay, not a recurring element
  // like the per-field buttons, so no injected stylesheet). Lives in the top
  // document's body; removed on confirm, cancel, backdrop click, or teardown.
  // Enter saves, Escape cancels, an empty name keeps the dialog open.
  let templatePromptEl = null;

  function showTemplatePrompt(onConfirm, onCancel) {
    removeTemplatePrompt();
    const doc = document;
    const overlay = doc.createElement("div");
    overlay.className = "jtk-ff-prompt";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      background: "rgba(0, 0, 0, 0.5)",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    });

    const box = doc.createElement("div");
    Object.assign(box.style, {
      maxWidth: "360px",
      width: "80vw",
      boxSizing: "border-box",
      padding: "20px",
      borderRadius: "8px",
      background: "#1f2937",
      color: "#ffffff",
      fontSize: "13px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      lineHeight: "1.4",
      boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
      display: "flex",
      flexDirection: "column",
      gap: "10px"
    });

    const title = doc.createElement("div");
    title.textContent = "Name this page template:";
    box.appendChild(title);

    const input = doc.createElement("input");
    input.type = "text";
    Object.assign(input.style, {
      width: "100%",
      boxSizing: "border-box",
      padding: "8px",
      borderRadius: "4px",
      border: "1px solid rgba(255, 255, 255, 0.4)",
      background: "rgba(0, 0, 0, 0.2)",
      color: "#ffffff",
      fontSize: "13px",
      fontFamily: "inherit",
      marginTop: "8px"
    });
    box.appendChild(input);

    const row = doc.createElement("div");
    Object.assign(row.style, {
      display: "flex",
      justifyContent: "flex-end",
      gap: "8px",
      marginTop: "4px"
    });

    const saveBtn = doc.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Save";
    Object.assign(saveBtn.style, {
      padding: "4px 16px",
      borderRadius: "999px",
      border: "none",
      background: "#ffffff",
      color: "#1f2937",
      fontSize: "12px",
      fontFamily: "inherit",
      cursor: "pointer"
    });
    saveBtn.addEventListener("click", () => {
      const name = String(input.value || "").trim();
      if (!name) {
        // An empty name is a mistake, not a cancel — keep the dialog open.
        input.focus();
        return;
      }
      removeTemplatePrompt();
      onConfirm(name);
    });
    row.appendChild(saveBtn);

    const cancelBtn = doc.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    Object.assign(cancelBtn.style, {
      padding: "4px 16px",
      borderRadius: "999px",
      border: "1px solid rgba(255, 255, 255, 0.5)",
      background: "transparent",
      color: "#ffffff",
      fontSize: "12px",
      fontFamily: "inherit",
      cursor: "pointer"
    });
    cancelBtn.addEventListener("click", () => {
      removeTemplatePrompt();
      if (onCancel) onCancel();
    });
    row.appendChild(cancelBtn);

    box.appendChild(row);
    overlay.appendChild(box);

    // Enter saves, Escape cancels — bound on the overlay so the handlers die
    // with it (the input is focused, so its keydown bubbles here).
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveBtn.click();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelBtn.click();
      }
    });
    // Backdrop click cancels; clicks inside the box never reach the overlay.
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cancelBtn.click();
    });

    (doc.body || doc.documentElement).appendChild(overlay);
    templatePromptEl = overlay;
    input.focus();
  }

  function removeTemplatePrompt() {
    if (templatePromptEl && templatePromptEl.parentNode) {
      templatePromptEl.parentNode.removeChild(templatePromptEl);
    }
    templatePromptEl = null;
  }

// Fill this document and all reachable same-origin iframes, summing results.
// "Unmatched" counts profile entries that matched no field anywhere, so the
// per-document tallies are merged (a wrapper page with no fields must not
// report every profile entry as unmatched).
function fillPageAll(activeProfile, force) {
    const totals = { filled: 0, skipped: 0, unmatched: 0, docs: 0, skippedNames: [] };
    const allMatchedKeys = new Set();
    forEachSameOriginDoc(
      (doc) => {
        totals.docs++;
        const r = fillPage(activeProfile, doc);
        totals.filled += r.filled;
        totals.skipped += r.skipped;
        if (Array.isArray(r.skippedNames)) totals.skippedNames.push(...r.skippedNames);
        if (Array.isArray(r.matchedKeys)) for (const key of r.matchedKeys) allMatchedKeys.add(key);
        // A template match replaces the whole page's fill — surface it to the
        // caller (the background toasts "Filled from template: X").
        if (r.templateUsed) totals.templateUsed = r.templateUsed;
      },
      undefined,
      force
    );
    const profile = activeProfile && typeof activeProfile === "object" ? activeProfile : {};
    const fields =
      profile.fields && typeof profile.fields === "object" ? profile.fields : {};
    const totalEntries = buildMatchEntries(fields).length;
    totals.matchedKeys = Array.from(allMatchedKeys);
    totals.totalEntries = totalEntries;
    totals.unmatched = Math.max(0, totalEntries - allMatchedKeys.size);
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
  // Wrong-autofill correction: global exclusions live in browser.storage.local
  // (the sync quota is a hard 100 KiB and not raisable), keyed by a signature
  // string, each record { profileKey, fieldNorms, ts }.
  const EXCLUSIONS_LOCAL = "jtk-form-filler-exclusions";
  const CLEAR_TIMEOUT_MS = 8000;
  const UNDO_TTL_MS = 60000;
  // Page templates also live in browser.storage.local: key
  // "jtk-form-filler-templates" → { "<id>": { name, shape, fields, savedUrl,
  // createdAt } }.
  const TEMPLATES_LOCAL = "jtk-form-filler-templates";
  // Profiles are offloaded from storage.sync to storage.local (unlimited)
  // to stay under the 100 KiB sync quota.
  const PROFILES_LOCAL = "jtk-form-filler-profiles";
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

  // Wrong-autofill correction state: profileKey -> array of fieldNorms arrays
  // that must never be autofilled again (a GLOBAL exclusion, persisted in
  // browser.storage.local). Loaded alongside config; a failure leaves an empty
  // map so the feature degrades to "no exclusions" rather than throwing.
  let exclusionsByKey = new Map(); // profileKey -> Array<Array<string>> (fieldNorms)

  async function reloadExclusions() {
    try {
      const res = await browser.storage.local.get(EXCLUSIONS_LOCAL);
      const map = res && res[EXCLUSIONS_LOCAL];
      exclusionsByKey = new Map();
      if (map && typeof map === "object") {
        for (const sig of Object.keys(map)) {
          const rec = map[sig];
          if (!rec || typeof rec.profileKey !== "string" || !Array.isArray(rec.fieldNorms)) continue;
          const norms = rec.fieldNorms.filter((n) => typeof n === "string" && n !== "");
          if (!norms.length) continue;
          const list = exclusionsByKey.get(rec.profileKey);
          if (list) list.push(norms); else exclusionsByKey.set(rec.profileKey, [norms]);
        }
      }
    } catch (err) {
      exclusionsByKey = new Map();
    }
  }

  // True when a stored exclusion's fieldNorms intersect the group's current
  // candidate set — the same identity space matching uses, so an exclusion
  // recorded against one identity (title, name, label, ...) blocks every
  // identity that would have matched the same profile entry.
  function isExcluded(profileKey, group) {
    const list = exclusionsByKey.get(profileKey);
    if (!list || list.length === 0) return false;
    const cands = groupCandidates(group);
    for (const norms of list) {
      for (const n of norms) {
        if (cands.indexOf(n) !== -1) return true;
      }
    }
    return false;
  }

  async function loadConfig() {
    try {
      const res = await browser.storage.sync.get(STORAGE_KEY);
      const store = res && res[STORAGE_KEY];
      const mod = store && store.modules && store.modules[MODULE_ID];
      let whitelist = [];
      if (mod && Array.isArray(mod.whitelist)) whitelist = mod.whitelist;
      let profileFields = {};
      const activeProfile = mod && mod.activeProfile;
      // Profiles live in storage.local (offloaded from sync to avoid the
      // 100 KiB quota). Fall back to the sync copy for pre-migration data.
      let profiles = {};
      try {
        const localRes = await browser.storage.local.get(PROFILES_LOCAL);
        profiles = localRes[PROFILES_LOCAL] || {};
      } catch (e) { /* ignore */ }
      if ((!profiles || Object.keys(profiles).length === 0) && mod && mod.profiles) {
        profiles = mod.profiles;
      }
      const active = activeProfile && profiles[activeProfile];
      if (active && active.fields && typeof active.fields === "object") {
        profileFields = active.fields;
      }
      config = {
        whitelist: whitelist,
        profileFields: profileFields,
        debug: mod && mod.debug === true
      };
      await reloadExclusions();
      await reloadTemplates();
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

  // Stage logging for the AI flow (page console). Gated behind the module
  // debug flag — when off, the page console stays quiet; the background still
  // logs every stage, and with debug on it also mirrors via aiDebugLog.
  // No id (direct harness calls) falls back to "?".
  function aiLog(flowId, text) {
    if (!config.debug) return;
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
      // The first input, not the anchor: a multiChoice anchor is the question
      // title element, which would defeat the type-compatibility check.
      { el: group.inputs[0], candidates: groupCandidates(group) }
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

  // Context-menu "Autofill this field once": fill the single right-clicked
  // question group from the profile, unconditionally, exactly like the in-page
  // up-arrow button (unlike fill-page, which never overwrites existing data).
  // The profile fields come from the background so the click always sees the
  // active profile. No whitelist interaction here — that is the background's
  // call, and it deliberately skips it for this action. Returns
  // { ok, key, label } on success or { ok: false, error } when the field is
  // gone, the question is unrecognized, or nothing matches.
  function fillFieldOnceAction(profileFields, targetElementId) {
    const el = resolveFieldElement(targetElementId);
    if (!el) {
      return { ok: false, error: "No fillable field at the right-clicked element." };
    }
    const root = el.ownerDocument || document;
    const groups = discoverGroups(root);
    let group = null;
    for (const g of groups) {
      if (g.inputs.indexOf(el) !== -1) {
        group = g;
        break;
      }
    }
    if (!group) {
      return { ok: false, error: "Could not identify the question for this field." };
    }
    const entries = buildMatchEntries(profileFields || {});
    const matches = matchFields(entries, [
      // The first input, not the anchor: a multiChoice anchor is the question
      // title element, which would defeat the type-compatibility check.
      { el: group.inputs[0], candidates: groupCandidates(group) }
    ]);
    if (!matches.length) {
      const display =
        group.titleText || group.key || group.inputs[0].name || group.inputs[0].id;
      return { ok: false, error: 'No saved value matches "' + display + '".' };
    }
    if (isExcluded(matches[0].key, group)) {
      const display =
        group.titleText || group.key || group.inputs[0].name || group.inputs[0].id;
      return { ok: false, error: 'Skipped — "' + display + '" was marked as incorrect.' };
    }
    // Unconditional override, same as the in-page up-arrow button.
    fillGroup(group, matches[0].entry.value);
    showClearButton(group);
    const label =
      group.titleText || group.key || group.inputs[0].name || group.inputs[0].id;
    return { ok: true, key: matches[0].key, label: label };
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
      // Diagnostic: log the exact state so we can diagnose why select values
      // appear empty. Only when debug is on to avoid breaking test harnesses.
      if (config && config.debug) {
        console.log(
          "[Form Filler] onAddClick empty scalar diag:",
          "kind=" + group.kind,
          "tag=" + (group.inputs[0] ? group.inputs[0].tagName : "?"),
          "value=" + JSON.stringify(desc.value),
          "name=" + JSON.stringify(desc.name),
          "el.value=" + (group.inputs[0] && group.inputs[0].value != null ? JSON.stringify(group.inputs[0].value) : "?"),
          "el.type=" + (group.inputs[0] ? group.inputs[0].type : "?"),
          "selectedIndex=" + (group.inputs[0] && group.inputs[0].selectedIndex != null ? group.inputs[0].selectedIndex : "?"),
          "options.length=" + (group.inputs[0] && group.inputs[0].options ? group.inputs[0].options.length : "?")
        );
      }
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
    if (match && isExcluded(match.key, group)) {
      toast('Skipped — "' + display + '" was marked as incorrect.');
      if (entry) {
        entry.fillBtn.classList.add("jtk-ff-dim");
        entry.fillBtn.title = "Skipped (marked incorrect)";
      }
      return;
    }
    if (!match) {
      toast('No saved value matches "' + display + '".');
      if (entry) entry.fillBtn.classList.add("jtk-ff-dim");
      return;
    }
    // Deliberate unconditional overwrite (no isFilled guard): the per-question
    // fill is an explicit override, unlike fill-page. No toast on success —
    // the visible value change is the feedback.
    fillGroup(group, match.entry.value);
    showClearButton(group);
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
    if (match && isExcluded(match.key, group)) {
      entry.fillBtn.classList.add("jtk-ff-dim");
      entry.fillBtn.title = "Skipped (marked incorrect)";
    } else if (match) {
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
  // Wrong-autofill correction: transient × button
  // ------------------------------------------------------------------
  //
  // After a successful autofill a small × appears beside the field. Clicking
  // it clears the group and records a GLOBAL exclusion for the profile-entry ↔
  // field pairing so all future autofills skip it (persisted in
  // browser.storage.local via the background). An Undo toast restores the
  // value and removes the exclusion. This is a standalone overlay — NOT gated
  // by the whitelist, and never rendered for AI answers (exclusions only apply
  // to profile-entry-based fills).

  let clearButtons = new Map(); // group.anchor -> { wrapper, timer, inputCleanups }
  let undoBuffer = new Map(); // compositeKey -> { group, value, ts }

  function compositeKey(profileKey, fieldNorms) {
    return profileKey + "\u0000" + fieldNorms.slice().sort().join("\u0001");
  }

  function showClearButton(group) {
    if (!group || !group.inputs || !group.inputs.length) return;
    removeClearButton(group);
    const doc = group.inputs[0].ownerDocument || document;
    const wrapper = doc.createElement("span");
    wrapper.className = BTN_WRAPPER_CLASS;

    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "jtk-ff-btn jtk-ff-clear";
    // × icon: two crossing strokes. The existing icons are fill-based; this
    // one is stroke-based, so the stroke attributes go on the svg element.
    const icon = createIcon(doc, [["path", { d: "M2 2l8 8M10 2L2 10" }]]);
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.5");
    btn.appendChild(icon);
    btn.title = "Clear and don't autofill this field again";
    btn.setAttribute("aria-label", "Clear and don't autofill this field again");
    btn.addEventListener("click", (e) => onClearClick(e, group));
    wrapper.appendChild(btn);

    const titleEl = group.titleEl;
    if (titleEl && titleEl.parentNode) {
      titleEl.parentNode.insertBefore(wrapper, titleEl.nextSibling);
    } else {
      const first = group.inputs[0];
      const parent = first.parentNode;
      if (parent) parent.insertBefore(wrapper, first.nextSibling);
    }

    // Same negative-top centering as the button pair (positionButtons).
    const target = group.titleEl || group.inputs[0];
    const measured = target.getBoundingClientRect().height;
    const fieldH = measured > 0 ? measured : 40;
    let marginBottom = 0;
    const view = target.ownerDocument ? target.ownerDocument.defaultView : null;
    if (view && typeof view.getComputedStyle === "function") {
      const mb = parseFloat(view.getComputedStyle(target).marginBottom);
      if (isFinite(mb) && mb > 0) marginBottom = Math.min(mb, 40);
    }
    wrapper.style.top = -Math.round(fieldH / 2 + marginBottom) + "px";

    // Auto-remove: a timeout, plus one-shot input/change listeners on every
    // member field (the user editing the field makes the correction moot).
    const inputCleanups = [];
    const timer = setTimeout(() => removeClearButton(group), CLEAR_TIMEOUT_MS);
    for (const el of group.inputs) {
      const onEdit = () => removeClearButton(group);
      el.addEventListener("input", onEdit, true);
      el.addEventListener("change", onEdit, true);
      inputCleanups.push(() => {
        el.removeEventListener("input", onEdit, true);
        el.removeEventListener("change", onEdit, true);
      });
    }
    clearButtons.set(group.anchor, {
      wrapper: wrapper,
      timer: timer,
      inputCleanups: inputCleanups
    });
  }

  function removeClearButton(group) {
    const entry = clearButtons.get(group.anchor);
    if (!entry) return;
    clearTimeout(entry.timer);
    for (const cleanup of entry.inputCleanups) {
      try {
        cleanup();
      } catch (err) {
        // Ignore.
      }
    }
    if (entry.wrapper && entry.wrapper.parentNode) entry.wrapper.remove();
    clearButtons.delete(group.anchor);
  }

  function onClearClick(e, group) {
    e.preventDefault();
    e.stopPropagation();
    const match = findProfileMatch(group);
    if (!match) {
      removeClearButton(group);
      return;
    }
    const value = match.entry.value;
    clearGroup(group);
    const fieldNorms = groupCandidates(group);
    // Prune stale undo entries while we're here.
    const now = Date.now();
    for (const [key, entry] of undoBuffer) {
      if (now - entry.ts > UNDO_TTL_MS) undoBuffer.delete(key);
    }
    undoBuffer.set(compositeKey(match.key, fieldNorms), {
      group: group,
      value: value,
      ts: now
    });
    // Fire-and-forget: the background persists the exclusion in storage.local.
    browser.runtime
      .sendMessage({
        type: "form-filler:addExclusion",
        profileKey: match.key,
        fieldNorms: fieldNorms
      })
      .catch(() => {});
    const msg = 'Cleared — won\'t autofill "' + match.key + '" here again.';
    try {
      if (typeof window.jobAppToolkit.content.showToast === "function") {
        // The toast action button sends { type: action.type, ...action.payload }
        // to the background, so the payload carries exactly profileKey +
        // fieldNorms for the undo round-trip.
        window.jobAppToolkit.content.showToast(msg, {
          type: "form-filler:undoExclusion",
          label: "Undo",
          payload: { profileKey: match.key, fieldNorms: fieldNorms }
        });
      } else {
        toast(msg);
      }
    } catch (err) {
      toast(msg);
    }
    removeClearButton(group);
  }

  // Empty a question group (the inverse of fillGroup): radios uncheck, multi
  // selects deselect every option, checkboxes uncheck, singles clear to "".
  // Every changed control dispatches the same user-like events fillGroup uses.
  function clearGroup(group) {
    if (!group || !group.inputs || !group.inputs.length) return;
    if (group.kind === "radio") {
      for (const el of group.inputs) {
        if (el.checked) {
          el.checked = false;
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      return;
    }
    if (group.kind === "multiChoice") {
      for (const el of group.inputs) {
        if (el.tagName === "SELECT") {
          let changed = false;
          for (const opt of el.options) {
            if (opt.selected) {
              opt.selected = false;
              changed = true;
            }
          }
          if (changed) el.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (el.type === "checkbox") {
          if (el.checked) {
            el.checked = false;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
      }
      return;
    }
    // Single: clear to "" via the native setter (fillField skips nothing for
    // empty strings, but setNativeValue is the exact same path fillField uses
    // for text inputs and dispatches both events).
    const el = group.inputs[0];
    // React-Select widgets hold the visible selection in the DOM, so the native
    // setter only wipes the hidden search box and "Yes" stays on screen. Click
    // the widget's own clear affordance first when there is one; clearComboboxWidget
    // is try/caught and returns false otherwise, falling through to the setter.
    if (el && isComboboxInput(el) && clearComboboxWidget(el)) return;
    if (el && el.value !== "") {
      setNativeValue(el, "");
    }
  }

  // Undo a wrong-autofill correction: restore the cleared value and drop the
  // exclusion (the background removes the stored record). No-op when the undo
  // buffer has no entry (expired, or the message arrived without a click).
  function handleUndoExclusion(message) {
    const key = compositeKey(message.profileKey, message.fieldNorms);
    const entry = undoBuffer.get(key);
    if (entry && entry.group && entry.group.inputs[0] && entry.group.inputs[0].isConnected) {
      fillGroup(entry.group, entry.value);
      undoBuffer.delete(key);
      toast('Undid — this field can autofill again.');
      const btnEntry = buttonMap.get(entry.group.anchor);
      if (btnEntry) updateButtonState(btnEntry, entry.group);
    }
    return { ok: true };
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

  // Walk a parsed JSON-LD value (node, array, or @graph) for a JobPosting.
  function findJobPostingNode(data) {
    if (!data) return null;
    const nodes = Array.isArray(data) ? data : [data];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node["@graph"])) {
        const nested = findJobPostingNode(node["@graph"]);
        if (nested) return nested;
      }
      const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
      if (types.indexOf("JobPosting") !== -1) return node;
    }
    return null;
  }

  // Cap for Ask AI job-description context (keep in sync with background
  // JOB_DESC_MAX_CHARS). Truncates at a word boundary when possible.
  const JOB_DESC_MAX_CHARS = 10000;
  const WELLFOUND_JOB_SLUG_RE = /^[0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*$/i;

  function truncateJobDescriptionText(text) {
    const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    if (s.length <= JOB_DESC_MAX_CHARS) return s;
    let cut = s.slice(0, JOB_DESC_MAX_CHARS);
    const m = cut.match(/\s+\S*$/);
    if (m && m.index > 0) cut = cut.slice(0, m.index);
    return cut.trim();
  }

  // Wellfound live-DOM fast path. Keep the URL gate narrow so a generic
  // #job-description on another page can never be reported as Wellfound.
  function wellfoundJobDescriptionFromDom(root) {
    const empty = { title: "", description: "" };
    try {
      const doc = root || document;
      const loc = doc.location || (doc.defaultView && doc.defaultView.location);
      const u = new URL(loc && loc.href ? loc.href : "");
      const host = u.hostname.toLowerCase();
      if (host !== "wellfound.com" && host !== "www.wellfound.com") return empty;

      const directPath = /^\/jobs\/\d+-[^/]+\/?$/.test(u.pathname);
      let queryPath = false;
      if (/^\/jobs\/?$/.test(u.pathname)) {
        const slugs = u.searchParams.getAll("job_listing_slug");
        queryPath = slugs.length === 1 && WELLFOUND_JOB_SLUG_RE.test(slugs[0]);
      }
      if (!directPath && !queryPath) return empty;

      const descriptionNode = doc.querySelector("#job-description");
      if (!descriptionNode) return empty;
      const tmp = doc.createElement("div");
      tmp.innerHTML = descriptionNode.innerHTML || descriptionNode.textContent || "";
      const description = truncateJobDescriptionText(tmp.textContent || "");
      if (!description) return empty;

      // An explicit h1 is a strong enough signal; do not infer a title from
      // the URL slug or unrelated metadata.
      const titleNode = doc.querySelector("h1");
      const title = titleNode ? collapseWs(titleNode.textContent) : "";
      return { title: title, description: description };
    } catch (err) {
      return empty;
    }
  }

  // MyGreenhouse gate + extraction for Ask AI. The "Quick Apply with
  // MyGreenhouse" wrapper is server-rendered beside the application form (the
  // button text is injected client-side, so match the class, not the text) —
  // detection therefore works on any company domain and inside the embedded
  // application iframe. Also derives the Greenhouse org + job id for the
  // background API fallback: from this frame's URL when it is a Greenhouse
  // board, else from the embed script (?for=<org>) and a data-job-id element.
  // `isGreenhouse` is the button gate; org/jobId are still reported when the
  // gate is false so the background can join them across frames (the gate
  // lives in the application iframe, the job id on the company page).
  function greenhouseProbe(root) {
    const doc = root || document;
    let org = "";
    let jobId = "";
    try {
      const loc = new URL(doc.location ? doc.location.href : "");
      if (/greenhouse\.io$/.test(loc.hostname)) {
        const parts = loc.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
        if (parts[0] === "embed") {
          org = loc.searchParams.get("for") || "";
        } else if (parts.length >= 2 && parts[0] !== "jobs") {
          org = parts[0];
          jobId = parts[parts.length - 1];
        }
      }
    } catch (err) {
      // Ignore.
    }
    if (!org) {
      const emb = doc.querySelector(
        'script[src*="greenhouse.io/embed/job_board"][src*="for="]'
      );
      if (emb) {
        try {
          org = new URL(
            emb.getAttribute("src"),
            doc.location ? doc.location.href : undefined
          ).searchParams.get("for") || "";
        } catch (err) {
          // Ignore.
        }
      }
    }
    if (!jobId) {
      const jidEl = doc.querySelector("[data-job-id]");
      if (jidEl) jobId = String(jidEl.getAttribute("data-job-id") || "");
    }
    const empty = { isGreenhouse: false, org: org, jobId: jobId, title: "", description: "" };
    const gate = doc.querySelector(".application--header--autofill-with-greenhouse");
    if (!gate) return empty;
    let title = "";
    const h1 = doc.querySelector(".job__title h1");
    if (h1) {
      title = collapseWs(h1.textContent);
    } else {
      const og = doc.querySelector('meta[property="og:title"]');
      if (og) title = collapseWs(og.getAttribute("content"));
    }
    let description = "";
    const descNode = doc.querySelector(".job__description");
    if (descNode) description = truncateJobDescriptionText(collapseWs(descNode.textContent || ""));
    return { isGreenhouse: true, org: org, jobId: jobId, title: title, description: description };
  }

  // JobPosting JSON-LD -> { title, description } for Ask AI. Description may
  // be HTML; strip to plain text. Empty strings when nothing usable is found.
  function jobPostingFromJsonLd(root) {
    const empty = { title: "", description: "" };
    try {
      const scripts = (root || document).querySelectorAll(
        'script[type="application/ld+json"]'
      );
      for (let i = 0; i < scripts.length; i++) {
        let data;
        try {
          data = JSON.parse(scripts[i].textContent);
        } catch (err) {
          continue;
        }
        const node = findJobPostingNode(data);
        if (!node) continue;
        const title =
          typeof node.title === "string" ? collapseWs(node.title) : "";
        let description = "";
        if (typeof node.description === "string" && node.description.trim()) {
          try {
            const tmp = document.createElement("div");
            tmp.innerHTML = node.description;
            description = collapseWs(tmp.textContent || "");
          } catch (err) {
            description = collapseWs(
              String(node.description).replace(/<[^>]+>/g, " ")
            );
          }
        }
        description = truncateJobDescriptionText(description);
        if (description) return { title: title, description: description };
      }
    } catch (err) {
      // Ignore.
    }
    return empty;
  }

  // JobPosting structured data -> hiringOrganization.name. The ATS emits this
  // for crawlers, so it is the most accurate company source on job boards.
  // Handles a single node, an array of nodes, @graph, and @type arrays.
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
        const node = findJobPostingNode(data);
        if (!node) continue;
        const org = node.hiringOrganization;
        if (org && typeof org.name === "string") {
          const name = collapseWs(org.name);
          if (name) return name;
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
    removeAlreadyAppliedWarning();
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
    // Wrong-autofill correction: drop every transient × button and the undo
    // buffer (the exclusions themselves persist in storage.local).
    for (const group of clearButtons.keys()) {
      try {
        removeClearButton(group);
      } catch (err) {
        // Ignore.
      }
    }
    clearButtons.clear();
    undoBuffer.clear();
    // Page templates: drop the in-memory copy (the persisted store is
    // untouched). Preserve an open naming dialog — the user triggered it
    // deliberately and should not lose it to a background scan or module
    // toggle. It is removed only by explicit Save/Cancel or a fresh
    // showTemplatePrompt call.
    savedTemplates = [];
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
    checkAlreadyApplied();
    await loadConfig();
    startObserving();
    scanPage();
  }

  // This is deliberately a top-frame, one-shot check.  The warning is an
  // alert rather than a toast because it is important context for the whole
  // application page, but it must remain passive so it cannot interrupt form
  // entry or steal focus.
  let alreadyAppliedChecked = false;
  let alreadyAppliedWarningEl = null;
  let alreadyAppliedWarningTimer = null;
  function checkAlreadyApplied() {
    if (alreadyAppliedChecked || window.top !== window) return;
    alreadyAppliedChecked = true;
    try {
      const request = browser.runtime.sendMessage({
        type: "form-filler:hasAppliedToCurrentUrl",
        url: location.href
      });
      Promise.resolve(request).then((result) => {
        if (
          result &&
          result.alreadyApplied === true &&
          window.jobAppToolkit.content.isModuleActive(MODULE_ID)
        ) {
          showAlreadyAppliedWarning();
        }
      }).catch(() => {});
    } catch (err) {
      // Runtime messaging can be unavailable while a temporary add-on reloads.
    }
  }

  function removeAlreadyAppliedWarning() {
    if (alreadyAppliedWarningTimer) {
      clearTimeout(alreadyAppliedWarningTimer);
      alreadyAppliedWarningTimer = null;
    }
    if (alreadyAppliedWarningEl && alreadyAppliedWarningEl.parentNode) {
      alreadyAppliedWarningEl.parentNode.removeChild(alreadyAppliedWarningEl);
    }
    alreadyAppliedWarningEl = null;
  }

  function showAlreadyAppliedWarning() {
    if (alreadyAppliedWarningEl || document.querySelector(".jtk-ff-applied-warning")) return;
    const alert = document.createElement("div");
    alert.className = "jtk-ff-applied-warning";
    alert.setAttribute("role", "alert");
    alert.setAttribute("aria-live", "assertive");
    alert.setAttribute("aria-atomic", "true");
    Object.assign(alert.style, {
      position: "fixed",
      top: "16px",
      left: "16px",
      zIndex: "2147483647",
      width: "min(360px, calc(100vw - 32px))",
      boxSizing: "border-box",
      display: "flex",
      alignItems: "flex-start",
      gap: "10px",
      padding: "14px 16px",
      border: "2px solid #7f1d1d",
      borderRadius: "10px",
      background: "#dc2626",
      color: "#ffffff",
      font: "600 14px/1.4 system-ui, -apple-system, sans-serif",
      textAlign: "left",
      boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)",
      pointerEvents: "none",
      opacity: "1"
    });
    for (const name of ["width", "box-sizing", "display", "padding", "border", "border-radius", "background", "color", "font", "text-align", "box-shadow", "pointer-events", "opacity", "position", "top", "left", "z-index"]) {
      alert.style.setProperty(name, alert.style.getPropertyValue(name), "important");
    }

    const mark = document.createElement("span");
    mark.textContent = "!";
    mark.setAttribute("aria-hidden", "true");
    Object.assign(mark.style, {
      flex: "none",
      width: "22px",
      height: "22px",
      borderRadius: "50%",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      background: "#ffffff",
      color: "#b91c1c",
      font: "800 16px/1 system-ui, sans-serif"
    });
    for (const name of ["flex", "width", "height", "border-radius", "display", "align-items", "justify-content", "background", "color", "font"]) {
      mark.style.setProperty(name, mark.style.getPropertyValue(name), "important");
    }
    const copy = document.createElement("span");
    copy.textContent = "You already applied to this job.";
    copy.style.setProperty("color", "#ffffff", "important");
    copy.style.setProperty("font", "600 14px/1.4 system-ui, -apple-system, sans-serif", "important");
    alert.appendChild(mark);
    alert.appendChild(copy);
    (document.body || document.documentElement).appendChild(alert);
    alreadyAppliedWarningEl = alert;
    alreadyAppliedWarningTimer = setTimeout(() => {
      if (alert.parentNode) alert.parentNode.removeChild(alert);
      if (alreadyAppliedWarningEl === alert) alreadyAppliedWarningEl = null;
      alreadyAppliedWarningTimer = null;
    }, 3000);
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

  // Snapshot of the field each AI flow started from, keyed by flowId. The
  // right-click capture (getAIFieldInfo) resolves the element while the menu
  // is alive; later fill/spinner/error messages for the same flow may arrive
  // after browser.menus.getTargetElement's weak reference to that element has
  // died, so we cache the resolved element here and fall back to it.
  const aiFieldCache = new Map();

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

  function handleAiSpinner(show, targetElementId, flowId) {
    if (!show) {
      hideAiSpinner();
      return { ok: true };
    }
    const el = resolveAiField(targetElementId, flowId);
    if (!el) return { ok: false };
    showAiSpinner(el);
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // AI error icon (red ! replacing the spinner on failure)
  // ------------------------------------------------------------------
  //
  // When the AI answer fails (API error, timeout, fill rejected), the
  // background sends form-filler:aiError. The content script replaces the
  // spinner with a red "!" icon at the same position. The icon persists
  // until the field's focus state changes (blur→focus or focus→blur), at
  // which point it is removed. Hovering shows the error via title.

  let aiErrorEl = null;       // the visible ! icon, if any
  let aiErrorField = null;    // the field the icon tracks
  let aiErrorFocusCleaner = null; // { blur, focus } — the listeners we attached

  const AI_ERROR_CLASS = "jtk-ff-ai-error";

  function injectAiErrorStyles(doc) {
    const root = doc || document;
    if (root.getElementById(SPINNER_STYLE_ID)) return;
    // Reuse the same style id — only one of spinner/error is ever visible.
    const style = root.createElement("style");
    style.id = SPINNER_STYLE_ID;
    style.textContent =
      // The red ! icon: same positioning as the spinner (fixed, top-left
      // of the field +6px). Small red circle with white !, pointer-events
      // none so it never blocks input.
      ".jtk-ff-ai-error{position:fixed;width:14px;height:14px;box-sizing:border-box;" +
      "border-radius:50%;background:#dc2626;color:#fff;font-size:10px;line-height:14px;" +
      "text-align:center;font-weight:700;pointer-events:none;z-index:2147483000;}";
    (root.head || root.documentElement).appendChild(style);
  }

  function positionAiError() {
    if (!aiErrorEl || !aiErrorField) return;
    try {
      if (!aiErrorField.isConnected) return;
      const rect = aiErrorField.getBoundingClientRect();
      const view = aiErrorEl.ownerDocument.defaultView || window;
      const vw = view.innerWidth || 0;
      const vh = view.innerHeight || 0;
      const onScreen =
        (vw <= 0 || (rect.left < vw && rect.right > 0)) &&
        (vh <= 0 || (rect.top < vh && rect.bottom > 0));
      if (!onScreen) return;
      aiErrorEl.style.left = Math.round(rect.left + 6) + "px";
      aiErrorEl.style.top = Math.round(rect.top + 6) + "px";
    } catch (err) {
      // Never fatal.
    }
  }

  function showAiError(el, errorMsg) {
    hideAiError();
    hideAiSpinner(); // clear any leftover spinner first
    const doc = el.ownerDocument || document;
    injectAiErrorStyles(doc);
    const holder = doc.body || doc.documentElement;
    if (!holder) return;
    aiErrorEl = doc.createElement("div");
    aiErrorEl.className = AI_ERROR_CLASS;
    aiErrorEl.setAttribute("aria-hidden", "true");
    aiErrorEl.title = errorMsg || "AI answer failed";
    aiErrorEl.textContent = "!";
    holder.appendChild(aiErrorEl);
    aiErrorField = el;
    positionAiError();
    // Re-position on scroll/resize so the icon stays near the field.
    const view = doc.defaultView || window;
    view.addEventListener("scroll", positionAiError, true);
    view.addEventListener("resize", positionAiError, true);
    // Attach focus/blur listener to the field: any focus-state change
    // removes the error icon. Use capture phase so we catch events even
    // when the field is in a shadow DOM or deeply nested.
    const onBlur = function () { hideAiError(); };
    const onFocus = function () { hideAiError(); };
    aiErrorFocusCleaner = { blur: onBlur, focus: onFocus };
    el.addEventListener("blur", onBlur, true);
    el.addEventListener("focus", onFocus, true);
  }

  function hideAiError() {
    if (aiErrorFocusCleaner && aiErrorField) {
      aiErrorField.removeEventListener("blur", aiErrorFocusCleaner.blur, true);
      aiErrorField.removeEventListener("focus", aiErrorFocusCleaner.focus, true);
      aiErrorFocusCleaner = null;
    }
    if (aiErrorEl) {
      const doc = aiErrorEl.ownerDocument;
      const view = doc.defaultView || window;
      view.removeEventListener("scroll", positionAiError, true);
      view.removeEventListener("resize", positionAiError, true);
      if (aiErrorEl.parentNode) aiErrorEl.parentNode.removeChild(aiErrorEl);
      const style = doc.getElementById(SPINNER_STYLE_ID);
      if (style) style.remove();
      aiErrorEl = null;
    }
    aiErrorField = null;
  }

  function handleAiError(targetElementId, errorMsg, flowId) {
    const el = resolveAiField(targetElementId, flowId);
    if (!el) { hideAiError(); return { ok: true }; }
    showAiError(el, errorMsg);
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------

  try {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "sync") {
        if (changes[STORAGE_KEY]) ensureActive();
      } else if (area === "local") {
        // Wrong-autofill correction: reload the exclusion map. buttonMap only
        // stores entry objects (keyed by group.anchor), so per-entry refresh
        // is skipped here — the 2s poll re-runs ensureButtons/updateButtonState
        // for every group anyway, which is the backstop.
        if (changes[EXCLUSIONS_LOCAL]) reloadExclusions().catch(() => {});
        // Page templates: pick up saves/deletes made by the background.
        if (changes[TEMPLATES_LOCAL]) reloadTemplates().catch(() => {});
      }
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
        else {
          removeTemplatePrompt();
          teardown();
        }
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
    if (type === "fillFieldOnce") {
      return Promise.resolve(
        fillFieldOnceAction(message.profileFields, message.targetElementId)
      );
    }
    if (type === "undoExclusion") {
      return Promise.resolve(handleUndoExclusion(message));
    }
    if (type === "promptSaveTemplate") {
      // "Save page template" context-menu action → show the naming dialog,
      // then capture the current page's shape + per-group values and hand them
      // to the background for persistence. The dialog is content-side only and
      // not whitelist-gated (the background gates the menu visibility).
      showTemplatePrompt(
        function (name) {
          const shape = computePageShape(document);
          const groups = discoverGroups(document);
          const fields = [];
          for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            const identity = groupIdentity(g);
            if (!identity) continue;
            const desc = describeGroup(g);
            fields.push({ identity: identity, value: desc.value, fieldLabel: desc.fieldLabel });
          }
          browser.runtime
            .sendMessage({
              type: "form-filler:saveTemplate",
              name: name,
              shape: shape,
              fields: fields,
              url: location.href
            })
            .then((res) => {
              if (res && res.error) toast(res.error);
              else toast('Saved page template "' + name + '".');
            })
            .catch(() => {});
        },
        function () {
          // Cancelled — nothing to do.
        }
      );
      return undefined;
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
      // Snapshot the resolved element for the rest of this flow: the menu's
      // weak reference can die while the AI answer is pending, and the later
      // fill/spinner/error messages still need the field.
      if (message.flowId) aiFieldCache.set(message.flowId, el);
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
    if (type === "aiDebugLog") {
      // Background mirrors Ask AI stages here when debug is on. Never a toast.
      if (config.debug) {
        const stage = message.stage == null ? "" : String(message.stage);
        const detail = message.detail == null || message.detail === ""
          ? ""
          : ": " + String(message.detail);
        console.log(
          "[Form Filler AI #" + (message.flowId || "?") + " " +
            new Date().toISOString().slice(11, 23) + "] " + stage + detail
        );
      }
      return Promise.resolve({ ok: true });
    }
    if (type === "getJobDescription") {
      // MyGreenhouse button-gated path first: the wrapper is server-rendered
      // next to the application form, so it works on any company domain and
      // inside the embedded application iframe. org/jobId are reported on
      // every response so the background can join them across frames for the
      // board-API fallback.
      const gh = greenhouseProbe(document);
      if (gh.isGreenhouse) {
        aiLog(
          message.flowId,
          "job description (MyGreenhouse): " + gh.description.length + " chars" +
            (gh.title ? ' ("' + gh.title.slice(0, 80) + '")' : "") +
            (gh.org || gh.jobId ? " [org=" + gh.org + " job=" + gh.jobId + "]" : "")
        );
        return Promise.resolve({
          ok: true,
          flowId: message.flowId,
          adapterId: "greenhouse",
          jobTitle: gh.title,
          jobDescription: gh.description,
          org: gh.org,
          jobId: gh.jobId
        });
      }
      // Wellfound live-DOM fast path: prefer the rendered description before
      // asking the background to make its credentialed fetch.
      const wellfound = wellfoundJobDescriptionFromDom(document);
      if (wellfound.description) {
        aiLog(
          message.flowId,
          "job description (Wellfound): " + wellfound.description.length + " chars" +
            (wellfound.title ? ' ("' + wellfound.title.slice(0, 80) + '")' : "")
        );
        return Promise.resolve({
          ok: true,
          flowId: message.flowId,
          adapterId: "wellfound",
          jobTitle: wellfound.title,
          jobDescription: wellfound.description,
          org: gh.org,
          jobId: gh.jobId
        });
      }
      // Top-frame Ask AI fast path: JobPosting JSON-LD on the live page
      // (Ashby posts this on both the posting and /application URLs).
      const posting = jobPostingFromJsonLd(document);
      if (posting.description) {
        aiLog(
          message.flowId,
          "job description: " + posting.description.length + " chars" +
            (posting.title ? ' ("' + posting.title.slice(0, 80) + '")' : "")
        );
        return Promise.resolve({
          ok: true,
          flowId: message.flowId,
          adapterId: "",
          jobTitle: posting.title,
          jobDescription: posting.description,
          org: gh.org,
          jobId: gh.jobId
        });
      }
      aiLog(message.flowId, "job description: none on this document");
      return Promise.resolve({
        ok: false,
        flowId: message.flowId,
        adapterId: "",
        jobTitle: "",
        jobDescription: "",
        org: gh.org,
        jobId: gh.jobId
      });
    }
    if (type === "fillAIField") {
      const value = String(message.value == null ? "" : message.value);
      const el = resolveAiField(message.targetElementId, message.flowId);
      if (!el || !el.isConnected) {
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
      return Promise.resolve(handleAiSpinner(message.show !== false, message.targetElementId, message.flowId));
    }
    if (type === "aiError") {
      // Background signals the AI answer failed: replace the spinner with a
      // persistent red "!" icon on the target field. The icon is removed
      // when the field's focus state changes.
      aiLog(message.flowId, "error icon target " + message.targetElementId + ": " + (message.error || ""));
      return Promise.resolve(handleAiError(message.targetElementId, message.error, message.flowId));
    }
    return undefined;
  });
})();
