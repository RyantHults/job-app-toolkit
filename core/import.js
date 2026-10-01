(() => {
  "use strict";

  const ui = window.jobAppToolkit.ui;
  const importFile = document.getElementById("import-file");
  const status = document.getElementById("status");

  // Final import results must outlive core/ui.js's transient status timer so
  // the user can inspect them while deciding what to do next.
  function setImportStatus(message) {
    if (status) status.textContent = message;
  }

  function safeErrorSummary(error) {
    let summary;
    if (typeof error === "string") summary = error;
    else if (error && typeof error.message === "string") summary = error.message;
    else {
      try { summary = String(error == null ? "Unknown error" : error); }
      catch (err) { summary = "Unknown error"; }
    }
    summary = summary.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    if (!summary) summary = "Unknown error";
    return summary.length > 160 ? summary.slice(0, 157) + "..." : summary;
  }

  function importStatus(res) {
    const imported = res && Array.isArray(res.imported) ? res.imported : [];
    const failures = res && Array.isArray(res.failures) ? res.failures : [];
    if (failures.length) {
      const failed = failures.map(failure => {
        const id = failure && failure.id ? String(failure.id) : "unknown module";
        return id + " (" + safeErrorSummary(failure && failure.error) + ")";
      }).join(", ");
      if (imported.length) {
        return "Imported " + imported.length + " module" + (imported.length === 1 ? "" : "s") + "; failed: " + failed + ".";
      }
      return "Import failed for: " + failed + ".";
    }
    if (res && res.ok) {
      return "Imported " + imported.length + " module" + (imported.length === 1 ? "" : "s") + ".";
    }
    return res && res.error ? safeErrorSummary(res.error) : "Import failed.";
  }

  importFile.addEventListener("change", () => {
    const file = importFile.files && importFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (err) {
        setImportStatus("Not a valid export file.");
        importFile.value = "";
        return;
      }
      const modules = parsed && parsed.modules && typeof parsed.modules === "object"
        ? Object.keys(parsed.modules) : [];
      ui.showConfirm(
        "Import will replace the current configuration for " + modules.length +
        " module" + (modules.length === 1 ? "" : "s") + " (" + modules.join(", ") + "). Continue?"
      ).then(confirmed => {
        if (!confirmed) return;
        return browser.runtime.sendMessage({ type: "jtk:importData", export: parsed })
          .then(res => setImportStatus(importStatus(res)))
          .catch(() => setImportStatus("Import failed."));
      }).then(() => { importFile.value = ""; });
    };
    reader.onerror = () => {
      setImportStatus("Could not read the file.");
      importFile.value = "";
    };
    reader.readAsText(file);
  });
})();
