/**
 * Site Settings — background module. Registers with the Job App Toolkit core
 * and owns persistence of per-site settings (currently: per-company block /
 * highlight lists and title-block keywords for job boards like LinkedIn).
 * Content scripts do the DOM work; this script mediates storage and in-page
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

    return undefined;
  }

  window.jobAppToolkit.registerModule({
    id: MODULE_ID,
    name: "Site Settings",
    description: "Website-specific settings for job boards: block or highlight postings by company.",
    optionsUrl: "modules/site-settings/options.html",
    handleMessage: handleMessage
  });
})();
