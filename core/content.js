/**
 * Job App Toolkit — shared content-script runtime (loaded by every module's
 * content script before the module script itself). Owns:
 *  - the module-active cache (refreshed from storage on load and via the
 *    background's activity broadcast) so module scripts no-op cheaply when a
 *    module is toggled off;
 *  - the in-page confirmation toast, with optional action-button support
 *    (e.g. "Undo") so modules can offer immediate, page-local recovery.
 *
 * Exposes window.jobAppToolkit.content. Core message types (jtk:*) are claimed
 * here; module-prefixed messages are left to each module's own listener.
 */
(function () {
  "use strict";

  const STORAGE_KEY = "jobAppToolkit";

  const active = Object.create(null);

  function moduleActiveInStore(data, id) {
    const mod = data && data.modules && data.modules[id];
    return mod ? mod.active === true : true;
  }

  async function refreshActive(id) {
    try {
      const res = await browser.storage.sync.get(STORAGE_KEY);
      active[id] = moduleActiveInStore(res[STORAGE_KEY], id);
    } catch (err) {
      active[id] = true;
    }
  }

  function isModuleActive(id) {
    return active[id] !== false;
  }

  function setModuleActive(id, isActive) {
    active[id] = Boolean(isActive);
  }

  // ------------------------------------------------------------------
  // In-page toast
  // ------------------------------------------------------------------

  // Optional `action` = { type, label, payload }. When present, an action
  // button is rendered next to the message and the toast stays up longer so
  // the user has time to click it. Clicking sends `{ type: action.type,
  // ...action.payload }` to the background and hides the toast. Without an
  // action the toast is passive and auto-dismisses faster.
  let toastEl = null;
  let toastTimer = null;

  function clearToastTimer() {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  }

  function hideToast() {
    clearToastTimer();
    if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
    toastEl = null;
  }

  function showToast(text, action) {
    if (!text) return;
    hideToast();

    const el = document.createElement("div");
    el.setAttribute("role", "status");
    Object.assign(el.style, {
      position: "fixed",
      top: "16px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      maxWidth: "80vw",
      boxSizing: "border-box",
      display: "flex",
      alignItems: "center",
      gap: "10px",
      padding: "10px 16px",
      borderRadius: "8px",
      background: "#1f2937",
      color: "#ffffff",
      fontSize: "13px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      lineHeight: "1.4",
      boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
      pointerEvents: action ? "auto" : "none",
      opacity: "0",
      transition: "opacity 0.2s ease"
    });

    const msg = document.createElement("span");
    msg.textContent = text;
    el.appendChild(msg);

    if (action && action.type && action.label) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = action.label;
      Object.assign(btn.style, {
        flex: "none",
        padding: "4px 12px",
        borderRadius: "999px",
        border: "1px solid rgba(255, 255, 255, 0.5)",
        background: "transparent",
        color: "#ffffff",
        fontSize: "12px",
        fontFamily: "inherit",
        cursor: "pointer"
      });
      btn.addEventListener("click", function () {
        hideToast();
        browser.runtime
          .sendMessage(Object.assign({ type: action.type }, action.payload || {}))
          .catch(() => {});
      });
      el.appendChild(btn);
    }

    toastEl = el;
    (document.body || document.documentElement).appendChild(el);
    requestAnimationFrame(() => {
      if (toastEl === el) el.style.opacity = "1";
    });
    toastTimer = setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => {
        if (el.parentNode) el.parentNode.removeChild(el);
        if (toastEl === el) toastEl = null;
      }, 200);
    }, action ? 5000 : 3500);
  }

  // ------------------------------------------------------------------
  // Core message handling (jtk:*)
  // ------------------------------------------------------------------

  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== "string") return undefined;

    if (message.type === "jtk:moduleActivityChanged") {
      if (message.id && typeof message.id === "string") {
        setModuleActive(message.id, Boolean(message.active));
      }
      return undefined;
    }

    if (message.type === "jtk:showToast") {
      const text = message.title ? message.title + ": " + message.message : message.message;
      showToast(text, message.action);
      return undefined;
    }

    return undefined;
  });

  window.jobAppToolkit = window.jobAppToolkit || {};
  window.jobAppToolkit.content = {
    refreshActive: refreshActive,
    isModuleActive: isModuleActive,
    setModuleActive: setModuleActive,
    showToast: showToast,
    hideToast: hideToast
  };
})();
