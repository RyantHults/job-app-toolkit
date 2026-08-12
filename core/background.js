/**
 * Job App Toolkit — core background (event page). Loaded after core/storage.js
 * and before the module background scripts.
 *
 * Provides:
 *  - the module registry (modules call registerModule at load time);
 *  - the shared "Job App Toolkit" context-menu root;
 *  - a message router: "jtk:*" is core-reserved, "<moduleId>:*" is dispatched
 *    to the owning module;
 *  - in-page toasts (routed to the content script of a tab, with optional
 *    action button — e.g. "Undo" — for immediate recovery), module activity
 *    toggling and the last-focused web-tab tracker (used so module options
 *    pages can fill the page the user is working on).
 */
(function () {
  "use strict";

  const MENU_ROOT_ID = "job-app-toolkit-menu";

  const g = window.jobAppToolkit;
  const modules = {}; // id -> registered module

  let lastWebTabId = null;

  // ------------------------------------------------------------------
  // In-page toast
  // ------------------------------------------------------------------

  // Ask the content script of a tab to show an in-page toast. Feedback is
  // rendered on the page itself, so it never depends on OS desktop
  // notifications. Errors are ignored: the page may have no content script
  // (e.g. a browser-internal page). An optional `action` ({ type, label,
  // payload }) renders an action button on the toast; clicking it sends
  // `{ type, ...payload }` back to the background. An optional `moduleId`
  // identifies the originating module so module-specific debug features
  // can filter toasts.
  function notify(tabId, title, message, action, moduleId) {
    if (typeof tabId !== "number") return Promise.resolve(false);
    return browser.tabs
      .sendMessage(tabId, {
        type: "jtk:showToast",
        title: title || "",
        message: message || "",
        action: action || null,
        module: moduleId || ""
      })
      .then(
        () => true,
        () => false
      );
  }

  // ------------------------------------------------------------------
  // API handed to modules
  // ------------------------------------------------------------------

  function moduleApi() {
    return {
      MENU_ROOT_ID: MENU_ROOT_ID,
      lastWebTabId: lastWebTabId,
      notify: notify,
      getModuleData: g.storage.getModuleData,
      setModuleData: g.storage.setModuleData,
      isModuleActive: g.storage.isModuleActive,
      setModuleActive: g.storage.setModuleActive
    };
  }

  // ------------------------------------------------------------------
  // Context menus
  // ------------------------------------------------------------------

  async function createContextMenus() {
    await browser.contextMenus.removeAll();
    browser.contextMenus.create({
      id: MENU_ROOT_ID,
      title: "Job App Toolkit",
      contexts: ["all"]
    });
    for (const mod of Object.values(modules)) {
      if (typeof mod.createContextMenu !== "function") continue;
      if (!(await g.storage.isModuleActive(mod.id))) continue;
      try {
        mod.createContextMenu(moduleApi());
      } catch (err) {
        console.error("Job App Toolkit: failed to create menus for " + mod.id, err);
      }
    }
  }

  // Modules filter their own menu ids: the event page may be re-created at any
  // time (persistent: false), so we must not rely on cached menu state from a
  // previous wake-up — every module's handler is invoked and no-ops unless the
  // clicked item is one of its own.
  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!info.menuItemId || info.menuItemId === MENU_ROOT_ID) return;
    for (const mod of Object.values(modules)) {
      if (typeof mod.handleMenuClick !== "function") continue;
      try {
        await mod.handleMenuClick(info, tab, moduleApi());
      } catch (err) {
        console.error("Job App Toolkit: menu handler failed for " + mod.id, err);
      }
    }
  });

  // ------------------------------------------------------------------
  // Module registry
  // ------------------------------------------------------------------

  function registerModule(module) {
    if (!module || typeof module.id !== "string" || !module.id) {
      throw new Error("jobAppToolkit.registerModule requires a module id");
    }
    modules[module.id] = module;
    // Carry the optional export/import data hooks on the stored module object
    // (they may be undefined for modules that don't implement them; the
    // jtk:exportData / jtk:importData router cases read them from here).
    modules[module.id].exportData = module.exportData;
    modules[module.id].importData = module.importData;
  }

  // ------------------------------------------------------------------
  // Activity broadcast (toggle on/off without reloading tabs)
  // ------------------------------------------------------------------

  async function broadcastModuleActivity(id, active) {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      try {
        await browser.tabs.sendMessage(tab.id, {
          type: "jtk:moduleActivityChanged",
          id: id,
          active: active
        });
      } catch (err) {
        // No content script on this tab — ignore.
      }
    }
  }

  // ------------------------------------------------------------------
  // Last-focused web tab (for module options pages)
  // ------------------------------------------------------------------

  browser.tabs.onActivated.addListener(async (info) => {
    try {
      const tab = await browser.tabs.get(info.tabId);
      if (tab.url && /^https?:/i.test(tab.url)) lastWebTabId = tab.id;
    } catch (err) {
      // Ignore.
    }
  });

  // ------------------------------------------------------------------
  // Message router
  // ------------------------------------------------------------------

  browser.runtime.onMessage.addListener(function onMessage(message, sender) {
    if (!message || typeof message.type !== "string") return undefined;

    switch (message.type) {
      case "jtk:getModules": {
        return Promise.all(
          Object.values(modules).map(async (mod) => ({
            id: mod.id,
            name: mod.name || mod.id,
            description: mod.description || "",
            active: await g.storage.isModuleActive(mod.id),
            optionsUrl: mod.optionsUrl || null,
            quickActions: (mod.quickActions || []).map((a) => ({ id: a.id, label: a.label }))
          }))
        );
      }

      case "jtk:setModuleActive": {
        return g.storage.setModuleActive(message.id, message.active).then(async () => {
          await createContextMenus();
          await broadcastModuleActivity(message.id, Boolean(message.active));
          return { ok: true };
        });
      }

      case "jtk:runQuickAction": {
        const mod = modules[message.moduleId];
        const action =
          mod && (mod.quickActions || []).find((a) => a.id === message.actionId);
        if (!action) {
          return Promise.resolve({ ok: false, error: "Unknown quick action." });
        }
        // The module is responsible for its own feedback (it notifies its
        // target tab in-page); this only relays the outcome to the caller.
        return Promise.resolve(action.handler(moduleApi())).then(
          (res) => res || { ok: false, error: "No result." },
          (err) => {
            console.error(
              "Job App Toolkit: quick action failed for " + message.moduleId,
              err
            );
            return { ok: false, error: String((err && err.message) || err) };
          }
        );
      }

      case "jtk:openOptions": {
        if (!message.url) return Promise.resolve({ ok: false });
        return browser.tabs
          .create({ url: browser.runtime.getURL(message.url) })
          .then(
            () => ({ ok: true }),
            () => ({ ok: false })
          );
      }

      case "jtk:exportData": {
        const includeApiKey = Boolean(message.includeApiKey);
        const exportedModules = {};
        return Promise.all(
          Object.values(modules).map(async (mod) => {
            const active = await g.storage.isModuleActive(mod.id);
            if (typeof mod.exportData === "function") {
              const res = await mod.exportData(moduleApi(), {
                includeApiKey: includeApiKey
              });
              exportedModules[mod.id] = {
                active: active,
                data: res.data,
                local: res.local
              };
            } else {
              const data = Object.assign({}, await g.storage.getModuleData(mod.id));
              delete data.active;
              exportedModules[mod.id] = { active: active, data: data, local: {} };
            }
          })
        ).then(() => ({
          ok: true,
          export: {
            format: "job-app-toolkit",
            version: 1,
            exportedAt: new Date().toISOString(),
            modules: exportedModules
          }
        }));
      }

      case "jtk:importData": {
        const exp = message.export;
        if (
          !exp ||
          exp.format !== "job-app-toolkit" ||
          exp.version !== 1 ||
          !exp.modules ||
          typeof exp.modules !== "object" ||
          Array.isArray(exp.modules)
        ) {
          return Promise.resolve({ ok: false, error: "Unsupported export format." });
        }
        const imported = [];
        // Imports run sequentially: storage.js reads-modifies-writes the whole
        // "jobAppToolkit" key per call, so parallel writes would lose updates.
        return Object.keys(exp.modules).reduce(
          (chain, id) =>
            chain.then(async () => {
              const exported = exp.modules[id];
              const mod = modules[id];
              try {
                if (mod && typeof mod.importData === "function") {
                  await mod.importData(moduleApi(), exported);
                } else {
                  await g.storage.setModuleData(id, exported.data || {});
                  await g.storage.setModuleActive(id, Boolean(exported.active !== false));
                }
                imported.push(id);
              } catch (err) {
                console.error("Job App Toolkit: import failed for " + id, err);
              }
            }),
          Promise.resolve()
        ).then(() => ({ ok: true, imported: imported }));
      }

      default: {
        for (const mod of Object.values(modules)) {
          if (message.type.indexOf(mod.id + ":") === 0) {
          if (typeof mod.handleMessage !== "function") return undefined;
          return Promise.resolve(mod.handleMessage(message, sender, moduleApi()));
          }
        }
        return undefined;
      }
    }
  });

  browser.runtime.onInstalled.addListener(createContextMenus);
  browser.runtime.onStartup.addListener(createContextMenus);

  g.registerModule = registerModule;
})();
