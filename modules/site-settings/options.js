(() => {
  "use strict";

  const MODULE_ID = "site-settings";
  const SITE_ID = "linkedin";

  const storage = window.jobAppToolkit.storage;
  const ui = window.jobAppToolkit.ui;

  const activeToggle = document.getElementById("active-toggle");
  const hideAppliedToggle = document.getElementById("hide-applied-toggle");
  const showGlassdoorToggle = document.getElementById("show-glassdoor-toggle");
  const blockedList = document.getElementById("blocked-list");
  const highlightedList = document.getElementById("highlighted-list");
  const keywordsList = document.getElementById("keyword-list");
  const addBlockedBtn = document.getElementById("add-blocked-btn");
  const addHighlightedBtn = document.getElementById("add-highlighted-btn");
  const addKeywordBtn = document.getElementById("add-keyword-btn");

  const BLOCKED_KEY = "blockedCompanies";
  const HIGHLIGHTED_KEY = "highlightedCompanies";
  const KEYWORDS_KEY = "titleBlockedKeywords";
  const HIDE_APPLIED_KEY = "hideApplied";
  const SHOW_GLASSDOR_KEY = "showGlassdoorRatings";

  let data = { active: true, sites: {} };
  let site = {
    [BLOCKED_KEY]: [],
    [HIGHLIGHTED_KEY]: [],
    [KEYWORDS_KEY]: [],
    [HIDE_APPLIED_KEY]: false,
    [SHOW_GLASSDOR_KEY]: false
  };

  function ensureSite() {
    if (!data.sites || typeof data.sites !== "object") data.sites = {};
    if (!data.sites[SITE_ID] || typeof data.sites[SITE_ID] !== "object") data.sites[SITE_ID] = {};
    site = data.sites[SITE_ID];
    site[BLOCKED_KEY] = Array.isArray(site[BLOCKED_KEY]) ? site[BLOCKED_KEY] : [];
    site[HIGHLIGHTED_KEY] = Array.isArray(site[HIGHLIGHTED_KEY]) ? site[HIGHLIGHTED_KEY] : [];
    site[KEYWORDS_KEY] = Array.isArray(site[KEYWORDS_KEY]) ? site[KEYWORDS_KEY] : [];
    site[HIDE_APPLIED_KEY] = site[HIDE_APPLIED_KEY] === true;
    site[SHOW_GLASSDOR_KEY] = site[SHOW_GLASSDOR_KEY] === true;
  }

  async function loadData() {
    data = await storage.getModuleData(MODULE_ID);
    if (!data || typeof data !== "object") data = {};
    activeToggle.checked = data.active === true;
    ensureSite();
    hideAppliedToggle.checked = site[HIDE_APPLIED_KEY] === true;
    showGlassdoorToggle.checked = site[SHOW_GLASSDOR_KEY] === true;
  }

  function saveData() {
    return storage.setModuleData(MODULE_ID, { sites: data.sites });
  }

  function renderList(listEl, entries, key) {
    listEl.textContent = "";
    if (entries.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "None yet.";
      listEl.appendChild(li);
      return;
    }
    for (const name of entries) {
      const li = document.createElement("li");
      li.className = "company-row";

      const nameDiv = document.createElement("div");
      nameDiv.className = "list-name";
      nameDiv.textContent = name;
      nameDiv.title = name;

      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-sm";
      del.textContent = "Remove";
      del.addEventListener("click", async () => {
        site[key] = site[key].filter((c) => c !== name);
        await saveData();
        render();
        ui.setStatus('Removed "' + name + '".');
      });

      li.appendChild(nameDiv);
      li.appendChild(del);
      listEl.appendChild(li);
    }
  }

  async function addCompany(key) {
    const raw = await ui.showPrompt("Company name:");
    if (raw === null) return;
    const name = raw.trim();
    if (!name) return;
    if (site[key].indexOf(name) !== -1) {
      ui.setStatus('"' + name + '" is already listed.');
      return;
    }
    const other = key === BLOCKED_KEY ? HIGHLIGHTED_KEY : BLOCKED_KEY;
    site[other] = site[other].filter((c) => c !== name);
    site[key].push(name);
    await saveData();
    render();
    ui.setStatus('Added "' + name + '".');
  }

  async function addKeyword() {
    const raw = await ui.showPrompt("Keyword to hide:");
    if (raw === null) return;
    const keyword = raw.trim();
    if (!keyword) return;
    const dup = site[KEYWORDS_KEY].some(
      (k) => k.toLowerCase() === keyword.toLowerCase()
    );
    if (dup) {
      ui.setStatus('"' + keyword + '" is already listed.');
      return;
    }
    site[KEYWORDS_KEY].push(keyword);
    await saveData();
    render();
    ui.setStatus('Added "' + keyword + '".');
  }

  function render() {
    renderList(blockedList, site[BLOCKED_KEY], BLOCKED_KEY);
    renderList(highlightedList, site[HIGHLIGHTED_KEY], HIGHLIGHTED_KEY);
    renderList(keywordsList, site[KEYWORDS_KEY], KEYWORDS_KEY);
  }

  function handleError(err) {
    console.error("Site Settings options error:", err);
    ui.setStatus("Something went wrong");
  }

  // ---- Handlers ---------------------------------------------------------------

  activeToggle.addEventListener("change", async () => {
    try {
      await storage.setModuleActive(MODULE_ID, activeToggle.checked);
      data.active = activeToggle.checked;
      ui.setStatus(activeToggle.checked ? "Module active." : "Module inactive.");
    } catch (err) {
      handleError(err);
    }
  });

  hideAppliedToggle.addEventListener("change", async () => {
    try {
      site[HIDE_APPLIED_KEY] = hideAppliedToggle.checked;
      await saveData();
      ui.setStatus(
        hideAppliedToggle.checked
          ? "Applied postings will be hidden."
          : "Applied postings will be shown."
      );
    } catch (err) {
      handleError(err);
    }
  });

  showGlassdoorToggle.addEventListener("change", async () => {
    try {
      site[SHOW_GLASSDOR_KEY] = showGlassdoorToggle.checked;
      await saveData();
      ui.setStatus(
        showGlassdoorToggle.checked
          ? "Glassdoor ratings will be shown."
          : "Glassdoor ratings will be hidden."
      );
    } catch (err) {
      handleError(err);
    }
  });

  addBlockedBtn.addEventListener("click", () => addCompany(BLOCKED_KEY).catch(handleError));
  addHighlightedBtn.addEventListener("click", () => addCompany(HIGHLIGHTED_KEY).catch(handleError));
  addKeywordBtn.addEventListener("click", () => addKeyword().catch(handleError));

  // ---- Init -------------------------------------------------------------------

  loadData()
    .then(() => render())
    .catch(handleError);
})();
