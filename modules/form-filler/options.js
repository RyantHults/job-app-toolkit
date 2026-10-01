(() => {
  "use strict";

  const MODULE_ID = "form-filler";
  const AI_KEY_LOCAL = "jtk-form-filler-ai-key";
  const AI_KEYS_LOCAL = "jtk-form-filler-ai-keys";
  const AI_ACTIVE_KEY_LOCAL = "jtk-form-filler-ai-active-key";
  const AI_CONTEXT_LOCAL = "jtk-form-filler-ai-context";
  // Profiles are offloaded from storage.sync to storage.local (unlimited) to
  // stay under the 100 KiB sync quota. Same key as background.js/content.js.
  const PROFILES_LOCAL = "jtk-form-filler-profiles";
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
  const aiKeyList = document.getElementById("ai-key-list");
  const aiKeyName = document.getElementById("ai-key-name");
  const aiKeyValue = document.getElementById("ai-key-value");
  const aiKeyAddBtn = document.getElementById("ai-key-add-btn");
  const aiKeyStatus = document.getElementById("ai-key-status");
  const aiSave = document.getElementById("ai-save");
  const aiContextAdd = document.getElementById("ai-context-add");
  const aiContextList = document.getElementById("ai-context-list");
  const aiContextEditor = document.getElementById("ai-context-editor");
  const aiContextTitle = document.getElementById("ai-context-title");
  const aiContextBody = document.getElementById("ai-context-body");
  const aiContextSave = document.getElementById("ai-context-save");
  const aiContextCancel = document.getElementById("ai-context-cancel");
  const aiContextDelete = document.getElementById("ai-context-delete");
  const debugToggle = document.getElementById("debug-toggle");
  const fieldEditOverlay = document.getElementById("field-edit-overlay");
  const fieldEditTitle = document.getElementById("field-edit-title");
  const fieldEditScalar = document.getElementById("field-edit-scalar");
  const fieldEditArray = document.getElementById("field-edit-array");
  const fieldEditSave = document.getElementById("field-edit-save");
  const fieldEditCancel = document.getElementById("field-edit-cancel");

  let data = { active: true, profiles: {}, activeProfile: null, whitelist: [], aiContext: [] };
  let editingIndex = -1;
  let editingIsNew = false;
  let fieldEditResolve = null;
  let fieldEditIsArray = false;

  // Search event listener
  fieldSearch.addEventListener("input", filterFields);

  // ---- Storage ---------------------------------------------------------------

  async function loadData() {
    data = await storage.getModuleData(MODULE_ID);
    // Profiles live in storage.local (offloaded from sync for quota). Prefer
    // the local copy; a non-empty sync copy is pre-migration legacy — move it
    // to local on first load and strip it from sync.
    try {
      const prof = await browser.storage.local.get(PROFILES_LOCAL);
      if (prof[PROFILES_LOCAL] !== undefined) {
        data.profiles = prof[PROFILES_LOCAL];
      } else if (data.profiles && Object.keys(data.profiles).length > 0) {
        await browser.storage.local.set({ [PROFILES_LOCAL]: data.profiles });
        const verify = await browser.storage.local.get(PROFILES_LOCAL);
        if (verify[PROFILES_LOCAL] && Object.keys(verify[PROFILES_LOCAL]).length > 0) {
          await storage.setModuleData(MODULE_ID, { profiles: undefined });
        }
      }
    } catch (e) { /* fall back to whatever module data carried */ }
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
    // Migration: old single key → new multi-key list
    const oldKey = await browser.storage.local.get(AI_KEY_LOCAL);
    const keysData = await browser.storage.local.get(AI_KEYS_LOCAL);
    let aiKeys = Array.isArray(keysData[AI_KEYS_LOCAL]) ? keysData[AI_KEYS_LOCAL] : [];
    if (oldKey[AI_KEY_LOCAL] && !aiKeys.length) {
      const migrated = { id: crypto.randomUUID(), name: "Default", key: oldKey[AI_KEY_LOCAL] };
      aiKeys = [migrated];
      await browser.storage.local.set({ [AI_KEYS_LOCAL]: aiKeys });
      await browser.storage.local.set({ [AI_ACTIVE_KEY_LOCAL]: migrated.id });
    }
    await browser.storage.local.remove(AI_KEY_LOCAL); // clean up legacy

    const activeData = await browser.storage.local.get(AI_ACTIVE_KEY_LOCAL);
    const activeKeyId = activeData[AI_ACTIVE_KEY_LOCAL] || (aiKeys.length ? aiKeys[0].id : null);
    renderKeyList(aiKeys, activeKeyId);
    activeToggle.checked = data.active === true;
    debugToggle.checked = data.debug === true;
  }

  // Entries are persisted to storage.local FIRST (they are the bulky part the
  // sync quota can't hold), then the rest of the module data goes to sync.
  // Profiles also live in storage.local; `profiles: undefined` tells
  // setModuleData to delete any stale sync copy.
  async function saveData() {
    await browser.storage.local.set({ [AI_CONTEXT_LOCAL]: data.aiContext });
    await browser.storage.local.set({ [PROFILES_LOCAL]: data.profiles || {} });
    return storage.setModuleData(MODULE_ID, {
      profiles: undefined,
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
    const isObj = entry && typeof entry === "object" && !Array.isArray(entry);
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
    const storedValue = isObj ? entry.value : entry;
    if (Array.isArray(storedValue) && storedValue.length) {
      const valueNorm = normalize(storedValue.join(" "));
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
      const isObj = entry && typeof entry === "object" && !Array.isArray(entry);
      const value = isObj ? entry.value : entry;
      const label = isObj && entry.label ? entry.label : key;

      const li = document.createElement("li");
      li.className = "field-row";
      li.dataset.key = key;

      const nameSpan = document.createElement("span");
      nameSpan.className = "field-name";
      nameSpan.textContent = label;
      nameSpan.title = label;

      const typeSelect = document.createElement("select");
      typeSelect.className = "field-type-select";
      typeSelect.title = "Field type (used during matching)";
      const entryType = isObj && entry.type ? entry.type : "";
      ["", "text", "textarea", "checkbox", "radio", "select"].forEach(function (t) {
        const opt = document.createElement("option");
        opt.value = t;
        opt.textContent = t || "Any";
        opt.selected = t === entryType;
        typeSelect.appendChild(opt);
      });
      typeSelect.addEventListener("change", async function () {
        const key = li.dataset.key;
        const profile = currentProfile();
        if (!profile || !profile.fields || !profile.fields[key]) return;
        const field = profile.fields[key];
        if (typeof field === "string" || Array.isArray(field)) {
          // Legacy string entry — promote to the { value, label, type } format.
          profile.fields[key] = { value: field, label: key, type: typeSelect.value };
        } else {
          field.type = typeSelect.value;
        }
        await saveData();
        render();
      });

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
      editBtn.setAttribute("aria-label", 'Edit saved field title and value for "' + label + '"');
      editBtn.addEventListener("click", () => editField(key));

      li.appendChild(nameSpan);
      li.appendChild(typeSelect);
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

  function openFieldEditor(key) {
    const profile = currentProfile();
    if (!profile || !Object.prototype.hasOwnProperty.call(profile.fields, key)) return;
    const entry = profile.fields[key];
    const isObj = entry && typeof entry === "object" && !Array.isArray(entry);
    const currentLabel = isObj && entry.label ? entry.label : key;
    const currentValue = isObj ? entry.value : entry;
    fieldEditIsArray = Array.isArray(currentValue);
    fieldEditResolve = null;
    fieldEditTitle.value = currentLabel;
    fieldEditScalar.value = fieldEditIsArray ? "" : String(currentValue == null ? "" : currentValue);
    fieldEditArray.value = fieldEditIsArray ? currentValue.join("\n") : "";
    fieldEditScalar.hidden = fieldEditIsArray;
    fieldEditArray.hidden = !fieldEditIsArray;
    fieldEditOverlay.querySelector(".modal-message").textContent =
      'Edit saved field "' + currentLabel + '"';
    fieldEditOverlay.hidden = false;
    fieldEditTitle.focus();
    fieldEditTitle.select();
    return new Promise(function (resolve) {
      fieldEditResolve = resolve;
    });
  }

  function closeFieldEditor(result) {
    if (!fieldEditResolve) return;
    const resolve = fieldEditResolve;
    fieldEditResolve = null;
    fieldEditOverlay.hidden = true;
    resolve(result);
  }

  async function editField(key) {
    const result = await openFieldEditor(key);
    if (result === null || !result) return;
    const profile = currentProfile();
    if (!profile || !Object.prototype.hasOwnProperty.call(profile.fields, key)) return;
    const entry = profile.fields[key];
    const isObj = entry && typeof entry === "object" && !Array.isArray(entry);
    const label = result.label.trim();
    if (!label) {
      ui.setStatus("Field title cannot be empty.");
      return;
    }
    let value;
    if (fieldEditIsArray) {
      value = result.value.split("\n").map(item => item.trim()).filter(Boolean);
    } else {
      value = result.value.trim();
      if (!value) {
        ui.setStatus("Field value cannot be empty.");
        return;
      }
    }
    if (isObj) {
      entry.label = label;
      entry.value = value;
    } else {
      // Legacy scalar/array entry — promote it while retaining the edited
      // value's scalar versus array shape.
      profile.fields[key] = { value: value, label: label };
    }
    await saveData();
    render();
    ui.setStatus("Field updated.");
  }

  function fieldEditorResult() {
    return { label: fieldEditTitle.value, value: fieldEditIsArray ? fieldEditArray.value : fieldEditScalar.value };
  }

  fieldEditSave.addEventListener("click", () => closeFieldEditor(fieldEditorResult()));
  fieldEditCancel.addEventListener("click", () => closeFieldEditor(null));
  fieldEditOverlay.addEventListener("click", e => {
    if (e.target === fieldEditOverlay) closeFieldEditor(null);
  });
  fieldEditOverlay.addEventListener("keydown", e => {
    if (e.key === "Escape") closeFieldEditor(null);
  });

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

  function renderKeyList(keys, activeId) {
    aiKeyList.innerHTML = "";
    keys.forEach(function (k) {
      const li = document.createElement("li");
      li.className = "key-item" + (k.id === activeId ? " active" : "");

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "ai-key-select";
      radio.checked = k.id === activeId;
      radio.addEventListener("change", async function () {
        await browser.storage.local.set({ [AI_ACTIVE_KEY_LOCAL]: k.id });
        renderKeyList(keys, k.id);
      });

      const nameSpan = document.createElement("span");
      nameSpan.className = "key-name";
      nameSpan.textContent = k.name || "(unnamed)";

      const tailSpan = document.createElement("span");
      tailSpan.className = "key-tail";
      tailSpan.textContent = "\u2026 " + (k.key ? k.key.slice(-4) : "????");

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async function () {
        const remaining = keys.filter(function (x) { return x.id !== k.id; });
        let nextActive = activeId;
        if (nextActive === k.id) {
          nextActive = remaining.length ? remaining[0].id : null;
        }
        await browser.storage.local.set({ [AI_KEYS_LOCAL]: remaining });
        await browser.storage.local.set({ [AI_ACTIVE_KEY_LOCAL]: nextActive });
        renderKeyList(remaining, nextActive);
        ui.setStatus("Key removed.");
      });

      li.appendChild(radio);
      li.appendChild(nameSpan);
      li.appendChild(tailSpan);
      li.appendChild(removeBtn);
      aiKeyList.appendChild(li);
    });
  }

  aiSave.addEventListener("click", async () => {
    const endpoint = aiEndpoint.value.trim();
    const model = aiModel.value.trim();
    if (!endpoint || !model) {
      ui.setStatus("Enter an endpoint and model.");
      return;
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

  // Add a named API key to the list; the first key is auto-selected.
  aiKeyAddBtn.addEventListener("click", async function () {
    const name = aiKeyName.value.trim();
    const key = aiKeyValue.value.trim();
    if (!key) { ui.setStatus("Enter an API key."); return; }
    const id = crypto.randomUUID();
    const entry = { id: id, name: name || "Unnamed", key: key };
    const keysData = await browser.storage.local.get(AI_KEYS_LOCAL);
    const keys = Array.isArray(keysData[AI_KEYS_LOCAL]) ? keysData[AI_KEYS_LOCAL] : [];
    keys.push(entry);
    await browser.storage.local.set({ [AI_KEYS_LOCAL]: keys });
    // Auto-select if it's the first key
    const activeData = await browser.storage.local.get(AI_ACTIVE_KEY_LOCAL);
    if (!activeData[AI_ACTIVE_KEY_LOCAL]) {
      await browser.storage.local.set({ [AI_ACTIVE_KEY_LOCAL]: id });
    }
    const newActive = (await browser.storage.local.get(AI_ACTIVE_KEY_LOCAL))[AI_ACTIVE_KEY_LOCAL] || id;
    renderKeyList(keys, newActive);
    aiKeyName.value = "";
    aiKeyValue.value = "";
    ui.setStatus("Key added.");
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

  // ---- Correction history -----------------------------------------------------

  // Marked-incorrect fields (exclusions) are global and stored in
  // browser.storage.local by the background; this section only shows the
  // count and offers a clear-all. The section is built here (not in
  // options.html) so the feature stays self-contained.
  const exclusionsSection = document.createElement("section");
  exclusionsSection.className = "section";
  exclusionsSection.setAttribute("aria-label", "Correction history");

  const exclusionsHeading = document.createElement("h2");
  exclusionsHeading.textContent = "Correction history";
  exclusionsSection.appendChild(exclusionsHeading);

  const exclusionsCount = document.createElement("p");
  exclusionsCount.className = "subtitle";
  exclusionsSection.appendChild(exclusionsCount);

  const exclusionsClearBtn = document.createElement("button");
  exclusionsClearBtn.type = "button";
  exclusionsClearBtn.className = "btn";
  exclusionsClearBtn.textContent = "Clear all";
  exclusionsSection.appendChild(exclusionsClearBtn);

  const statusLine = document.getElementById("status");
  if (statusLine && statusLine.parentNode) {
    statusLine.parentNode.insertBefore(exclusionsSection, statusLine);
  } else {
    document.body.appendChild(exclusionsSection);
  }

  function renderExclusionsCount(count) {
    const n = typeof count === "number" ? count : 0;
    exclusionsCount.textContent =
      n +
      " marked-incorrect field" +
      (n === 1 ? "" : "s") +
      " (corrections are global \u2014 they apply on every site)";
  }

  async function loadExclusions() {
    try {
      const res = await browser.runtime.sendMessage({ type: "form-filler:getExclusions" });
      if (res && res.ok && typeof res.count === "number") {
        renderExclusionsCount(res.count);
      }
    } catch (err) {
      // Background unavailable; leave the section empty rather than throw.
    }
  }

  exclusionsClearBtn.addEventListener("click", async () => {
    if (!(await ui.showConfirm("Clear all marked-incorrect fields?"))) return;
    try {
      const res = await browser.runtime.sendMessage({ type: "form-filler:clearExclusions" });
      if (res && res.ok) {
        renderExclusionsCount(0);
        ui.setStatus("Correction history cleared.");
      } else {
        ui.setStatus((res && res.error) || "Could not clear correction history.");
      }
    } catch (err) {
      ui.setStatus("Could not clear correction history.");
    }
  });

  // ---- Page templates ---------------------------------------------------------

  // Saved page templates live in browser.storage.local (managed by the
  // background); this section lists them with a delete button. Built here
  // (not in options.html) so the feature stays self-contained, same as the
  // correction-history section above.
  const templatesSection = document.createElement("section");
  templatesSection.className = "section";
  templatesSection.setAttribute("aria-label", "Page templates");

  const templatesHeading = document.createElement("h2");
  templatesHeading.textContent = "Page templates";
  templatesSection.appendChild(templatesHeading);

  const templatesSubtitle = document.createElement("p");
  templatesSubtitle.className = "subtitle";
  templatesSubtitle.textContent =
    "Saved page templates fill all fields when the page's field shape matches.";
  templatesSection.appendChild(templatesSubtitle);

  const templatesList = document.createElement("ul");
  templatesList.id = "templates-list";
  templatesSection.appendChild(templatesList);

  // Insert after the correction-history section (it sits right before the
  // status line).
  if (exclusionsSection && exclusionsSection.parentNode) {
    exclusionsSection.parentNode.insertBefore(templatesSection, exclusionsSection.nextSibling);
  } else if (statusLine && statusLine.parentNode) {
    statusLine.parentNode.insertBefore(templatesSection, statusLine);
  } else {
    document.body.appendChild(templatesSection);
  }

  // Templates as rendered: { "<id>": { name, shape, fields, savedUrl, createdAt } }.
  let templatesData = null;

  function renderTemplates(templates) {
    templatesData = templates || {};
    templatesList.textContent = "";
    const list = Object.keys(templatesData).map((id) => ({
      id: id,
      tpl: templatesData[id]
    }));
    list.sort((a, b) => (b.tpl.createdAt || 0) - (a.tpl.createdAt || 0));
    if (list.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No templates saved.";
      templatesList.appendChild(li);
      return;
    }
    for (const entry of list) {
      const li = document.createElement("li");
      li.className = "template-row";

      const nameSpan = document.createElement("span");
      nameSpan.className = "template-name";
      nameSpan.textContent = (entry.tpl.name && entry.tpl.name.trim()) || "Untitled template";
      nameSpan.title = entry.tpl.name || "";

      const urlText = typeof entry.tpl.savedUrl === "string" ? entry.tpl.savedUrl : "";
      const urlSpan = document.createElement("span");
      urlSpan.className = "template-url";
      urlSpan.textContent = urlText.length > 60 ? urlText.slice(0, 60) + "\u2026" : urlText;
      urlSpan.title = urlText;

      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-sm template-del";
      del.dataset.templateId = entry.id;
      del.textContent = "Delete";

      li.appendChild(nameSpan);
      li.appendChild(urlSpan);
      li.appendChild(del);
      templatesList.appendChild(li);
    }
  }

  async function loadTemplates() {
    try {
      const res = await browser.runtime.sendMessage({ type: "form-filler:getTemplates" });
      if (res && res.ok) {
        renderTemplates(res.templates);
      }
    } catch (err) {
      // Background unavailable; leave the section empty rather than throw.
    }
  }

  // Event delegation so Delete buttons keep working after re-renders.
  templatesList.addEventListener("click", async (event) => {
    const btn = event.target.closest(".template-del");
    if (!btn || !btn.dataset || !btn.dataset.templateId) return;
    const tpl = templatesData[btn.dataset.templateId] || {};
    const name = (tpl.name && tpl.name.trim()) || "template";
    if (!(await ui.showConfirm('Delete template "' + name + '"?'))) return;
    try {
      const res = await browser.runtime.sendMessage({
        type: "form-filler:deleteTemplate",
        templateId: btn.dataset.templateId
      });
      if (res && res.ok) {
        await loadTemplates();
        ui.setStatus("Template deleted.");
      } else {
        ui.setStatus((res && res.error) || "Could not delete template.");
      }
    } catch (err) {
      ui.setStatus("Could not delete template.");
    }
  });

  // ---- Init -------------------------------------------------------------------

  loadData().then(() => {
    fieldSearch.value = "";
    filterFields();
    render();
    loadExclusions();
    loadTemplates();
  }).catch(handleError);
})();
