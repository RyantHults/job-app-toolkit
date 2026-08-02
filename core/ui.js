/**
 * Job App Toolkit — shared UI helpers for extension pages (popup and module
 * options pages): a transient status line and an inline confirm/prompt modal.
 * No-ops gracefully when the host page does not include the expected markup.
 */
(function () {
  "use strict";

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(msg) {
    const el = $("status");
    if (!el) return;
    el.textContent = msg;
    if (msg) {
      clearTimeout(setStatus._timer);
      setStatus._timer = setTimeout(function () {
        setStatus("");
      }, 4000);
    }
  }

  let modalResolve = null;

  function hideModal() {
    const o = $("modal-overlay");
    if (!o) return;
    o.hidden = true;
    const input = $("modal-input");
    if (input) {
      input.value = "";
      input.hidden = true;
    }
    modalResolve = null;
  }

  function showModal(message, inputType, defaultValue) {
    return new Promise(function (resolve) {
      const o = $("modal-overlay");
      const msgEl = $("modal-message");
      if (!o || !msgEl) {
        resolve(null);
        return;
      }
      modalResolve = resolve;
      msgEl.textContent = message;
      o.hidden = false;

      const input = $("modal-input");
      const confirm = $("modal-confirm");
      if (inputType === "prompt" && input) {
        input.type = "text";
        input.value = defaultValue || "";
        input.hidden = false;
        input.focus();
        if (confirm) confirm.textContent = "OK";
      } else if (confirm) {
        if (input) input.hidden = true;
        confirm.textContent = "Yes";
      }
    });
  }

  function showPrompt(message, defaultValue) {
    return showModal(message, "prompt", defaultValue);
  }

  function showConfirm(message) {
    return showModal(message, "confirm");
  }

  function wireModal() {
    const confirm = $("modal-confirm");
    const cancel = $("modal-cancel");
    const overlay = $("modal-overlay");

    if (confirm) {
      confirm.addEventListener("click", function () {
        if (!modalResolve) return;
        const input = $("modal-input");
        if (input && !input.hidden) {
          modalResolve(input.value);
        } else {
          modalResolve(true);
        }
        hideModal();
      });
    }
    if (cancel) {
      cancel.addEventListener("click", function () {
        if (modalResolve) modalResolve(null);
        hideModal();
      });
    }
    if (overlay) {
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) {
          if (modalResolve) modalResolve(null);
          hideModal();
        }
      });
    }
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && modalResolve) {
        modalResolve(null);
        hideModal();
      }
    });
  }

  wireModal();

  window.jobAppToolkit = window.jobAppToolkit || {};
  window.jobAppToolkit.ui = {
    setStatus: setStatus,
    showPrompt: showPrompt,
    showConfirm: showConfirm,
    hideModal: hideModal
  };
})();
