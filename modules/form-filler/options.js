(() => {
  "use strict";

  const MODULE_ID = "form-filler";

  const storage = window.jobAppToolkit.storage;
  const ui = window.jobAppToolkit.ui;

  const activeToggle = document.getElementById("active-toggle");
  const profileSelect = document.getElementById("profile-select");
  const fillBtn = document.getElementById("fill-btn");
  const addFieldBtn = document.getElementById("add-field-btn");
  const addAllFieldsBtn = document.getElementById("add-all-fields-btn");
  const fieldsList = document.getElementById("fields-list");
  const fieldSearch = document.getElementById("field-search");
  const newProfileBtn = document.getElementById("new-profile-btn");
  const renameProfileBtn = document.getElementById("rename-profile-btn");
  const deleteProfileBtn = document.getElementById("delete-profile-btn");

  let data = { active: true, profiles: {}, activeProfile: null };

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
    activeToggle.checked = data.active === true;
  }

  function saveData() {
    return storage.setModuleData(MODULE_ID, {
      profiles: data.profiles,
      activeProfile: data.activeProfile
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
        "No fields in this profile. Use the context menu on a form field to add one, or click '+ Add Current Field'.";
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
      valueSpan.textContent = String(value);
      valueSpan.title = String(value);

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

  function render() {
    renderProfileSelect();
    renderFields();
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

  // ---- Init -------------------------------------------------------------------

  loadData().then(() => {
    fieldSearch.value = "";
    filterFields();
    render();
  }).catch(handleError);
})();
