/**
 * Job App Toolkit — shared storage (loaded by the background event page, the
 * popup and every module options page). Owns the namespaced per-module store
 * under a single "jobAppToolkit" key, per-module active flags, and the one-time
 * migration from the legacy "formFillerData" flat store (old key is kept so the
 * data can be recovered if the addon is ever rolled back).
 */
(function () {
  "use strict";

  const KEY = "jobAppToolkit";
  const LEGACY_KEY = "formFillerData";

  // Module data defaults to ACTIVE when nothing has been written yet, so a
  // fresh install (or a newly added module) works out of the box.
  function moduleData(store, id) {
    const mod = store.modules[id];
    if (mod && typeof mod === "object") return mod;
    return { active: true };
  }

  async function migrate() {
    const res = await browser.storage.sync.get([KEY, LEGACY_KEY]);
    if (res[KEY]) return;
    const legacy = res[LEGACY_KEY];
    if (!legacy || typeof legacy !== "object" || !legacy.profiles) return;
    await browser.storage.sync.set({
      [KEY]: {
        modules: {
          "form-filler": {
            active: true,
            profiles: legacy.profiles || {},
            activeProfile: legacy.activeProfile || null
          }
        }
      }
    });
  }

  async function getAll() {
    await migrate();
    const res = await browser.storage.sync.get(KEY);
    const data = res[KEY];
    if (data && typeof data === "object" && data.modules) return data;
    return { modules: {} };
  }

  async function setAll(data) {
    await browser.storage.sync.set({ [KEY]: data });
  }

  // The whole module object: { active, ...modulePayload }. Returned as a
  // detached copy so callers can hold it across their own setModuleData
  // writes without aliasing the store (a later delete/merge must never
  // mutate data a caller is still reading).
  async function getModuleData(id) {
    const store = await getAll();
    return JSON.parse(JSON.stringify(moduleData(store, id)));
  }

  async function isModuleActive(id) {
    const mod = await getModuleData(id);
    return mod.active === true;
  }

  async function setModuleActive(id, active) {
    const store = await getAll();
    const mod = moduleData(store, id);
    mod.active = Boolean(active);
    store.modules[id] = mod;
    await setAll(store);
  }

  // Merge a payload into the module's data (preserves the active flag).
  // Keys with an `undefined` value are deleted — this lets callers offload
  // a key to storage.local while cleaning up the sync blob.
  async function setModuleData(id, data) {
    const store = await getAll();
    const mod = moduleData(store, id);
    const keys = Object.keys(data);
    for (let i = 0; i < keys.length; i++) {
      if (data[keys[i]] === undefined) delete mod[keys[i]];
      else mod[keys[i]] = data[keys[i]];
    }
    store.modules[id] = mod;
    await setAll(store);
  }

  window.jobAppToolkit = window.jobAppToolkit || {};
  window.jobAppToolkit.storage = {
    getAll: getAll,
    setAll: setAll,
    getModuleData: getModuleData,
    setModuleData: setModuleData,
    isModuleActive: isModuleActive,
    setModuleActive: setModuleActive
  };
})();
