/**
 * Form Filler — background script (Firefox Manifest V2, event page).
 *
 * Responsibilities:
 *  - Register the "Add field to profile" context menu for editable fields.
 *  - Relay field capture from the content script to a transient pending slot
 *    that the popup consumes on open.
 *  - Mediate storage reads/writes and the message contract with popup/content.
 */
(function () {
  "use strict";

  const SYNC_KEY = "formFillerData";
  const LOCAL_KEY = "pendingFieldAdd";
  const MENU_ID = "add-field-to-profile";

  // ------------------------------------------------------------------
  // Storage helpers
  // ------------------------------------------------------------------

  async function getData() {
    const result = await browser.storage.sync.get(SYNC_KEY);
    const data = result[SYNC_KEY];
    if (data && typeof data === "object" && data.profiles) {
      return data;
    }
    return { profiles: {}, activeProfile: null };
  }

  async function setData(data) {
    await browser.storage.sync.set({ [SYNC_KEY]: data });
  }

  // ------------------------------------------------------------------
  // Context menu
  // ------------------------------------------------------------------

  function createContextMenu() {
    browser.contextMenus.create({
      id: MENU_ID,
      title: "Add field to profile",
      contexts: ["editable"] // inputs, textareas, contenteditable
    });
  }

  browser.runtime.onInstalled.addListener(createContextMenu);
  browser.runtime.onStartup.addListener(createContextMenu);

  // ------------------------------------------------------------------
  // Context menu click handler
  // ------------------------------------------------------------------

  async function handleMenuClick(info, tab) {
    if (info.menuItemId !== MENU_ID) {
      return;
    }

    if (!tab || typeof tab.id !== "number") {
      console.warn("Form Filler: no active tab for 'Add field to profile'.");
      return;
    }

    // Ask the content script for the currently focused field's data.
    let focused;
    try {
      focused = await browser.tabs.sendMessage(tab.id, { type: "getFocusedField" });
    } catch (err) {
      // Content script not present on this page (e.g. browser-internal page).
      console.warn("Form Filler: content script unreachable:", err.message);
      return;
    }

    // contenteditable divs (and other edge cases) yield null from the content
    // script. We can't open the popup reliably, so warn and bail for the MVP.
    if (!focused || typeof focused.name !== "string" || focused.name === "" ||
        typeof focused.value !== "string") {
      console.warn(
        "Form Filler: could not detect a form field. " +
        "Click on a form field first, then right-click."
      );
      return;
    }

    // Stage the capture in storage.local (transient) so the popup can pick it
    // up when it opens and offer a confirm dialog.
    await browser.storage.local.set({
      [LOCAL_KEY]: {
        name: focused.name,
        value: focused.value,
        fieldLabel: focused.fieldLabel || null,
        tabId: tab.id,
        createdAt: Date.now()
      }
    });
  }

  browser.contextMenus.onClicked.addListener(handleMenuClick);

  // ------------------------------------------------------------------
  // Message contract
  // ------------------------------------------------------------------

  browser.runtime.onMessage.addListener(function onMessage(message) {
    if (!message || typeof message.type !== "string") {
      return;
    }

    switch (message.type) {
      // Popup: read the full profile store.
      case "getProfiles": {
        return getData().then(function (data) {
          return {
            profiles: data.profiles,
            activeProfile: data.activeProfile
          };
        });
      }

      // Popup: persist the full profile store (profiles + activeProfile).
      case "saveProfiles": {
        return setData({
          profiles: message.profiles || {},
          activeProfile: message.activeProfile || null
        }).then(function () {
          return { ok: true };
        });
      }

      // Popup: open the profile manager. MVP: full options page comes later.
      case "openProfileManager": {
        console.log("Form Filler: profile manager requested (not implemented yet).");
        return;
      }

      // Content script: the extraction logic lives there; the background does
      // not track field state on its own, so respond with null.
      case "getFocusedField": {
        return null;
      }

      default:
        return;
    }
  });
})();
