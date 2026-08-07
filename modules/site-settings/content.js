// Site Settings — content script module (Firefox WebExtensions, Manifest V2).
// Applies per-site settings to job boards. The first adapter is LinkedIn job
// search: every job card gets two small buttons beside the company name so the
// user can block (hide) or highlight (tint) all postings from that company,
// plus a filter button beside the job title that opens an in-page prompt for
// hiding postings by title keyword. Lists persist in sync storage and
// propagate to every open tab via storage.onChanged.
//
// An optional per-site toggle (sites.linkedin.showGlassdoorRatings) renders a
// small Glassdoor rating badge (★ 4.4) in flow next to the company name.
// Ratings are fetched from the background via site-settings:glassdoor:getRatings
// (names are collected on each scan and debounced into one request) and kept
// fresh through site-settings:glassdoor:updated broadcasts; the badge is
// rendered only once a rating entry actually arrives.
//
// Site-specific knowledge lives behind adapters ({ siteId, isTargetPage,
// findJobCards, companyFromCard }) so future job boards slot in without
// touching the driver below. Module activity and toasts come from
// core/content.js (loaded before this script).
(function () {
  "use strict";

  const MODULE_ID = "site-settings";
  const STORAGE_KEY = "jobAppToolkit";

  // ------------------------------------------------------------------
  // Site adapters
  // ------------------------------------------------------------------

  // Job card containers on the LinkedIn jobs search page. Kept defensive and
  // centralized: LinkedIn reworks its markup often, and this list is the first
  // thing to revisit when a card stops being found.
  const CARD_SELECTORS = [
    "li.job-card-container",
    "[data-job-id]",
    ".jobs-search-results-list li"
  ];

  // Company-name elements inside a card, in priority order.
  const COMPANY_SELECTORS = [
    '[data-anonymize="company-name"]',
    ".artdeco-entity-lockup__subtitle",
    ".job-card-container__primary-description",
    ".job-card-container__company-name",
    'a[data-tracking-control-name*="company"]',
    'a[href*="/company/"]',
    '[class*="company" i]'
  ];

  // Job-title elements inside a card, in priority order. Centralized like the
  // other selector lists — LinkedIn reworks its markup often, so this is the
  // first thing to revisit when a title stops being found.
  const TITLE_SELECTORS = [
    "a.job-card-container__link",
    ".job-card-list__title",
    '[data-anonymize="job-title"]',
    ".job-card-container__title",
    'a[data-tracking-control-name*="job-title"]',
    '[class*="job-title" i]'
  ];

  // Applied-job markers inside a card, in priority order. LinkedIn reworks its
  // markup often — this list is the first thing to revisit when applied jobs
  // stop hiding.
  const APPLIED_SELECTORS = [
    ".job-card-container__applied",
    '[class*="applied" i]',
    '[aria-label*="applied" i]',
    '[data-tracking-control-name*="applied" i]'
  ];

  function companyText(el) {
    // The ★/⊘ wrapper can live INSIDE the company element (in-flow placement
    // in the subtitle row), so a raw read would pollute the name with glyphs —
    // breaking dataset.company matching on every scan and isBlocked /
    // isHighlighted lookups. Read from a clone with our wrappers stripped.
    const clone = el.cloneNode(true);
    for (const w of clone.querySelectorAll(
      "." + BTN_WRAPPER_CLASS + ", ." + TITLE_BTN_WRAPPER_CLASS + ", ." + GD_WRAPPER_CLASS
    )) {
      w.remove();
    }
    let text = String(clone.textContent || "")
      .trim()
      .replace(/\s+/g, " ");
    // Some card variants append the location ("Acme · Remote"); keep the part
    // before the separator.
    text = text.split(/\s*[·•|]\s*/)[0].trim();
    return text;
  }

  function titleText(el) {
    // Same cleanup as companyText (trim + collapse whitespace) but without the
    // ·•| separator split: a job title is kept verbatim so keyword substrings
    // match against the whole title.
    return String(el.textContent || "")
      .trim()
      .replace(/\s+/g, " ");
  }

  const linkedinAdapter = {
    siteId: "linkedin",
    isTargetPage: function () {
      return /^\/jobs\/search/.test(location.pathname);
    },
    findJobCards: function (root) {
      const container = root.querySelector(".jobs-search-results-list");
      const scope = container || root;
      const seen = new Set();
      const cards = [];
      for (const sel of CARD_SELECTORS) {
        const nodes = scope.querySelectorAll(sel);
        for (const node of nodes) {
          if (seen.has(node)) continue;
          seen.add(node);
          cards.push(node);
        }
      }
      return cards;
    },
    companyFromCard: function (card) {
      for (const sel of COMPANY_SELECTORS) {
        const el = card.querySelector(sel);
        if (!el) continue;
        const text = companyText(el);
        // Length cap guards against whole-card text blobs caught by the broad
        // fallback selectors, but must stay generous: real company profile
        // names can be long (e.g. Underdog.io's 88-char name) and still need
        // block/highlight buttons.
        if (text && text.length < 200) return { el: el, name: text };
      }
      return null;
    },
    titleFromCard: function (card) {
      for (const sel of TITLE_SELECTORS) {
        const el = card.querySelector(sel);
        if (!el) continue;
        const text = titleText(el);
        if (text) return { el: el, text: text };
      }
      return null;
    }
  };

  const ADAPTERS = [linkedinAdapter];

  let adapter = null;

  function currentAdapter() {
    for (const a of ADAPTERS) {
      if (a.isTargetPage()) return a;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Config (per-site, from sync storage)
  // ------------------------------------------------------------------

  function siteConfigFromStore(store) {
    const mod = store && store.modules && store.modules[MODULE_ID];
    const site = mod && mod.sites && mod.sites[adapter.siteId];
    return site && typeof site === "object" ? site : {};
  }

  let config = {
    blockedCompanies: [],
    highlightedCompanies: [],
    titleBlockedKeywords: [],
    hideApplied: false,
    showGlassdoorRatings: false
  };

  async function loadConfig() {
    try {
      const res = await browser.storage.sync.get(STORAGE_KEY);
      const site = siteConfigFromStore(res[STORAGE_KEY]);
      config = {
        blockedCompanies: Array.isArray(site.blockedCompanies) ? site.blockedCompanies : [],
        highlightedCompanies: Array.isArray(site.highlightedCompanies)
          ? site.highlightedCompanies
          : [],
        titleBlockedKeywords: Array.isArray(site.titleBlockedKeywords)
          ? site.titleBlockedKeywords
          : [],
        hideApplied: site.hideApplied === true,
        showGlassdoorRatings: site.showGlassdoorRatings === true
      };
    } catch (err) {
      config = {
        blockedCompanies: [],
        highlightedCompanies: [],
        titleBlockedKeywords: [],
        hideApplied: false,
        showGlassdoorRatings: false
      };
    }
  }

  function normalizeCompany(name) {
    return String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function isBlocked(name) {
    const norm = normalizeCompany(name);
    return config.blockedCompanies.some((c) => normalizeCompany(c) === norm);
  }

  function isHighlighted(name) {
    const norm = normalizeCompany(name);
    return config.highlightedCompanies.some((c) => normalizeCompany(c) === norm);
  }

  // A title is keyword-blocked when its normalized form contains any normalized
  // keyword as a substring. Empty keywords and empty titles never match.
  function isTitleBlocked(title) {
    const norm = normalizeCompany(title);
    return config.titleBlockedKeywords.some((k) => {
      const normKey = normalizeCompany(k);
      return normKey && norm.includes(normKey);
    });
  }

  // Detects a card LinkedIn marks as already-applied. Returns true when (a) an
  // APPLIED_SELECTORS element is found, or (b) a SHORT text badge (≤40 chars)
  // word-matches /\bapplied\b/i — scanning the card's descendants but skipping
  // the job-title element and its subtree so a title like "Applied Scientist"
  // or a company like "Applied Materials" never counts. "Easy Apply" never
  // matches either: the word boundary requires "applied", not "apply".
  function isApplied(card, titleEl) {
    for (const sel of APPLIED_SELECTORS) {
      if (card.querySelector(sel)) return true;
    }
    for (const el of card.querySelectorAll("*")) {
      if (titleEl && (el === titleEl || titleEl.contains(el))) continue;
      const text = String(el.textContent || "").trim();
      if (!text || text.length > 40) continue;
      if (/\bapplied\b/i.test(text)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Styling (scoped, jtk- prefixed)
  // ------------------------------------------------------------------

  const STYLE_ID = "jtk-site-settings-styles";
  const BTN_WRAPPER_CLASS = "jtk-ss-btns";
  const TITLE_BTN_WRAPPER_CLASS = "jtk-ss-title-btns";
  const GD_WRAPPER_CLASS = "jtk-ss-gd";
  const GD_PENDING_CLASS = "jtk-ss-gd-pending";

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    // The buttons must paint ABOVE LinkedIn's job-card navigation overlay: the
    // whole card is clickable and often carries an absolutely-positioned (or
    // high-stacked) link/div that intercepts pointer events, so a low z-index
    // lets the card swallow the block/highlight clicks. The wrappers AND the
    // buttons use a high z-index with explicit pointer-events:auto so no
    // inherited pointer-events:none (some boards apply one on hover/overlay
    // states) can eat the clicks either.
    style.textContent =
      ".jtk-ss-block{display:none !important;}" +
      ".jtk-ss-highlight{background:rgba(255,196,0,.14) !important;box-shadow:inset 3px 0 0 rgba(202,138,4,.85);}" +
      ".jtk-ss-title-btns{display:inline-flex;align-items:center;gap:2px;margin-left:6px;vertical-align:middle;position:relative;z-index:1000;pointer-events:auto;}" +
      ".jtk-ss-btns{display:inline-flex;align-items:center;gap:2px;margin-left:6px;vertical-align:middle;position:relative;z-index:1000;pointer-events:auto;}" +
      ".jtk-ss-btn,.jtk-ss-filt{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:none;border-radius:4px;background:transparent;font-size:12px;line-height:1;cursor:pointer;opacity:.45;transition:opacity .15s ease,background .15s ease;position:relative;z-index:1000;pointer-events:auto;}" +
      ".jtk-ss-btns .jtk-ss-btn,.jtk-ss-title-btns .jtk-ss-filt{color:inherit !important;}" +
      ".jtk-ss-btn:hover,.jtk-ss-filt:hover{opacity:1;background:rgba(0,0,0,.06);}" +
      ".jtk-ss-btn.jtk-ss-btn-active{opacity:1;}" +
      ".jtk-ss-btn.jtk-ss-hl.jtk-ss-btn-active{color:#b45309;}" +
      ".jtk-ss-btn.jtk-ss-blk.jtk-ss-btn-active{color:#b91c1c;}" +
      // Glassdoor rating badge: painted above the card navigation overlay just
      // like the buttons (high z-index + explicit pointer-events:auto).
      ".jtk-ss-gd{display:inline-flex;align-items:center;gap:3px;margin-left:6px;vertical-align:middle;font-size:12px;line-height:1;color:#0caa41;text-decoration:none;cursor:pointer;opacity:.85;position:relative;z-index:1000;pointer-events:auto;}" +
      ".jtk-ss-gd:hover{opacity:1;text-decoration:underline;}" +
      ".jtk-ss-gd-pending{color:#9ca3af;cursor:default;text-decoration:none;}" +
      ".jtk-ss-gd-pending:hover{text-decoration:none;}" +
      // Failed badge ("?"): gray, clickable, sends a retry request to the
      // background. Same z-index/pointer-events as the success badge so the
      // card overlay doesn't eat the click.
      ".jtk-ss-gd-failed{color:#9ca3af;cursor:pointer;text-decoration:none;}" +
      ".jtk-ss-gd-failed:hover{opacity:1;color:#6b7280;}" +
      // Retrying state: a small CSS-only spinner (no image, no font glyph)
      // shown from the moment the user clicks "?" until the background's
      // retry broadcast resolves the badge.
      ".jtk-ss-gd-retrying{color:#9ca3af;cursor:default;text-decoration:none;display:inline-flex;align-items:center;}" +
      ".jtk-ss-gd-retrying:hover{text-decoration:none;}" +
      "@keyframes jtk-ss-gd-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}" +
      ".jtk-ss-gd-spinner{display:inline-block;width:10px;height:10px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:jtk-ss-gd-spin 0.8s linear infinite;}" +
      ".jtk-ss-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:2147483000;}" +
      ".jtk-ss-modal-card{background:#ffffff;border-radius:8px;padding:16px;width:min(360px,calc(100vw - 32px));box-shadow:0 4px 12px rgba(0,0,0,.15);font:13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;color:#111827;box-sizing:border-box;}" +
      ".jtk-ss-modal-label{display:block;margin:0 0 8px 0;color:#111827;}" +
      ".jtk-ss-modal-input{width:100%;padding:6px 8px;border:1px solid #d1d5db;border-radius:4px;font-size:13px;font-family:inherit;margin-bottom:12px;outline:none;box-sizing:border-box;}" +
      ".jtk-ss-modal-input:focus{border-color:#2563eb;box-shadow:0 0 0 2px rgba(37,99,235,.15);}" +
      ".jtk-ss-modal-actions{display:flex;justify-content:flex-end;gap:8px;}" +
      ".jtk-ss-modal-btn{padding:6px 12px;border:1px solid #d1d5db;border-radius:4px;background:#f9fafb;color:#111827;font-size:13px;font-family:inherit;cursor:pointer;}" +
      ".jtk-ss-modal-btn:hover{background:#f3f4f6;}" +
      ".jtk-ss-modal-btn-primary{background:#2563eb;border-color:#2563eb;color:#ffffff;}" +
      ".jtk-ss-modal-btn-primary:hover{background:#1d4ed8;}";
    (document.head || document.documentElement).appendChild(style);
  }

  // ------------------------------------------------------------------
  // Scan + apply
  // ------------------------------------------------------------------

  // Block must survive LinkedIn's SPA re-renders. LinkedIn's framework rewrites
  // `className` on result-card nodes when a card is selected/recycled, which
  // silently drops a class-based hide. An inline `display:none !important`
  // survives that (React doesn't manage inline styles here), and the tracked
  // set lets teardown un-hide exactly the cards we touched.
  const touchedCards = new Set();

  function applyCardState(card, name, titleText, titleEl) {
    const blocked =
      isBlocked(name) ||
      (titleText && isTitleBlocked(titleText)) ||
      (config.hideApplied && isApplied(card, titleEl));
    const highlighted = !blocked && isHighlighted(name);
    card.classList.toggle("jtk-ss-block", blocked);
    card.classList.toggle("jtk-ss-highlight", highlighted);
    if (blocked) {
      card.style.setProperty("display", "none", "important");
      touchedCards.add(card);
    } else {
      card.style.removeProperty("display");
    }
    return { blocked: blocked, highlighted: highlighted };
  }

  function sendSetCompany(name, state) {
    if (!adapter) return;
    console.log('[Site Settings] sendMessage setCompanyState "' + name + '" (' + state + ')');
    browser.runtime
      .sendMessage({
        type: "site-settings:setCompanyState",
        siteId: adapter.siteId,
        company: name,
        state: state
      })
      .then((res) => console.log("[Site Settings] setCompanyState response:", res))
      .catch((err) => {
        console.error("[Site Settings] setCompanyState failed:", err);
      });
  }

  function sendAddKeyword(keyword) {
    if (!adapter) return;
    browser.runtime
      .sendMessage({
        type: "site-settings:addTitleKeyword",
        siteId: adapter.siteId,
        keyword: keyword
      })
      .catch((err) => {
        console.error("Site Settings: addTitleKeyword failed:", err);
      });
  }

  // Job cards are fully clickable on LinkedIn — the company name lives inside
  // the card's <a>, and the whole card usually carries a navigation handler
  // (sometimes an absolutely-positioned overlay). Without stopping the event,
  // clicking a button would navigate to the job detail page (or be swallowed
  // by the overlay) and the block/highlight would never visibly apply.
  function onButtonClick(e, name, btn, stateKey) {
    e.preventDefault();
    e.stopPropagation();
    const state = btn.classList.contains("jtk-ss-btn-active") ? "none" : stateKey;
    console.log('[Site Settings] button click: "' + name + '" -> ' + state);
    sendSetCompany(name, state);
  }

  function createButtons(name) {
    const wrapper = document.createElement("span");
    wrapper.className = BTN_WRAPPER_CLASS;

    const hl = document.createElement("button");
    hl.type = "button";
    hl.className = "jtk-ss-btn jtk-ss-hl";
    hl.textContent = "\u2605";
    hl.addEventListener("click", (e) => onButtonClick(e, name, hl, "highlighted"));

    const blk = document.createElement("button");
    blk.type = "button";
    blk.className = "jtk-ss-btn jtk-ss-blk";
    blk.textContent = "\u2298";
    blk.addEventListener("click", (e) => onButtonClick(e, name, blk, "blocked"));

    wrapper.appendChild(hl);
    wrapper.appendChild(blk);
    return { wrapper: wrapper, hl: hl, blk: blk };
  }

  function setButtonStates(btnSet, name, blocked, highlighted) {
    btnSet.hl.classList.toggle("jtk-ss-btn-active", highlighted);
    btnSet.blk.classList.toggle("jtk-ss-btn-active", blocked);
    btnSet.hl.title = highlighted ? "Remove highlight for " + name : "Highlight " + name;
    btnSet.blk.title = blocked ? "Unblock " + name : "Block " + name;
  }

  // Insert the two buttons on the company-name line, IN FLOW. The title and
  // company live in separate row divs on LinkedIn, so card-anchored absolute
  // math breaks when the title wraps; placing the pair inside the company row
  // makes it immune to title length. When company.el is a block container
  // (the real subtitle div, whose only child is the name span) the wrapper is
  // appended as its last child, flowing right after the name on the same line.
  // For inline elements or links (older markup variants) the wrapper is
  // inserted as a sibling instead — it must never nest inside a link, where
  // clicks would navigate. Reuses an existing wrapper when the company is
  // unchanged, so repeated scans (SPA re-renders, poll ticks) stay cheap.
  function ensureButtons(card, company, blocked, highlighted) {
    const existing = card.querySelector("." + BTN_WRAPPER_CLASS);
    if (existing && existing.dataset.company === company.name) {
      setButtonStates(
        { hl: existing.querySelector(".jtk-ss-hl"), blk: existing.querySelector(".jtk-ss-blk") },
        company.name,
        blocked,
        highlighted
      );
      return;
    }
    if (existing) existing.remove();
    const btnSet = createButtons(company.name);
    btnSet.wrapper.dataset.company = company.name;
    console.log(
      '[Site Settings] buttons for "' + company.name + '" on card ' +
        (card.id ? "#" + card.id : "") +
        (card.className ? "." + String(card.className).trim().replace(/\s+/g, ".") : "<no class>")
    );
    setButtonStates(btnSet, company.name, blocked, highlighted);
    const tag = company.el.tagName;
    if (tag === "DIV" || tag === "LI" || tag === "UL" || tag === "P" || tag === "SECTION" || tag === "ARTICLE") {
      company.el.appendChild(btnSet.wrapper);
    } else {
      const parent = company.el.parentNode;
      if (parent) parent.insertBefore(btnSet.wrapper, company.el.nextSibling);
    }
  }

  // ------------------------------------------------------------------
  // Glassdoor rating badges (optional per-site feature)
  // ------------------------------------------------------------------

  // Ratings live in the background (which owns the cache and the fetch); this
  // content side only (a) throttles the unique on-screen company names into one
  // debounced getRatings request and (b) renders/updates badges from the batch
  // response and from site-settings:glassdoor:updated broadcasts. Resolved
  // entries (ok:true or ok:false) are kept in a module-scoped cache so repeated
  // scans (SPA re-renders, 2s poll) re-render from cache instead of re-asking.
  const gdCache = new Map(); // gdNormalize(name) -> rating entry
  const gdRetrying = new Set(); // gdNormalize(name) -> currently awaiting a retry result
  let pendingNames = new Set();
  let ratingRequestTimer = null;
  let gdLastRequestedAt = 0;
  let gdBroadcastListenerInstalled = false;

  // Light normalization used for request dedup, dataset keys and broadcast
  // matching. Deliberately NOT normalizeCompany(): the background looks names up
  // as written, and companyText already trims/collapses whitespace.
  function gdNormalize(name) {
    return String(name)
      .trim()
      .replace(/\s+/g, " ");
  }

  // Cards (with their company info) whose name matches, so a batch response or
  // a broadcast can re-render every card carrying that company. Re-runs the
  // adapter's extraction rather than trusting our own wrappers: LinkedIn can
  // wipe a badge wrapper on re-render, and the broadcast may arrive for a name
  // whose card only appeared after our last scan.
  function cardsForName(name) {
    if (!adapter) return [];
    const norm = gdNormalize(name);
    const found = [];
    for (const card of adapter.findJobCards(document)) {
      const company = adapter.companyFromCard(card);
      if (company && gdNormalize(company.name) === norm) {
        found.push({ card: card, company: company });
      }
    }
    return found;
  }

  // Renders (or re-renders) the inner content of a jtk-ss-gd wrapper: an <a>
  // with "★ <rating>" for a resolved rating, a "?" button for a failed
  // fetch (click to retry), or a pending "…" span for a not-yet-fetched entry.
  function updateRatingBadge(wrapper, entry) {
    wrapper.textContent = "";
    // Any in-flight retry state is replaced by whatever this entry renders;
    // the class must not linger and gray out a fresh green star or a "?".
    wrapper.classList.remove("jtk-ss-gd-retrying");
    if (entry.ok === false) {
      // Failed fetch — render a "?" badge that retries on click. The retry
      // message goes through the background, which evicts the failed cache
      // entry and re-enqueues the fetch; a subsequent broadcast updates the
      // badge in place (success → green, failure → stays "?").
      wrapper.classList.remove(GD_PENDING_CLASS);
      wrapper.classList.add("jtk-ss-gd-failed");
      const btn = document.createElement("span");
      btn.className = "jtk-ss-gd-retry";
      btn.textContent = "?";
      btn.title = (entry.reason ? "Glassdoor: " + entry.reason + " — click to retry" : "Glassdoor rating unavailable — click to retry");
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        // The company name for the retry must be the original LinkedIn string
        // (the typeahead normalization is the background's concern). The
        // wrapper's dataset.gdName is the normalized form, so we re-derive
        // the original by scanning the cache key — simpler: just re-queue
        // by sending the name from the cache entry's source. We don't have
        // it here, so we send a sentinel that the retry handler ignores
        // (it reads the cache to find the company). Instead: send the
        // wrapper's gdName (normalized) — the background normalizes again
        // (idempotent) and looks up + deletes the cache entry.
        const retryName = wrapper.dataset.gdName || "";
        if (!retryName) return;
        // Track the retry and swap the "?" for a spinner immediately: the
        // background's retry is throttled (serial queue, >=2s gap) and may sit
        // behind other companies from the regular poll, so the user needs
        // instant visual confirmation that the click registered. The spinner
        // stays until the next broadcast for this name re-renders the badge.
        gdRetrying.add(retryName);
        updateRetrySpinner(wrapper);
        browser.runtime
          .sendMessage({ type: "site-settings:glassdoor:retryRating", name: retryName })
          .catch(() => {});
      });
      wrapper.appendChild(btn);
      return;
    }
    if (entry.ok !== true) {
      wrapper.classList.add(GD_PENDING_CLASS);
      const span = document.createElement("span");
      span.textContent = "\u2026";
      wrapper.appendChild(span);
      return;
    }
    wrapper.classList.remove(GD_PENDING_CLASS);
    wrapper.classList.remove("jtk-ss-gd-failed");
    const rating = String(entry.rating);
    const countText = entry.countText || (entry.count ? entry.count + " reviews" : "");
    const pageUrl = entry.pageUrl || "";
    const link = document.createElement("a");
    link.textContent = "\u2605 " + rating;
    link.href = pageUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = "Glassdoor rating: " + rating + (countText ? " \u2014 " + countText : "");
    link.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (pageUrl) window.open(pageUrl, "_blank", "noopener,noreferrer");
    });
    wrapper.appendChild(link);
  }

  // Swaps a failed "?" badge for a CSS-only spinner while a retry is queued in
  // the background. The wrapper keeps its .jtk-ss-gd identity (same placement,
  // z-index and pointer-events), so scans and broadcasts can re-render it.
  function updateRetrySpinner(wrapper) {
    wrapper.textContent = "";
    wrapper.classList.remove("jtk-ss-gd-failed");
    wrapper.classList.add("jtk-ss-gd-retrying");
    const spinner = document.createElement("span");
    spinner.className = "jtk-ss-gd-spinner";
    spinner.setAttribute("aria-label", "Retrying");
    wrapper.appendChild(spinner);
  }

  // Inserts/updates the rating badge on a single card, keyed by company name
  // via wrapper.dataset.gdName. Same in-flow placement logic as ensureButtons
  // (block container vs inline sibling). No-op for a null entry; ok:false
  // removes any badge previously rendered for this company on this card.
  function ensureRatingBadge(card, company, ratingEntry) {
    if (!ratingEntry || typeof ratingEntry !== "object") return;
    const norm = gdNormalize(company.name);
    let existing = card.querySelector("." + GD_WRAPPER_CLASS);
    if (existing && existing.dataset.gdName !== norm) {
      existing.remove();
      existing = null;
    }
    if (ratingEntry.ok === false) {
      // Failed fetch — render (or update) a "?" badge. The badge stays
      // visible (doesn't auto-retry) and the user clicks it to retry.
      if (existing) {
        updateRatingBadge(existing, ratingEntry);
        return;
      }
      const wrapper = document.createElement("span");
      wrapper.className = GD_WRAPPER_CLASS;
      wrapper.dataset.gdName = norm;
      updateRatingBadge(wrapper, ratingEntry);
      const tag = company.el.tagName;
      if (tag === "DIV" || tag === "LI" || tag === "UL" || tag === "P" || tag === "SECTION" || tag === "ARTICLE") {
        company.el.appendChild(wrapper);
      } else {
        const parent = company.el.parentNode;
        if (parent) parent.insertBefore(wrapper, company.el.nextSibling);
      }
      return;
    }
    if (ratingEntry.ok !== true) {
      // No definitive rating yet (not cached, not fetched): leave the company
      // name alone until a response/broadcast arrives. Avoids a "…" flicker.
      return;
    }
    if (existing) {
      updateRatingBadge(existing, ratingEntry);
      return;
    }
    const wrapper = document.createElement("span");
    wrapper.className = GD_WRAPPER_CLASS;
    wrapper.dataset.gdName = norm;
    updateRatingBadge(wrapper, ratingEntry);
    const tag = company.el.tagName;
    if (tag === "DIV" || tag === "LI" || tag === "UL" || tag === "P" || tag === "SECTION" || tag === "ARTICLE") {
      company.el.appendChild(wrapper);
    } else {
      const parent = company.el.parentNode;
      if (parent) parent.insertBefore(wrapper, company.el.nextSibling);
    }
  }

  function handleRatingsResponse(res) {
    if (!res || !res.ratings || typeof res.ratings !== "object") return;
    for (const name of Object.keys(res.ratings)) {
      const entry = res.ratings[name];
      gdCache.set(gdNormalize(name), entry);
      for (const match of cardsForName(name)) {
        ensureRatingBadge(match.card, match.company, entry);
      }
    }
  }

  // Sends one getRatings request for the accumulated names. No-op when the
  // toggle is off or there is nothing to ask for.
  function flushRatingRequests() {
    ratingRequestTimer = null;
    if (!adapter || !config.showGlassdoorRatings) return;
    if (pendingNames.size === 0) return;
    const names = Array.from(pendingNames);
    pendingNames.clear();
    gdLastRequestedAt = Date.now();
    console.log("[Site Settings] glassdoor getRatings for:", names.join(", "));
    browser.runtime
      .sendMessage({ type: "site-settings:glassdoor:getRatings", names: names })
      .then(handleRatingsResponse)
      .catch((err) => {
        console.error("[Site Settings] glassdoor getRatings failed:", err);
      });
  }

  // Debounced collector: scanCards feeds the unique unseen names in, the flush
  // fires 250ms after the last addition (dedup via pendingNames keeps repeated
  // scans from resetting the timer once everything is already queued).
  function queueRatingRequests(names) {
    if (!config.showGlassdoorRatings) return;
    for (const name of names) {
      const norm = gdNormalize(name);
      if (norm && !gdCache.has(norm)) pendingNames.add(norm);
    }
    if (pendingNames.size === 0) {
      clearTimeout(ratingRequestTimer);
      ratingRequestTimer = null;
      return;
    }
    clearTimeout(ratingRequestTimer);
    ratingRequestTimer = setTimeout(flushRatingRequests, 250);
  }

  function removeAllRatingBadges() {
    clearTimeout(ratingRequestTimer);
    ratingRequestTimer = null;
    pendingNames.clear();
    const wrappers = document.querySelectorAll("." + GD_WRAPPER_CLASS);
    for (const w of Array.from(wrappers)) w.remove();
  }

  // Background broadcast: a single company's rating resolved (or failed).
  function onGlassdoorUpdated(message) {
    if (!adapter || !config.showGlassdoorRatings) return;
    const name = message && message.name;
    if (!name) return;
    // A broadcast resolves any in-flight retry for this company; clear the
    // retrying marker so the badge renders the fresh result (green ★ or "?")
    // and the spinner never lingers.
    gdRetrying.delete(gdNormalize(name));
    const entry =
      message.ok === true
        ? {
            ok: true,
            rating: message.rating,
            count: message.count,
            countText: message.countText,
            pageUrl: message.pageUrl,
            employerId: message.employerId
          }
        : { ok: false };
    gdCache.set(gdNormalize(name), entry);
    for (const match of cardsForName(name)) {
      ensureRatingBadge(match.card, match.company, entry);
    }
  }

  // ------------------------------------------------------------------
  // Title filter button + in-page prompt
  // ------------------------------------------------------------------

  // The filter button is an ACTION, not a toggle: it opens a prompt to add a
  // title keyword, so it never carries the jtk-ss-btn-active state. Its wrapper
  // class is distinct from the company buttons' so ensureButtons (which finds
  // and prunes `.jtk-ss-btns` wrappers) never touches it.
  function onFilterClick(e, title) {
    e.preventDefault();
    e.stopPropagation();
    openTitleModal(title);
  }

  function createFilterButton(title) {
    const wrapper = document.createElement("span");
    wrapper.className = TITLE_BTN_WRAPPER_CLASS;
    wrapper.dataset.title = title;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "jtk-ss-btn jtk-ss-filt";
    btn.title = "Filter postings with this title";
    btn.setAttribute("aria-label", "Filter postings with this title");
    // Inline SVG funnel (stroke: currentColor) so it inherits the button's
    // hover color and renders reliably on Linux Firefox — no font glyphs.
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 5h16l-6 8h-4L4 5z M10 13v4l-2 2h8l-2-2v-4z"/></svg>';
    btn.addEventListener("click", (e) => onFilterClick(e, title));

    wrapper.appendChild(btn);
    return wrapper;
  }

  // Insert one filter button per card, right after the title element. Reuses
  // the existing wrapper when the title is unchanged (repeated scans stay
  // cheap); a changed title means the card was recycled, so rebuild.
  function ensureFilterButton(card, title) {
    const existing = card.querySelector("." + TITLE_BTN_WRAPPER_CLASS);
    if (existing && existing.dataset.title === title.text) return;
    if (existing) existing.remove();
    const wrapper = createFilterButton(title.text);
    const parent = title.el.parentNode;
    if (parent) parent.insertBefore(wrapper, title.el.nextSibling);
  }

  // Single shared modal, created lazily on first open and removed on close, so
  // there is never more than one and stale keydown listeners cannot linger. It
  // lives on document.body — never inside a job card — so its events cannot
  // bubble into LinkedIn's card navigation handlers.
  let titleModal = null;
  let titleModalInput = null;

  function onModalKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeTitleModal();
    } else if (e.key === "Enter" && e.target === titleModalInput) {
      e.preventDefault();
      e.stopPropagation();
      confirmTitleModal();
    }
  }

  function ensureTitleModal() {
    if (titleModal) return;
    const overlay = document.createElement("div");
    overlay.className = "jtk-ss-modal-overlay";

    const card = document.createElement("div");
    card.className = "jtk-ss-modal-card";

    const label = document.createElement("label");
    label.className = "jtk-ss-modal-label";
    label.textContent = "Hide postings whose title contains:";
    label.htmlFor = "jtk-ss-modal-input";

    const input = document.createElement("input");
    input.type = "text";
    input.id = "jtk-ss-modal-input";
    input.className = "jtk-ss-modal-input";

    const actions = document.createElement("div");
    actions.className = "jtk-ss-modal-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "jtk-ss-modal-btn";
    cancel.textContent = "Cancel";

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "jtk-ss-modal-btn jtk-ss-modal-btn-primary";
    confirm.textContent = "Confirm";

    actions.appendChild(cancel);
    actions.appendChild(confirm);
    card.appendChild(label);
    card.appendChild(input);
    card.appendChild(actions);
    overlay.appendChild(card);

    overlay.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.target === overlay) closeTitleModal();
    });
    cancel.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTitleModal();
    });
    confirm.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmTitleModal();
    });

    titleModal = overlay;
    titleModalInput = input;
    (document.body || document.documentElement).appendChild(overlay);
  }

  function openTitleModal(title) {
    ensureTitleModal();
    if (!titleModal) return;
    titleModalInput.value = title;
    titleModalInput.focus();
    titleModalInput.select();
    document.addEventListener("keydown", onModalKeydown);
  }

  function closeTitleModal() {
    document.removeEventListener("keydown", onModalKeydown);
    if (titleModal) {
      titleModal.remove();
      titleModal = null;
      titleModalInput = null;
    }
  }

  function confirmTitleModal() {
    const keyword = titleModalInput ? titleModalInput.value.trim() : "";
    closeTitleModal();
    if (!keyword) return;
    sendAddKeyword(keyword);
  }

  function scanCards() {
    if (!adapter) return;
    injectStyles();
    for (const c of touchedCards) {
      if (!c.isConnected) touchedCards.delete(c);
    }
    const cards = adapter.findJobCards(document);
    const gdNames = [];
    for (const card of cards) {
      const title = adapter.titleFromCard(card);
      if (title) ensureFilterButton(card, title);
      const company = adapter.companyFromCard(card);
      if (!company) continue;
      const state = applyCardState(
        card,
        company.name,
        title ? title.text : "",
        title ? title.el : null
      );
      ensureButtons(card, company, state.blocked, state.highlighted);
      if (config.showGlassdoorRatings) {
        // Don't fetch or render ratings for cards that are already hidden
        // (blocked company, title keyword match, or hideApplied). A card
        // that became hidden after a rating was fetched also has its badge
        // removed — the card is display:none so the badge wouldn't be seen,
        // but removing it keeps the DOM clean and makes a future un-hide
        // re-render the badge from the content-side cache.
        if (state.blocked) {
          const existing = card.querySelector("." + GD_WRAPPER_CLASS);
          if (existing) existing.remove();
        } else {
          const cached = gdCache.get(gdNormalize(company.name));
          if (cached) {
            // While a retry is in flight the badge shows the spinner; a scan
            // must not re-render the stale ok:false cache entry over it (the
            // broadcast that resolves the retry owns the re-render).
            if (!gdRetrying.has(gdNormalize(company.name))) {
              ensureRatingBadge(card, company, cached);
            }
          } else {
            gdNames.push(company.name);
          }
        }
      }
    }
    if (config.showGlassdoorRatings) {
      queueRatingRequests(gdNames);
    } else {
      removeAllRatingBadges();
    }
  }

  // ------------------------------------------------------------------
  // Observation + page lifecycle
  // ------------------------------------------------------------------

  let observer = null;
  let scanTimer = null;

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanCards, 150);
  }

  function startObserving() {
    if (observer) observer.disconnect();
    const target = document.querySelector(".jobs-search-results-list") || document.body;
    if (!target) return;
    observer = new MutationObserver(scheduleScan);
    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"]
    });
  }

  function teardown() {
    adapter = null;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(scanTimer);
    removeAllRatingBadges();
    const wrappers = document.querySelectorAll(
      "." + BTN_WRAPPER_CLASS + ",." + TITLE_BTN_WRAPPER_CLASS
    );
    for (const w of wrappers) w.remove();
    for (const c of touchedCards) {
      c.classList.remove("jtk-ss-block");
      c.classList.remove("jtk-ss-highlight");
      c.style.removeProperty("display");
    }
    touchedCards.clear();
    closeTitleModal();
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
  }

  async function ensureActive() {
    if (!window.jobAppToolkit.content.isModuleActive(MODULE_ID)) {
      teardown();
      return;
    }
    const next = currentAdapter();
    if (!next) {
      teardown();
      return;
    }
    adapter = next;
    await loadConfig();
    startObserving();
    scanCards();
  }

  // SPA navigation safety net: LinkedIn swaps pages without full reloads. A
  // cheap periodic tick catches (a) navigation into/out of the target page and
  // (b) result containers a MutationObserver on the previous one would miss.
  function pollTick() {
    const onTarget = currentAdapter() !== null;
    if (onTarget !== Boolean(adapter)) {
      ensureActive();
      return;
    }
    if (onTarget) scanCards();
  }

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------

  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== "string") return undefined;
    if (message.type === "jtk:moduleActivityChanged") {
      if (message.id === MODULE_ID) {
        if (message.active) ensureActive();
        else teardown();
      }
      return undefined;
    }
    return undefined;
  });

  // Glassdoor rating updates from the background. Installed exactly once; the
  // handler re-checks the toggle and adapter so a broadcast arriving while the
  // feature is off is a cheap no-op.
  if (!gdBroadcastListenerInstalled) {
    gdBroadcastListenerInstalled = true;
    browser.runtime.onMessage.addListener((message) => {
      if (message && message.type === "site-settings:glassdoor:updated") {
        onGlassdoorUpdated(message);
      }
      return undefined;
    });
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes[STORAGE_KEY]) return;
    loadConfig().then(() => {
      if (adapter) scanCards();
    });
  });

  window.jobAppToolkit.content.refreshActive(MODULE_ID);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureActive);
  } else {
    ensureActive();
  }
  setInterval(pollTick, 2000);
})();
