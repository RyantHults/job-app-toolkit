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
