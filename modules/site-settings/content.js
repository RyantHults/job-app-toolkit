// Site Settings — content script module (Firefox WebExtensions, Manifest V2).
// Applies per-site settings to job boards. Two LinkedIn adapters today:
//   - /jobs/search: each job card gets two small buttons beside the company
//     name so the user can block (hide) or highlight (tint) all postings from
//     that company, plus a filter button beside the job title that opens an
//     in-page prompt for hiding postings by title keyword.
//   - /search/results/people: each person card gets a line below the job
//     title showing the current company, scraped from that person's
//     /in/<vanity>/ profile (cached in storage.local). Lazy: the company is
//     fetched only the first time a card scrolls into view.
//
// An optional per-site toggle (sites.linkedin.showGlassdoorRatings) renders a
// small Glassdoor rating badge (★ 4.4) in flow next to the company name on
// job-search cards. Ratings are fetched from the background via
// site-settings:glassdoor:getRatings (names are collected on each scan and
// debounced into one request) and kept fresh through
// site-settings:glassdoor:updated broadcasts; the badge is rendered only once
// a rating entry actually arrives.
//
// An optional per-site toggle (sites.linkedin.showPeopleSearchCompany) drives
// the people-search company line. When off, the people adapter runs no
// fetches, queues no work, and inserts no DOM. When on, the adapter's scan
// collects one profile URL per visible card and the background script (via
// site-settings:people:getCompany) does the actual visit-and-parse; results
// are broadcast as site-settings:people:companyResolved. When the bg's
// fetch() finds no company signal (parse_error) it broadcasts
// site-settings:people:fetchFailed and this content side fires an on-demand
// hidden-iframe scrape (site-settings:people:iframeScraped) as the fallback.
//
// Site-specific knowledge lives behind adapters ({ siteId, isTargetPage, ... })
// so future job boards slot in without touching the driver below. Each page
// type has its own scan driver (scanCards for /jobs/search, scanPeople for
// /search/results/people) selected by which adapter matches. Module activity
// and toasts come from core/content.js (loaded before this script).
(function () {
  "use strict";

  const MODULE_ID = "site-settings";
  const STORAGE_KEY = "jobAppToolkit";

  // Unconditional first signal: fires on EVERY page load before any adapter
  // loop and before the module-activity check. If this line is missing from
  // the console, the content script never ran (manifest match or add-on load
  // problem), not a module/adapter issue.
  console.log("[Site Settings] content script loaded at " + location.pathname);

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

  // ------------------------------------------------------------------
  // People-search adapter (LinkedIn /search/results/people/)
  // ------------------------------------------------------------------
  // Each card is a role="listitem" that contains one or more /in/<vanity>/
  // links. The first link that wraps a text column — the avatar anchor —
  // has the avatar <figure> and a text column <div> among its DIRECT
  // children; the text column holds the name row, the title row, and
  // (optionally) location / mutual-connection rows. The name is read from
  // INSIDE the text column (never from the anchor's own text: on
  // connection-filtered searches the anchor wraps the ENTIRE card, so its
  // textContent is the whole card blob). The job title is the first
  // text-only <p> inside the column, and the company line is injected
  // right after the title row. The DOM uses heavily hashed class names, so
  // selectors are intentionally structural; the one shared class set that
  // anchors every text-only <p> (title, location, mutual-connection note)
  // is PEOPLE_TEXT_P_SELECTOR. Every structural fallback runs INSIDE the
  // text column — never the whole card. This is the first thing to revisit
  // when LinkedIn reworks people-search markup.

  // The vanilla /in/<vanity>/ profile URL regex. Matches both
  // "/in/foo/" and "/in/foo" and rejects "/in/foo/embed/" etc. The vanity
  // itself is captured so it can be used as the cache key.
  const PROFILE_URL_RE = /^\/in\/([a-zA-Z0-9\-_.%]+)\/?$/;

  function parseProfileUrl(href) {
    if (!href) return null;
    let url;
    try {
      url = new URL(href, location.origin);
    } catch (err) {
      return null;
    }
    if (url.origin !== location.origin) return null;
    const m = PROFILE_URL_RE.exec(url.pathname);
    if (!m) return null;
    return { url: url.href, vanity: m[1].toLowerCase() };
  }

  // The class set every text-only row in a card uses. We treat the first
  // <p> inside the text column with this class set as the title, the next
  // as the location, and so on. (When LinkedIn reworks markup, this is the
  // first anchor to revisit.)
  const PEOPLE_TEXT_P_SELECTOR =
    "p.b6439155.d6ccb5ca.b9c6bdb2.b5c7976a._26286ef4.fb20d64c._82ca4578.ecda3541.a8c606cd";
  // The same class set as a space-separated class list — the classes the
  // title/location <p> rows actually carry. Derived from the selector so the
  // two can never drift apart. Applied to the injected company-line <p> AND
  // its <span> so the line inherits the title row's typography (font-size,
  // line-height, color) instead of falling back to the element default.
  const PEOPLE_TEXT_P_CLASSES = PEOPLE_TEXT_P_SELECTOR.replace(/^p\./, "").replace(/\./g, " ");

  // The card root: the closest [role="listitem"] that carries at least one
  // person signal. role="listitem" is the only stable landmark in the
  // people-search results. A card is accepted when it has EITHER a person
  // avatar <figure> (an <img> whose src carries "profile-displayphoto" —
  // the same shape the person-accent figure uses) OR a non-empty <p> (the
  // name, or "LinkedIn Member" on anonymous cards). This deliberately does
  // NOT require a /in/<vanity>/ link: connection-filtered searches
  // (/search/results/people/?connectionOf=...) render cards with NO /in/
  // links when the user has "Open Profile" privacy enabled — those cards
  // still carry the avatar figure and the name/headline <p>s, so they must
  // be found. personFromCard later marks such cards as having no profile
  // URL (profileUrl: null) so no company fetch is attempted for them.
  function findPeopleCards(root) {
    const items = root.querySelectorAll('[role="listitem"]');
    const cards = [];
    for (const item of items) {
      // Person avatar figure (profile-displayphoto <img>).
      if (item.querySelector('figure img[src*="profile-displayphoto"]')) {
        cards.push(item);
        continue;
      }
      // Non-empty <p> (the name or "LinkedIn Member").
      let hasText = false;
      for (const p of item.querySelectorAll("p")) {
        if (String(p.textContent || "").trim()) {
          hasText = true;
          break;
        }
      }
      if (hasText) cards.push(item);
    }
    return cards;
  }

  // A /in/ link is the avatar anchor when it directly holds the avatar
  // <figure> (either as a FIGURE child or wrapped in its own <div>). Its
  // text column is then found two ways:
  //   A. the anchor wraps the column: the first non-avatar DIRECT child
  //      <div> (connection-filtered searches, where the anchor wraps the
  //      ENTIRE card);
  //   B. the anchor holds only the avatar: the column is its next sibling
  //      <div> inside the same container (the standard people-search card).
  // Returns the text column <div>, or null when the link is not the avatar
  // anchor (a bare name link, an empty preload anchor).
  function avatarTextColumn(link) {
    let hasFigure = false;
    for (const child of link.children) {
      if (
        child.tagName === "FIGURE" ||
        (child.tagName === "DIV" && child.querySelector("figure"))
      ) {
        hasFigure = true;
        break;
      }
    }
    if (!hasFigure) return null;
    // Case A: text column wrapped by the anchor.
    for (const child of link.children) {
      if (child.tagName === "FIGURE") continue;
      if (child.tagName !== "DIV") continue;
      if (child.querySelector("figure")) continue; // avatar wrapper <div>
      return child;
    }
    // Case B: text column as the anchor's next sibling.
    let sib = link.nextElementSibling;
    while (sib) {
      if (sib.tagName === "DIV" && !sib.querySelector("figure") && sib.querySelector("p")) {
        return sib;
      }
      sib = sib.nextElementSibling;
    }
    return null;
  }

  // Fallback text column: the first <div> inside the card that has a <p>
  // as a DIRECT child. A text column holds <p>s; the avatar figure holds
  // only <img>/<svg>; most other <div>s are empty scaffolding. Only used
  // when no avatar anchor wraps a text column. Never scans the whole card
  // for stray <p>s.
  function firstDivWithParagraph(root) {
    for (const div of root.querySelectorAll("div")) {
      if (div.querySelector("figure")) continue;
      for (const child of div.children) {
        if (child.tagName === "P" && String(child.textContent || "").trim()) {
          return div;
        }
      }
    }
    return null;
  }

  // Compact, human-readable descriptor for the first-card diagnostic
  // (e.g. "div.b6f5dc85" or "#someId").
  function shortSel(el) {
    if (!el) return "none";
    if (el.id) return "#" + el.id;
    const cls = String(el.className || "").trim().split(/\s+/).filter(Boolean);
    return el.tagName.toLowerCase() + (cls.length ? "." + cls[0] : "");
  }

  // The title text rule: non-empty, not a pronoun line ("He/…", "She/…"),
  // and not the name itself. Also excludes the company-line wrapper this
  // module inserts (its <p> carries the same class set as the real text
  // rows, so a re-scan must not mistake the pending "…" for the title).
  // Returns the normalized text, or null when the <p> is not a title
  // candidate.
  function titleCandidateText(p, name) {
    if (p.closest && p.closest("." + PEOPLE_COMPANY_WRAPPER_CLASS)) return null;
    const t = String(p.textContent || "")
      .trim()
      .replace(/\s+/g, " ");
    if (!t) return null;
    if (/^(he|she|they)\//i.test(t)) return null;
    if (name && name !== "unknown" && t.indexOf(name) !== -1) return null;
    return t;
  }

  // Extract the name, profile url, and the text column + title row from a
  // card. Returns null when the card shape doesn't match (e.g. an ad slot
  // with a /in/ link but no name/title rows); on failure it sets
  // lastPeopleFailureReason so scanPeople can log a one-line skip reason.
  //
  // All structural work happens INSIDE the avatar anchor's text column:
  //   1. The text column is the first non-avatar DIRECT child <div> of the
  //      avatar anchor (the first /in/ link whose children include the
  //      avatar <figure> + a text column). On connection-filtered searches
  //      the anchor wraps the ENTIRE card; on the standard page the first
  //      /in/ links are empty preload anchors and the real anchor sits
  //      deeper. Either way we only inspect the anchor's direct children —
  //      never the whole card.
  //   2. The title is the first <p> INSIDE the text column that is
  //      non-empty, not a pronoun line, and not the name itself. The known
  //      shared class set (PEOPLE_TEXT_P_SELECTOR) is tried first, scoped
  //      to the column.
  //   3. The location is the row right after the title: the SECOND <p>
  //      carrying PEOPLE_TEXT_P_SELECTOR when the title was found via
  //      that class set, otherwise the first non-empty <p> after the
  //      title in document order. Missing location -> "" (which disables
  //      the background's location filter for this person).
  //   4. If no anchor wraps a column, the fallback is the first <div> in
  //      the card with a <p> as a direct child; if that also fails, the
  //      card is too weird and we return null.
  function personFromCard(card) {
    // A /in/<vanity>/ link is OPTIONAL. On connection-filtered searches
    // with "Open Profile" privacy enabled, cards render with NO /in/ link
    // ("LinkedIn Member" cards) — those still carry the avatar figure and
    // the name/headline <p>s, so we extract them and mark profileUrl as
    // null (no profile to fetch). When a link IS present it must parse to
    // a real /in/<vanity>/ URL; a link that fails to parse is treated the
    // same as no link (profileUrl: null).
    const link = card.querySelector('a[href*="/in/"]');
    let parsed = null;
    if (link) {
      parsed = parseProfileUrl(link.getAttribute("href") || "");
    }
    const profileUrl = parsed ? parsed.url : null;
    const vanity = parsed ? parsed.vanity : "";

    // --- Text column -------------------------------------------------
    let textColumn = null;
    let textColumnVia = "first-div";
    if (link) {
      for (const l of card.querySelectorAll('a[href*="/in/"]')) {
        const col = avatarTextColumn(l);
        if (col) {
          textColumn = col;
          textColumnVia = "avatar-child";
          break;
        }
      }
    }
    if (!textColumn) {
      textColumn = firstDivWithParagraph(card);
      textColumnVia = "first-div";
    }
    if (!textColumn) {
      lastPeopleFailureReason = "no text column found";
      return null;
    }

    // --- Name --------------------------------------------------------
    // The first /in/ link's text is the ENTIRE card on connection-filtered
    // searches (the outer anchor wraps the whole card, avatar image
    // included), so it is used ONLY when that link is a bare text link with
    // no children — a bare link cannot be wrapping the card, so its text is
    // the name itself. Otherwise the name is read from inside the text
    // column: the first /in/ link with text (same profile as the card's),
    // then the first <p>.
    let name = "";
    if (link && link.children.length === 0) {
      name = String(link.textContent || "").trim();
    }
    if (!name && link) {
      const href = link.getAttribute("href");
      for (const l of textColumn.querySelectorAll('a[href*="/in/"]')) {
        const t = String(l.textContent || "").trim();
        if (t && l.getAttribute("href") === href) {
          name = t;
          break;
        }
      }
    }
    if (!name) {
      for (const p of textColumn.querySelectorAll("p")) {
        if (p.closest && p.closest("." + PEOPLE_COMPANY_WRAPPER_CLASS)) continue;
        const t = String(p.textContent || "").trim();
        if (t) {
          name = t;
          break;
        }
      }
    }
    if (!name) name = "unknown";

    // --- Title -------------------------------------------------------
    let titleP = null;
    let titleText = "";
    const classCandidate = textColumn.querySelector(PEOPLE_TEXT_P_SELECTOR);
    if (classCandidate) {
      const t = titleCandidateText(classCandidate, name);
      if (t) {
        titleP = classCandidate;
        titleText = t;
      }
    }
    if (!titleP) {
      for (const p of textColumn.querySelectorAll("p")) {
        const t = titleCandidateText(p, name);
        if (t) {
          titleP = p;
          titleText = t;
          break;
        }
      }
    }

    let titleRow = titleP ? titleP.parentElement : null;
    let titleRowVia = "column-itself";
    if (titleRow && titleRow !== textColumn) titleRowVia = "row-child";

    // --- Location -----------------------------------------------------
    // The location is the text row right after the title. When the title
    // was found via the shared class set, the location is the SECOND <p>
    // carrying that class set; otherwise it is the first non-empty <p>
    // after the title in document order. Missing location -> "" (the
    // background's isLocation check then has nothing to reject against).
    let locationText = "";
    if (titleP) {
      const classPs = textColumn.querySelectorAll(PEOPLE_TEXT_P_SELECTOR);
      if (classPs.length >= 2 && classPs[0] === titleP) {
        const t = String(classPs[1].textContent || "").trim().replace(/\s+/g, " ");
        if (t) locationText = t;
      }
      if (!locationText) {
        let seenTitle = false;
        for (const p of textColumn.querySelectorAll("p")) {
          if (p === titleP) {
            seenTitle = true;
            continue;
          }
          if (!seenTitle) continue;
          if (p.closest && p.closest("." + PEOPLE_COMPANY_WRAPPER_CLASS)) continue;
          const t = String(p.textContent || "").trim().replace(/\s+/g, " ");
          if (t) {
            locationText = t;
            break;
          }
        }
      }
    }

    return {
      card: card,
      link: link,
      name: name,
      profileUrl: profileUrl,
      vanity: vanity,
      titleEl: titleP,
      titleText: titleText,
      titleRow: titleRow,
      textColumn: textColumn,
      textColumnVia: textColumnVia,
      titleRowVia: titleRowVia,
      location: locationText
    };
  }

  const linkedinPeopleAdapter = {
    siteId: "linkedin",
    isTargetPage: function () {
      return /^\/search\/results\/people\/?$/.test(location.pathname);
    },
    findPeopleCards: findPeopleCards,
    personFromCard: personFromCard
  };

  const ADAPTERS = [linkedinAdapter, linkedinPeopleAdapter];

  let adapter = null;

  function currentAdapter() {
    for (const a of ADAPTERS) {
      if (a.isTargetPage()) return a;
    }
    return null;
  }

  // Short human name for the diagnostic log, distinguishing the two LinkedIn
  // adapters (they share siteId "linkedin").
  function adapterName(a) {
    if (a === linkedinPeopleAdapter) return "linkedin:people";
    if (a === linkedinAdapter) return "linkedin:jobs";
    return a && a.siteId ? String(a.siteId) : "null";
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
    showGlassdoorRatings: false,
    showPeopleSearchCompany: false
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
        showGlassdoorRatings: site.showGlassdoorRatings === true,
        showPeopleSearchCompany: site.showPeopleSearchCompany === true
      };
    } catch (err) {
      config = {
        blockedCompanies: [],
        highlightedCompanies: [],
        titleBlockedKeywords: [],
        hideApplied: false,
        showGlassdoorRatings: false,
        showPeopleSearchCompany: false
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
      ".jtk-ss-modal-btn-primary:hover{background:#1d4ed8;}" +
      // People-search company line: visually matches the existing
      // title/location rows (same _b6f5dc85 _7851829c _57561673 _1735088d
      // _292c9533_ base class set, applied at insertion time). The
      // pending "…" state is a touch dimmer so the line is recognizable
      // as "loading" without breaking the row's rhythm. The failed class
      // is reserved for any future "always-visible muted dash" state; the
      // current driver removes the wrapper on failure instead, so this
      // style is currently inert.
      // Belt-and-suspenders: LinkedIn sizes secondary text in profile
      // cards at 14px/1.25 (0.875rem on a 16px base); force that with
      // !important on the company line AND its <p>/<span> so no class-set
      // drift, inherited wrapper rule, or CSS-variable font-size token
      // (the title row's parent hash classes resolve to variables this
      // wrapper does not inherit) can shrink the line below the title's
      // typography. The !important is a heavy hammer, but the title's own
      // class set on the injected <p>/<span> would otherwise let LinkedIn's
      // higher-specificity rules win over a plain inline rule.
      ".jtk-ss-ppl,.jtk-ss-ppl p,.jtk-ss-ppl span{font-size:14px !important;line-height:1.25 !important;color:inherit !important;}" +
      ".jtk-ss-ppl-pending{opacity:.7;}" +
      ".jtk-ss-ppl-failed{opacity:.5;}";
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
  // People-search company line (optional per-site feature)
  // ------------------------------------------------------------------
  // Each person card on /search/results/people/ gets a line below the
  // job title showing the person's current company. The company is
  // scraped from their /in/<vanity>/ profile page (handled by the
  // background) and cached. Cached company names are re-rendered on
  // every scan; uncached ones are queued and a "…" placeholder sits in
  // the new line until the broadcast (site-settings:people:companyResolved)
  // replaces it. When the toggle is off, the people adapter still
  // detects cards but does no fetching and inserts no DOM.
  //
  // The bg's fetch() is the primary path (the SSR shell carries the
  // company line); when it reports a parse_error the hidden-iframe
  // scrape fires as an on-demand fallback (see maybeScrapeProfileViaIframe
  // and onPeopleFetchFailed) — the iframe sees the hydrated Experience
  // section the fetch() body never carries.
  //
  // Lazy by IntersectionObserver: a card's company is only requested
  // the first time it scrolls into view. Subsequent visits are instant
  // (cache hit). The background owns the fetch throttle (≥2s gap, no
  // per-tab cap; the 2s gap is the rate-limit safety).

  const PEOPLE_COMPANY_WRAPPER_CLASS = "jtk-ss-ppl";
  const PEOPLE_COMPANY_PENDING_CLASS = "jtk-ss-ppl-pending";
  const PEOPLE_COMPANY_FAILED_CLASS = "jtk-ss-ppl-failed";
  // Placeholder shown on a card that has no /in/<vanity>/ profile URL (a
  // "LinkedIn Member" card with Open Profile privacy enabled): there is no
  // profile to fetch, so the company line renders this muted text instead
  // of the pending "…".
  const PEOPLE_NO_PROFILE_TEXT = "Profile private";
  let peopleObserver = null;
  // One-shot people-driver state. The first scan logs its extraction
  // diagnostics and force-fires the IO callback for every wrapper (so the
  // initial company requests do not depend on the IO firing). After that,
  // rescans from the 2s pollTick are silent DOM no-ops unless the result
  // actually changes. The MutationObserver is gone: our own wrapper/text
  // writes fed it and the 150ms debounce re-scanned forever (runaway loop);
  // the 2s poll + initial scan + storage.onChanged + targeted broadcasts
  // are what drive rescans now.
  let peopleScanLogged = false; // first-scan extraction diagnostics printed
  let peopleFirstScanDone = false; // forced IO fire has happened
  let peopleIntersectFired = false; // "[People] intersect fired" logged
  let peopleComputedSizeDiagLogged = false; // one-shot computed-size diagnostic
  let lastPeopleSummary = ""; // change-detection for the scan summary line
  // Change-detection for the scanPeople "searching for cards..." diagnostic:
  // logs on the first scan and then only when the items//in-links/extracted
  // triple changes, so the user sees both the empty-shell state and the
  // populated state without the 2s poll spamming.
  let lastPeopleSearchDiag = "";
  // Reason the most recent card was skipped, set by personFromCard /
  // ensurePeopleCompanyLine when they bail and consumed by scanPeople's
  // per-card diagnostic. Read immediately after the call, so no staleness.
  let lastPeopleFailureReason = null;
  // Vanity URL -> card nodes we've already rendered (or are rendering) a
  // company line for, so a re-scan or a follow-up broadcast never duplicates
  // a line on the same card after a re-render.
  const peopleKnownCards = new Map();
  // Vanity URL -> company string, in-memory mirror of the cache. Populated
  // once per session from storage.local when the page becomes active.
  const peopleCompanies = new Map();
  // Vanity URLs we have an in-flight background request for; the broadcast
  // is what fills peopleCompanies + re-renders.
  const peoplePendingRequests = new Set();
  let peopleBroadcastListenerInstalled = false;
  // Hidden-iframe scrape (on-demand FALLBACK company source). The
  // background's fetch() can only read the SSR shell, and on a logged-in
  // view of ANOTHER user's profile that shell has no company (the company
  // lives only in the lazily-hydrated Experience section). Most profiles
  // resolve via the bg's cheap fetch() (the SSR shell carries the company
  // line as a <p> next to a /company/ link); the iframe scrape fires ONLY
  // when the bg's fetch() reports a parse_error (no company signal at all)
  // — the edge cases: private profiles, auth walls, or a future LinkedIn
  // markup change that breaks the bg parser. On those, this content side
  // loads the profile URL in an off-screen iframe, lets LinkedIn's own
  // hydration render, and reads the company from iframe.contentDocument.
  const PEOPLE_IFRAME_TIMEOUT_MS = 10000; // give hydration a fair window
  const PEOPLE_IFRAME_POLL_MS = 250; // hydration poll interval
  const PEOPLE_IFRAME_ATTR = "data-jtk-people-scrape";
  let peopleIframeDiagLogged = false; // one-time "[People] iframe scrape enabled" log
  // Vanities with an in-flight iframe scrape (dedupe against re-scans and
  // against the companyResolved + fetchFailed double-broadcast on a parse
  // miss).
  const peopleIframeScraping = new Set();

  // The on-demand hidden-iframe scrape is DISABLED. Each iframe-loaded
  // profile counts as a real visit from the user's account, burning LinkedIn
  // profile views and risking rate-limiting/flagging. The bg's tier-0
  // fetch() alone is accurate enough; profiles whose company can't be
  // extracted just don't show a company line. Flip this to false to
  // re-enable the iframe fallback.
  const iframeFallbackDisabled = true;
  // One-time-per-page-load diagnostic so we don't spam the console per card.
  let peopleIframeFallbackDiagLogged = false;

  // Format a "[People] ..." diagnostic from an unexpected exception. The scan
  // driver re-throws after logging (so the page console also shows the full
  // stack); the listeners only log. withFrame appends the first stack frame,
  // which points at the caller that threw.
  function peopleLogError(prefix, err, withFrame) {
    const name = err && err.name ? err.name : "Error";
    const message = err && err.message ? err.message : String(err);
    let line = prefix + name + ": " + message;
    if (withFrame && err && err.stack) {
      const frame = (String(err.stack).split("\n")[1] || "").trim();
      if (frame) line += " AT " + frame;
    }
    console.error(line);
  }

  // Cached-company TTL mirrors the background's 7d success / 1h failure.
  // 7 days = people change jobs rarely, so refresh weekly. Failures retry
  // hourly so a transient parse miss doesn't poison the badge for long.
  const PEOPLE_SUCCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const PEOPLE_FAILURE_TTL_MS = 60 * 60 * 1000;

  const PEOPLE_CACHE_KEY = "jtk-site-settings-people";

  function peopleCacheFresh(entry) {
    if (!entry || typeof entry.fetchedAt !== "number") return false;
    const ttl = entry.ok ? PEOPLE_SUCCESS_TTL_MS : PEOPLE_FAILURE_TTL_MS;
    return Date.now() - entry.fetchedAt < ttl;
  }

  async function peopleCacheLoad() {
    try {
      const res = await browser.storage.local.get(PEOPLE_CACHE_KEY);
      const val = res[PEOPLE_CACHE_KEY];
      const out = new Map();
      if (val && typeof val === "object") {
        for (const k of Object.keys(val)) {
          if (peopleCacheFresh(val[k])) out.set(k, val[k]);
        }
      }
      peopleCompanies.clear();
      for (const [k, v] of out) peopleCompanies.set(k, v);
    } catch (err) {
      // Non-fatal — start with an empty in-memory cache. The next
      // successful fetch will repopulate it.
      console.warn("[People] cache load failed:", err);
    }
  }

  // Build (or reuse) the jtk-ss-ppl wrapper inside the text column. The
  // wrapper is a flex row matching the location row's display: stacked
  // <p><span> with the same class set as the other text rows in the card,
  // so it visually blends in. The text content is the company name, "…"
  // while a fetch is in flight, or a muted dash on failure.
  function ensurePeopleCompanyLine(person) {
    const { textColumn, titleRow, vanity, profileUrl, name } = person;
    // If the adapter couldn't isolate a text column, fall back to the outer
    // card — a line at the end of the card beats no line at all.
    const column = textColumn || person.card;
    if (!column) {
      lastPeopleFailureReason = "wrapper insert failed";
      return null;
    }
    let existing = column.querySelector("." + PEOPLE_COMPANY_WRAPPER_CLASS);
    if (existing) {
      peopleKnownCards.set(vanity, { wrapper: existing, person: person });
      return existing;
    }
    const wrapper = document.createElement("div");
    wrapper.className = PEOPLE_COMPANY_WRAPPER_CLASS;
    // Mirror the TITLE row's parent wrapper class set so the line sits
    // flush with its siblings (same margins, font, color). LinkedIn sizes
    // the title's text on the row's PARENT <div>, not on the <p> itself —
    // this wrapper must carry the title wrapper's class set (the
    // _11b345ff token, NOT the location row's a2521a0a) or the line
    // renders smaller than the title above it. This is the part of the
    // "match LinkedIn's own style" choice — we look like a real row,
    // not a foreign element.
    wrapper.className += " b6f5dc85 _7851829c _57561673 _1735088d _292c9533 _11b345ff _79b27b60";
    wrapper.dataset.vanity = vanity;
    wrapper.dataset.profileUrl = profileUrl || "";
    wrapper.dataset.personName = name || "";
    wrapper.dataset.personTitle = person.titleText || "";
    wrapper.dataset.personLocation = person.location || "";

    const p = document.createElement("p");
    // The company line's <p> and <span> use the SAME class set as the
    // title/location rows' <p> (PEOPLE_TEXT_P_SELECTOR / PEOPLE_TEXT_P_CLASSES)
    // — the title row's typography lives on those classes, so the line must
    // carry them to render at the same font-size as the title above it.
    p.className = PEOPLE_TEXT_P_CLASSES;

    const span = document.createElement("span");
    span.className = PEOPLE_TEXT_P_CLASSES;
    p.appendChild(span);
    wrapper.appendChild(p);

    // Insert AFTER the title row when there is one. If there's a location
    // row sitting between the title and the end of the column, the new
    // line will go under it (last child of the column) — same visual
    // effect, since both rows are identical wrappers. Using
    // titleRow.nextSibling keeps the DOM order stable: title, location,
    // company. Without a title row, append to the end of the column.
    if (titleRow && titleRow.nextSibling) {
      column.insertBefore(wrapper, titleRow.nextSibling);
    } else {
      column.appendChild(wrapper);
    }
    peopleKnownCards.set(vanity, { wrapper: wrapper, person: person });
    return wrapper;
  }

  function setPeopleCompanyContent(wrapper, kind, text) {
    const span = wrapper.querySelector("span");
    if (!span) return;
    span.textContent = text;
    wrapper.classList.remove(PEOPLE_COMPANY_PENDING_CLASS, PEOPLE_COMPANY_FAILED_CLASS);
    if (kind === "pending") wrapper.classList.add(PEOPLE_COMPANY_PENDING_CLASS);
    else if (kind === "failed") wrapper.classList.add(PEOPLE_COMPANY_FAILED_CLASS);
  }

  // Request a company for one person. The background owns the cache and the
  // fetch; the result comes back as a site-settings:people:companyResolved
  // broadcast to this tab (and to the response of the same getCompany call).
  // This fires ONLY the bg site-settings:people:getCompany path — the cheap
  // fetch() that reads the SSR shell. The hidden-iframe scrape is NOT fired
  // here anymore: it is an on-demand fallback that runs only when the bg
  // reports it could not find a company signal (parse_error, via
  // onPeopleCompanyResolved / site-settings:people:fetchFailed).
  //
  // The card's job title (person.titleText) rides along as `title` so the
  // background's parser can reject any candidate that equals the title,
  // and the card's location (person.location — the <p> right after the
  // title) rides along as `location` so the parser can reject any
  // candidate that matches the location (a common false company signal).
  function requestPeopleCompany(vanity, profileUrl, name, title, location) {
    try {
      // No profile URL (a "LinkedIn Member" card with Open Profile privacy
      // enabled): there is no profile to fetch, so skip the background
      // message entirely. The wrapper already shows the placeholder text.
      if (!profileUrl) return;
      if (peoplePendingRequests.has(vanity)) return;
      peoplePendingRequests.add(vanity);
      browser.runtime
        .sendMessage({
          type: "site-settings:people:getCompany",
          vanity: vanity,
          profileUrl: profileUrl,
          name: name,
          title: title || "",
          location: location || ""
        })
        .then((res) => {
          // The broadcast may beat the response (different code path). Either
          // way, the wrapper will be re-rendered. Nothing to do here.
        })
        .catch((err) => {
          peoplePendingRequests.delete(vanity);
          console.warn("[People] getCompany send failed:", err);
        });
    } catch (err) {
      // Synchronous throw (e.g. the add-on was reloaded and the message
      // listener detached): drop the pending guard so the next scan can retry,
      // then surface the failure.
      peoplePendingRequests.delete(vanity);
      peopleLogError("[People] request threw for " + vanity + ": ", err, false);
    }
  }

  // ------------------------------------------------------------------
  // Hidden-iframe scrape (on-demand fallback company source)
  // ------------------------------------------------------------------
  // The background's fetch() only ever sees the SSR shell, and on a
  // logged-in view of ANOTHER user's profile that shell has no company —
  // the company appears only in the lazily-hydrated Experience section.
  // This path is the fallback for a bg parse_error: it loads the profile
  // URL in an off-screen iframe, waits for LinkedIn's hydration to render,
  // and reads the company straight out of iframe.contentDocument — fully
  // invisible (no tab-bar activity) and running LinkedIn's own hydration
  // code in a real browser context. The result is sent back to the bg via
  // site-settings:people:iframeScraped, which caches and broadcasts the
  // same companyResolved signal the fetch() path emits.
  //
  // OPEN QUESTION (the point of this experiment): whether LinkedIn's
  // hydration detects the iframe context (window.parent / window.top /
  // frame-busting) and refuses to render, or renders differently. The
  // diagnostics below answer that — if "[People] iframe resolved ..."
  // fires, the iframe approach works; if "[People] iframe timeout/failed"
  // fires, the bg fetch() remains the only working source for that profile.

  // Normalize for the name-equality check (same rule as the bg parser).
  function peopleNameNorm(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .trim();
  }

  // A parsed candidate that just echoes the person's name is a false signal.
  function isPeoplePersonName(candidate, name) {
    if (!name || !candidate) return false;
    const n = peopleNameNorm(name);
    const c = peopleNameNorm(candidate);
    return !!n && n === c;
  }

  // "Acme · Full-time" -> "Acme": drop the employment-type suffix that the
  // Experience section appends to company lines.
  function stripPeopleEmploymentSuffix(text) {
    return String(text)
      .replace(
        /\s*(?:[\u2022·]\s*)?(?:Full[- ]time|Part[- ]time|Contract|Freelance|Internship)\s*$/i,
        ""
      )
      .trim();
  }

  // "Name - Company | LinkedIn" -> "Company" (last " - " segment).
  function peopleCompanyFromTitleLike(text) {
    const cleaned = String(text || "")
      .replace(/\s*\|\s*LinkedIn\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    const parts = cleaned.split(/\s+-\s+/);
    const last = parts[parts.length - 1].trim();
    if (!last || last.length > 200) return null;
    return last;
  }

  // The person's name as the profile page renders it (the first " - "
  // segment of <title>), used to distrust title-derived candidates that
  // merely echo the name back.
  function peoplePageTitleName(doc) {
    const title = String(doc.title || "")
      .replace(/\s*\|\s*LinkedIn\s*$/i, "")
      .trim();
    return title.split(/\s+-\s+/)[0].trim();
  }

  // The hydrated profile document renders MANY <section> blocks: the top
  // card, About, Activity, Experience, Education — plus the recommendation
  // sidebars ("Explore Premium profiles", "People you may know", "More
  // profiles for you", "You might like" ...). The sidebars carry /company/
  // links and company <p>s for OTHER people, so a document-wide walk can
  // hand back a related profile's company instead of this person's own.
  // Only the Experience section is this person's own history, so the
  // parser scopes every walk to the FIRST <section> whose heading (or
  // leading text) is "Experience", skipping the sidebar sections. Returns
  // the section element, or null when the page has no Experience section
  // (a profile with no experience — nothing to walk).
  function findPeopleExperienceSection(doc) {
    // Sidebar headings that must never be treated as the Experience
    // section, even when the word "Experience" appears somewhere inside.
    const SIDEBAR_RE =
      /Explore Premium|People also viewed|People you may know|More profiles|Similar|Recommended|Promoted|You might like/i;
    for (const section of doc.querySelectorAll("section")) {
      const text = String(section.textContent || "").replace(/\s+/g, " ").trim();
      if (SIDEBAR_RE.test(text)) continue;
      const heading = section.querySelector("h1, h2, h3, h4");
      const headingText = heading
        ? String(heading.textContent || "").replace(/\s+/g, " ").trim()
        : "";
      if (/^Experience/i.test(headingText) || /^Experience/i.test(text)) {
        return section;
      }
    }
    return null;
  }

  // Content-side equivalent of the background's parseCompanyFromProfileHtml,
  // run against the LIVE hydrated iframe document instead of fetch() HTML.
  // The walk is scoped to the Experience section ONLY (via
  // findPeopleExperienceSection): the recommendation sidebars ("Explore
  // Premium profiles", "People you may know", ...) carry /company/ links
  // and company <p>s for OTHER people and must never win over this
  // person's own history. When the page has no Experience section, there
  // is no trustworthy signal and the parser returns null (the sidebars
  // alone are never enough).
  // Tier order matches the bg parser:
  //   Tier 1 — the "_08b5ea62" top-card <p> (bare company name, no
  //            employment-type suffix).
  //   Tier 2 — an employment-type <p> ("Acme · Full-time"), the strongest
  //            signal the hydrated Experience section carries. Experiences
  //            render most-recent-first, so the first match is the current
  //            company.
  //   Tier 3 — a /company/ anchor with non-empty text.
  //   Tier 4 — og:title / page <title> (last resort, name-checked). These
  //            live on the root document, not the section, so they are
  //            still consulted when the Experience section has no company.
  // Returns the company string, or null when no signal matches.
  function parsePeopleCompanyFromDoc(doc, name) {
    if (!doc || !doc.body) return null;

    const expSection = findPeopleExperienceSection(doc);
    if (!expSection) return null; // no Experience section -> no signal

    // --- Tier 1: the "_08b5ea62" <p> (top-card company line) ----------
    for (const p of expSection.querySelectorAll("p")) {
      const cls = typeof p.className === "string" ? p.className : "";
      if (cls.indexOf("_08b5ea62") === -1) continue;
      const raw = String(p.textContent || "").replace(/\s+/g, " ").trim();
      if (!raw || raw.length > 200) continue;
      if (isPeoplePersonName(raw, name)) continue;
      return raw;
    }

    // --- Tier 2: an employment-type <p> --------------------------------
    for (const p of expSection.querySelectorAll("p")) {
      const text = String(p.textContent || "").replace(/\s+/g, " ").trim();
      const m = text.match(
        /^([\s\S]*?)\s*[\u2022·]\s*(Full[- ]time|Part[- ]time|Internship|Self[- ]employed|Freelance|Contract)(?:\s|$)/i
      );
      if (!m) continue;
      const company = m[1].trim();
      if (!company || company.length > 200) continue;
      if (isPeoplePersonName(company, name)) continue;
      return company;
    }

    // --- Tier 3: /company/ anchors -------------------------------------
    for (const a of expSection.querySelectorAll('a[href*="/company/"]')) {
      const text = stripPeopleEmploymentSuffix(
        String(a.textContent || "").replace(/\s+/g, " ").trim()
      );
      if (text && text.length <= 200 && !isPeoplePersonName(text, name)) {
        return text;
      }
    }

    // --- Tier 4 (last resort): og:title / page <title> -----------------
    const og = doc.querySelector('meta[property="og:title"], meta[name="og:title"]');
    const ogVal =
      (og && (og.getAttribute("content") || og.getAttribute("value"))) || "";
    const cand = peopleCompanyFromTitleLike(ogVal || doc.title || "");
    if (cand) {
      // Reject a title-derived candidate that echoes the person's name
      // (either the content-side name or the page title's own first segment).
      const pageName = peoplePageTitleName(doc);
      if (!isPeoplePersonName(cand, name) && !isPeoplePersonName(cand, pageName)) {
        return cand;
      }
    }
    return null;
  }

  // Load the profile URL in a hidden off-screen iframe and wait for
  // LinkedIn's hydration to render, then read the company from
  // iframe.contentDocument. The iframe is removed on completion (always).
  // Resolves { ok: true, company } or { ok: false, reason } where reason is:
  //   "load_error" — the iframe could not be created or contentDocument is
  //                  inaccessible (frame-busting / off-origin redirect);
  //   "no_signal"  — the iframe rendered real page content but no company
  //                  signal appeared (private profile, auth wall, or a
  //                  context where hydration refuses to run);
  //   "timeout"    — nothing rendered within PEOPLE_IFRAME_TIMEOUT_MS.
  function scrapeProfileViaIframe(profileUrl, vanity, name) {
    return new Promise((resolve) => {
      let iframe = null;
      let settled = false;
      let sawContent = false; // the iframe document ever carried real text
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (iframe) {
          try {
            iframe.remove();
          } catch (err) {
            /* already gone */
          }
          iframe = null;
        }
        if (result.ok === true) {
          console.log("[People] iframe resolved " + vanity + " -> " + result.company);
        } else if (result.reason === "timeout") {
          console.log("[People] iframe timeout for " + vanity);
        } else {
          console.log("[People] iframe failed for " + vanity + ": " + result.reason);
        }
        resolve(result);
      };

      try {
        if (!peopleIframeDiagLogged) {
          peopleIframeDiagLogged = true;
          console.log("[People] iframe scrape enabled");
        }
        iframe = document.createElement("iframe");
        iframe.setAttribute(PEOPLE_IFRAME_ATTR, "1");
        iframe.setAttribute("src", profileUrl);
        iframe.setAttribute("aria-hidden", "true");
        iframe.setAttribute("tabindex", "-1");
        // Off-screen and 1x1 — deliberately NOT display:none: a
        // display:none frame can skip layout work entirely, and we want
        // LinkedIn's hydration to run like it would in a visible tab.
        iframe.style.cssText =
          "position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;border:0;visibility:hidden;";
        (document.body || document.documentElement).appendChild(iframe);
      } catch (err) {
        finish({ ok: false, reason: "load_error" });
        return;
      }

      const startedAt = Date.now();
      const timer = setInterval(() => {
        let doc = null;
        try {
          doc = iframe && iframe.contentDocument;
        } catch (err) {
          // contentDocument access threw: LinkedIn frame-busted or
          // redirected the frame off-origin. The iframe approach is blocked.
          clearInterval(timer);
          finish({ ok: false, reason: "load_error" });
          return;
        }
        if (doc && doc.body) {
          const text = String(doc.body.textContent || "").trim();
          if (text.length > 200) sawContent = true;
          const company = parsePeopleCompanyFromDoc(doc, name);
          if (company) {
            clearInterval(timer);
            finish({ ok: true, company: company });
            return;
          }
        }
        if (Date.now() - startedAt >= PEOPLE_IFRAME_TIMEOUT_MS) {
          clearInterval(timer);
          // Real content but no company signal (private / auth wall /
          // hydration refused) vs. nothing at all (never loaded).
          finish({ ok: false, reason: sawContent ? "no_signal" : "timeout" });
        }
      }, PEOPLE_IFRAME_POLL_MS);
    });
  }

  // The iframe scrape finished: hand the result to the background, which
  // caches it and broadcasts companyResolved — the same broadcast the
  // fetch() path emits. Skipped when this vanity already resolved with a
  // FRESH success (the other path won; a late iframe failure must never
  // clobber a working company line).
  function handleIframeScrapeResult(vanity, result) {
    try {
      if (peopleFreshSuccess(vanity)) {
        return; // the fetch() path (or an earlier scrape) already won
      }
      const msg = {
        type: "site-settings:people:iframeScraped",
        vanity: vanity,
        ok: result.ok === true
      };
      if (result.ok === true) {
        msg.company = result.company;
        msg.reason = undefined;
      } else {
        msg.reason = result.reason || "unknown";
      }
      browser.runtime
        .sendMessage(msg)
        .catch((err) => {
          console.warn("[People] iframeScraped send failed:", err);
        });
    } catch (err) {
      peopleLogError("[People] iframe result threw: ", err, false);
    }
  }

  // Find the { wrapper, person } record for a vanity by EXACT key first (the
  // content side keys peopleKnownCards by the raw URL vanity, e.g.
  // "sujatha-mizar-1614831"), then by normalized key (the background strips
  // non-alphanumerics for its cache/broadcast keys, e.g.
  // "sujathamizar1614831"). Exact-first keeps the raw-vanity broadcast path
  // (and the harness) untouched; the normalized fallback is what makes the
  // bg's broadcasts — and the new fetchFailed fallback — reach the wrapper
  // in production.
  function knownPersonForVanity(vanity) {
    const exact = peopleKnownCards.get(vanity);
    if (exact) return exact;
    const norm = peopleNameNorm(vanity);
    if (!norm) return null;
    for (const [key, val] of peopleKnownCards) {
      if (val && val.person && peopleNameNorm(key) === norm) return val;
    }
    return null;
  }

  // Look up a peopleCompanies entry by exact key first, then by normalized
  // key (the bg caches and broadcasts under the normalized vanity, so the
  // raw-keyed reads in scanPeople / renderPersonCompany would miss in
  // production). Same exact-first rule as knownPersonForVanity.
  function peopleEntryForVanity(vanity) {
    const exact = peopleCompanies.get(vanity);
    if (exact) return exact;
    const norm = peopleNameNorm(vanity);
    if (!norm) return null;
    for (const [key, entry] of peopleCompanies) {
      if (peopleNameNorm(key) === norm) return entry;
    }
    return null;
  }

  // True when a FRESH ok:true company already exists in the in-memory cache
  // for this vanity — by exact key or by normalized key. Lets the iframe
  // fallback skip a vanity another path already resolved.
  function peopleFreshSuccess(vanity) {
    const entry = peopleEntryForVanity(vanity);
    return !!(entry && entry.ok && peopleCacheFresh(entry));
  }

  // Fire the on-demand hidden-iframe scrape for a vanity whose bg fetch()
  // found no company signal (parse_error). Deduped: at most one scrape per
  // vanity per session (peopleIframeScraping), and a scrape is skipped when
  // a fresh ok:true already resolved the vanity (the other path won). The
  // result is sent back to the bg via site-settings:people:iframeScraped,
  // which caches + broadcasts the same companyResolved the fetch() path
  // emits.
  function maybeScrapeProfileViaIframe(vanity, profileUrl, name) {
    if (iframeFallbackDisabled) {
      if (!peopleIframeFallbackDiagLogged) {
        peopleIframeFallbackDiagLogged = true;
        console.warn(
          "[People] iframe fallback disabled (saves LinkedIn profile views); company unknown for this card"
        );
      }
      return;
    }
    if (!vanity || !profileUrl) return;
    if (peopleIframeScraping.has(vanity)) return;
    if (peopleFreshSuccess(vanity)) return;
    peopleIframeScraping.add(vanity);
    scrapeProfileViaIframe(profileUrl, vanity, name)
      .then((result) => {
        peopleIframeScraping.delete(vanity);
        handleIframeScrapeResult(vanity, result);
      })
      .catch((err) => {
        peopleIframeScraping.delete(vanity);
        peopleLogError("[People] iframe scrape threw: ", err, false);
      });
  }

  // Background broadcast handler: a single person's company resolved
  // (or failed). Re-render every card carrying that vanity.
  //
  // Fallback wiring: an ok:false with reason "parse_error" means the bg's
  // fetch() saw a profile body with no company signal — a LinkedIn-markup or
  // auth-shape issue, NOT a definite "no company". The hydrated hidden iframe
  // can still see the Experience section the fetch() body never carries, so
  // on parse_error we fire the on-demand iframe scrape and keep the wrapper
  // pending ("…") while it runs. A successful scrape lands here again as
  // ok:true and renders the company; a failed scrape arrives as ok:false with
  // a non-parse_error reason and removes the wrapper. We deliberately do NOT
  // cache a negative for parse_error: a re-scan must keep the wrapper pending
  // until the scrape settles. Other failures (not_found, auth_wall,
  // fetch_error, toggle off) are not LinkedIn-markup issues — an iframe
  // cannot help, so they keep the current behavior (cache negative + remove
  // the wrapper).
  function onPeopleCompanyResolved(message) {
    try {
      if (!message || typeof message.vanity !== "string") return;
      const vanity = message.vanity;
      peoplePendingRequests.delete(vanity);
      if (message.ok === true && typeof message.company === "string" && message.company) {
        peopleCompanies.set(vanity, {
          ok: true,
          company: message.company,
          fetchedAt: Date.now()
        });
      } else if (message.ok === false && message.reason === "parse_error") {
        if (iframeFallbackDisabled) {
          // The on-demand iframe scrape is disabled (it burns LinkedIn
          // profile views), so there's no fallback to hand off to. Cache a
          // negative and fall through to renderPersonCompany below, which
          // removes the wrapper — a profile whose company can't be extracted
          // just doesn't show a company line.
          peopleCompanies.set(vanity, {
            ok: false,
            reason: "parse_error",
            fetchedAt: Date.now()
          });
        } else {
          // The bg's fetch() found no company signal. Hand off to the
          // on-demand iframe scrape; the wrapper stays pending until the
          // scrape settles.
          const known = knownPersonForVanity(vanity);
          maybeScrapeProfileViaIframe(
            vanity,
            (known && known.person && known.person.profileUrl) || "",
            (known && known.person && known.person.name) || ""
          );
          return;
        }
      } else {
        // ok:false (no public company, not_found, auth_wall, fetch_error,
        // toggle off, private experience section). Cache a negative entry so
        // we don't re-fire on every scan. The wrapper renders nothing when no
        // card for this vanity is on screen.
        peopleCompanies.set(vanity, {
          ok: false,
          reason: message && message.reason ? message.reason : "unknown",
          fetchedAt: Date.now()
        });
      }
      // Re-render every known card for this vanity.
      const known = knownPersonForVanity(vanity);
      if (known) {
        renderPersonCompany(known.wrapper, known.person);
      }
    } catch (err) {
      peopleLogError("[People] resolved threw: ", err, false);
    }
  }

  // The bg's fetch() failed to find a company signal (parse_error). The
  // on-demand hidden-iframe scrape is DISABLED (iframeFallbackDisabled) — each
  // iframe-loaded profile counts as a real visit from the user's account,
  // burning LinkedIn profile views and risking rate-limiting/flagging. So this
  // handler no-ops: the bg's tier-0 fetch() alone is accurate enough, and a
  // profile whose company can't be extracted just doesn't show a company line.
  // The one-time diagnostic is emitted by maybeScrapeProfileViaIframe (which
  // both this handler and onPeopleCompanyResolved funnel through), so it fires
  // once per page load, not per card. The companyResolved ok:false broadcast
  // that accompanies this message is handled separately by
  // onPeopleCompanyResolved, which removes the wrapper on the parse-miss.
  function onPeopleFetchFailed(message) {
    try {
      if (!message || typeof message.vanity !== "string") return;
      if (message.reason !== "parse_error") return;
      const vanity = message.vanity;
      peoplePendingRequests.delete(vanity);
      maybeScrapeProfileViaIframe(
        vanity,
        String((message && message.profileUrl) || ""),
        String((message && message.name) || "")
      );
    } catch (err) {
      peopleLogError("[People] fetchFailed threw: ", err, false);
    }
  }

  // One-shot computed-style diagnostic: compares the rendered font-size of
  // the company line against the title row's first <p> so we can tell
  // whether LinkedIn's own classes (or a CSS-variable font-size token on
  // the row parent) are overriding our explicit !important rule. Logs once
  // per page load (gated by peopleComputedSizeDiagLogged) on the first
  // card that gets a real company name. ratio = company/title: ~1.0 means
  // the line matches the title, 0.875 means it renders at 87.5% of the
  // title, etc. A ratio well below 0.875 means an override is still
  // winning.
  function peopleLogComputedSizes(wrapper, person) {
    if (peopleComputedSizeDiagLogged) return;
    peopleComputedSizeDiagLogged = true;
    try {
      const wrapP = wrapper ? wrapper.querySelector("p") : null;
      // The title row's first <p>: prefer the row captured at extraction
      // time; fall back to the wrapper's previous sibling (the row the line
      // was inserted after).
      const titleRow =
        (person && person.titleRow) || (wrapper && wrapper.previousElementSibling);
      const titleP = titleRow ? titleRow.querySelector(PEOPLE_TEXT_P_SELECTOR) : null;
      const cs = window.getComputedStyle;
      const companySize = wrapP ? cs(wrapP).getPropertyValue("font-size") : "?";
      const companyLh = wrapP ? cs(wrapP).getPropertyValue("line-height") : "?";
      const titleSize = titleP ? cs(titleP).getPropertyValue("font-size") : "?";
      const titleLh = titleP ? cs(titleP).getPropertyValue("line-height") : "?";
      const ratio =
        isFinite(parseFloat(companySize)) && parseFloat(titleSize) > 0
          ? (parseFloat(companySize) / parseFloat(titleSize)).toFixed(3)
          : "?";
      console.log(
        "[People] computed sizes: title=" + titleSize + " " + titleLh +
          ", company=" + companySize + " " + companyLh + ", ratio=" + ratio
      );
    } catch (err) {
      peopleLogError("[People] computed-size diag threw: ", err, false);
    }
  }

  function renderPersonCompany(wrapper, person) {
    // peopleEntryForVanity: the in-memory cache may hold the entry under the
    // normalized vanity (bg broadcast/cache keys) while the person carries
    // the raw URL vanity.
    const entry = peopleEntryForVanity(person.vanity);
    if (!entry || !entry.ok) {
      // No usable company: drop the line entirely. A failed fetch (ok:false)
      // shouldn't leave a visible placeholder; the next scan can retry once
      // the failure TTL expires, but most failures are permanent (private
      // profile, no experience section) and a permanent "—" would be noise.
      if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
      return;
    }
    setPeopleCompanyContent(wrapper, "ready", entry.company);
    // Company name is now set — the rendered line is comparable to the
    // title, so log the computed sizes once (see peopleLogComputedSizes).
    peopleLogComputedSizes(wrapper, person);
  }

  // Queue fetches for the cards that just scrolled into view. We don't try
  // to dedupe across cards with the same vanity (rare in real search
  // results) — the background has its own dedupe.
  function onPersonIntersect(entries) {
    if (!config.showPeopleSearchCompany) return;
    // One-time confirmation that the IO callback ran — either the real IO
    // firing on scroll or the forced fire from the first scan. If this line
    // is missing from the console, the company fetches are never triggered.
    if (!peopleIntersectFired) {
      peopleIntersectFired = true;
      console.log("[People] intersect fired");
      // One-shot diagnostic: log every observed wrapper's vanity so a bg
      // getCompany message can be traced back to a specific card — including
      // stale wrappers from a previous scan (the scanner found 0 cards but
      // the IO still fires for leftover observed wrappers).
      const vanities = [];
      for (const entry of entries) {
        const w = entry && entry.target;
        if (!w || !w.dataset) continue;
        const v = w.dataset.vanity || "(no vanity)";
        vanities.push(v + (entry.isIntersecting ? "" : " (out)"));
      }
      if (vanities.length) {
        console.log("[People] intersect observed vanities: " + vanities.join(", "));
      }
    }
    try {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const wrapper = entry.target;
        const vanity = wrapper.dataset.vanity;
        if (!vanity) continue;
        if (peopleEntryForVanity(vanity)) continue;
        if (peoplePendingRequests.has(vanity)) continue;
        const profileUrl = wrapper.dataset.profileUrl || "";
        const name = wrapper.dataset.personName || "";
        const title = wrapper.dataset.personTitle || "";
        const location = wrapper.dataset.personLocation || "";
        if (!profileUrl) continue;
        requestPeopleCompany(vanity, profileUrl, name, title, location);
      }
    } catch (err) {
      peopleLogError("[People] intersect threw: ", err, false);
    }
  }

  // For each card currently on screen: if we have a cached company, render
  // it now. If not, insert the wrapper (it renders as "…" — see
  // ensurePeopleCompanyLine + initial setPeopleCompanyContent call) and
  // register the wrapper with the IntersectionObserver so the company is
  // requested the first time the card scrolls into view.
  function scanPeople() {
    if (!adapter || adapter !== linkedinPeopleAdapter) return;
    // NOTE: no hard early-return on the toggle here. The extraction loop
    // runs regardless so the harness can assert adapter output with the
    // toggle off; the toggle gates the toggle-sensitive work instead —
    // wrapper insertion/rendering, fetches (onPersonIntersect), style
    // injection, the scan summary, and the forced IO fire below. Toggle-off
    // DOM cleanup on a flip is handled by rescanPeopleIfActive; the
    // per-card guard below covers the already-off fresh load.
    const firstScan = !peopleFirstScanDone;
    try {
      if (config.showPeopleSearchCompany) injectStyles();
      // One-shot diagnostic: count what the DOM actually has at scan time so
      // "0 cards found" can be attributed to (a) no [role="listitem"]
      // elements, (b) listitems with no /in/ links, (c) /in/ links rejected
      // by parseProfileUrl, or (d) personFromCard returning null for every
      // card. personFromCard's per-card result is tallied in the loop and
      // folded into the same line below.
      const diagItems = document.querySelectorAll('[role="listitem"]').length;
      let diagItemsWithInLinks = 0;
      for (const di of document.querySelectorAll('[role="listitem"]')) {
        if (di.querySelector('a[href*="/in/"]')) diagItemsWithInLinks++;
      }
      let diagExtracted = 0;
      const cards = adapter.findPeopleCards(document);
      let wrappersInserted = 0;
      // Indexed loop (not for...of) so a per-card failure can report which
      // card threw without aborting the rest of the scan.
      for (let i = 0; i < cards.length; i++) {
        try {
          const card = cards[i];
          lastPeopleFailureReason = null;
          const person = adapter.personFromCard(card);
          if (person) diagExtracted++;
          if (!person) {
            if (firstScan) {
              console.log(
                "[People] card #" + i + " skipped: " + (lastPeopleFailureReason || "unknown")
              );
            }
            continue;
          }
          // First successful card of the driver session: confirm the adapter
          // is working on at least one card, showing exactly which name/title
          // the fallbacks picked and how the text column + title row were
          // located (element descriptors, or the fallback tag when the
          // structural path chose them). Logged once — the 2s pollTick would
          // otherwise repeat it forever.
          if (i === 0 && !peopleScanLogged) {
            peopleScanLogged = true;
            console.log(
              "[People] card #0 extracted: name=" + person.name +
                " title=" + person.titleText +
                " column=" +
                (person.textColumnVia === "avatar-child"
                  ? shortSel(person.textColumn)
                  : "first-div") +
                " row=" +
                (person.titleRowVia === "row-child"
                  ? shortSel(person.titleRow)
                  : "first-non-figure-div")
            );
          }
          // Toggle gate: when the feature is off, no wrapper may be
          // inserted and no cached company/placeholder may be rendered. The
          // flip-off case is handled by rescanPeopleIfActive (storage
          // onChanged); this guard covers the already-off fresh page load,
          // where nothing ever inserts a line in the first place.
          if (!config.showPeopleSearchCompany) continue;
          // Cached failure: never render a line for this vanity. Rendering
          // would insert a wrapper and immediately remove it again on every
          // poll (churn); skipping the insert keeps steady-state scans
          // DOM-write-free. A stale wrapper from an earlier state is dropped
          // if present.
          const cached = peopleEntryForVanity(person.vanity);
          if (cached && !cached.ok) {
            const col = person.textColumn || person.card;
            const stale = col ? col.querySelector("." + PEOPLE_COMPANY_WRAPPER_CLASS) : null;
            if (stale) stale.remove();
            continue;
          }
          const wrapper = ensurePeopleCompanyLine(person);
          if (!wrapper) {
            if (firstScan) {
              console.log(
                "[People] card #" + i + " skipped: " + (lastPeopleFailureReason || "wrapper insert failed")
              );
            }
            continue;
          }
          wrappersInserted++;
          if (cached && cached.ok) {
            // Skip the rewrite when the wrapper already shows this company
            // (re-scans stay a DOM no-op; a broadcast or a first render owns
            // the transition from "…" to the name).
            const span = wrapper.querySelector("span");
            if (
              !span ||
              span.textContent !== cached.company ||
              wrapper.classList.contains(PEOPLE_COMPANY_PENDING_CLASS)
            ) {
              renderPersonCompany(wrapper, person);
            }
          } else if (!person.profileUrl) {
            // No profile URL (a "LinkedIn Member" card with Open Profile
            // privacy enabled): there is no profile to fetch, so render a
            // muted placeholder instead of the pending "…" and do NOT
            // register the wrapper with the IntersectionObserver (nothing
            // to request). Re-scans skip re-writing an already-placeholder
            // wrapper so the 2s poll stays a DOM no-op.
            const span = wrapper.querySelector("span");
            if (
              !wrapper.classList.contains(PEOPLE_COMPANY_FAILED_CLASS) ||
              (span && span.textContent !== PEOPLE_NO_PROFILE_TEXT)
            ) {
              setPeopleCompanyContent(wrapper, "failed", PEOPLE_NO_PROFILE_TEXT);
            }
          } else {
            // Pending state: the wrapper shows "…" until the broadcast lands
            // (success → real name; failure → wrapper is removed). Watching the
            // card via IntersectionObserver triggers the actual fetch the first
            // time it enters the viewport, which prevents hammering the
            // background with requests for off-screen results the user may
            // never scroll to. Re-scans skip re-writing an already-pending
            // wrapper so the 2s poll stays a DOM no-op.
            const span = wrapper.querySelector("span");
            if (
              !wrapper.classList.contains(PEOPLE_COMPANY_PENDING_CLASS) ||
              (span && span.textContent !== "\u2026")
            ) {
              setPeopleCompanyContent(wrapper, "pending", "\u2026");
            }
            if (peopleObserver) peopleObserver.observe(wrapper);
          }
        } catch (err) {
          // One bad card must not abort the rest of the scan; report and
          // continue. The outer catch re-throws, so a failure here is never
          // silently swallowed by the driver.
          peopleLogError("[People] card threw on #" + i + ": ", err, false);
        }
      }
      // One-shot search diagnostic: items = [role="listitem"] in the DOM,
      // /in/ links = listitems that carry a /in/ link, personFromCard
      // returned = how many of those cards yielded a person. Logged once
      // per distinct triple so the first scan and any change are visible
      // but the steady-state 2s poll stays silent. Placed outside the
      // toggle gate so a toggle-off scan still reports what the adapter
      // found.
      const searchDiag =
        "[People] scan: searching for cards... items: " + diagItems +
        ", /in/ links: " + diagItemsWithInLinks +
        ", personFromCard returned: " + diagExtracted;
      if (searchDiag !== lastPeopleSearchDiag) {
        lastPeopleSearchDiag = searchDiag;
        console.log(searchDiag);
      }
      if (config.showPeopleSearchCompany) {
        // The scan summary logs on the first scan and then only when the
        // result actually changes (new cards rendered, a wrapper appeared).
        // A steady-state poll is silent, so the console no longer loops.
        const summary = cards.length + "/" + wrappersInserted;
        if (summary !== lastPeopleSummary) {
          lastPeopleSummary = summary;
          console.log(
            "[People] scan: " + cards.length + " cards found, " +
              wrappersInserted + " wrappers inserted"
          );
        }
        // First scan: fire the IO callback for every wrapper synchronously,
        // as if each card had just scrolled into view. This guarantees the
        // initial company requests go out even when no card is in the
        // viewport (the IO would otherwise wait for a scroll). The IO stays
        // registered for cards that render later.
        if (firstScan) {
          peopleFirstScanDone = true;
          const wrappers = document.querySelectorAll("." + PEOPLE_COMPANY_WRAPPER_CLASS);
          const entries = [];
          for (const w of wrappers) entries.push({ target: w, isIntersecting: true });
          if (entries.length) onPersonIntersect(entries);
        }
      }
    } catch (err) {
      // Log a friendly one-liner (with the throwing frame) and re-throw so
      // the page console also shows the full stack via default exception
      // handling.
      peopleLogError("[People] scan threw: ", err, true);
      throw err;
    }
  }

  function startPeopleObserving() {
    if (peopleObserver) peopleObserver.disconnect();
    // IntersectionObserver is universally available in Firefox 128+; the
    // module targets that baseline. A guard keeps older Firefox from
    // throwing — without an observer, the driver falls back to fetching
    // every card on the first scan (a thundering herd, but better than
    // a broken page).
    if (typeof IntersectionObserver === "function") {
      peopleObserver = new IntersectionObserver(onPersonIntersect, {
        root: null,
        rootMargin: "0px",
        threshold: 0.01
      });
    }
    // Fresh driver session: reset the one-shot diagnostics so a new page
    // load (or a cache clear / module re-enable) logs and force-fires once
    // again.
    peopleScanLogged = false;
    peopleFirstScanDone = false;
    peopleIntersectFired = false;
    peopleComputedSizeDiagLogged = false;
    lastPeopleSummary = "";
    // No MutationObserver for the people driver. Our own wrapper/text
    // writes (wrapper inserts, "…" -> company, pending-class toggles) are
    // childList/attribute mutations, so an MO on document.body fired the
    // 150ms debounce forever (scan -> mutate -> scan). Rescans instead run
    // on the 2s pollTick, storage.onChanged, and the broadcast-triggered
    // targeted re-renders; steady-state scans are silent DOM no-ops.
  }

  // Re-render every person line when the toggle flips on (or the cache
  // changes for any other reason — currently only the toggle). A no-op
  // when the adapter is the jobs adapter.
  function rescanPeopleIfActive() {
    if (adapter !== linkedinPeopleAdapter) return;
    if (!config.showPeopleSearchCompany) {
      // Toggled off: drop every line + queued request, keep the IO alive
      // (it costs nothing to leave connected and saves a re-attach on
      // re-toggle).
      for (const w of document.querySelectorAll("." + PEOPLE_COMPANY_WRAPPER_CLASS)) {
        w.remove();
      }
      peopleKnownCards.clear();
      peoplePendingRequests.clear();
      // The next toggle-on rescan behaves like a fresh first scan: it logs
      // its diagnostics and force-fires the IO for every re-inserted
      // wrapper.
      peopleScanLogged = false;
      peopleFirstScanDone = false;
      peopleComputedSizeDiagLogged = false;
      lastPeopleSummary = "";
      return;
    }
    scanPeople();
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
    teardownJobCards();
    teardownPeople();
    adapter = null;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(scanTimer);
    removeAllRatingBadges();
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
  }

  // Strip every block/highlight, every wrapper, and reset the job-search
  // driver state. Safe to call when nothing is on screen.
  function teardownJobCards() {
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
  }

  // Strip every people-company line, disconnect the IntersectionObserver,
  // drop the queued fetch set, and reset the people-driver state. Safe to
  // call when nothing is on screen.
  function teardownPeople() {
    if (peopleObserver) {
      peopleObserver.disconnect();
      peopleObserver = null;
    }
    for (const w of document.querySelectorAll("." + PEOPLE_COMPANY_WRAPPER_CLASS)) {
      w.remove();
    }
    // Drop any in-flight iframe scrapes — the pages they were loading are
    // going away, and a completed scrape would only report into a torn-down
    // driver.
    for (const f of document.querySelectorAll("iframe[" + PEOPLE_IFRAME_ATTR + "]")) {
      f.remove();
    }
    peopleIframeScraping.clear();
    peoplePendingRequests.clear();
    peopleKnownCards.clear();
  }

  // When the adapter changes mid-session (e.g. user navigates from
  // /jobs/search to /search/results/people), tear down only the previous
  // driver's state. The shared state (observer, ratings, styles) stays so
  // the new driver can start without flicker. The previous adapter is
  // passed in explicitly because by the time this is called, the global
  // `adapter` has already been updated to the new one.
  function teardownDriverState(prev) {
    if (prev === linkedinPeopleAdapter) teardownPeople();
    else teardownJobCards();
  }

  async function ensureActive() {
    const isActive = window.jobAppToolkit.content.isModuleActive(MODULE_ID);
    const next = currentAdapter();
    // Fires once on page load and again on adapter change (SPA navigation).
    // active=false -> the module toggle is off; adapter=null -> no page type
    // matched; both are silent teardown paths, so this log is the only way
    // to tell them apart.
    console.log(
      "[Site Settings] ensureActive: active=" + isActive +
        ", adapter=" + adapterName(next) +
        ", path=" + location.pathname
    );
    if (!isActive) {
      teardown();
      return;
    }
    if (!next) {
      teardown();
      return;
    }
    const prev = adapter;
    adapter = next;
    await loadConfig();
    // Different adapter (different page type) — tear down the previous
    // driver state before starting the new one, so the Glassdoor pipeline,
    // people pipeline, and block/highlight pipeline don't leak across pages.
    if (prev && prev !== next) teardownDriverState(prev);
    if (next === linkedinPeopleAdapter) {
      console.log("[People] adapter matched: " + location.pathname);
      // The people driver needs the in-memory company cache before
      // scanPeople runs (cached entries render instantly; uncached ones
      // show "…" and queue a fetch). peopleCacheLoad is cheap when the
      // cache is empty.
      await peopleCacheLoad();
      startPeopleObserving();
      scanPeople();
    } else {
      startObserving();
      scanCards();
    }
  }

  // SPA navigation safety net: LinkedIn swaps pages without full reloads. A
  // cheap periodic tick catches (a) navigation into/out of the target page and
  // (b) result containers a MutationObserver on the previous one would miss.
  function pollTick() {
    const next = currentAdapter();
    const onTarget = next !== null;
    if (onTarget !== Boolean(adapter) || (adapter && next && adapter !== next)) {
      ensureActive();
      return;
    }
    if (adapter === linkedinPeopleAdapter) scanPeople();
    else if (adapter) scanCards();
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

  // People-company resolutions from the background. Installed exactly once;
  // the handler is a no-op when the people adapter isn't active or the
  // toggle is off (the in-memory map is empty, so nothing renders). Also
  // listens for site-settings:people:fetchFailed — the bg's signal that its
  // fetch() found no company (parse_error) and the on-demand hidden-iframe
  // scrape should fire as the fallback.
  if (!peopleBroadcastListenerInstalled) {
    peopleBroadcastListenerInstalled = true;
    browser.runtime.onMessage.addListener((message) => {
      if (message && message.type === "site-settings:people:companyResolved") {
        onPeopleCompanyResolved(message);
      } else if (message && message.type === "site-settings:people:fetchFailed") {
        onPeopleFetchFailed(message);
      }
      return undefined;
    });
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[STORAGE_KEY]) {
      loadConfig().then(() => {
        if (!adapter) return;
        if (adapter === linkedinPeopleAdapter) {
          rescanPeopleIfActive();
        } else {
          scanCards();
        }
      });
      return;
    }
    if (area === "local" && changes[PEOPLE_CACHE_KEY]) {
      const change = changes[PEOPLE_CACHE_KEY];
      const cleared = change && change.newValue === undefined;
      if (cleared) {
        // The options page cleared the cache (the key was removed). Reset
        // every piece of in-memory driver state so the re-scan starts
        // clean: peopleKnownCards can hold wrappers that a failure
        // re-render already removed from the DOM, and peoplePendingRequests
        // can hold vanities whose broadcast was lost (e.g. the background
        // event page unloaded mid-fetch) — either would silently block the
        // re-scan from re-creating lines and re-queueing fetches. Drop and
        // re-create the observers so the fresh wrappers are tracked.
        peopleKnownCards.clear();
        peoplePendingRequests.clear();
        for (const f of document.querySelectorAll("iframe[" + PEOPLE_IFRAME_ATTR + "]")) {
          f.remove();
        }
        peopleIframeScraping.clear();
        if (peopleObserver) {
          peopleObserver.disconnect();
          peopleObserver = null;
        }
      }
      peopleCacheLoad().then(() => {
        if (adapter !== linkedinPeopleAdapter) return;
        if (cleared) startPeopleObserving();
        rescanPeopleIfActive();
      });
    }
  });

  window.jobAppToolkit.content.refreshActive(MODULE_ID);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      peopleCacheLoad().then(ensureActive);
    });
  } else {
    peopleCacheLoad().then(ensureActive);
  }
  setInterval(pollTick, 2000);
})();
