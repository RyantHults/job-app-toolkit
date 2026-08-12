(() => {
  "use strict";

  const MODULE_ID = "form-filler";
  const AI_KEY_LOCAL = "jtk-form-filler-ai-key";
  const AI_CONTEXT_LOCAL = "jtk-form-filler-ai-context";
  // Keep in sync with the DEFAULT_AI_INSTRUCTIONS constant in
  // modules/form-filler/background.js — the background uses it as the system
  // prompt fallback when the user has not entered custom instructions.
  const DEFAULT_AI_INSTRUCTIONS =
    "You are a job-application assistant writing answers for a candidate. " +
    "Write in the first person, be specific and concrete, and never invent " +
    "facts that are not present in the background information. Keep a " +
    "professional, natural tone, like a good cover letter or interview " +
    "answer. Output plain text only: no markdown formatting, no leading " +
    "label, no quotes around the answer.";

  const storage = window.jobAppToolkit.storage;
  const ui = window.jobAppToolkit.ui;

  const activeToggle = document.getElementById("active-toggle");
  const profileSelect = document.getElementById("profile-select");
  const fillBtn = document.getElementById("fill-btn");
  const addFieldBtn = document.getElementById("add-field-btn");
  const addAllFieldsBtn = document.getElementById("add-all-fields-btn");
  const applicationsBtn = document.getElementById("applications-btn");
  const fieldsList = document.getElementById("fields-list");
  const fieldSearch = document.getElementById("field-search");
  const newProfileBtn = document.getElementById("new-profile-btn");
  const renameProfileBtn = document.getElementById("rename-profile-btn");
  const deleteProfileBtn = document.getElementById("delete-profile-btn");
  const whitelistInput = document.getElementById("whitelist-input");
  const whitelistAddBtn = document.getElementById("whitelist-add");
  const whitelistList = document.getElementById("whitelist-list");
  const aiEndpoint = document.getElementById("ai-endpoint");
  const aiModel = document.getElementById("ai-model");
  const aiInstructions = document.getElementById("ai-instructions");
  const aiInstructionsReset = document.getElementById("ai-instructions-reset");
  const aiKeyInput = document.getElementById("ai-key");
  const aiKeyStatus = document.getElementById("ai-key-status");
  const aiSave = document.getElementById("ai-save");
  const aiKeyClear = document.getElementById("ai-key-clear");
  const aiContextAdd = document.getElementById("ai-context-add");
  const aiContextList = document.getElementById("ai-context-list");
  const aiContextEditor = document.getElementById("ai-context-editor");
  const aiContextTitle = document.getElementById("ai-context-title");
  const aiContextBody = document.getElementById("ai-context-body");
  const aiContextSave = document.getElementById("ai-context-save");
  const aiContextCancel = document.getElementById("ai-context-cancel");
  const aiContextDelete = document.getElementById("ai-context-delete");
  const debugToggle = document.getElementById("debug-toggle");

  let data = { active: true, profiles: {}, activeProfile: null, whitelist: [], aiContext: [] };
  let aiKey = "";
  let editingIndex = -1;
  let editingIsNew = false;

  // Search event listener
  fieldSearch.addEventListener("input", filterFields);

  // ---- Storage ---------------------------------------------------------------

  async function loadData() {
    data = await storage.getModuleData(MODULE_ID);
    if (!data.profiles || typeof data.profiles !== "object") {
      data.profiles = {};
    }
    if (!data.activeProfile || !(data.activeProfile in data.profiles)) {
      data.activeProfile = Object.keys(data.profiles)[0] || null;
    }
    data.whitelist = Array.isArray(data.whitelist) ? data.whitelist : [];
    // Entries live in storage.local (the sync quota can't hold bulky bodies).
    // Prefer the local copy; a non-empty module-data copy is a pre-move
    // legacy location, so migrate it to local on first load and keep it in
    // data.aiContext for rendering. Capture whether module data carried a
    // legacy key BEFORE reassigning it below.
    const hadLegacyContext = Object.prototype.hasOwnProperty.call(data, "aiContext");
    const ctx = await browser.storage.local.get(AI_CONTEXT_LOCAL);
    if (Array.isArray(ctx[AI_CONTEXT_LOCAL])) {
      data.aiContext = ctx[AI_CONTEXT_LOCAL];
    } else if (Array.isArray(data.aiContext) && data.aiContext.length > 0) {
      await browser.storage.local.set({ [AI_CONTEXT_LOCAL]: data.aiContext });
    } else {
      data.aiContext = [];
    }
    if (hadLegacyContext) {
      // setModuleData merges and never removes keys: drop the now-stale sync
      // copy so it stops eating the 100 KiB sync quota. The local copy is
      // authoritative from here on; the in-memory data.aiContext stays for the
      // editor.
      const store = await storage.getAll();
      const mod = store.modules && store.modules[MODULE_ID];
      if (
        mod &&
        typeof mod === "object" &&
        Object.prototype.hasOwnProperty.call(mod, "aiContext")
      ) {
        delete mod.aiContext;
        await storage.setAll(store);
      }
    }
    aiEndpoint.value = data.aiEndpoint || "";
    aiModel.value = data.aiModel || "";
    aiInstructions.value =
      typeof data.aiInstructions === "string" && data.aiInstructions.trim()
        ? data.aiInstructions
        : DEFAULT_AI_INSTRUCTIONS;
    const kr = await browser.storage.local.get(AI_KEY_LOCAL);
    if (kr[AI_KEY_LOCAL]) {
      aiKey = kr[AI_KEY_LOCAL];
      aiKeyInput.placeholder = "saved \u2014 leave blank to keep";
      aiKeyStatus.textContent = "API key saved in this browser.";
      aiKeyClear.hidden = false;
    }
    activeToggle.checked = data.active === true;
    debugToggle.checked = data.debug === true;
  }

  // Entries are persisted to storage.local FIRST (they are the bulky part the
  // sync quota can't hold), then the rest of the module data goes to sync.
  async function saveData() {
    await browser.storage.local.set({ [AI_CONTEXT_LOCAL]: data.aiContext });
    return storage.setModuleData(MODULE_ID, {
      profiles: data.profiles,
      activeProfile: data.activeProfile,
      whitelist: data.whitelist,
      aiEndpoint: data.aiEndpoint,
      aiModel: data.aiModel,
      aiInstructions: data.aiInstructions,
      debug: data.debug
    });
  }

  // ---- Small helpers ----------------------------------------------------------

  function currentProfile() {
    return data.activeProfile ? data.profiles[data.activeProfile] : null;
  }

  function profileNames() {
    return Object.keys(data.profiles);
  }

  function isDuplicateProfile(name) {
    return Object.prototype.hasOwnProperty.call(data.profiles, name);
  }

  function handleError(err) {
    console.error("Form Filler options error:", err);
    ui.setStatus("Something went wrong");
  }

  // Render a stored field value for display. Multi-answer questions store
  // arrays of selected option values/labels: show them joined with ", " and a
  // neutral placeholder when nothing was selected. Everything else renders as
  // a scalar string exactly as before (legacy bare-string entries included).
  function displayValue(value) {
    if (Array.isArray(value)) {
      return value.length ? value.join(", ") : "(none selected)";
    }
    return String(value);
  }

  // Normalize a user-typed whitelist entry into a bare hostname: tolerate a
  // pasted full URL, a path/port suffix, or a leading "www."; lowercased,
  // no trailing dot. Returns "" when nothing usable.
  function normalizeHostname(raw) {
    let value = String(raw == null ? "" : raw).trim().toLowerCase();
    if (!value) return "";
    try {
      if (value.includes("://") || /[/:?#]/.test(value)) {
        value = new URL(value.includes("://") ? value : "https://" + value).hostname;
      }
    } catch (err) {
      return "";
    }
    return value.replace(/^www\./, "").replace(/\.$/, "");
  }

  // ---- Search helpers ---------------------------------------------------------
  // Mirrors content.js matching logic so the options page and fill logic agree.

  function normalize(str) {
    return String(str == null ? "" : str)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function entryNorms(entry, key) {
    const isObj = entry && typeof entry === "object";
    const label = isObj && entry.label ? entry.label : key;
    const keyNorm = normalize(key);
    const labelNorm = normalize(label);
    const norms = [];
    if (keyNorm) norms.push(keyNorm);
    if (labelNorm && labelNorm !== keyNorm) norms.push(labelNorm);
    // Multi-answer entries (arrays of selected options) are searchable by any
    // of their options: normalize the JOINED text so "Java,Python" never
    // becomes the single token "javapython". Skip empty arrays (nothing to
    // match) and scalar values (unchanged from legacy behavior).
    if (isObj && Array.isArray(entry.value) && entry.value.length) {
      const valueNorm = normalize(entry.value.join(" "));
      if (valueNorm && valueNorm !== keyNorm && valueNorm !== labelNorm) {
        norms.push(valueNorm);
      }
    }
    return norms;
  }

  function matchScore(queryNorm, norms) {
    if (!queryNorm) return 0;
    let best = 0;
    for (const norm of norms) {
      if (norm === queryNorm) {
        best = 100;
      } else if (norm.startsWith(queryNorm) || queryNorm.startsWith(norm)) {
        const r = Math.min(norm.length, queryNorm.length) / Math.max(norm.length, queryNorm.length);
        best = Math.max(best, Math.round(80 + 19 * r));
      } else if (norm.includes(queryNorm) || queryNorm.includes(norm)) {
        const shorter = norm.length < queryNorm.length ? norm : queryNorm;
        const longer = norm.length >= queryNorm.length ? norm : queryNorm;
        const r = shorter.length / longer.length;
        best = Math.max(best, Math.round(40 + 39 * r));
      } else {
        const set1 = new Set(norm), set2 = new Set(queryNorm);
        const inter = [...set1].filter(x => set2.has(x)).length;
        const union = new Set([...set1, ...set2]).size;
        best = Math.max(best, Math.round((inter / union) * 40));
      }
    }
    return best;
  }

  function filterFields() {
    const q = normalize(fieldSearch.value);
    const rows = fieldsList.querySelectorAll(".field-row");
    const profile = currentProfile();
    if (!profile) return;

    // Empty search: show all rows with no highlight
    if (!q) {
      rows.forEach(row => {
        row.classList.remove("hidden");
        row.style.setProperty("--match-opacity", 0);
      });
      return;
    }

    rows.forEach(row => {
      const key = row.dataset.key;
      const entry = profile.fields[key];
      const norms = entryNorms(entry, key);
      const score = matchScore(q, norms);

      if (score >= 1) {
        row.classList.remove("hidden");
        row.style.setProperty("--match-opacity", score / 100);
      } else {
        row.classList.add("hidden");
        row.style.setProperty("--match-opacity", 0);
      }
    });
  }

  // ---- Rendering --------------------------------------------------------------

  function renderProfileSelect() {
    profileSelect.textContent = "";
    const names = profileNames();
    if (names.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No profiles";
      profileSelect.appendChild(opt);
      profileSelect.disabled = true;
      return;
    }
    profileSelect.disabled = false;
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      profileSelect.appendChild(opt);
    }
    profileSelect.value = data.activeProfile || "";
  }

  function renderFields() {
    fieldsList.textContent = "";
    const profile = currentProfile();

    if (!profile) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No profiles yet. Click '+ New' to create one.";
      fieldsList.appendChild(li);
      return;
    }

    const entries = Object.entries(profile.fields || {});
    if (entries.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent =
        "Fill in a field and use its save button to add it, or click '+ Add Current Field'.";
      fieldsList.appendChild(li);
      return;
    }

    for (const [key, entry] of entries) {
      const isObj = entry && typeof entry === "object";
      const value = isObj ? entry.value : entry;
      const label = isObj && entry.label ? entry.label : key;

      const li = document.createElement("li");
      li.className = "field-row";
      li.dataset.key = key;

      const nameSpan = document.createElement("span");
      nameSpan.className = "field-name";
      nameSpan.textContent = label;
      nameSpan.title = label;

      const valueSpan = document.createElement("span");
      valueSpan.className = "field-value";
      const valueText = displayValue(value);
      valueSpan.textContent = valueText;
      valueSpan.title = valueText;

      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-sm field-del";
      del.textContent = "Del";
      del.addEventListener("click", () => deleteField(key));

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "btn btn-sm field-edit";
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", () => editFieldLabel(key));

      li.appendChild(nameSpan);
      li.appendChild(valueSpan);
      li.appendChild(editBtn);
      li.appendChild(del);
      fieldsList.appendChild(li);
    }
  }

  function renderWhitelist() {
    whitelistList.textContent = "";
    if (!data.whitelist || data.whitelist.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No sites added yet.";
      whitelistList.appendChild(li);
      return;
    }
    for (const host of data.whitelist) {
      const li = document.createElement("li");
      li.className = "whitelist-row";

      const nameSpan = document.createElement("span");
      nameSpan.className = "whitelist-domain";
      nameSpan.textContent = host;

      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-sm whitelist-del";
      del.dataset.domain = host;
      del.textContent = "Remove";

      li.appendChild(nameSpan);
      li.appendChild(del);
      whitelistList.appendChild(li);
    }
  }

  function renderAIContext() {
    aiContextList.textContent = "";
    if (!data.aiContext.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No background entries yet. Click '+ New entry' to add one.";
      aiContextList.appendChild(li);
      return;
    }
    data.aiContext.forEach((entry, index) => {
      const li = document.createElement("li");
      li.className = "ai-context-row";

      const titleSpan = document.createElement("span");
      titleSpan.textContent = (entry.title && entry.title.trim()) || "Untitled entry";
      titleSpan.title = String(entry.body || "").slice(0, 200);

      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "btn btn-sm";
      edit.textContent = "Edit";
      edit.dataset.action = "edit";
      edit.dataset.index = String(index);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-sm";
      del.textContent = "Del";
      del.dataset.action = "del";
      del.dataset.index = String(index);

      li.appendChild(titleSpan);
      li.appendChild(edit);
      li.appendChild(del);
      aiContextList.appendChild(li);
    });
  }

  function render() {
    renderProfileSelect();
    renderFields();
    renderWhitelist();
    renderAIContext();
    const hasProfile = Boolean(currentProfile());
    fillBtn.disabled = !hasProfile;
    addFieldBtn.disabled = !hasProfile;
    renameProfileBtn.disabled = !hasProfile;
    deleteProfileBtn.disabled = !hasProfile;
    filterFields();
  }

  // ---- Actions ----------------------------------------------------------------

  async function setActiveProfile(name) {
    data.activeProfile = name || null;
    await saveData();
    render();
  }

  async function deleteField(name) {
    const profile = currentProfile();
    if (!profile) return;
    if (!(await ui.showConfirm('Delete field "' + name + '"?'))) return;
    delete profile.fields[name];
    await saveData();
    render();
  }

  async function editFieldLabel(key) {
    const profile = currentProfile();
    if (!profile || !Object.prototype.hasOwnProperty.call(profile.fields, key)) return;
    const entry = profile.fields[key];
    const isObj = entry && typeof entry === "object";
    const currentLabel = isObj && entry.label ? entry.label : key;

    const raw = await ui.showPrompt("Field title:", currentLabel);
    if (raw === null) return;
    const label = raw.trim();
    if (!label) return;

    if (isObj) {
      entry.label = label;
    } else {
      // Legacy string entry — promote to the { value, label } format.
      profile.fields[key] = { value: entry, label: label };
    }
    await saveData();
    render();
    ui.setStatus("Field title updated.");
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

  debugToggle.addEventListener("change", async () => {
    try {
      data.debug = debugToggle.checked;
      await storage.setModuleData(MODULE_ID, { debug: data.debug });
      ui.setStatus(data.debug ? "Debug enabled." : "Debug disabled.");
    } catch (err) {
      handleError(err);
    }
  });

  profileSelect.addEventListener("change", () => {
    setActiveProfile(profileSelect.value).catch(handleError);
  });

  fillBtn.addEventListener("click", async () => {
    if (!currentProfile()) {
      ui.setStatus("No active profile.");
      return;
    }
    try {
      const res = await browser.runtime.sendMessage({ type: "form-filler:fillPageRequest" });
      if (res && res.ok) {
        ui.setStatus(res.message || "Done.");
      } else {
        ui.setStatus((res && res.error) || "Cannot fill this page.");
      }
    } catch (err) {
      ui.setStatus("Cannot fill this page.");
    }
  });

  addFieldBtn.addEventListener("click", async () => {
    if (!currentProfile()) {
      ui.setStatus("No active profile.");
      return;
    }
    try {
      const res = await browser.runtime.sendMessage({ type: "form-filler:captureFieldRequest" });
      if (res && res.ok) {
        ui.setStatus(res.message || "Field captured.");
        render();
      } else {
        ui.setStatus((res && res.error) || "Could not capture the current field.");
      }
    } catch (err) {
      ui.setStatus("Could not capture the current field.");
    }
  });

  addAllFieldsBtn.addEventListener("click", async () => {
    if (!currentProfile()) {
      ui.setStatus("No active profile.");
      return;
    }
    try {
      const res = await browser.runtime.sendMessage({ type: "form-filler:collectAllRequest" });
      if (res && res.ok) {
        ui.setStatus(res.message || "Fields added.");
        render();
      } else {
        ui.setStatus((res && res.error) || "Could not read the current page.");
      }
    } catch (err) {
      ui.setStatus("Could not read the current page.");
    }
  });

  applicationsBtn.addEventListener("click", async () => {
    try {
      await browser.tabs.create({
        url: browser.runtime.getURL("modules/form-filler/applications.html")
      });
      ui.setStatus("Opening application history\u2026");
    } catch (err) {
      handleError(err);
    }
  });

  newProfileBtn.addEventListener("click", async () => {
    const raw = await ui.showPrompt("New profile name:");
    if (raw === null) return;
    const name = raw.trim();
    if (!name) return;
    if (isDuplicateProfile(name)) {
      ui.setStatus("A profile with that name already exists.");
      return;
    }
    data.profiles[name] = { fields: {} };
    data.activeProfile = name;
    await saveData();
    render();
    ui.setStatus('Profile "' + name + '" created.');
  });

  renameProfileBtn.addEventListener("click", async () => {
    const oldName = data.activeProfile;
    if (!oldName) return;
    const raw = await ui.showPrompt('New name for profile "' + oldName + '":', oldName);
    if (raw === null) return;
    const name = raw.trim();
    if (!name || name === oldName) return;
    if (isDuplicateProfile(name)) {
      ui.setStatus("A profile with that name already exists.");
      return;
    }
    data.profiles[name] = data.profiles[oldName];
    delete data.profiles[oldName];
    data.activeProfile = name;
    await saveData();
    render();
    ui.setStatus('Profile renamed to "' + name + '".');
  });

  deleteProfileBtn.addEventListener("click", async () => {
    const name = data.activeProfile;
    if (!name) return;
    if (!(await ui.showConfirm('Delete profile "' + name + '"?'))) return;
    delete data.profiles[name];
    const remaining = profileNames();
    data.activeProfile = remaining.length ? remaining[0] : null;
    await saveData();
    render();
  });

  whitelistAddBtn.addEventListener("click", async () => {
    const host = normalizeHostname(whitelistInput.value);
    if (!host) {
      ui.setStatus("Enter a site domain first.");
      return;
    }
    if (data.whitelist.includes(host)) {
      ui.setStatus("Already added.");
      return;
    }
    data.whitelist.push(host);
    await saveData();
    renderWhitelist();
    whitelistInput.value = "";
    ui.setStatus('Added "' + host + '".');
  });

  // Event delegation so Remove buttons keep working after re-renders.
  whitelistList.addEventListener("click", async (event) => {
    const btn = event.target.closest(".whitelist-del");
    if (!btn) return;
    const host = btn.dataset.domain;
    data.whitelist = data.whitelist.filter(item => item !== host);
    await saveData();
    renderWhitelist();
    ui.setStatus('Removed "' + host + '".');
  });

  // ---- AI answers --------------------------------------------------------------

  // Field-level only: restore the textarea to the built-in default; the user
  // still clicks Save to persist it (no endpoint/model requirement).
  aiInstructionsReset.addEventListener("click", () => {
    aiInstructions.value = DEFAULT_AI_INSTRUCTIONS;
    ui.setStatus("Default instructions restored \u2014 click Save to keep.");
  });

  aiSave.addEventListener("click", async () => {
    const endpoint = aiEndpoint.value.trim();
    const model = aiModel.value.trim();
    if (!endpoint || !model) {
      ui.setStatus("Enter an endpoint and model.");
      return;
    }
    const key = aiKeyInput.value.trim();
    if (key) {
      await browser.storage.local.set({ [AI_KEY_LOCAL]: key });
      aiKey = key;
      aiKeyInput.value = "";
      aiKeyInput.placeholder = "saved \u2014 leave blank to keep";
      aiKeyStatus.textContent = "API key saved in this browser.";
      aiKeyClear.hidden = false;
    }
    try {
      data.aiEndpoint = endpoint;
      data.aiModel = model;
      data.aiInstructions = aiInstructions.value.trim();
      await saveData();
      ui.setStatus("AI settings saved.");
    } catch (err) {
      console.error("Form Filler options: failed to save AI settings:", err);
      ui.setStatus("Couldn't save AI settings: " + (err && err.message ? err.message : "storage error"));
    }
  });

  // Remove the saved key from local storage; the endpoint/model stay.
  aiKeyClear.addEventListener("click", async () => {
    await browser.storage.local.remove(AI_KEY_LOCAL);
    aiKey = "";
    aiKeyInput.value = "";
    aiKeyInput.placeholder = "sk-\u2026";
    aiKeyStatus.textContent = "";
    aiKeyClear.hidden = true;
    ui.setStatus("API key removed.");
  });

  // ---- AI background -----------------------------------------------------------

  function openEditor(index, isNew) {
    editingIndex = index;
    editingIsNew = Boolean(isNew);
    const entry = data.aiContext[index] || { title: "", body: "" };
    aiContextTitle.value = entry.title || "";
    aiContextBody.value = entry.body || "";
    aiContextEditor.hidden = false;
    aiContextTitle.focus();
  }

  // Close the editor; when `discardNew` is set and the editor was opened for a
  // freshly-added (still unsaved) entry, drop it again — Cancel after "+ New
  // entry" must not leave an empty ghost behind that a later save would persist.
  function closeEditor(discardNew) {
    if (discardNew && editingIsNew && editingIndex >= 0 && editingIndex < data.aiContext.length) {
      data.aiContext.splice(editingIndex, 1);
    }
    editingIndex = -1;
    editingIsNew = false;
    aiContextEditor.hidden = true;
    aiContextTitle.value = "";
    aiContextBody.value = "";
  }

  aiContextAdd.addEventListener("click", () => {
    data.aiContext.push({ title: "", body: "" });
    const index = data.aiContext.length - 1;
    renderAIContext();
    openEditor(index, true);
  });

  aiContextSave.addEventListener("click", async () => {
    if (editingIndex < 0 || editingIndex >= data.aiContext.length) return;
    const title = aiContextTitle.value.trim();
    if (!title) {
      ui.setStatus("Enter a title.");
      return;
    }
    try {
      data.aiContext[editingIndex] = { title: title, body: aiContextBody.value.trim() };
      await saveData();
      closeEditor();
      renderAIContext();
      ui.setStatus("Entry saved.");
    } catch (err) {
      console.error("Form Filler options: failed to save AI background entry:", err);
      ui.setStatus("Couldn't save entry: " + (err && err.message ? err.message : "storage error"));
    }
  });

  aiContextCancel.addEventListener("click", () => closeEditor(true));

  aiContextDelete.addEventListener("click", async () => {
    if (editingIndex < 0 || editingIndex >= data.aiContext.length) return;
    const entry = data.aiContext[editingIndex] || {};
    const title = (entry.title && entry.title.trim()) || "Untitled entry";
    if (!(await ui.showConfirm('Delete entry "' + title + '"?'))) return;
    try {
      data.aiContext.splice(editingIndex, 1);
      closeEditor();
      await saveData();
      renderAIContext();
    } catch (err) {
      console.error("Form Filler options: failed to delete AI background entry:", err);
      ui.setStatus("Couldn't delete entry: " + (err && err.message ? err.message : "storage error"));
    }
  });

  // Event delegation so the Edit/Del buttons keep working after re-renders.
  aiContextList.addEventListener("click", async (event) => {
    const btn = event.target.closest("button");
    if (!btn || !btn.dataset || btn.dataset.index === undefined) return;
    const index = Number(btn.dataset.index);
    if (btn.dataset.action === "edit") {
      openEditor(index);
      return;
    }
    if (btn.dataset.action !== "del") return;
    const entry = data.aiContext[index] || {};
    const title = (entry.title && entry.title.trim()) || "Untitled entry";
    if (!(await ui.showConfirm('Delete entry "' + title + '"?'))) return;
    data.aiContext.splice(index, 1);
    if (editingIndex === index) closeEditor();
    else if (editingIndex > index) editingIndex--;
    await saveData();
    renderAIContext();
  });

  // ---- Init -------------------------------------------------------------------

  loadData().then(() => {
    fieldSearch.value = "";
    filterFields();
    render();
  }).catch(handleError);
})();
