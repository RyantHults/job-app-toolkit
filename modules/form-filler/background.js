/**
 * Form Filler — background module. Registers with the Job App Toolkit core and
 * owns:
 *  - the "Form Filler" context-menu submenu (Add field / Fill field / Fill page);
 *  - popup quick actions ("Fill Page" and "Add Current Field");
 *  - request handlers used by the module options page.
 *
 * All fill/capture logic lives in the content script; this script mediates
 * storage, menus, in-page feedback and tab targeting.
 */
(function () {
  "use strict";

  const MODULE_ID = "form-filler";

  const MENU = {
    root: MODULE_ID + "-menu",
    add: MODULE_ID + "-add-field",
    addAll: MODULE_ID + "-add-all-fields",
    fill: MODULE_ID + "-fill-field",
    fillPage: MODULE_ID + "-fill-page"
  };

  // ------------------------------------------------------------------
  // Context menu
  // ------------------------------------------------------------------

  function createContextMenu(api) {
    browser.contextMenus.create({
      id: MENU.root,
      parentId: api.MENU_ROOT_ID,
      title: "Form Filler",
      contexts: ["all"]
    });
    browser.contextMenus.create({
      id: MENU.add,
      parentId: MENU.root,
      title: "Add field to profile",
      contexts: ["all"]
    });
    browser.contextMenus.create({
      id: MENU.addAll,
      parentId: MENU.root,
      title: "Add all fields to profile",
      contexts: ["all"]
    });
    browser.contextMenus.create({
      id: MENU.fill,
      parentId: MENU.root,
      title: "Fill field from profile",
      contexts: ["all"]
    });
    browser.contextMenus.create({
      id: MENU.fillPage,
      parentId: MENU.root,
      title: "Fill page from profile",
      contexts: ["all"]
    });
    return [MENU.root, MENU.add, MENU.fill, MENU.fillPage];
  }

  // The tab whose page the user is actually working on: the last-focused web
  // tab (kept by the core) so actions from the popup and from this module's
  // options page both land on the right tab. Falls back to the first web tab.
  async function getWebTab(api) {
    if (api.lastWebTabId) {
      try {
        const tab = await browser.tabs.get(api.lastWebTabId);
        if (tab && typeof tab.id === "number") return tab;
      } catch (err) {
        // Fall through.
      }
    }
    const tabs = await browser.tabs.query({});
    const webTabs = tabs.filter((t) => typeof t.id === "number" && t.url && /^https?:/i.test(t.url));
    return webTabs.find((t) => t.active) || webTabs[0] || null;
  }

  // Send a message to the content script of a frame in the target tab. Defaults
  // to the top frame (frameId 0) so popup/options flows behave exactly as
  // before; context-menu flows pass info.frameId so actions land on the frame
  // that was actually clicked (forms often live inside iframes on job portals).
  // Returns null when the frame has no content script or it is inactive.
  async function sendToContent(tab, message, frameId) {
    try {
      const res = await browser.tabs.sendMessage(tab.id, message, {
        frameId: frameId == null ? 0 : frameId
      });
      return res || null;
    } catch (err) {
      return null;
    }
  }

  // Frame ids of a tab, main frame first. Job portals (iCIMS, Workday, ...)
  // render their forms in nested iframes, so actions must reach every frame.
  // Falls back to just the main frame when the frames API is unavailable.
  async function frameIdsOf(tab) {
    try {
      const frames = await browser.tabs.getAllFrames(tab.id);
      if (frames && frames.length) {
        return frames.filter((f) => !f.errorOccurred).map((f) => f.frameId);
      }
    } catch (err) {
      // Fall through to the main frame only.
    }
    return [0];
  }

  // Collect fields from every frame of the tab and merge the results. Fields
  // are deduped by name (first frame wins). Returns null when no frame could
  // respond. When the first pass finds nothing, a second "force" pass asks the
  // main frame to walk even same-origin iframes that carry their own content
  // script — per-frame messaging may have failed to reach them, but the main
  // frame can still read them directly.
  async function collectFieldsFromTab(tab, profileFields) {
    const frameIds = await frameIdsOf(tab);

    const merged = { fields: [], skippedExisting: 0, skippedEmpty: 0, found: 0 };
    const seen = new Set();
    let anyResponded = false;
    let responded = 0;

    const sendOne = async (frameId, message) => {
      try {
        return await browser.tabs.sendMessage(tab.id, message, { frameId: frameId });
      } catch (err) {
        return null;
      }
    };

    for (const frameId of frameIds) {
      const res = await sendOne(frameId, {
        type: "form-filler:collectFields",
        profileFields: profileFields || {}
      });
      if (!res || !Array.isArray(res.fields)) continue;
      anyResponded = true;
      responded++;
      merged.found += res.found || 0;
      merged.skippedExisting += res.skippedExisting || 0;
      merged.skippedEmpty += res.skippedEmpty || 0;
      for (const f of res.fields) {
        if (seen.has(f.name)) continue;
        seen.add(f.name);
        merged.fields.push(f);
      }
    }

    if (anyResponded && merged.fields.length === 0 && merged.found === 0) {
      const forced = await sendOne(0, {
        type: "form-filler:collectFields",
        profileFields: profileFields || {},
        force: true
      });
      if (forced && Array.isArray(forced.fields)) {
        merged.fields = forced.fields;
        merged.found = forced.found || 0;
        merged.skippedExisting += forced.skippedExisting || 0;
        merged.skippedEmpty += forced.skippedEmpty || 0;
      }
    }

    if (anyResponded) {
      console.log(
        "[Form Filler] collect: frames=" + frameIds.length + " responded=" + responded + " fields=" + merged.fields.length
      );
    }
    return anyResponded ? merged : null;
  }

  // Fill every frame of the tab from the profile and sum the results. When
  // nothing matched anywhere, a "force" pass asks the main frame to walk even
  // same-origin iframes that carry their own content script (per-frame
  // messaging may not have reached them).
  async function fillPageAcrossFrames(tab, fields) {
    const frameIds = await frameIdsOf(tab);
    const totals = { filled: 0, skipped: 0, unmatched: 0 };
    let anyResponded = false;
    let responded = 0;

    const sendOne = async (frameId, message) => {
      try {
        return await browser.tabs.sendMessage(tab.id, message, { frameId: frameId });
      } catch (err) {
        return null;
      }
    };

    for (const frameId of frameIds) {
      const res = await sendOne(frameId, {
        type: "form-filler:fillPage",
        activeProfile: { fields: fields || {} }
      });
      if (!res || typeof res !== "object") continue;
      anyResponded = true;
      responded++;
      totals.filled += res.filled || 0;
      totals.skipped += res.skipped || 0;
      totals.unmatched += res.unmatched || 0;
    }

    if (
      anyResponded &&
      totals.filled === 0 &&
      totals.skipped === 0 &&
      totals.unmatched > 0
    ) {
      const forced = await sendOne(0, {
        type: "form-filler:fillPage",
        activeProfile: { fields: fields || {} },
        force: true
      });
      if (forced && typeof forced === "object") {
        totals.filled += forced.filled || 0;
        totals.skipped += forced.skipped || 0;
        totals.unmatched = forced.unmatched || 0;
      }
    }

    if (anyResponded) {
      console.log(
        "[Form Filler] fill: frames=" + frameIds.length + " responded=" + responded + " filled=" + totals.filled
      );
    }
    return anyResponded ? totals : null;
  }

  // Find the currently focused field across all frames. Only the frame that
  // owns DOM focus returns a field; the others respond null.
  async function focusedFieldAcrossFrames(tab) {
    const frameIds = await frameIdsOf(tab);
    for (const frameId of frameIds) {
      let res = null;
      try {
        res = await browser.tabs.sendMessage(
          tab.id,
          { type: "form-filler:getFocusedField" },
          { frameId: frameId }
        );
      } catch (err) {
        res = null;
      }
      if (res && typeof res.name === "string" && res.name !== "") return res;
    }
    return null;
  }

  // Human-readable summary of the skipped buckets from collectFields.
  function skippedText(res) {
    const parts = [];
    if (res.skippedExisting) parts.push(res.skippedExisting + " already in profile");
    if (res.skippedEmpty) parts.push(res.skippedEmpty + " empty");
    return parts.length ? " Skipped: " + parts.join(", ") + "." : "";
  }

  // Merge collected fields into the profile, persist once, and describe the
  // outcome. Mutates data.profiles[profileName].
  async function mergeCollectedFields(api, data, profileName, res) {
    const fields = res.fields;
    if (!fields.length) {
      const skipped = skippedText(res);
      if (skipped) return skipped;
      return res.found
        ? "No new fields to add (" + res.found + " fillable fields found)."
        : "No fillable fields found on this page.";
    }
    const profile = data.profiles[profileName];
    profile.fields = profile.fields || {};
    for (const f of fields) {
      profile.fields[f.name] = { value: f.value, label: f.fieldLabel || f.name };
    }
    await api.setModuleData(MODULE_ID, {
      profiles: data.profiles,
      activeProfile: data.activeProfile
    });
    const plural = fields.length === 1 ? "field" : "fields";
    return (
      'Added ' + fields.length + ' ' + plural + ' to profile "' + profileName + '".' + skippedText(res)
    );
  }

  async function handleMenuClick(info, tab, api) {
    // Called by the core for every menu click; act only on our own items.
    if (!info.menuItemId || Object.values(MENU).indexOf(info.menuItemId) === -1) return;
    if (info.menuItemId === MENU.root) return;
    if (!tab || typeof tab.id !== "number") {
      console.warn("Form Filler: no active tab for context-menu action.");
      return;
    }

    const data = await api.getModuleData(MODULE_ID);
    const profileName = data.activeProfile;
    if (!profileName || !data.profiles || !data.profiles[profileName]) {
      api.notify(
        tab.id,
        "Job App Toolkit",
        "No active profile. Open the Form Filler options page and create or select one."
      );
      return;
    }
    const profile = data.profiles[profileName];
    profile.fields = profile.fields || {};

    if (info.menuItemId === MENU.fillPage) {
      const res = await fillPageAcrossFrames(tab, profile.fields);
      if (!res) {
        api.notify(tab.id, "Job App Toolkit", "Cannot fill on this page.");
        return;
      }
      let msg = "Filled " + res.filled + ", skipped " + res.skipped;
      if (res.unmatched) msg += ", unmatched " + res.unmatched;
      api.notify(tab.id, "Job App Toolkit", msg + ".");
      return;
    }

    if (info.menuItemId === MENU.addAll) {
      const res = await collectFieldsFromTab(tab, profile.fields);
      if (!res) {
        api.notify(tab.id, "Job App Toolkit", "Cannot read fields on this page.");
        return;
      }
      const msg = await mergeCollectedFields(api, data, profileName, res);
      api.notify(tab.id, "Job App Toolkit", msg);
      return;
    }

    const focused = await sendToContent(
      tab,
      {
        type: "form-filler:getFocusedField",
        targetElementId: info.targetElementId
      },
      info.frameId
    );
    if (!focused || typeof focused.name !== "string" || focused.name === "") {
      api.notify(tab.id, "Job App Toolkit", "Click on a form field first, then right-click.");
      return;
    }

    if (info.menuItemId === MENU.add) {
      const display = focused.fieldLabel || focused.name;
      if (typeof focused.value !== "string" || focused.value === "") {
        api.notify(tab.id, "Job App Toolkit", 'Field "' + display + '" is empty. Enter a value first.');
        return;
      }
      const exists = Object.prototype.hasOwnProperty.call(profile.fields, focused.name);
      profile.fields[focused.name] = {
        value: focused.value,
        label: focused.fieldLabel || focused.name
      };
      await api.setModuleData(MODULE_ID, {
        profiles: data.profiles,
        activeProfile: data.activeProfile
      });
      api.notify(
        tab.id,
        "Job App Toolkit",
        exists
          ? 'Updated "' + display + '" in profile "' + profileName + '".'
          : 'Added "' + display + '" to profile "' + profileName + '".'
      );
      return;
    }

    if (info.menuItemId === MENU.fill) {
      const display = focused.fieldLabel || focused.name;
      const res = await sendToContent(
        tab,
        {
          type: "form-filler:fillFocusedField",
          fields: profile.fields || {},
          overwrite: true,
          targetElementId: info.targetElementId
        },
        info.frameId
      );
      if (res && res.filled > 0) {
        api.notify(
          tab.id,
          "Job App Toolkit",
          'Filled "' + display + '" from profile field "' + res.key + '".'
        );
      } else if (res && res.skipped > 0) {
        api.notify(tab.id, "Job App Toolkit", 'Could not fill "' + display + '".');
      } else {
        api.notify(tab.id, "Job App Toolkit", 'No saved value matches field "' + display + '".');
      }
    }
  }

  // ------------------------------------------------------------------
  // Quick actions (popup) + request handlers (options page)
  // ------------------------------------------------------------------

  // Fill the page the user is working on from the active profile.
  async function fillPageAction(api) {
    const tab = await getWebTab(api);
    if (!tab) return { ok: false, error: "No web page to fill." };
    const data = await api.getModuleData(MODULE_ID);
    const profileName = data.activeProfile;
    if (!profileName || !data.profiles || !data.profiles[profileName]) {
      return { ok: false, error: "No active profile. Open the Form Filler options page." };
    }
    const res = await fillPageAcrossFrames(tab, data.profiles[profileName].fields || {});
    if (!res) {
      return { ok: false, error: "Form Filler is inactive on this page." };
    }
    let msg = "Filled " + res.filled + ", skipped " + res.skipped;
    if (res.unmatched) msg += ", unmatched " + res.unmatched;
    msg += ".";
    api.notify(tab.id, "Job App Toolkit", msg);
    return { ok: true, message: msg };
  }

  // Capture the currently focused field into the active profile.
  async function captureActiveField(api) {
    const tab = await getWebTab(api);
    if (!tab) return { ok: false, error: "No web page to read." };
    const focused = await focusedFieldAcrossFrames(tab);
    if (!focused || typeof focused.name !== "string" || focused.name === "") {
      return { ok: false, error: "No focused form field detected." };
    }
    const data = await api.getModuleData(MODULE_ID);
    const profileName = data.activeProfile;
    if (!profileName || !data.profiles || !data.profiles[profileName]) {
      return { ok: false, error: "No active profile. Open the Form Filler options page." };
    }
    const profile = data.profiles[profileName];
    const display = focused.fieldLabel || focused.name;
    if (typeof focused.value !== "string" || focused.value === "") {
      return { ok: false, error: 'Field "' + display + '" is empty.' };
    }
    profile.fields = profile.fields || {};
    profile.fields[focused.name] = {
      value: focused.value,
      label: focused.fieldLabel || focused.name
    };
    await api.setModuleData(MODULE_ID, {
      profiles: data.profiles,
      activeProfile: data.activeProfile
    });
    const msg = 'Captured "' + display + '".';
    api.notify(tab.id, "Job App Toolkit", msg);
    return { ok: true, message: msg };
  }

  // Capture every filled-out field on the target page into the active profile,
  // skipping fields already present and empty fields.
  async function addAllFieldsAction(api) {
    const tab = await getWebTab(api);
    if (!tab) return { ok: false, error: "No web page to read." };
    const data = await api.getModuleData(MODULE_ID);
    const profileName = data.activeProfile;
    if (!profileName || !data.profiles || !data.profiles[profileName]) {
      return { ok: false, error: "No active profile. Open the Form Filler options page." };
    }
    const profile = data.profiles[profileName];
    profile.fields = profile.fields || {};
    const res = await collectFieldsFromTab(tab, profile.fields);
    if (!res) {
      return { ok: false, error: "Cannot read fields on this page." };
    }
    const msg = await mergeCollectedFields(api, data, profileName, res);
    api.notify(tab.id, "Job App Toolkit", msg);
    return { ok: true, message: msg };
  }

  function handleMessage(message, sender, api) {
    // The actions notify the target page in-page; the caller (options page)
    // also surfaces the result message through its own status line.
    if (message.type === "form-filler:fillPageRequest") {
      return fillPageAction(api);
    }
    if (message.type === "form-filler:captureFieldRequest") {
      return captureActiveField(api);
    }
    if (message.type === "form-filler:collectAllRequest") {
      return addAllFieldsAction(api);
    }
    return undefined;
  }

  // ------------------------------------------------------------------
  // Registration
  // ------------------------------------------------------------------

  window.jobAppToolkit.registerModule({
    id: MODULE_ID,
    name: "Form Filler",
    description: "Save form fields to named profiles and autofill job application forms.",
    optionsUrl: "modules/form-filler/options.html",
    createContextMenu: createContextMenu,
    handleMenuClick: handleMenuClick,
    handleMessage: handleMessage,
    quickActions: [
      { id: "fill-page", label: "Fill Page", handler: fillPageAction },
      { id: "add-field", label: "Add Current Field", handler: captureActiveField },
      { id: "add-all-fields", label: "Add All Fields", handler: addAllFieldsAction }
    ]
  });
})();
