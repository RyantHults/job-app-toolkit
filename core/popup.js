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
})();
