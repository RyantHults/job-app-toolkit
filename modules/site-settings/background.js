/**
 * Site Settings — background module. Registers with the Job App Toolkit core
 * and owns persistence of per-site settings (per-company block / highlight
 * lists and title-block keywords for job boards like LinkedIn) plus the
 * Glassdoor rating cache and the people-search company cache. Content
 * scripts do the DOM work; this script mediates storage and in-page
 * feedback.
 */
(function () {
  "use strict";

  const MODULE_ID = "site-settings";

  const BLOCKED_KEY = "blockedCompanies";
  const HIGHLIGHTED_KEY = "highlightedCompanies";
  const TITLE_KEYWORDS_KEY = "titleBlockedKeywords";
  const HIDE_APPLIED_KEY = "hideApplied";

  // ------------------------------------------------------------------
  // Glassdoor ratings fetcher + cache
  // ------------------------------------------------------------------
  // Ratings are fetched per company (typeahead -> search results), cached in
  // browser.storage.local, and broadcast back to the requesting tab as
  // site-settings:glassdoor:updated. Requests are serial with a 2s gap and a
  // 15-fetch session cap (resets whenever the background event page wakes).
  // All failures (network, DataDome 403/503, parse miss) cache an ok:false
  // entry and broadcast a negative update. Fetches only run while
  // sites.linkedin.showGlassdoorRatings is enabled.

  const GLASSDOOR_CACHE_KEY = "jtk-site-settings-glassdoor";
  // Bump when the cache entry shape or the fetcher pipeline changes in a way
  // that makes old entries misleading. Entries without a matching
  // schemaVersion are treated as stale by glassdoorFresh and re-fetched. v5 =
  // add the "?" failed-badge + retryRating message (content-side change:
  // ok:false entries are now rendered as a clickable retry badge instead of
  // removed). v4 = api.glassdoor.com base. All v4 entries (including v4
  // failures) are evicted so the new retry path starts clean.
  const GLASSDOOR_CACHE_SCHEMA_VERSION = 5;
  const GLASSDOOR_SUCCESS_TTL = 90 * 24 * 60 * 60 * 1000; // 90 days — ratings don't change much, refresh ~quarterly
  const GLASSDOOR_FAILURE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
  const GLASSDOOR_FETCH_GAP_MS = 2000;
  const GLASSDOOR_SESSION_CAP = 15;
  // The Cloudflare WAF that gates www.glassdoor.com does NOT gate
  // api.glassdoor.com — confirmed by live probe: the typeahead, BFF, and
  // Overview endpoints on api.glassdoor.com all return 200 with no cookie
  // and no TLS-fingerprint challenge. The www. Overview is the badge-click
  // target (a real browser tab) and is hardcoded separately where needed.
  const GLASSDOOR_BASE = "https://api.glassdoor.com";
  const GLASSDOOR_UA =
    "Mozilla/5.0 (X11; Linux x86_64; rv:136.0) Gecko/20100101 Firefox/136.0";

  // Latest sites.linkedin.showGlassdoorRatings; re-read on every getRatings
  // so toggling on takes effect immediately without a background restart.
  let showGlassdoorRatings = false;
  let glassdoorWarmedUp = false; // warm-up once per session
  let glassdoorFetchesThisSession = 0;
  let glassdoorController = null; // AbortController for the in-flight fetch
  let glassdoorLastFetchStart = 0; // enforces the 2s gap between starts
  let glassdoorTimer = null;
  const glassdoorQueue = [];
  const glassdoorPending = new Set(); // normalized names queued or in flight
  let glassdoorActive = false;

  function normalizeCompanyName(name) {
    return String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function glassdoorErr(err) {
    return err && err.message ? err.message : String(err);
  }

  // Compact count formatter for the badge: 999 -> "999", 70683 -> "70.7K",
  // 1234567 -> "1.2M". Returns "" for non-numeric input.
  function formatCount(n) {
    n = Number(n);
    if (!isFinite(n)) return "";
    if (n < 1000) return String(n);
    if (n < 1000000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
    return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  }

  function glassdoorFetch(url, opts) {
    return fetch(url, {
      signal: opts && opts.signal,
      credentials: "include",
      redirect: "follow",
      headers: {
        "User-Agent": GLASSDOOR_UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.5",
        "Referer": GLASSDOOR_BASE + "/",
        "Origin": GLASSDOOR_BASE
      }
    });
  }

  // --- hop 2: BFF JSON + api.glassdoor.com Overview fallback -----------

  // POST the www.glassdoor.com BFF employer-reviews endpoint for a resolved
  // employerId. Returns the parsed rating object, or { ok: false, reason:
  // "no_reviews" } when the employer exists but has zero reviews (a valid
  // response, not a parse miss), or null on any failure (403/429 = missing
  // gdId cookie / rate-limited; other HTTP; parse miss; network error) so the
  // caller can fall through to the Overview fallback.
  async function glassdoorFetchBff(employerId, signal) {
    let res;
    try {
      res = await fetch(
        GLASSDOOR_BASE + "/bff/employer-profile-mono/employer-reviews",
        {
          method: "POST",
          signal: signal,
          credentials: "include",
          redirect: "follow",
          headers: {
            "User-Agent": GLASSDOOR_UA,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.5",
            "Referer": GLASSDOOR_BASE + "/",
            "Origin": GLASSDOOR_BASE,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            employerId: Number(employerId),
            pageSize: 3,
            page: 1
          })
        }
      );
    } catch (err) {
      if (err && (err.name === "AbortError" || (signal && signal.aborted))) throw err;
      console.warn("[Glassdoor] BFF fetch failed: " + glassdoorErr(err));
      return null;
    }
    if (res.status === 403 || res.status === 429) {
      console.warn("[Glassdoor] BFF " + res.status);
      return null;
    }
    if (!res.ok) {
      console.warn("[Glassdoor] BFF HTTP " + res.status);
      return null;
    }
    let j;
    try {
      j = await res.json();
    } catch (err) {
      console.warn("[Glassdoor] BFF parse miss");
      return null;
    }
    const er = j && j.data && j.data.employerReviews;
    if (!er || !er.ratings) {
      console.warn("[Glassdoor] BFF parse miss");
      return null;
    }
    // Zero reviews is a valid "no rating" response, not a parse miss. Return a
    // shape the caller will treat as ok:false (caches the no-rating state, the
    // content side shows the "?" badge with the reason in the tooltip). The
    // 7-day failure TTL means a retry within a week won't re-fetch; after that
    // a new fetch will pick up any new reviews.
    if (
      er.allReviewsCount === 0 ||
      er.ratedReviewsCount === 0 ||
      er.ratings.overallRating == null
    ) {
      console.log("[Glassdoor] BFF no reviews for employerId " + employerId);
      return { ok: false, reason: "no_reviews" };
    }
    if (er.ratings.reviewCount == null) {
      console.warn("[Glassdoor] BFF parse miss");
      return null;
    }
    const count = formatCount(er.ratings.reviewCount);
    // The employer-reviews BFF on api.glassdoor.com does not include the
    // employer object (it returns null for data.employerReviews.employer);
    // the rating + count are what we need. The caller builds the pageUrl
    // from the typeahead pick (suggestion + employerId).
    return {
      ok: true,
      rating: er.ratings.overallRating,
      count: count,
      countText: count + " reviews"
    };
  }

  // GET the api.glassdoor.com Overview page and read rating/count off the
  // rendered markup. Slug-forgiving (wrong slug 301s to canonical), no
  // DataDome, unrate-limited — the backstop when the www BFF 403s. Returns
  // the parsed rating object or null on any failure.
  async function glassdoorFetchOverviewFallback(employerId, slug, signal) {
    if (!slug) return null;
    const url =
      GLASSDOOR_BASE + "/Overview/Working-at-" +
      encodeURIComponent(String(slug).replace(/\s+/g, "-")) +
      "-EI_IE" + employerId + ".htm";
    let res;
    try {
      res = await glassdoorFetch(url, { signal: signal });
    } catch (err) {
      if (err && (err.name === "AbortError" || (signal && signal.aborted))) throw err;
      console.warn("[Glassdoor] Overview fallback fetch failed: " + glassdoorErr(err));
      return null;
    }
    if (!res.ok) {
      console.warn("[Glassdoor] Overview fallback HTTP " + res.status);
      return null;
    }
    let html;
    try {
      html = await res.text();
    } catch (err) {
      console.warn("[Glassdoor] Overview fallback parse miss");
      return null;
    }
    let doc = null;
    try {
      doc = new DOMParser().parseFromString(html, "text/html");
    } catch (err) {
      doc = null;
    }
    if (!doc || typeof doc.querySelectorAll !== "function") {
      console.warn("[Glassdoor] Overview fallback parse miss");
      return null;
    }
    const ratingEl = doc.querySelector('[class*="CompanyOverview_overallRating"]');
    if (!ratingEl) {
      console.warn("[Glassdoor] Overview fallback parse miss");
      return null;
    }
    const rating = parseFloat(String(ratingEl.textContent || "").trim());
    if (isNaN(rating)) {
      console.warn("[Glassdoor] Overview fallback parse miss");
      return null;
    }
    let count = "";
    const countEl = doc.querySelector('[class*="CompanyOverview_ratingCount"]');
    if (countEl) {
      const text = String(countEl.textContent || "").trim();
      const m = text.match(/([\d,]+)\s*rating/);
      if (m) {
        const parsed = parseInt(m[1].replace(/,/g, ""), 10);
        if (!isNaN(parsed)) count = parsed; // missing/odd count still returns a badge
      }
    }
    return {
      rating: rating,
      count: count === "" ? "" : formatCount(count),
      countText: count === "" ? "" : formatCount(count) + " reviews",
      pageUrl:
        "https://www.glassdoor.com/Overview/Working-at-" +
        encodeURIComponent(String(slug).replace(/\s+/g, "-")) +
        "-EI_IE" + employerId + ".htm",
      employerId: String(employerId)
    };
  }

  // --- cache ------------------------------------------------------------

  // A cached entry is fresh when it is within its TTL (30d success, 7d
  // failure). Anything past its TTL is treated as a miss on lookup.
  function glassdoorFresh(entry) {
    if (!entry || typeof entry.fetchedAt !== "number") return false;
    if (entry.schemaVersion !== GLASSDOOR_CACHE_SCHEMA_VERSION) return false;
    const ttl = entry.ok ? GLASSDOOR_SUCCESS_TTL : GLASSDOOR_FAILURE_TTL;
    return Date.now() - entry.fetchedAt < ttl;
  }

  async function glassdoorCacheGet() {
    try {
      const res = await browser.storage.local.get(GLASSDOOR_CACHE_KEY);
      const val = res[GLASSDOOR_CACHE_KEY];
      return val && typeof val === "object" ? val : {};
    } catch (err) {
      console.warn("[Glassdoor] cache read failed: " + glassdoorErr(err));
      return {};
    }
  }

  async function glassdoorCacheSet(norm, entry) {
    try {
      const cache = await glassdoorCacheGet();
      cache[norm] = entry;
      await browser.storage.local.set({ [GLASSDOOR_CACHE_KEY]: cache });
    } catch (err) {
      console.warn("[Glassdoor] cache write failed: " + glassdoorErr(err));
    }
  }

  async function glassdoorCacheMiss(norm, reason) {
    await glassdoorCacheSet(norm, {
      ok: false,
      reason: reason,
      schemaVersion: GLASSDOOR_CACHE_SCHEMA_VERSION,
      fetchedAt: Date.now()
    });
  }

  // Broadcast an update to the originating tab. The content side re-renders
  // its badges from this. Failures (tab closed, no content script) are
  // ignored.
  function glassdoorBroadcast(tabId, payload) {
    if (typeof tabId !== "number") return;
    const msg = { type: "site-settings:glassdoor:updated" };
    Object.keys(payload).forEach((k) => {
      msg[k] = payload[k];
    });
    try {
      browser.tabs.sendMessage(tabId, msg).catch(() => {});
    } catch (err) {
      // Tab may be gone — nothing to do.
    }
  }

  // --- typeahead + search parsing ---------------------------------------

  // Pick the best company entry from a typeahead response: prefer the first
  // directHit company/employer entry, else the first company/employer entry.
  // Returns { employerId, suggestion } (suggestion = the raw suggestion
  // string, used as the Overview-page slug) or null when there is no usable
  // entry.
  function pickCompanyFromTypeahead(typeahead) {
    if (!Array.isArray(typeahead)) return null;
    let fallback = null;
    for (const item of typeahead) {
      if (!item || typeof item !== "object") continue;
      const category = item.category || item.kind || "";
      if (category !== "company" && category !== "employer") continue;
      const employerId = item.employerId != null ? String(item.employerId) : "";
      if (!employerId) continue;
      const suggestion = item.suggestion != null ? String(item.suggestion) : "";
      if (item.directHit === true) {
        return { employerId: employerId, suggestion: suggestion };
      }
      if (!fallback) fallback = { employerId: employerId, suggestion: suggestion };
    }
    return fallback;
  }

  // Nearest ancestor (starting at el) whose class attribute contains
  // "CompanyCard" — the search-results card that carries rating + count.
  function closestCompanyCard(el, doc) {
    let node = el;
    while (node && node !== doc) {
      if (typeof node.getAttribute === "function") {
        const cls = node.getAttribute("class") || "";
        if (cls.indexOf("CompanyCard") !== -1) return node;
      }
      node = node.parentElement || node.parentNode;
    }
    return null;
  }

  // no longer called from the main path as of 2026-08-06; retained for reference
  // Parse the search-results page for the card matching EI_IE<employerId>.
  // Returns { ok: true, rating, count, countText, pageUrl, employerId } or
  // { ok: false, reason: "no_match" | "parse_error" }.
  function parseSearchResults(html, employerId) {
    const token = "EI_IE" + employerId + ".";
    let doc = null;
    try {
      doc = new DOMParser().parseFromString(html, "text/html");
    } catch (err) {
      doc = null;
    }
    const result = { ok: false, reason: "no_match" };
    if (!doc || typeof doc.querySelectorAll !== "function") return result;
    const anchors = doc.querySelectorAll('a[href*="' + token + '"]');
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const href = (a.getAttribute && a.getAttribute("href")) || "";
      if (!/^\/Overview\/Working-at-/i.test(href)) continue;
      const card = closestCompanyCard(a, doc);
      if (!card) continue;
      const text = card.textContent || "";
      const ratingMatch = text.match(/([0-9]\.[0-9])\u2605/);
      if (!ratingMatch) {
        result.reason = "parse_error";
        continue;
      }
      const countMatch = text.match(/(\d+(?:\.\d+)?[KM]?)\s*reviews/);
      const count = countMatch ? countMatch[1] : "";
      let pageUrl = href;
      try {
        pageUrl = new URL(href, GLASSDOOR_BASE).href;
      } catch (err) {
        // Keep the raw href.
      }
      return {
        ok: true,
        rating: parseFloat(ratingMatch[1]),
        count: count,
        countText: count ? count + " reviews" : "",
        pageUrl: pageUrl,
        employerId: employerId
      };
    }
    return result;
  }

  // --- queue + pipeline -------------------------------------------------

  function glassdoorEnqueue(name, tabId) {
    if (glassdoorFetchesThisSession >= GLASSDOOR_SESSION_CAP) return;
    const norm = normalizeCompanyName(name);
    if (!norm || glassdoorPending.has(norm)) return;
    glassdoorPending.add(norm);
    glassdoorQueue.push({ name: name, norm: norm, tabId: tabId });
    glassdoorPump();
  }

  // Serial pump: at most one fetch in flight, and at least 2s between the
  // START of consecutive fetches. Waits out the remaining gap (from
  // glassdoorLastFetchStart) before starting the next queued company.
  function glassdoorPump() {
    if (glassdoorActive) return;
    if (!showGlassdoorRatings) {
      // Toggled off mid-queue: drop everything, start nothing.
      clearTimeout(glassdoorTimer);
      glassdoorTimer = null;
      glassdoorQueue.length = 0;
      glassdoorPending.clear();
      return;
    }
    if (glassdoorFetchesThisSession >= GLASSDOOR_SESSION_CAP) return;
    if (glassdoorQueue.length === 0) return;
    const elapsed = Date.now() - glassdoorLastFetchStart;
    if (elapsed < GLASSDOOR_FETCH_GAP_MS) {
      clearTimeout(glassdoorTimer);
      glassdoorTimer = setTimeout(glassdoorPump, GLASSDOOR_FETCH_GAP_MS - elapsed);
      return;
    }
    const job = glassdoorQueue.shift();
    if (!job) return;
    glassdoorActive = true;
    glassdoorLastFetchStart = Date.now();
    glassdoorFetchOne(job.name, job.norm, job.tabId)
      .catch((err) => {
        console.error('[Glassdoor] unexpected error for "' + job.norm + '":', err);
      })
      .then(() => {
        glassdoorPending.delete(job.norm);
        glassdoorActive = false;
        if (
          glassdoorQueue.length > 0 &&
          glassdoorFetchesThisSession < GLASSDOOR_SESSION_CAP
        ) {
          glassdoorPump();
        }
      });
  }

  // One company pipeline: warm-up (once) -> typeahead -> search results.
  // Every terminal path caches an entry and broadcasts to the requesting tab.
  async function glassdoorFetchOne(name, norm, tabId) {
    glassdoorFetchesThisSession++;

    if (!glassdoorWarmedUp) {
      glassdoorWarmedUp = true;
      try {
        const res = await glassdoorFetch(GLASSDOOR_BASE + "/index.htm");
        console.log("[Glassdoor] warm-up " + res.status);
      } catch (err) {
        // Non-fatal: the user's real cookie store may already be seeded.
        console.warn("[Glassdoor] warm-up failed: " + glassdoorErr(err));
      }
    }

    const controller = new AbortController();
    glassdoorController = controller;
    const signal = controller.signal;

    try {
      // 1. Typeahead — resolves the company to an employer id.
      const taRes = await glassdoorFetch(
        GLASSDOOR_BASE +
          "/searchsuggest/typeahead?numSuggestions=8&source=GD_V2&version=NEW&rf=full&fallback=token&input=" +
          encodeURIComponent(name),
        { signal: signal }
      );
      if (taRes.status === 403 || taRes.status === 503) {
        // Diagnostic: dump the 403 response headers so we can see what the
        // gate is — cf-ray (Cloudflare), Set-Cookie (what it tried to set),
        // server, and any cookie-related headers. Reveals whether the block
        // is cookie-partitioning (no Set-Cookie needed, just a gate) vs
        // missing-cookie (the response would Set-Cookie a challenge token).
        try {
          const hdrs = {};
          for (const k of ["set-cookie", "cf-ray", "server", "www-authenticate", "x-amz-cf-id", "x-cache"]) {
            const v = taRes.headers && typeof taRes.headers.get === "function" ? taRes.headers.get(k) : null;
            if (v) hdrs[k] = v;
          }
          console.warn("[Glassdoor] typeahead blocked " + taRes.status + ' for "' + norm + '"', hdrs);
        } catch (hdrErr) { /* header probe failed — non-fatal */ }
        // Do NOT cache a 403 from the typeahead — the gate is external
        // stateful state (cookies, IP, Cloudflare mood), not a property of
        // the company. Caching it would block every retry for 7 days. The
        // 2s throttle already prevents hammering. Broadcast the negative
        // update so the content side removes the badge, and let the next
        // scan tick actually retry the typeahead.
        glassdoorBroadcast(tabId, { name: name, ok: false });
        return;
      }
      if (!taRes.ok) {
        console.warn("[Glassdoor] typeahead HTTP " + taRes.status + ' for "' + norm + '"');
        await glassdoorCacheMiss(norm, "fetch_error");
        glassdoorBroadcast(tabId, { name: name, ok: false });
        return;
      }
      let typeahead;
      try {
        typeahead = await taRes.json();
      } catch (err) {
        console.warn('[Glassdoor] typeahead parse failed for "' + norm + '"');
        await glassdoorCacheMiss(norm, "parse_error");
        glassdoorBroadcast(tabId, { name: name, ok: false });
        return;
      }
      const pick = pickCompanyFromTypeahead(typeahead);
      if (!pick) {
        console.log('[Glassdoor] no typeahead match for "' + norm + '"');
        await glassdoorCacheMiss(norm, "no_match");
        glassdoorBroadcast(tabId, { name: name, ok: false });
        return;
      }
      console.log('[Glassdoor] typeahead hit "' + norm + '" -> EI_IE' + pick.employerId);

      // 2. BFF JSON (replaces the old search-results HTML parse).
      const bff = await glassdoorFetchBff(pick.employerId, signal);
      if (bff && bff.ok === true) {
        // existing success path — build pageUrl, cache, broadcast ok:true
        const fallbackSlug = pick.suggestion || name;
        const pageUrl =
          "https://www.glassdoor.com/Overview/Working-at-" +
          encodeURIComponent(String(fallbackSlug).replace(/\s+/g, "-")) +
          "-EI_IE" + pick.employerId + ".htm";
        const entry = { ok: true, rating: bff.rating, count: bff.count, countText: bff.countText, pageUrl: pageUrl, employerId: pick.employerId, schemaVersion: GLASSDOOR_CACHE_SCHEMA_VERSION, fetchedAt: Date.now() };
        console.log('[Glassdoor] BFF hit "' + norm + '" ' + entry.rating + "\u2605 " + entry.countText + " " + entry.pageUrl);
        await glassdoorCacheSet(norm, entry);
        glassdoorBroadcast(tabId, { name: name, ok: true, rating: entry.rating, count: entry.count, countText: entry.countText, pageUrl: entry.pageUrl, employerId: entry.employerId });
        return;
      }
      if (bff && bff.ok === false) {
        // BFF says no reviews exist (valid response, not a parse miss). Cache
        // the no-rating state and broadcast so the content side shows the "?"
        // badge. The 7-day failure TTL prevents retry storms; a real review
        // appearing will be picked up after the TTL expires or via manual
        // retry (which evicts the cache entry).
        await glassdoorCacheMiss(norm, bff.reason || "no_reviews");
        glassdoorBroadcast(tabId, { name: name, ok: false, reason: bff.reason || "no_reviews" });
        return;
      }
      // bff is null — fall through to the Overview fallback
      // 2b. Fallback: api.glassdoor.com Overview HTML, using the typeahead
      // suggestion as slug (best-effort; the original name if no suggestion).
      const fallbackSlug = pick.suggestion || name;
      const fb = await glassdoorFetchOverviewFallback(pick.employerId, fallbackSlug, signal);
      if (fb) {
        const entry = { ok: true, rating: fb.rating, count: fb.count, countText: fb.countText, pageUrl: fb.pageUrl, employerId: fb.employerId, schemaVersion: GLASSDOOR_CACHE_SCHEMA_VERSION, fetchedAt: Date.now() };
        console.log('[Glassdoor] fallback hit "' + norm + '" ' + entry.rating + "\u2605 " + entry.countText + " " + entry.pageUrl);
        await glassdoorCacheSet(norm, entry);
        glassdoorBroadcast(tabId, { name: name, ok: true, rating: entry.rating, count: entry.count, countText: entry.countText, pageUrl: entry.pageUrl, employerId: entry.employerId });
        return;
      }
      // 2c. All paths failed (BFF 403/429/parse, fallback HTTP/parse miss).
      const reason = "fetch_error";
      console.warn('[Glassdoor] all paths failed for "' + norm + '"');
      await glassdoorCacheMiss(norm, reason);
      glassdoorBroadcast(tabId, { name: name, ok: false });
    } catch (err) {
      if (err && (err.name === "AbortError" || controller.signal.aborted)) {
        return; // Background unloaded mid-fetch — abandon silently.
      }
      console.error('[Glassdoor] fetch failed for "' + norm + '":', err);
      await glassdoorCacheMiss(norm, "fetch_error");
      glassdoorBroadcast(tabId, { name: name, ok: false });
    } finally {
      if (glassdoorController === controller) glassdoorController = null;
    }
  }

  // getRatings entry point: fresh cache hits return synchronously; misses are
  // queued and delivered later via site-settings:glassdoor:updated.
  async function glassdoorGetRatings(names, sender) {
    console.log("[Glassdoor] glassdoorGetRatings entered", { nameCount: (names || []).length });
    const tabId =
      sender && sender.tab && typeof sender.tab.id === "number"
        ? sender.tab.id
        : null;
    const cache = await glassdoorCacheGet();
    console.log("[Glassdoor] cache state", { cacheSize: Object.keys(cache).length });
    const ratings = {};
    const list = Array.isArray(names) ? names : [];
    for (const name of list) {
      const raw = String(name || "").trim();
      if (!raw) continue;
      const norm = normalizeCompanyName(raw);
      if (!norm) continue;
      const hit = cache[norm];
      if (hit && glassdoorFresh(hit)) {
        ratings[raw] = hit.ok
          ? {
              ok: true,
              rating: hit.rating,
              count: hit.count,
              countText: hit.countText,
              pageUrl: hit.pageUrl,
              employerId: hit.employerId
            }
          : { ok: false };
      } else {
        glassdoorEnqueue(raw, tabId);
      }
    }
    return { ratings: ratings };
  }

  // ------------------------------------------------------------------
  // People-search company fetcher
  // ------------------------------------------------------------------
  // Each visible /search/results/people/ card with no cached company
  // sends a getCompany request; the background fetches that person's
  // /in/<vanity>/ profile, parses the current company from the top card
  // (the SSR-stable signal — the Experience section is lazy-loaded and
  // absent from the fetch body), and broadcasts the result to the
  // originating tab.
  // The cache is local (storage.local) keyed by vanity; success TTL is
  // 7 days (people change jobs rarely), failure TTL is 1 hour (a parse
  // miss on a real profile should retry quickly). Serial ≥2s gap, same
  // throttle shape as the Glassdoor pipeline.

  const PEOPLE_CACHE_KEY = "jtk-site-settings-people";
  // Bump when the fetcher pipeline or the parser changes in a way that
  // makes old entries misleading. v1 = initial release.
  const PEOPLE_CACHE_SCHEMA_VERSION = 1;
  const PEOPLE_SUCCESS_TTL = 7 * 24 * 60 * 60 * 1000;
  const PEOPLE_FAILURE_TTL = 60 * 60 * 1000;
  const PEOPLE_FETCH_GAP_MS = 2000;
  const LINKEDIN_UA =
    "Mozilla/5.0 (X11; Linux x86_64; rv:136.0) Gecko/20100101 Firefox/136.0";

  let showPeopleSearchCompany = false;
  let peopleController = null;
  let peopleLastFetchStart = 0;
  let peopleTimer = null;
  const peopleQueue = [];
  const peoplePending = new Set(); // normalized vanities queued or in flight
  let peopleActive = false;

  function peopleVanity(v) {
    return String(v || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .trim();
  }

  function peopleErr(err) {
    return err && err.message ? err.message : String(err);
  }

  // --- profile HTML parser -------------------------------------------

  // The last company source produced by parseCompanyFromProfileHtml: the
  // tier that matched ("logo_p", "logo_span" — tier 0 Pass A, the
  // company-logo <figure>-container structural key; "company_span" —
  // tier 0 Pass B, the plain <span> walk; "_08b5ea62", "sep_p",
  // "company_adjacent_p", "company_link", "company_link2", "og_title",
  // "page_title") or the "name_check_skipped_tier4" marker when the title
  // fallback was rejected because it just echoed the person's name.
  // peopleFetchOne reads it to log which
  // tier matched; the parser touches it only when running inside the real
  // background script (guarded with typeof so the jtk-test harness, which
  // extracts the function body and runs it standalone, still works).
  let lastCompanyParseSource = null;

  // The profile's top card (name, headline, company, location) is the only
  // part of the page that is reliably present in the background's fetch()
  // body: LinkedIn server-renders the top card but lazy-loads the
  // Experience section client-side after hydration, so the Experience
  // markup (which an earlier parser targeted via
  // id="...ExperienceTopLevelSection") is absent from the SSR shell the
  // fetch() sees. The company <p> in the top card is the element whose
  // class list carries the "_08b5ea62" token — verified on the user's
  // saved logged-in profile (/tmp/opencode/rh_linkedIn.html) and in the
  // guest SSR. The token is unique to the company line: the other top-card
  // <p>s (pronouns, title, location) never carry it, and inside the top
  // card it appears only on that <p>. The top-card company <p> holds just
  // the bare company name — no "· Full-time" employment-type suffix (that
  // suffix exists only in the lazy Experience section).
  //
  // The top card is SSR-stable: it is present for every profile size and
  // for both logged-in and guest fetches, so this is the reliable primary
  // source. This is the first thing to revisit when LinkedIn reworks
  // profile markup (the "_08b5ea62" token and the cards' selector lists
  // in content.js follow the same rule).
  //
  // Fallback chain (2026-08-08): connection-filtered people-search pages
  // fetch OTHER users' profiles in a shape that does not carry the
  // "_08b5ea62" token — the token works on the signed-in viewer's own
  // profile but not on other profiles' logged-in views. When the primary
  // <p> is absent the parser tries, in order:
  //   Tier 0 — the positive company-line signal, in two passes:
  //     Pass A — the figure-container structural key: on hydrated
  //              profiles the company's <p><span> lives in a <div> that
  //              also carries the company LOGO as a <figure> descendant
  //              (<div><figure><svg><img ...company-logo_100_100...>
  //              </figure> ... <p><span>Company</span></p> ...</div>).
  //              Every <div> in the <main> content region (or the whole
  //              body when there is no <main> — the global nav header,
  //              the own-profile edit bar, and the right rail all sit
  //              outside <main> and never hold this person's company)
  //              whose <figure> carries the company-logo URL
  //              ("company-logo_100_100" in the <img> src — the
  //              person-accent silhouette and school logos do not) or
  //              the "company-accent" <svg> fallback is a candidate
  //              container; its <p>/<span> descendants are walked in
  //              document order and the FIRST text that passes every
  //              company check is returned
  //              ("logo_p" when the match is a <p> wrapping a <span>,
  //              "logo_span" when it is a direct <span> not wrapped in
  //              a <p>; a bare <p> with no <span> child is skipped —
  //              LinkedIn's Experience-entry job-title lines are exactly
  //              that shape). The company-logo <figure> is the
  //              discriminating feature: most other profile-body <p>s
  //              (education, projects, footer, sidebar) have no <figure>
  //              sibling, and person/school figures carry no
  //              company-logo URL.
  //     Pass B — the plain <span> walk (the original tier 0): every
  //              <span> element in document order, the same check set.
  //              Catches the company line on profiles where the logo is
  //              absent (older markup).
  //            The check set (both passes): 2-60 chars, Title Case, no
  //            "·"/"•"/"|" separator, not a role word, not the person's
  //            name/title/location, not a footer/utility link, not an
  //            action label, and not another person's name. LinkedIn
  //            renders the company as <p><span>Company</span></p> in the
  //            Experience section — the one place other sections
  //            (education, projects, activity, footer, sidebars) don't
  //            reuse this exact shape — and the company <p> always
  //            PRECEDES the education <p> in document order, so the
  //            first qualifying text is the employer, not the school
  //            (the David Phu bug was exactly this: "Worcester
  //            Polytechnic Institute" was returned instead of "Raytheon
  //            Technologies"). This replaced the old naked-<p> tier,
  //            which had no shape to latch onto and kept letting
  //            education/activity <p>s slip through.
  //   Tier 1 — the "_08b5ea62" top-card <p> (the SSR-stable company line).
  //   Tier 2 — the first <p> with a "Name · something" shape: LinkedIn
  //            joins the company to a second element with "·" (also "•"
  //            or "|") — an employment type ("Acme · Full-time"), a
  //            school ("Yelp · William Paterson University of New
  //            Jersey"), a degree ("Acme · MBA"), or a location. The
  //            company is always the FIRST segment, so take the prefix
  //            before the first separator, sanity-checked (length, not
  //            the person's own name, not the page title's first
  //            segment). This is the strongest signal the "other
  //            profile" shape carries.
  //   Tier 3 — the /company/ logo anchor's adjacent <p>: a company line
  //            that carries neither "_08b5ea62" nor a "·" separator is
  //            still identifiable by its position — it sits IMMEDIATELY
  //            next to the figure-wrapped <a href="/company/.../"> logo
  //            link (the saved Sujatha Mizar profile's top card is
  //            exactly that shape: a <div> holding the logo anchor,
  //            directly followed by a bare <p>Ab Initio Software</p>).
  //            Walk every /company/ anchor, look at its parent's
  //            next-sibling (and its own next-sibling) for a <p>, and
  //            take the first one whose text is non-empty and 1-80
  //            chars, sanity-checked against the person's name.
  //   Tier 4 — a /company/ anchor with non-empty text (first, then the
  //            second — the first is sometimes a logo-only link).
  //   (Tier 5 — the naked company <p> — was REMOVED on 2026-08-08. A bare
  //   <p> with no <span> has no positive signal to latch onto: education,
  //   activity, project, and footer <p>s are all shaped identically, so
  //   the tier kept handing back "Worcester Polytechnic Institute" as the
  //   company. Tier 0's positive <span> signal is the real last resort:
  //   the company's <p> carries a <span> child, the other sections'
  //   don't, and the company always precedes them in document order.)
  //   Tier 6 — the og:title meta tag, then the page <title> (last resort).
  //            On a logged-in view of another user's profile these are
  //            just "Name | LinkedIn" — no company — so a title-derived
  //            value is trusted ONLY when it survives the name check: a
  //            candidate that equals the person's name (the `name` the
  //            content side sends with the getCompany request, or the
  //            page title's own first segment) is rejected.
  // A candidate that equals the person's name is rejected at every tier:
  // rendering the name as the "company" is actively misleading. The same
  // rule applies to the person's JOB TITLE (the `title` the content side
  // reads from the people-search card and sends with the getCompany
  // request): a candidate that equals the title — or is a prefix/suffix
  // of it — is a title, not a company, and is rejected so the next tier
  // is tried. The same rule applies to the person's LOCATION (the
  // `location` the content side reads from the card's text column — the
  // <p> right after the title — and sends with the getCompany request):
  // a candidate that equals the location, is a prefix/suffix of it, or
  // contains it, is a location, not a company, and is rejected.
  // Returns the company string, or null when no signal matches.
  function parseCompanyFromProfileHtml(html, name, title, location) {
    if (typeof html !== "string" || !html) return null;

    // Source tracking for peopleFetchOne's tier log. This module-scoped
    // variable only exists in the real background script; the jtk-test
    // harness extracts this function body and runs it standalone, so guard
    // every touch with typeof.
    const trackSource = typeof lastCompanyParseSource !== "undefined";
    if (trackSource) lastCompanyParseSource = null;

    // Sections whose content must never be treated as this person's own
    // company signal. Two kinds of sections are excluded:
    //   1. Recommendation/upsell sidebars — "Explore Premium profiles",
    //      "People you may know", "More profiles for you", "You might
    //      like", ... — that render OTHER people's names, titles, and
    //      companies as bare Title-Case <p>s and /company/ links (the
    //      same sidebar sections the fix-29 iframe path scopes out via
    //      findPeopleExperienceSection in content.js). Every tier walk
    //      must skip those <p>/<a> matches, or the company_span tier
    //      happily hands back a related profile's name ("Hannan S.") as
    //      the company.
    //   2. Non-company profile-body sections — Education, Projects,
    //      Skills, Licenses & certifications, ... — whose heading starts
    //      with a NON_COMPANY_HEADING_PREFIX. A school ("Worcester
    //      Polytechnic Institute") or project name ("Open Source Tool")
    //      is a legit Title-Case 2-60 char phrase free of separators and
    //      role words, so tier 5's shape checks alone cannot reject it —
    //      the David Phu bug was exactly this shape (the parser returned
    //      his school instead of his employer). Only the Experience
    //      section holds this person's current company, and "Experience"
    //      is deliberately NOT a prefix here: that section must keep
    //      matching.
    // Returns an array of [start, end) offset ranges, one per matched
    // <section>.
    function findExcludedSections(html) {
      const SIDEBAR_RE =
        /Explore Premium|People also viewed|People you may know|More profiles|Similar|Recommended|Promoted|You might like/i;
      // Lowercased prefixes of LinkedIn profile-body section headings
      // that are clearly NOT the current-employer Experience section.
      const NON_COMPANY_HEADING_PREFIXES = [
        "education", "licenses & certifications", "projects",
        "volunteer experience", "skills", "languages",
        "recommendations", "honors & awards", "publications",
        "test scores", "courses", "causes i care about", "patents",
        "featured", "interests", "groups", "activity",
      ];
      const ranges = [];
      const openRe = /<section\b[^>]*>/g;
      let om;
      while ((om = openRe.exec(html)) !== null) {
        // Find the matching </section>, tolerating nested <section>s (the
        // main column nests sections inside the top-card section).
        let depth = 1;
        const pairRe = /<\/section>|<section\b[^>]*>/g;
        pairRe.lastIndex = om.index + om[0].length;
        let pm;
        let closeEnd = -1;
        while ((pm = pairRe.exec(html)) !== null) {
          if (pm[0].indexOf("</section>") === 0) {
            depth--;
            if (depth === 0) {
              closeEnd = pm.index + pm[0].length;
              break;
            }
          } else {
            depth++;
          }
        }
        if (closeEnd === -1) continue; // unbalanced — skip defensively
        const inner = html.slice(om.index, closeEnd);
        if (SIDEBAR_RE.test(inner) || isNonCompanySection(inner)) {
          ranges.push([om.index, closeEnd]);
        }
      }
      return ranges;

      // True when a <section>'s leading heading starts with a
      // non-company heading prefix. The heading is the first h1-h6
      // element inside the section; a section with no heading element
      // falls back to its leading visible text. Prefix match (not
      // substring anywhere) so "Experience and Education" — a section
      // that holds experience — is never misread as Education.
      function isNonCompanySection(inner) {
        const headingMatch = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(inner);
        const headingText = (
          headingMatch ? cleanText(headingMatch[1]) : cleanText(inner)
        ).toLowerCase();
        return NON_COMPANY_HEADING_PREFIXES.some(
          (p) => headingText.indexOf(p) === 0
        );
      }
    }

    // The LinkedIn page footer (present on EVERY page) must never be
    // treated as this person's company. The footer is a single-line row
    // of utility links — "About", "Accessibility", "Help Center",
    // "Privacy & Terms", ... — rendered as bare Title-Case <p>s. It is
    // NOT a <section> (so findExcludedSections above cannot catch it)
    // and it carries no "/company/" anchor, so without this exclusion
    // the company_span tier walks straight past it and hands
    // "Accessibility" back as the company on profiles whose every other
    // signal was rejected. Returns an array of [start, end) offset
    // ranges: every <footer>...</footer> element (wherever it sits in
    // the document, tolerating nested <footer>s), plus the
    // bottom-of-page strip from the last main-content close tag
    // (</main>, or the last </section> when there is no </main>) to
    // </body> — the area where LinkedIn's single-line footer and
    // utility nav live.
    function findExcludedFooter(html) {
      const ranges = [];
      const openRe = /<footer\b[^>]*>/g;
      let om;
      while ((om = openRe.exec(html)) !== null) {
        // Find the matching </footer>, tolerating nested <footer>s.
        let depth = 1;
        const pairRe = /<\/footer>|<footer\b[^>]*>/g;
        pairRe.lastIndex = om.index + om[0].length;
        let pm;
        let closeEnd = -1;
        while ((pm = pairRe.exec(html)) !== null) {
          if (pm[0].indexOf("</footer>") === 0) {
            depth--;
            if (depth === 0) {
              closeEnd = pm.index + pm[0].length;
              break;
            }
          } else {
            depth++;
          }
        }
        if (closeEnd === -1) continue; // unbalanced — skip defensively
        ranges.push([om.index, closeEnd]);
      }
      // Bottom-of-page strip: from the last main-content close tag to
      // </body>. Covers footers that are not wrapped in <footer> plus
      // the utility nav that renders below the main column.
      const bodyTag = /<\/body\b[^>]*>/i.exec(html);
      if (bodyTag) {
        const bodyStart = bodyTag.index;
        let boundary = -1;
        const mainClose = /<\/main\b[^>]*>/gi;
        let mm;
        while ((mm = mainClose.exec(html)) !== null) {
          if (mm.index < bodyStart) boundary = mm.index;
        }
        if (boundary === -1) {
          const sectionClose = /<\/section\b[^>]*>/gi;
          let sm;
          while ((sm = sectionClose.exec(html)) !== null) {
            if (sm.index < bodyStart) boundary = sm.index;
          }
        }
        if (boundary !== -1 && boundary < bodyStart) {
          ranges.push([boundary, bodyStart]);
        }
      }
      return ranges;
    }

    const excludedSections = findExcludedSections(html);
    const excludedFooterRanges = findExcludedFooter(html);

    // True when an offset falls inside an excluded sidebar section or
    // the excluded footer / bottom-of-page strip.
    function inExcluded(offset) {
      for (let i = 0; i < excludedSections.length; i++) {
        if (offset >= excludedSections[i][0] && offset < excludedSections[i][1]) {
          return true;
        }
      }
      for (let i = 0; i < excludedFooterRanges.length; i++) {
        if (offset >= excludedFooterRanges[i][0] && offset < excludedFooterRanges[i][1]) {
          return true;
        }
      }
      return false;
    }

    // Shared cleanup: strip nested tags, decode the handful of entities
    // LinkedIn emits, collapse whitespace.
    function cleanText(raw) {
      return String(raw)
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&nbsp;/g, " ")
        .replace(/&#x2022;/g, "\u2022")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
    }

    // "Name - Company | LinkedIn" -> "Company": strip the trailing
    // " | LinkedIn", take the last " - " segment.
    function companyFromTitleLike(text) {
      const cleaned = cleanText(text).replace(/\s*\|\s*LinkedIn\s*$/i, "");
      const parts = cleaned.split(/\s+-\s+/);
      const last = parts[parts.length - 1].trim();
      if (!last || last.length > 200) return null;
      return last;
    }

    // "Acme · Full-time" -> "Acme": drop the employment-type suffix that
    // the Experience section appends to company anchors.
    function stripEmploymentSuffix(text) {
      return text
        .replace(/\s*(?:[\u2022·]\s*)?(?:Full[- ]time|Part[- ]time|Contract|Freelance|Internship)\s*$/i, "")
        .trim();
    }

    // Lowercase + strip non-alphanumerics, for the name-equality check
    // ("Sujatha Mizar" and "sujatha-mizar" both normalize to "sujathamizar").
    function normForCompare(s) {
      return String(s || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "")
        .trim();
    }

    // True when a parsed candidate is just the person's own name. The
    // content side sends `name` in the site-settings:people:getCompany
    // message; a "company" that equals it is a false signal and must be
    // rejected (the wrapper is removed instead of showing the name).
    function isPersonName(candidate) {
      if (!name || !candidate) return false;
      const n = normForCompare(name);
      const c = normForCompare(candidate);
      return !!n && n === c;
    }

    // Common given names and surnames (lowercased) used to recognize a
    // person-name-shaped candidate in tier 5 when it is NOT the
    // page-owner's own name (isPersonName only catches the page owner).
    // The recommendation sidebars render OTHER people's names as bare
    // Title-Case <p>s ("Hannan S.", "Mary K.", "John Smith", "Pat
    // O'Brien") — identical in shape to a naked company line, so tier 5
    // must reject them on shape+content alone. A short (1-3 word)
    // Title-Case phrase whose words are ALL common given names/surnames
    // is a person, not a company ("John Smith", "Pat O'Brien"); a phrase
    // with any non-name word ("Acme Corp", "Cambridge Mobile Telematics")
    // is a company and survives.
    const PERSON_NAME_WORDS = new Set([
      // given names
      "james","john","robert","michael","william","david","richard","charles","joseph","thomas",
      "christopher","daniel","matthew","anthony","mark","donald","steven","paul","andrew","joshua",
      "kenneth","kevin","brian","george","edward","ronald","timothy","jason","jeffrey","ryan",
      "jacob","gary","nicholas","eric","jonathan","stephen","larry","justin","scott","brandon",
      "benjamin","samuel","gregory","alexander","frank","patrick","raymond","jack","dennis","jerry",
      "tyler","aaron","adam","nathan","henry","douglas","zachary","peter","kyle","mary",
      "patricia","jennifer","linda","elizabeth","barbara","susan","jessica","sarah","karen","lisa",
      "nancy","betty","margaret","sandra","ashley","kimberly","emily","donna","michelle","carol",
      "amanda","dorothy","melissa","deborah","stephanie","rebecca","sharon","laura","cynthia",
      "kathleen","amy","angela","shirley","anna","brenda","pamela","emma","nicole","helen",
      "samantha","katherine","christine","debra","rachel","carolyn","janet","catherine","maria","heather",
      "hannah","megan","julia","olivia","ava","sophia","mia","chloe","lily","grace",
      "hannan","hannah","mathieu","evan","ricky","ankit","coleman","anne","jim","jay",
      "pat","bob","tom","sam","mike","dave","dan","joe","bill","ben","tim","ron",
      "don","ted","jeff","chris","alex","andy","matt","nick","tony","phil","jane","sue",
      "kate","beth","carrie","ann","jo","gina","lena","nina","carl","ted","marty",
      // surnames
      "smith","johnson","williams","brown","jones","garcia","miller","davis","rodriguez","martinez",
      "hernandez","lopez","gonzalez","wilson","anderson","thomas","taylor","moore","jackson","martin",
      "lee","perez","thompson","white","harris","sanchez","clark","ramirez","lewis","robinson",
      "walker","young","allen","king","wright","scott","torres","nguyen","hill","flores",
      "green","adams","nelson","baker","hall","rivera","campbell","mitchell","carter","roberts",
      "gomez","phillips","evans","turner","diaz","parker","cruz","edwards","collins","reyes",
      "stewart","morris","morales","murphy","cook","rogers","gutierrez","ortiz","morgan","cooper",
      "peterson","bailey","reed","kelly","howard","ramos","kim","cox","ward","richardson",
      "watson","brooks","chavez","wood","james","bennett","gray","mendoza","ruiz","hughes",
      "price","alvarez","castillo","sanders","patel","myers","long","ross","foster","jimenez",
      "o'brien","o'connor","o'neil","o'neill","gilleland","riverin","cramer","chowdhury","kelleghan","mead",
    ]);

    // True when a candidate is shaped like ANOTHER person's name even
    // though it is not the page-owner's own name. Two signatures:
    //   - a trailing single-letter initial ("Hannan S.", "Mary K.",
    //     "John Q.") — the period+single-letter is a name signature, not
    //     a company ("Acme Corp." and "Inc." end in multi-letter
    //     suffixes, so a bare "S." / "K." is unambiguous);
    //   - a short 1-3 word Title-Case phrase whose words are ALL common
    //     given names or surnames ("John Smith", "Pat O'Brien").
    function isOtherPersonName(text) {
      if (!text) return false;
      const t = String(text).trim();
      if (/\s[A-Z]\.$/.test(t)) return true;
      const words = t.split(/\s+/);
      if (words.length < 1 || words.length > 3) return false;
      if (!words.every((w) => /^[A-Z][a-z'-]+$/.test(w))) return false;
      return words.every((w) => PERSON_NAME_WORDS.has(w.toLowerCase()));
    }

    // Common role/job words that can never be a company. LinkedIn puts
    // these as the FIRST segment of a tier-2 separator <p> when the
    // profile's top card renders "Role · Company" (headline "Engineer |
    // AI Workflows | ..." on the gregformichelli profile is exactly this
    // shape — tier 2 was taking "Engineer" as the company). A candidate
    // that is exactly one of these (case-insensitive) is a job title,
    // not a company, and must be rejected so the next tier / next <p> is
    // tried. Matching is exact-word (a Set, O(1)); a candidate that only
    // CONTAINS one of these words ("Engineering Manager", which could be
    // a real company name) is not rejected by the Set alone.
    const ROLE_WORDS = new Set([
      "engineer", "engineers", "manager", "director", "designer",
      "analyst", "architect", "lead", "senior", "junior", "principal",
      "staff", "recruiter", "consultant", "specialist", "developer",
      "founder", "ceo", "cto", "cfo", "coo", "vp", "president",
      "engineering", "marketer", "writer", "editor", "scientist",
      "researcher", "advisor", "coordinator", "operator", "producer",
      "executive", "co-founder", "cofounder", "owner", "partner",
    ]);

    // True when a candidate is a role/job-title string rather than a
    // company. A multi-word phrase whose FIRST word is a role word
    // ("Senior Director", "Engineering Manager") is also a role — those
    // render as "Role phrase · Company" in the tier-2 shape, so the
    // phrase must be rejected and the suffix taken instead.
    function isRoleWord(candidate) {
      const t = String(candidate || "").trim().toLowerCase().replace(/\s+/g, " ");
      if (!t) return false;
      if (ROLE_WORDS.has(t)) return true;
      const firstWord = t.split(" ")[0];
      return ROLE_WORDS.has(firstWord);
    }

    // True when a candidate equals the person's JOB TITLE (the `title`
    // the content side reads from the people-search card and sends with
    // the getCompany request). The company line must never be the same as
    // the title: a fallback tier that happens to match the title (e.g.
    // the role-word blacklist misses something, or a future tier matches
    // the headline) is a false signal and is rejected so the next tier is
    // tried. Empty titles disable the check entirely. Both sides are
    // normalized the same way (lowercase, non-alphanumerics -> space,
    // trimmed) so "Senior Software Engineer" and "senior-software
    // engineer" compare equal. A candidate that is a PREFIX or SUFFIX of
    // the title ("Senior Software" of "Senior Software Engineer",
    // "Engineer" of "Senior Software Engineer") is also the title, not a
    // company, and is rejected.
    function isJobTitle(candidate) {
      if (!title || !candidate) return false;
      const norm = (s) =>
        String(s)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim();
      const c = norm(candidate);
      const t = norm(title);
      if (!c || !t) return false;
      if (c === t) return true;
      if (t.indexOf(c) === 0) return true;
      if (t.indexOf(c) === t.length - c.length) return true;
      return false;
    }

    // True when a candidate matches the person's LOCATION (the `location`
    // the content side reads from the people-search card — the <p> right
    // after the title — and sends with the getCompany request). A candidate
    // whose word tokens substantially overlap the location's word tokens is
    // a location, not a company, and must be rejected so the next tier is
    // tried. Empty locations disable the check entirely (backward
    // compatible with callers that do not send one). Both sides are
    // normalized the same way (lowercase, non-alphanumerics -> space,
    // trimmed, split into word tokens) so "Greater Boston" and
    // "greater-boston" compare equal.
    //
    // Matching is by token overlap rather than raw string containment so
    // that a state-abbreviated form matches its spelled-out form: "Acton,
    // MA" and "Acton, Massachusetts" share the token "acton" plus (via
    // abbreviation expansion) "ma" -> "massachusetts". A candidate with 1-2
    // tokens must match every token (100%); a longer candidate needs >= 50%.
    function isLocation(candidate, loc) {
      if (!loc || !candidate) return false;
      const tokens = (s) =>
        String(s)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim()
          .split(" ")
          .filter((t) => t.length > 0);
      const c = tokens(candidate);
      const l = tokens(loc);
      if (c.length === 0 || l.length === 0) return false;
      // Single-token prefix: "Acton" vs "Acton, Massachusetts" — the
      // candidate's one token is the location's first token.
      if (c.length === 1 && l[0] === c[0]) return true;
      const locSet = new Set(l);
      // A token overlaps when it literally appears in the location, or when
      // a short (2-3 letter) token is the abbreviation prefix of a location
      // token ("ma" -> "massachusetts"), or when the location holds the
      // short abbreviation and the candidate token is its long form
      // ("massachusetts" vs a location token "ma").
      const overlaps = (t) => {
        if (locSet.has(t)) return true;
        if (t.length >= 2 && t.length <= 3) {
          return l.some((lt) => lt.length > t.length && lt.indexOf(t) === 0);
        }
        if (t.length > 3) {
          return l.some((lt) => lt.length >= 2 && lt.length <= 3 && t.indexOf(lt) === 0);
        }
        return false;
      };
      const matched = c.filter(overlaps).length;
      // 1-2 token candidates must match every token; 3+ token candidates
      // need >= 50%.
      const needed = c.length <= 2 ? c.length : Math.ceil(c.length / 2);
      return matched >= needed;
    }

    // The name as the page itself renders it: the first " - " segment of
    // the page <title> (e.g. "Sujatha Mizar" from "Sujatha Mizar |
    // LinkedIn"). Used to distrust title-derived candidates that merely
    // echo the person's name back, independent of the content-side name.
    function pageTitleName() {
      const tag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
      if (!tag) return "";
      const cleaned = cleanText(tag[1]).replace(/\s*\|\s*LinkedIn\s*$/i, "");
      return cleaned.split(/\s+-\s+/)[0].trim();
    }

    // Tier-5 gate: a title-derived candidate is untrustworthy when it
    // equals the person's name (from the content side) or the page
    // title's first segment (the name as LinkedIn renders it).
    function isTitleName(candidate) {
      if (!candidate) return false;
      if (isPersonName(candidate)) return true;
      const tn = normForCompare(pageTitleName());
      return !!tn && tn === normForCompare(candidate);
    }

    // --- Tier 0: the company line's positive signals --------------------
    // LinkedIn renders the company name as <p><span>Company</span></p> in
    // the Experience section — the one place the other sections (education,
    // projects, activity, footer, sidebars) don't reuse this exact shape.
    // The company <p> ALWAYS precedes the education <p> in document order,
    // so the FIRST qualifying text IS the employer, not the school (the
    // David Phu bug: "Worcester Polytechnic Institute" was being returned
    // instead of "Raytheon Technologies"). This tier runs TWO passes:
    //   Pass A — the figure-container structural key: on hydrated
    //            profiles the company's <p><span> lives in a <div> that
    //            also carries the company LOGO as a <figure> descendant
    //            (<div><figure><svg><img ...company-logo_100_100...>
    //            </figure> ... <p><span>Company</span></p> ...</div>).
    //            Every <div> in the <main> content region (or the whole
    //            body when there is no <main>) whose <figure> carries the
    //            company-logo URL ("company-logo_100_100" in the <img>
    //            src — the person-accent silhouette and school logos do
    //            not) or the "company-accent" <svg> fallback is a
    //            candidate container; its <p>/<span> descendants are
    //            walked in document order and the FIRST text that passes
    //            every company check is returned ("logo_p" when the match
    //            is a <p> wrapping a <span>, "logo_span" when it is a
    //            direct <span> not wrapped in a <p>). A bare <p> with no
    //            <span> child is skipped — LinkedIn's Experience-entry
    //            job-title lines ("Software Engineer") are exactly that
    //            shape. The company-logo <figure> is the discriminating
    //            feature: most other profile-body <p>s (education,
    //            projects, footer, sidebar) have no <figure> sibling, and
    //            person/school figures carry no company-logo URL.
    //   Pass B — the plain <span> walk (the original tier 0): every
    //            <span> in document order, the same check set. Catches
    //            the company line on profiles where the logo is absent
    //            (older markup).
    // Both passes apply the full check set (length, Title Case, no
    // separator, not a role word, not the person's name/title/location,
    // not another person's name, not a footer/utility link, not an
    // action/UI label, not a pronouns line). Both walks are restricted to
    // the <main> content region when the body has one: the global nav
    // header ("Home", "My Network", ...), the own-profile edit bar
    // ("Resources", "Add section", ...), and the right rail all sit
    // OUTSIDE <main> and would otherwise be the first Title-Case spans in
    // the document. A body with no <main> (the synthetic top-card shell,
    // the old experience-section slice) falls back to walking everything.
    const ACTION_LABELS = new Set([
      "connect", "message", "follow", "pending", "following", "more",
      "see all", "see more", "save", "cancel", "reply", "send", "share",
      "like", "contact", "contact info", "settings", "about", "private",
      "learn more", "help", "help center", "report", "block", "done",
      "close", "add", "edit", "unfollow", "questions?",
    ]);
    const LOCATION_WORDS = new Set([
      "greater boston", "san francisco bay area", "greater new york city area",
      "greater seattle area", "greater chicago area", "greater los angeles area",
      "new york city", "san francisco", "los angeles", "chicago", "boston",
      "seattle", "austin", "denver", "atlanta", "dallas", "philadelphia",
      "washington d.c.", "san diego", "phoenix", "portland", "miami",
      "toronto", "vancouver", "london", "berlin", "paris", "amsterdam",
      "singapore", "sydney", "remote",
    ]);
    // LinkedIn renders the profile's pronouns as a bare <p> ("He/Him") in
    // the top card; the "/" also fails the Title Case word check below,
    // but an explicit set keeps the intent clear and covers separator
    // shapes other than "/" if LinkedIn ever changes the markup.
    const PRONOUNS = new Set([
      "he/him", "she/her", "they/them", "he/they", "she/they",
      "ze/zir", "xe/xem", "any pronouns",
    ]);
    // LinkedIn's single-line page footer (present on EVERY page) is a
    // row of utility links — "About", "Accessibility", "Help Center",
    // "Privacy & Terms", ... — rendered as bare Title-Case <p>s that
    // are identical in shape to a naked company line. A candidate that
    // exactly matches one of these texts (case-insensitive) is footer
    // chrome, never a company, and is rejected at tier 0 BEFORE the
    // person-name check so a footer link can never shadow a real
    // company <span> — this is the belt to findExcludedFooter's suspenders
    // (it still catches the "Accessibility" <span> even when the body has
    // no <footer> element and no </main>/</section> boundary).
    const UTILITY_LINK_TEXTS = new Set([
      "about", "accessibility", "help center", "privacy & terms",
      "community guidelines", "talent solutions", "marketing solutions",
      "sales solutions", "safety center", "cookie policy",
      "privacy policy", "user agreement", "linkedin corporation",
      "\u00a9 2026", "\u00a9 2026 linkedin corporation",
      "open app", "language", "learning", "jobs", "salary",
      "employers", "companies", "directory", "profile",
      "terms & conditions", "send feedback", "report a problem",
      "ad choices", "linkedin learning", "sign in", "join now",
    ]);
    // The <main> content region (when present): elements outside it are
    // page chrome — the global nav header, the own-profile edit bar, the
    // right rail — never this person's company.
    const mainOpen = /<main\b[^>]*>/i.exec(html);
    const mainClose = /<\/main\b[^>]*>/i.exec(html);
    const spanLo = mainOpen ? mainOpen.index : 0;
    const spanHi = mainClose ? mainClose.index : html.length;

    // The shared company-text check, identical for both passes: a text is
    // a company candidate only when it survives every reject below.
    function companyTextQualifies(text) {
      if (!text) return false;
      // Footer utility links and copyright lines are page chrome, never a
      // company; reject FIRST (before the person-name check) so a footer
      // link can never shadow a real company text later in the body.
      if (
        UTILITY_LINK_TEXTS.has(text.toLowerCase()) ||
        /^(\u00a9|&copy;)\s*\d{4}/i.test(text)
      ) {
        return false;
      }
      if (text.length < 2 || text.length > 60) return false;
      // The tier-2 "Company · something" shape — leave it to tier 2.
      if (/[\u2022\u00b7|]/.test(text)) return false;
      // A role word ("Engineer", "Senior Director") is a job title, not
      // a company.
      if (isRoleWord(text)) return false;
      // The person's own name is never a company.
      if (isPersonName(text)) return false;
      // Another person's name ("Hannan S.", "Mary K.", "John Smith") is
      // never a company either — the sidebar's related profiles and the
      // activity feed's authors are exactly this shape.
      if (isOtherPersonName(text)) return false;
      // The text holds the person's job title (the content side sends it
      // with the getCompany request) — not a company.
      if (isJobTitle(text)) return false;
      // The text holds the person's location (the content side sends it
      // with the getCompany request) — not a company.
      if (isLocation(text, location)) return false;
      const lower = text.toLowerCase();
      if (ACTION_LABELS.has(lower)) return false;
      if (LOCATION_WORDS.has(lower)) return false;
      if (PRONOUNS.has(lower)) return false;
      // The top-card location line ("Somewhere, Earth", "New York, NY",
      // "London, England") — a Title Case "City, Region" phrase that no
      // company line uses.
      if (/^[A-Z][A-Za-z]+,\s+[A-Z][A-Za-z.]+$/.test(text)) return false;
      // Title Case: every word starts with an uppercase letter (or is
      // "&", as in "Barnes & Noble"). Rejects the lowercase footer
      // lines, upsell pills ("Try Premium for $0"), and connection
      // notes ("Pete is a mutual connection").
      const words = text.split(/\s+/);
      if (!words.every((w) => /^[A-Z][A-Za-z0-9'.,\-()]*$/.test(w) || w === "&")) return false;
      return true;
    }

    // --- Tier 0 Pass A: the figure-container structural key -------------
    // Find the end offset of a <div> open tag's matching </div>, tracking
    // nesting depth (divs nest; the closing-tag regex must count). Returns
    // -1 when the div is unbalanced (defensive skip).
    function divEndAt(openIndex) {
      let depth = 1;
      const pairRe = /<\/div\b[^>]*>|<div\b[^>]*>/g;
      pairRe.lastIndex = openIndex + 1;
      let m;
      while ((m = pairRe.exec(html)) !== null) {
        if (m[0].indexOf("</div>") === 0) {
          depth--;
          if (depth === 0) return m.index + m[0].length;
        } else {
          depth++;
        }
      }
      return -1;
    }

    const divRe = /<div\b[^>]*>/g;
    let dm;
    while ((dm = divRe.exec(html)) !== null) {
      if (dm.index < spanLo || dm.index >= spanHi) continue;
      // Skip excluded sections — a school / project / related-profile
      // name inside an Education/Projects/sidebar <section> is never the
      // company even when its container holds a <figure>.
      if (inExcluded(dm.index)) continue;
      const divEnd = divEndAt(dm.index);
      if (divEnd === -1) continue;
      const inner = html.slice(dm.index, divEnd);
      // The discriminating feature: a <figure> (logo) descendant whose
      // <img> carries the literal company-logo URL ("company-logo_100_100")
      // — the person-accent silhouette and school logos do not — or whose
      // <svg> is the "company-accent" fallback LinkedIn renders when the
      // logo image fails to load. Any other figure (a person icon, a
      // school logo, an empty client-side logo slot) is not this person's
      // company logo, so the whole <div> is skipped.
      const figRe = /<figure\b[^>]*>([\s\S]*?)<\/figure>/gi;
      let isCompanyFigure = false;
      let fm;
      while ((fm = figRe.exec(inner)) !== null) {
        if (
          /<img\b[^>]*\ssrc=["'][^"']*company-logo_100_100[^"']*["']/i.test(fm[1]) ||
          /<svg\b[^>]*\sid=["']company-accent/i.test(fm[1])
        ) {
          isCompanyFigure = true;
          break;
        }
      }
      if (!isCompanyFigure) continue;
      // Walk this div's <p>/<span> descendants in document order and take
      // the first text that passes every company check. A <p> match is the
      // company's <p><span>Company</span></p> wrapper (logo_p); a <span>
      // match that is not inside a <p> is a direct <span> (logo_span) —
      // the <p> branch consumes its nested <span>s, so a <span>-branch
      // match is never wrapped in a <p>. A BARE <p> with no <span> child
      // is skipped: LinkedIn's Experience-entry job-title lines
      // ("Software Engineer") are exactly that shape, and a bare <p> has
      // no positive signal to latch onto.
      const pSpanRe = /<p\b[^>]*>([\s\S]*?)<\/p>|<span\b[^>]*>([\s\S]*?)<\/span>/g;
      let pm;
      while ((pm = pSpanRe.exec(inner)) !== null) {
        const isP = pm[1] !== undefined;
        const raw = isP ? pm[1] : pm[2];
        if (isP && !/<span\b/i.test(raw)) continue;
        const abs = dm.index + pm.index;
        if (inExcluded(abs)) continue;
        const text = cleanText(raw);
        if (!companyTextQualifies(text)) continue;
        if (trackSource) {
          lastCompanyParseSource = isP ? "logo_p" : "logo_span";
        }
        return text;
      }
    }

    // --- Tier 0 Pass B: the plain <span> walk ---------------------------
    // Every <span> in document order, the same check set. Catches the
    // company line on profiles where the logo/figure is absent (older
    // markup).
    const spanRe = /<span\b[^>]*>([\s\S]*?)<\/span>/g;
    let sm;
    while ((sm = spanRe.exec(html)) !== null) {
      if (sm.index < spanLo || sm.index >= spanHi) continue;
      // Skip excluded sections — a school / project / related-profile name
      // inside an Education/Projects/sidebar <section> is never the
      // company even when it is <p><span> shaped.
      if (inExcluded(sm.index)) continue;
      const text = cleanText(sm[1]);
      if (!companyTextQualifies(text)) continue;
      if (trackSource) lastCompanyParseSource = "company_span";
      return text;
    }

    // --- Tier 1: the "_08b5ea62" <p> (top-card company line) ----------
    // Iterating each <p> open tag and substring-testing the attributes —
    // rather than demanding the token sit between word boundaries — means
    // a hyphen/dot-quilted class list (LinkedIn re-rolls these class
    // hashes per user/session) still matches, while a token inside a
    // <script> body or on some other element's tag never matches.
    const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
    let m;
    while ((m = pRe.exec(html)) !== null) {
      // Skip sidebar sections (Explore Premium profiles, People you may
      // know, ...) — they carry other people's <p>s, never this person's
      // company.
      if (inExcluded(m.index)) continue;
      if (m[1].indexOf("_08b5ea62") === -1) continue;

      // The company line has no nested markup in practice, but strip any
      // tags defensively (same cleanup the old experience-section parser
      // applied) and decode the handful of entities LinkedIn emits.
      const raw = cleanText(m[2]);
      if (!raw) return null;
      // Length cap mirrors companyText in the content side; the Glassdoor
      // pipeline uses the same sanity bound.
      if (raw.length > 200) return null;
      // A top-card line that holds a role word ("Engineer") is a job
      // title, not a company (markup drift) — keep hunting.
      if (isRoleWord(raw)) continue;
      // A top-card line that holds the person's own name is a false
      // signal (markup drift) — keep hunting through the lower tiers.
      if (isPersonName(raw)) continue;
      // A top-card line that holds the person's job title (the content
      // side sends it with the getCompany request) is a false signal too
      // — the company line must not be the title.
      if (isJobTitle(raw)) continue;
      // A top-card line that holds the person's location (the content
      // side sends it with the getCompany request) is a false signal too
      // — the company line must not be the location.
      if (isLocation(raw, location)) continue;
      if (trackSource) lastCompanyParseSource = "_08b5ea62";
      return raw;
    }

    // --- Tier 2: the first "Name · something" <p> ----------------------
    // LinkedIn joins the company to a second element with a separator
    // ("·", "•", or "|"): an employment type ("Acme · Full-time"), a
    // school ("Yelp · William Paterson University of New Jersey"), a
    // degree ("Acme · MBA"), or a location. The company is always the
    // FIRST segment, so take the prefix before the first separator on
    // the first <p> that has that shape — with the same sanity checks
    // as the other tiers: a sane length (1-80 chars), not the person's
    // own name (the content-side `name`), and not the page title's
    // first segment (the name as LinkedIn renders it — a candidate that
    // echoes it is a name, not a company).
    const sepPRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
    let sp;
    while ((sp = sepPRe.exec(html)) !== null) {
      // Skip sidebar sections — their "Name · Title" lines are other
      // people's, not this person's company signal.
      if (inExcluded(sp.index)) continue;
      const text = cleanText(sp[2]);
      const sepIdx = text.search(/[\u2022\u00b7|]/);
      if (sepIdx === -1) continue;
      let company = text.slice(0, sepIdx).trim();
      // Role blacklist: LinkedIn top cards can render "Role · Company"
      // ("Engineer · Cambridge Mobile Telematics") — the company is then
      // the SECOND segment, and the role prefix must not be taken as the
      // company. When the prefix is a role word, take the suffix instead
      // — but only when it is a single clean token. A suffix that still
      // contains a separator is more title text, not a company (the
      // "Engineer | AI Workflows | React Perf Op | ..." headline on the
      // gregformichelli profile is exactly that shape), so such a <p> is
      // skipped entirely and the next one is tried.
      if (isRoleWord(company)) {
        const suffix = text.slice(sepIdx + 1).trim();
        if (!suffix || /[\u2022\u00b7|]/.test(suffix)) continue;
        company = suffix;
      }
      if (!company || company.length > 80) continue;
      if (isPersonName(company)) continue;
      const titleName = normForCompare(pageTitleName());
      if (titleName && titleName === normForCompare(company)) continue;
      // The candidate is the person's job title (or a prefix/suffix of
      // it) — the title, not a company; keep hunting through the tiers.
      if (isJobTitle(company)) continue;
      // The candidate is the person's location (or matches it) — a
      // location, not a company; keep hunting through the tiers.
      if (isLocation(company, location)) continue;
      // Diagnostic: log what the company was paired with (employment
      // type, school, location, ...) so a wrong match is easy to debug.
      const prefix = text.slice(0, sepIdx).replace(/\s+/g, " ").trim();
      const suffix = text.slice(sepIdx + 1).replace(/\s+/g, " ").trim();
      console.log(
        "[People] tier 2 sep_p matched with context: " +
          (company === suffix ? prefix : suffix).slice(0, 60)
      );
      if (trackSource) lastCompanyParseSource = "sep_p";
      return company;
    }

    // --- Tier 3: /company/ logo anchor -> adjacent company <p> ---------
    // A profile top card can carry the company as a bare <p> (no
    // "_08b5ea62" token, no "·" separator) that sits IMMEDIATELY next to
    // the company's logo anchor — the <a href="/company/.../"> wrapping
    // the <figure> logo. Walk every /company/ anchor and look at the <p>
    // right after it (its own next sibling, or the next sibling of its
    // wrapper <div>). Take the first such <p> whose text is non-empty
    // and 1-80 chars, and that is not the person's own name. Only logo
    // anchors (empty anchor text) participate: an anchor that already
    // names the company is tier 4's job, and its trailing <p> may be a
    // date range or employment-type suffix, not the company. The
    // connection-degree pills ("· 1st", "· 2nd") that share the top card
    // start with the separator tier 2 keys on and are skipped so they
    // can't masquerade as a company.
    const adjPRe = /<a\b[^>]*\bhref=["'][^"']*\/company\/[^"']*["'][^>]*>([\s\S]*?)<\/a>(?:\s*<\/[a-z][^>]*>){0,3}\s*<p\b[^>]*>([\s\S]*?)<\/p>/gi;
    let ap;
    while ((ap = adjPRe.exec(html)) !== null) {
      // Skip sidebar sections — a related profile's logo + company <p>
      // (e.g. "Skytap" beside another person's name) is not this
      // person's company.
      if (inExcluded(ap.index)) continue;
      // Skip anchors that carry their own text — those are handled by
      // the /company/ text-anchor tier below.
      if (cleanText(ap[1])) continue;
      const text = cleanText(ap[2]);
      if (!text || text.length > 80) continue;
      // Connection-degree pills start with "·"/"•"/"|"; never a company.
      if (/^[\u2022\u00b7|]/.test(text)) continue;
      // A role word ("Engineer") is a job title, not a company.
      if (isRoleWord(text)) continue;
      if (isPersonName(text)) continue;
      // The <p> holds the person's job title — not a company.
      if (isJobTitle(text)) continue;
      // The <p> holds the person's location — not a company.
      if (isLocation(text, location)) continue;
      if (trackSource) lastCompanyParseSource = "company_adjacent_p";
      return text;
    }

    // --- Tier 4: /company/ anchors -------------------------------------
    // Logo-only links carry no text; prefer the first anchor that
    // actually names the company, and fall back to the second when the
    // first is logo-only.
    const aRe = /<a\b[^>]*\bhref=["'][^"']*\/company\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    let am;
    const firstTwoLinkTexts = [];
    while ((am = aRe.exec(html)) !== null && firstTwoLinkTexts.length < 2) {
      // Skip /company/ anchors inside sidebar sections — those name
      // OTHER people's companies, not this person's.
      if (inExcluded(am.index)) continue;
      firstTwoLinkTexts.push(stripEmploymentSuffix(cleanText(am[1])));
    }
    const firstLinkText = firstTwoLinkTexts[0] || "";
    const secondLinkText = firstTwoLinkTexts[1] || "";
    if (firstLinkText && firstLinkText.length <= 200 && !isRoleWord(firstLinkText) && !isPersonName(firstLinkText) && !isJobTitle(firstLinkText) && !isLocation(firstLinkText, location)) {
      if (trackSource) lastCompanyParseSource = "company_link";
      return firstLinkText;
    }
    if (secondLinkText && secondLinkText.length <= 200 && !isRoleWord(secondLinkText) && !isPersonName(secondLinkText) && !isJobTitle(secondLinkText) && !isLocation(secondLinkText, location)) {
      if (trackSource) lastCompanyParseSource = "company_link2";
      return secondLinkText;
    }

    // --- Tier 6 (last resort): og:title / page <title> -----------------
    // Only trust a title-derived value when it is NOT the person's name:
    // on a logged-in view of another user's profile the titles are just
    // "Name | LinkedIn" — no company, and taking the name would render a
    // misleading "company".
    const ogTag = /<meta\b[^>]*\bog:title\b[^>]*>/i.exec(html);
    if (ogTag) {
      const cm = /(?:content|value)=["']([^"']*)["']/i.exec(ogTag[0]);
      if (cm) {
        const cand = companyFromTitleLike(cm[1]);
        if (cand) {
          if (isTitleName(cand)) {
            if (trackSource) lastCompanyParseSource = "name_check_skipped_tier4";
          } else if (!isRoleWord(cand) && !isJobTitle(cand) && !isLocation(cand, location)) {
            if (trackSource) lastCompanyParseSource = "og_title";
            return cand;
          }
          // A role-word candidate ("... - Engineer | LinkedIn") is a job
          // title, not a company — fall through to the page title.
        }
      }
    }

    const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (titleTag) {
      const cand = companyFromTitleLike(titleTag[1]);
      if (cand) {
        if (isTitleName(cand)) {
          if (trackSource) lastCompanyParseSource = "name_check_skipped_tier4";
        } else if (!isRoleWord(cand) && !isJobTitle(cand) && !isLocation(cand, location)) {
          if (trackSource) lastCompanyParseSource = "page_title";
          return cand;
        }
      }
    }

    return null;
  }

  // --- cache ---------------------------------------------------------

  function peopleCacheFresh(entry) {
    if (!entry || typeof entry.fetchedAt !== "number") return false;
    if (entry.schemaVersion !== PEOPLE_CACHE_SCHEMA_VERSION) return false;
    const ttl = entry.ok ? PEOPLE_SUCCESS_TTL : PEOPLE_FAILURE_TTL;
    return Date.now() - entry.fetchedAt < ttl;
  }

  async function peopleCacheGet() {
    try {
      const res = await browser.storage.local.get(PEOPLE_CACHE_KEY);
      const val = res[PEOPLE_CACHE_KEY];
      return val && typeof val === "object" ? val : {};
    } catch (err) {
      console.warn("[People] cache read failed: " + peopleErr(err));
      return {};
    }
  }

  async function peopleCacheSet(vanity, entry) {
    try {
      const cache = await peopleCacheGet();
      cache[vanity] = entry;
      await browser.storage.local.set({ [PEOPLE_CACHE_KEY]: cache });
    } catch (err) {
      console.warn("[People] cache write failed: " + peopleErr(err));
    }
  }

  async function peopleCacheMiss(vanity, reason) {
    await peopleCacheSet(vanity, {
      ok: false,
      reason: reason,
      schemaVersion: PEOPLE_CACHE_SCHEMA_VERSION,
      fetchedAt: Date.now()
    });
  }

  // True when the cache already holds a FRESH ok:true entry for this vanity.
  // Used to keep a late fetch()/iframe failure from clobbering a success the
  // OTHER parallel path already resolved (the iframe scrape resolves first
  // for profiles whose company the fetch() body never carries).
  async function peopleCacheHasFreshSuccess(vanity) {
    try {
      const cache = await peopleCacheGet();
      const hit = cache[vanity];
      return !!(hit && hit.ok && peopleCacheFresh(hit));
    } catch (err) {
      return false;
    }
  }

  // --- broadcast ------------------------------------------------------

  // Mirror Glassdoor's broadcast: tell the originating tab the company
  // resolved (or didn't). The content side updates its in-memory map and
  // re-renders the line. type defaults to the companyResolved broadcast;
  // pass an explicit type for the fetchFailed fallback signal.
  function peopleBroadcast(tabId, payload, type) {
    if (typeof tabId !== "number") return;
    const msg = { type: type || "site-settings:people:companyResolved" };
    Object.keys(payload).forEach((k) => {
      msg[k] = payload[k];
    });
    try {
      browser.tabs.sendMessage(tabId, msg).catch(() => {});
    } catch (err) {
      // Tab may be gone — nothing to do.
    }
  }

  // Cache + broadcast one resolution. Shared by the fetch() path
  // (peopleFetchOne) and the content-side iframe-scrape path
  // (site-settings:people:iframeScraped), so both end in exactly the same
  // cache entry shape and the same companyResolved broadcast:
  //   ok:true  -> cache company (7d TTL), broadcast { ok:true, company, name }
  //   ok:false -> cache failure (1h TTL), broadcast { ok:false, reason }
  async function peopleResolve(tabId, vanity, name, ok, company, reason) {
    if (ok) {
      await peopleCacheSet(vanity, {
        ok: true,
        company: company,
        schemaVersion: PEOPLE_CACHE_SCHEMA_VERSION,
        fetchedAt: Date.now()
      });
    } else {
      await peopleCacheMiss(vanity, reason || "unknown");
    }
    const payload = { vanity: vanity, ok: ok };
    if (ok) {
      payload.company = company;
      payload.name = name;
    } else {
      payload.reason = reason || "unknown";
    }
    peopleBroadcast(tabId, payload);
  }

  // --- queue + pipeline ----------------------------------------------

  function peopleEnqueue(vanity, profileUrl, name, title, location, tabId) {
    const norm = peopleVanity(vanity);
    if (!norm || peoplePending.has(norm)) return;
    peoplePending.add(norm);
    peopleQueue.push({ vanity: norm, profileUrl: profileUrl, name: name, title: title, location: location, tabId: tabId });
    peoplePump();
  }

  // Same shape as glassdoorPump: at most one fetch in flight, ≥2s between
  // starts. Honors the showPeopleSearchCompany toggle so a mid-queue flip
  // off drops everything (a queued /in/ fetch is user-initiated work, but
  // the user just turned the feature off — respect that).
  function peoplePump() {
    if (peopleActive) return;
    if (!showPeopleSearchCompany) {
      clearTimeout(peopleTimer);
      peopleTimer = null;
      peopleQueue.length = 0;
      peoplePending.clear();
      return;
    }
    if (peopleQueue.length === 0) return;
    const elapsed = Date.now() - peopleLastFetchStart;
    if (elapsed < PEOPLE_FETCH_GAP_MS) {
      clearTimeout(peopleTimer);
      peopleTimer = setTimeout(peoplePump, PEOPLE_FETCH_GAP_MS - elapsed);
      return;
    }
    const job = peopleQueue.shift();
    if (!job) return;
    peopleActive = true;
    peopleLastFetchStart = Date.now();
    peopleFetchOne(job.vanity, job.profileUrl, job.name, job.title, job.location, job.tabId)
      .catch((err) => {
        console.error("[People] unexpected error for " + job.vanity + ":", err);
      })
      .then(() => {
        peoplePending.delete(job.vanity);
        peopleActive = false;
        if (peopleQueue.length > 0 && showPeopleSearchCompany) peoplePump();
      });
  }

  async function peopleFetchOne(vanity, profileUrl, name, title, location, tabId) {
    const controller = new AbortController();
    peopleController = controller;
    const signal = controller.signal;

    let res;
    try {
      res = await fetch(profileUrl, {
        method: "GET",
        signal: signal,
        credentials: "include",
        redirect: "follow",
        headers: {
          "User-Agent": LINKEDIN_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5"
        }
      });
    } catch (err) {
      if (err && (err.name === "AbortError" || (signal && signal.aborted))) return;
      console.warn("[People] fetch failed for " + vanity + ": " + peopleErr(err));
      if (await peopleCacheHasFreshSuccess(vanity)) return; // iframe path already won
      await peopleResolve(tabId, vanity, name, false, null, "fetch_error");
      return;
    }
    if (!res.ok) {
      // 401/403 = auth wall (logged out, region block, account restricted);
      // 404 = profile deleted/private; 429 = throttled. We don't try to
      // distinguish them in the UI — all of them are "no company available
      // right now" — but logging the status helps debug.
      console.warn("[People] HTTP " + res.status + " for " + vanity);
      const reason =
        res.status === 404
          ? "not_found"
          : res.status === 401 || res.status === 403
          ? "auth_wall"
          : "fetch_error";
      if (await peopleCacheHasFreshSuccess(vanity)) return; // iframe path already won
      await peopleResolve(tabId, vanity, name, false, null, reason);
      return;
    }
    let html;
    try {
      html = await res.text();
    } catch (err) {
      console.warn("[People] body read failed for " + vanity);
      if (await peopleCacheHasFreshSuccess(vanity)) return; // iframe path already won
      await peopleResolve(tabId, vanity, name, false, null, "fetch_error");
      return;
    }
    let company = null;
    let parseSource = null;
    try {
      company = parseCompanyFromProfileHtml(html, name, title, location);
      parseSource = lastCompanyParseSource;
    } catch (err) {
      company = null;
    }
    if (company) {
      // Tier log (one line per resolution): which parser tier produced
      // the company — "_08b5ea62" is the SSR-stable top-card <p>, the
      // others are the fallback tiers that fire on the
      // connection-filtered "other profile" shape. Confirms the primary
      // tier stays dominant on the user's own profile and tells us which
      // signal the other profile shape actually carries.
      console.log('[People] resolved "' + vanity + '" via ' + parseSource + ' -> "' + company + '"');
    }
    if (!company) {
      // Diagnostic (one line): has_08b5ea62 is the raw offset of the class
      // token anywhere in the body (-1 when absent — the "LinkedIn
      // re-rolled the class hash" case); has_company_p_class reports
      // whether a <p class="..._08b5ea62..."> tag literally matches;
      // has_ExperienceTopLevel tells us whether the (lazy-loaded)
      // Experience section made it into the fetch body at all. The
      // og/twitter-title, jsonld and /company/-link signals report which
      // fallback signal the body DOES carry so the parser can be aimed at
      // the real shape. name_check reports whether tier 5 (og:title / page
      // title) fired but was rejected because it just echoed the person's
      // own name ("skipped_tier4") — the expected state for a logged-in
      // view of another user's profile, whose titles are "Name | LinkedIn"
      // with no company in the SSR shell at all.
      const ct =
        res.headers && typeof res.headers.get === "function"
          ? res.headers.get("content-type")
          : null;
      const cl =
        res.headers && typeof res.headers.get === "function"
          ? res.headers.get("content-length")
          : null;
      const trunc100 = (s) => {
        const t = String(s);
        return t.length > 100 ? t.slice(0, 100) : t;
      };
      const metaVal = (prop) => {
        const re = new RegExp("<meta\\b[^>]*\\b" + prop + "\\b[^>]*>", "i");
        const tag = re.exec(html);
        if (!tag) return null;
        const cm = /(?:content|value)=["']([^"']*)["']/i.exec(tag[0]);
        return cm ? cm[1] : null;
      };
      const ogTitle = metaVal("og:title");
      const twTitle = metaVal("twitter:title");
      const hasJsonld = /<script\b[^>]*type=["']application\/ld\+json["']/i.test(html) ? "yes" : "no";
      const numCompanyLinks = (html.match(/href=["'][^"']*\/company\//gi) || []).length;
      const linkRe = /<a\b[^>]*\bhref=["'][^"']*\/company\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
      const firstTwoLinkTexts = [];
      let lm;
      while ((lm = linkRe.exec(html)) !== null && firstTwoLinkTexts.length < 2) {
        firstTwoLinkTexts.push(
          lm[1]
            .replace(/<[^>]+>/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&nbsp;/g, " ")
            .replace(/&#x2022;/g, "\u2022")
            .replace(/\s+/g, " ")
            .trim()
        );
      }
      console.warn(
        "[People] no company parseable for " + vanity +
          " status=" + res.status +
          " ct=" + ct +
          " len=" + (cl || html.length) +
          " has_08b5ea62=" + html.indexOf("_08b5ea62") +
          " has_ExperienceTopLevel=" + (html.indexOf("ExperienceTopLevel") !== -1) +
          " has_company_p_class=" + (/<p\b[^>]*_08b5ea62[^>]*>/.test(html)) +
          " has_og_title=" + (ogTitle ? trunc100(ogTitle) : "none") +
          " has_twitter_title=" + (twTitle ? trunc100(twTitle) : "none") +
          " has_jsonld=" + hasJsonld +
          " num_company_links=" + numCompanyLinks +
          " first_company_link_text=" + (firstTwoLinkTexts[0] === undefined ? "none" : trunc100(firstTwoLinkTexts[0])) +
          " second_company_link_text=" + (firstTwoLinkTexts[1] === undefined ? "none" : trunc100(firstTwoLinkTexts[1])) +
          " name_check=" + (parseSource === "name_check_skipped_tier4" ? "skipped_tier4" : "n/a")
      );
      // The content-side iframe scrape may have resolved this vanity while
      // this fetch was in flight — the iframe sees the hydrated Experience
      // section, which the fetch() body never carries. Don't let the fetch's
      // parse miss clobber that success (or wipe the rendered line via the
      // ok:false broadcast).
      if (await peopleCacheHasFreshSuccess(vanity)) return;
      await peopleResolve(tabId, vanity, name, false, null, "parse_error");
      // The fetch() could not find a company signal — a LinkedIn-markup or
      // auth-shape issue, not a definite "no company". Broadcast the new
      // fallback signal so the content side fires the on-demand hidden-iframe
      // scrape (the hydrated iframe sees the Experience section the fetch()
      // body never carries). The companyResolved ok:false broadcast above
      // stays unchanged; the iframe result comes back via
      // site-settings:people:iframeScraped.
      console.log(
        "[People] fetch failed for " + vanity + ": parse_error; broadcasting fallback signal"
      );
      peopleBroadcast(
        tabId,
        {
          vanity: vanity,
          name: name,
          profileUrl: profileUrl,
          reason: "parse_error"
        },
        "site-settings:people:fetchFailed"
      );
      return;
    }
    await peopleResolve(tabId, vanity, name, true, company, null);
  }

  // getCompany entry point. Returns the cached value synchronously when
  // the cache has a fresh hit, otherwise queues a fetch and reports ok:false
  // with reason:"queued" (the broadcast carries the real answer). Cached
  // negatives are returned as ok:false with the cached reason so the
  // content side doesn't queue a second fetch.
  async function peopleGetCompany(vanity, profileUrl, name, title, location, sender) {
    const norm = peopleVanity(vanity);
    if (!norm) return { ok: false, reason: "bad_vanity" };
    const tabId =
      sender && sender.tab && typeof sender.tab.id === "number"
        ? sender.tab.id
        : null;
    const cache = await peopleCacheGet();
    const hit = cache[norm];
    if (hit && peopleCacheFresh(hit)) {
      if (hit.ok) return { ok: true, company: hit.company };
      // Diagnostic: the cache is serving a stale negative (e.g. a parse_error
      // left by an older parser). One short line so the user can tell whether
      // the cache is blocking a re-fetch.
      console.log("[People] cache negative for " + norm + ": " + (hit.reason || "cached_negative"));
      return { ok: false, reason: hit.reason || "cached_negative" };
    }
    peopleEnqueue(norm, profileUrl, name, title, location, tabId);
    return { ok: false, reason: "queued" };
  }

  function siteOf(data, siteId) {
    const sites = data.sites || (data.sites = {});
    const site = sites[siteId] || (sites[siteId] = {});
    site[BLOCKED_KEY] = site[BLOCKED_KEY] || [];
    site[HIGHLIGHTED_KEY] = site[HIGHLIGHTED_KEY] || [];
    site[TITLE_KEYWORDS_KEY] = site[TITLE_KEYWORDS_KEY] || [];
    site[HIDE_APPLIED_KEY] = Boolean(site[HIDE_APPLIED_KEY]);
    return site;
  }

  // Move a company to the given state (blocked/highlighted/none). Blocked and
  // highlighted are mutually exclusive per company. Returns false when the
  // company name is empty.
  function setCompanyState(data, siteId, company, state) {
    const name = String(company || "").trim();
    if (!name) return false;
    const site = siteOf(data, siteId);
    site[BLOCKED_KEY] = site[BLOCKED_KEY].filter((c) => c !== name);
    site[HIGHLIGHTED_KEY] = site[HIGHLIGHTED_KEY].filter((c) => c !== name);
    if (state === "blocked") site[BLOCKED_KEY].push(name);
    else if (state === "highlighted") site[HIGHLIGHTED_KEY].push(name);
    return true;
  }

  function handleMessage(message, sender, api) {
    if (message.type === "site-settings:setCompanyState") {
      const siteId = message.siteId || "linkedin";
      const state =
        message.state === "blocked" || message.state === "highlighted"
          ? message.state
          : "none";
      return api.getModuleData(MODULE_ID).then((data) => {
        if (!setCompanyState(data, siteId, message.company, state)) {
          return { ok: false, error: "No company name." };
        }
        return api.setModuleData(MODULE_ID, { sites: data.sites }).then(() => {
          if (state === "blocked" && sender && sender.tab && typeof sender.tab.id === "number") {
            api.notify(sender.tab.id, "Blocked", message.company, {
              type: "site-settings:undoBlock",
              label: "Undo",
              payload: { siteId: siteId, company: message.company }
            });
          }
          return { ok: true };
        });
      });
    }

    if (message.type === "site-settings:addTitleKeyword") {
      const siteId = message.siteId || "linkedin";
      const keyword = String(message.keyword || "").trim();
      if (!keyword) return Promise.resolve({ ok: false, error: "No keyword." });
      return api.getModuleData(MODULE_ID).then((data) => {
        const site = siteOf(data, siteId);
        const dup = site[TITLE_KEYWORDS_KEY].some(
          (k) => String(k).toLowerCase() === keyword.toLowerCase()
        );
        // Case-insensitive dedupe: the first verbatim form wins.
        if (!dup) site[TITLE_KEYWORDS_KEY].push(keyword);
        return api.setModuleData(MODULE_ID, { sites: data.sites }).then(() => {
          if (sender && sender.tab && typeof sender.tab.id === "number") {
            api.notify(sender.tab.id, "Filter added", keyword);
          }
          return { ok: true };
        });
      });
    }

    if (message.type === "site-settings:undoBlock") {
      const siteId = message.siteId || "linkedin";
      const name = String(message.company || "").trim();
      if (!name) return Promise.resolve({ ok: false, error: "No company name." });
      return api.getModuleData(MODULE_ID).then((data) => {
        const site = siteOf(data, siteId);
        site[BLOCKED_KEY] = site[BLOCKED_KEY].filter((c) => c !== name);
        return api.setModuleData(MODULE_ID, { sites: data.sites }).then(() => ({
          ok: true
        }));
      });
    }

    if (message.type === "site-settings:glassdoor:getRatings") {
      console.log("[Glassdoor] getRatings received", { nameCount: (message.names || []).length, senderTabId: sender && sender.tab && sender.tab.id });
      return api.getModuleData(MODULE_ID).then((data) => {
        const site = (data && data.sites && data.sites.linkedin) || {};
        const resolved = site.showGlassdoorRatings === true;
        console.log("[Glassdoor] getRatings module data", {
          hasData: !!data,
          dataKeys: data ? Object.keys(data) : null,
          hasSites: !!(data && data.sites),
          siteKeys: data && data.sites ? Object.keys(data.sites) : null,
          linkedinKeys: data && data.sites && data.sites.linkedin ? Object.keys(data.sites.linkedin) : null,
          rawToggle: site.showGlassdoorRatings,
          resolvedToggle: resolved
        });
        showGlassdoorRatings = resolved;
        // Toggle off: never initiate any fetch — just report no ratings.
        if (!showGlassdoorRatings) return { ratings: {} };
        return glassdoorGetRatings(message.names, sender);
      });
    }

    if (message.type === "site-settings:glassdoor:retryRating") {
      // Click on a "?" badge: evict the failed cache entry for this name and
      // re-queue the fetch. The next completion broadcast updates the badge
      // in place (success → green star, failure → stays "?" with fresh
      // fetchedAt). The content side sends the *normalized* name (wrapper
      // dataset.gdName); the typeahead matches it case-insensitively.
      return api.getModuleData(MODULE_ID).then((data) => {
        const site = (data && data.sites && data.sites.linkedin) || {};
        showGlassdoorRatings = site.showGlassdoorRatings === true;
        if (!showGlassdoorRatings) return { ok: false, reason: "toggle_off" };
        const raw = String((message && message.name) || "").trim();
        if (!raw) return { ok: false, reason: "no_name" };
        const tabId = sender && sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : null;
        // Evict the cache entry so glassdoorFresh treats it as a miss on the
        // next regular getRatings (and so glassdoorEnqueue can re-fetch
        // without the "already in glassdoorPending" guard blocking it).
        return glassdoorCacheGet().then((cache) => {
          const norm = normalizeCompanyName(raw);
          if (norm && Object.prototype.hasOwnProperty.call(cache, norm)) {
            delete cache[norm];
            browser.storage.local.set({ [GLASSDOOR_CACHE_KEY]: cache }).catch(() => {});
          }
          // If it was already in-flight (pending or active), don't double-queue.
          if (norm && glassdoorPending.has(norm)) return { ok: true, note: "already_pending" };
          glassdoorEnqueue(raw, tabId);
          return { ok: true };
        });
      });
    }

    if (message.type === "site-settings:people:getCompany") {
      // The content side sends a request per visible card, carrying the
      // person's name, job title AND location (read from the people-search
      // card). We honor the toggle on every request so a mid-session flip
      // off takes effect immediately (the in-flight fetches finish but no
      // new ones start).
      return api.getModuleData(MODULE_ID).then((data) => {
        const site = (data && data.sites && data.sites.linkedin) || {};
        showPeopleSearchCompany = site.showPeopleSearchCompany === true;
        if (!showPeopleSearchCompany) {
          return { ok: false, reason: "toggle_off" };
        }
        const vanity = String((message && message.vanity) || "");
        const profileUrl = String((message && message.profileUrl) || "");
        const name = String((message && message.name) || "");
        const title = String((message && message.title) || "");
        const location = String((message && message.location) || "");
        if (!vanity || !profileUrl) {
          return { ok: false, reason: "bad_input" };
        }
        return peopleGetCompany(vanity, profileUrl, name, title, location, sender);
      });
    }

    if (message.type === "site-settings:people:iframeScraped") {
      // The content side's hidden-iframe scrape resolved (or failed). This
      // is the parallel PRIMARY path to the fetch() in peopleFetchOne: the
      // iframe lets LinkedIn's own hydration render the Experience section,
      // so it can see companies the fetch() body never carries. Cache +
      // broadcast exactly like a fetch() resolution (peopleResolve). Two
      // guards keep the paths from fighting:
      //   - a failure never clobbers a FRESH ok:true entry the other path
      //     already cached;
      //   - an ok:true always wins over a cached failure (the whole point —
      //     the fetch() parse-miss is the reason the iframe path exists).
      const vanity = String((message && message.vanity) || "");
      const norm = peopleVanity(vanity);
      if (!norm) return Promise.resolve({ ok: false, reason: "bad_vanity" });
      const ok = message.ok === true;
      const company = ok ? String((message && message.company) || "").trim() : "";
      const reason = ok ? "" : String((message && message.reason) || "unknown");
      if (ok && !company) return Promise.resolve({ ok: false, reason: "bad_input" });
      const tabId =
        sender && sender.tab && typeof sender.tab.id === "number"
          ? sender.tab.id
          : null;
      const name = String((message && message.name) || "");
      return (async () => {
        if (!ok && (await peopleCacheHasFreshSuccess(norm))) {
          return { ok: true, note: "kept_existing_success" };
        }
        await peopleResolve(tabId, norm, name, ok, company, reason);
        return { ok: true };
      })();
    }

    if (message.type === "site-settings:people:clearCache") {
      // Options-page action: wipe the local cache so the next scan re-fetches
      // every person. Also drop the in-memory queue + pending set: a vanity
      // still marked "pending" here makes peopleEnqueue a silent no-op, so a
      // post-clear getCompany for it would never re-fetch (the exact stale
      // negative the user cleared the cache to get rid of). An actively
      // in-flight fetch is left to finish — it completes and writes a fresh
      // entry + broadcast, which is what a post-clear scan wants anyway. The
      // toggle state is independent of the cache and is NOT touched.
      peoplePending.clear();
      peopleQueue.length = 0;
      clearTimeout(peopleTimer);
      peopleTimer = null;
      return browser.storage.local
        .remove(PEOPLE_CACHE_KEY)
        .then(() => {
          return { ok: true };
        })
        .catch((err) => {
          return { ok: false, reason: "remove_failed", error: peopleErr(err) };
        });
    }

    return undefined;
  }

  // ------------------------------------------------------------------
  // Export / import (core feature)
  // ------------------------------------------------------------------

  // Export the module config: the sync payload minus the active flag (the
  // core tracks that separately). The Glassdoor rating cache and the
  // people-company cache (storage.local) are deliberately excluded — they are
  // regenerable derived data, not config, so they never travel with an export.
  async function exportData(api) {
    const data = {};
    const payload = await api.getModuleData(MODULE_ID);
    if (payload && typeof payload === "object") {
      Object.keys(payload).forEach(function (k) {
        if (k !== "active") data[k] = payload[k];
      });
    }
    return { data: data, local: {} };
  }

  // Restore the sync payload and active flag. The caches are never imported.
  async function importData(api, exported) {
    exported = exported || {};
    await api.setModuleData(MODULE_ID, exported.data || {});
    await api.setModuleActive(MODULE_ID, Boolean(exported.active !== false));
  }

  window.jobAppToolkit.registerModule({
    id: MODULE_ID,
    name: "Site Settings",
    description: "Website-specific settings for job boards: block or highlight postings by company.",
    optionsUrl: "modules/site-settings/options.html",
    handleMessage: handleMessage,
    exportData: exportData,
    importData: importData
  });
})();
