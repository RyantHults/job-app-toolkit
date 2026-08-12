(() => {
  "use strict";

  const listEl = document.getElementById("modules-list");
  const ui = window.jobAppToolkit.ui;

  function rowFor(module) {
    const row = document.createElement("div");
    row.className = "module-row";
    row.setAttribute("role", "listitem");

    const info = document.createElement("div");
    info.className = "module-info";

    const name = document.createElement("div");
    name.className = "module-name";
    name.textContent = module.name;

    const desc = document.createElement("div");
    desc.className = "module-desc";
    desc.textContent = module.description || "";

    info.appendChild(name);
    info.appendChild(desc);

    const controls = document.createElement("div");
    controls.className = "module-controls";

    const actionButtons = [];

    const toggleLabel = document.createElement("label");
    toggleLabel.className = "toggle";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = Boolean(module.active);
    toggle.addEventListener("change", () => {
      browser.runtime
        .sendMessage({ type: "jtk:setModuleActive", id: module.id, active: toggle.checked })
        .then((res) => {
          if (res && res.ok) {
            for (const b of actionButtons) b.disabled = !toggle.checked;
          } else {
            toggle.checked = !toggle.checked;
            ui.setStatus("Could not toggle module.");
          }
        })
        .catch(() => {
          toggle.checked = !toggle.checked;
          ui.setStatus("Could not toggle module.");
        });
    });
    const toggleText = document.createElement("span");
    toggleText.textContent = "Active";
    toggleLabel.appendChild(toggle);
    toggleLabel.appendChild(toggleText);
    controls.appendChild(toggleLabel);

    for (const action of module.quickActions || []) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-sm";
      btn.textContent = action.label;
      btn.disabled = !module.active;
      actionButtons.push(btn);
      btn.addEventListener("click", () => {
        browser.runtime
          .sendMessage({
            type: "jtk:runQuickAction",
            moduleId: module.id,
            actionId: action.id
          })
          .then((res) => {
            if (res && res.ok === false) ui.setStatus((res && res.error) || "Action failed.");
          })
          .catch(() => ui.setStatus("Action failed."));
      });
      controls.appendChild(btn);
    }

    if (module.optionsUrl) {
      const options = document.createElement("button");
      options.type = "button";
      options.className = "btn btn-sm";
      options.textContent = "Options";
      options.addEventListener("click", () => {
        browser.runtime
          .sendMessage({ type: "jtk:openOptions", url: module.optionsUrl })
          .catch(() => ui.setStatus("Could not open options."));
      });
      controls.appendChild(options);
    }

    row.appendChild(info);
    row.appendChild(controls);
    return row;
  }

  function renderModules(modules) {
    listEl.textContent = "";
    if (!modules || modules.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No modules installed.";
      listEl.appendChild(empty);
      return;
    }
    for (const module of modules) {
      listEl.appendChild(rowFor(module));
    }
  }

  browser.runtime
    .sendMessage({ type: "jtk:getModules" })
    .then(renderModules)
    .catch(() => ui.setStatus("Something went wrong"));

  // ------------------------------------------------------------------
  // Export / import data
  // ------------------------------------------------------------------

  const includeApiKeyEl = document.getElementById("include-api-key");
  const exportBtn = document.getElementById("export-btn");
  const importBtn = document.getElementById("import-btn");
  const importFile = document.getElementById("import-file");

  function exportFileName() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return "job-app-toolkit-export-" + y + "-" + m + "-" + day + ".json";
  }

  exportBtn.addEventListener("click", () => {
    browser.runtime
      .sendMessage({
        type: "jtk:exportData",
        includeApiKey: includeApiKeyEl.checked
      })
      .then((res) => {
        if (!res || !res.ok || !res.export) {
          ui.setStatus((res && res.error) || "Export failed.");
          return;
        }
        const json = JSON.stringify(res.export, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = exportFileName();
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        ui.setStatus("Exported " + Object.keys(res.export.modules).length + " modules.");
      })
      .catch((err) => {
        console.error("Job App Toolkit: export failed", err);
        ui.setStatus("Export failed.");
      });
  });

  importBtn.addEventListener("click", () => {
    importFile.value = "";
    importFile.click();
  });

  importFile.addEventListener("change", () => {
    const file = importFile.files && importFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (err) {
        ui.setStatus("Not a valid export file.");
        importFile.value = "";
        return;
      }
      const count = parsed && parsed.modules ? Object.keys(parsed.modules).length : 0;
      ui.showConfirm(
        "Import will replace the current configuration for " + count + " modules. Continue?"
      ).then((confirmed) => {
        if (!confirmed) return;
        return browser.runtime
          .sendMessage({ type: "jtk:importData", export: parsed })
          .then((res) => {
            if (res && res.ok) {
              ui.setStatus("Imported " + (res.imported || []).length + " modules.");
            } else {
              ui.setStatus((res && res.error) || "Import failed.");
            }
          })
          .catch(() => ui.setStatus("Import failed."));
      }).then(() => {
        // Reset the input in every path (parse handled above, cancel and the
        // send flow here).
        importFile.value = "";
      });
    };
    reader.onerror = () => {
      ui.setStatus("Could not read the file.");
      importFile.value = "";
    };
    reader.readAsText(file);
  });
})();
