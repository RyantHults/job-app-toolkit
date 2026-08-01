(() => {
  "use strict";

  const STORAGE_KEY = "formFillerData";

  const profileSelect = document.getElementById("profile-select");
  const fillBtn = document.getElementById("fill-btn");
  const addFieldBtn = document.getElementById("add-field-btn");
  const fieldsList = document.getElementById("fields-list");
  const newProfileBtn = document.getElementById("new-profile-btn");
  const renameProfileBtn = document.getElementById("rename-profile-btn");
  const deleteProfileBtn = document.getElementById("delete-profile-btn");
  const statusEl = document.getElementById("status");

  let data = { profiles: {}, activeProfile: null };

  // ---- Storage ---------------------------------------------------------------

  async function loadData() {
    const result = await browser.storage.sync.get(STORAGE_KEY);
    data = result[STORAGE_KEY] || { profiles: {}, activeProfile: null };
    if (!data.profiles || typeof data.profiles !== "object") {
      data.profiles = {};
    }
    if (!data.activeProfile || !(data.activeProfile in data.profiles)) {
      data.activeProfile = Object.keys(data.profiles)[0] || null;
    }
  }

  function saveData() {
    return browser.storage.sync.set({ [STORAGE_KEY]: data });
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

  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  async function getActiveTab() {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  function handleError(err) {
    console.error("Form Filler popup error:", err);
    setStatus("Something went wrong");
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

    for (const [name, value] of entries) {
      const li = document.createElement("li");
      li.className = "field-row";

      const nameSpan = document.createElement("span");
      nameSpan.className = "field-name";
      nameSpan.textContent = name;
      nameSpan.title = name;

      const valueSpan = document.createElement("span");
      valueSpan.className = "field-value";
      valueSpan.textContent = String(value);
      valueSpan.title = String(value);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-sm field-del";
      del.textContent = "Del";
      del.addEventListener("click", () => deleteField(name));

      li.appendChild(nameSpan);
      li.appendChild(valueSpan);
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
    if (!window.confirm('Delete field "' + name + '"?')) return;
    delete profile.fields[name];
    await saveData();
    render();
  }

  // ---- Handlers ---------------------------------------------------------------

  profileSelect.addEventListener("change", () => {
    setActiveProfile(profileSelect.value).catch(handleError);
  });

  fillBtn.addEventListener("click", async () => {
    const profile = currentProfile();
    if (!profile) {
      setStatus("No active profile.");
      return;
    }
    try {
      const tab = await getActiveTab();
      if (!tab) {
        setStatus("No active tab found.");
        return;
      }
      const response = await browser.tabs.sendMessage(tab.id, {
        type: "fillPage",
        activeProfile: { fields: profile.fields || {} },
      });
      let msg = "Filled " + response.filled + ", skipped " + response.skipped;
      if (response.unmatched) {
        msg += ", unmatched " + response.unmatched;
      }
      setStatus(msg);
    } catch (err) {
      setStatus("Cannot fill this page");
    }
  });

  addFieldBtn.addEventListener("click", async () => {
    const profile = currentProfile();
    if (!profile) {
      setStatus("No active profile.");
      return;
    }
    let tab;
    let field;
    try {
      tab = await getActiveTab();
      if (!tab) {
        setStatus("No active tab found.");
        return;
      }
      field = await browser.tabs.sendMessage(tab.id, { type: "getFocusedField" });
    } catch (err) {
      setStatus("Cannot read the current page");
      return;
    }
    if (!field || !field.name) {
      setStatus("No focused form field detected");
      return;
    }

    const name = window.prompt("Field name:", field.name);
    if (name === null) return;
    const trimmedName = name.trim();
    if (!trimmedName) return;

    const value = window.prompt("Value to save:", field.value !== undefined ? field.value : "");
    if (value === null) return;

    profile.fields = profile.fields || {};
    if (Object.prototype.hasOwnProperty.call(profile.fields, trimmedName)) {
      if (!window.confirm('Field "' + trimmedName + '" already exists. Overwrite it?')) {
        return;
      }
    }
    profile.fields[trimmedName] = value;
    await saveData();
    render();
    setStatus('Added field "' + trimmedName + '".');
  });

  newProfileBtn.addEventListener("click", async () => {
    const raw = window.prompt("New profile name:");
    if (raw === null) return;
    const name = raw.trim();
    if (!name) return;
    if (isDuplicateProfile(name)) {
      window.alert("A profile with that name already exists.");
      return;
    }
    data.profiles[name] = { fields: {} };
    data.activeProfile = name;
    await saveData();
    render();
    setStatus('Profile "' + name + '" created.');
  });

  renameProfileBtn.addEventListener("click", async () => {
    const oldName = data.activeProfile;
    if (!oldName) return;
    const raw = window.prompt('New name for profile "' + oldName + '":', oldName);
    if (raw === null) return;
    const name = raw.trim();
    if (!name || name === oldName) return;
    if (isDuplicateProfile(name)) {
      window.alert("A profile with that name already exists.");
      return;
    }
    data.profiles[name] = data.profiles[oldName];
    delete data.profiles[oldName];
    data.activeProfile = name;
    await saveData();
    render();
    setStatus('Profile renamed to "' + name + '".');
  });

  deleteProfileBtn.addEventListener("click", async () => {
    const name = data.activeProfile;
    if (!name) return;
    if (!window.confirm('Delete profile "' + name + '"?')) return;
    delete data.profiles[name];
    const remaining = profileNames();
    data.activeProfile = remaining.length ? remaining[0] : null;
    await saveData();
    render();
  });

  // ---- Init -------------------------------------------------------------------

  // The script is loaded with `defer`, so by the time it runs the DOM is
  // already parsed and DOMContentLoaded has already fired. Call init directly.
  loadData().then(render).catch(handleError);
})();
