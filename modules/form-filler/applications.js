(() => {
  "use strict";

  const ui = window.jobAppToolkit.ui;

  const list = document.getElementById("applications-list");
  const sortSelect = document.getElementById("sort-select");

  let applications = [];
  let stages = [];

  function handleError(err) {
    console.error("Application History error:", err);
    ui.setStatus("Something went wrong");
  }

  function errorText(res, fallback) {
    return (res && res.error) || fallback;
  }

  async function load() {
    try {
      const res = await browser.runtime.sendMessage({
        type: "form-filler:getApplications"
      });
      if (!res || !res.ok) {
        ui.setStatus(errorText(res, "Could not load applications."));
        return;
      }
      applications = Array.isArray(res.applications) ? res.applications : [];
      stages = Array.isArray(res.stages) ? res.stages : [];
      render();
    } catch (err) {
      handleError(err);
      ui.setStatus("Could not load applications.");
    }
  }

  // Bold primary label for the row: company, else the title, else a neutral
  // fallback. Trimmed so an empty string on the board side falls through.
  function companyLabel(app) {
    const company = app.company ? String(app.company).trim() : "";
    const title = app.title ? String(app.title).trim() : "";
    return company || title || "Unknown company";
  }

  // Secondary line: the job title, but only when it is not already shown as
  // the company fallback above (so an empty company doesn't print it twice).
  function titleLine(app) {
    const title = app.title ? String(app.title).trim() : "";
    const company = app.company ? String(app.company).trim() : "";
    if (!title) return "";
    return title === company ? "" : title;
  }

  function formatDate(appliedAt) {
    if (typeof appliedAt !== "number" || !isFinite(appliedAt)) return "";
    const d = new Date(appliedAt);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  }

  function sortApplications() {
    const sorted = applications.slice();
    if (sortSelect.value === "company") {
      sorted.sort((a, b) => {
        const ca = (a.company || "").trim().toLowerCase();
        const cb = (b.company || "").trim().toLowerCase();
        const ea = ca ? 0 : 1;
        const eb = cb ? 0 : 1;
        if (ea !== eb) return ea - eb; // empty companies sort last
        if (ca !== cb) return ca < cb ? -1 : 1;
        return (b.appliedAt || 0) - (a.appliedAt || 0); // tiebreak: newest first
      });
    } else {
      sorted.sort((a, b) => (b.appliedAt || 0) - (a.appliedAt || 0));
    }
    return sorted;
  }

  // Predefined stages plus the entry's current stage when it is a custom one,
  // so a custom stage selected here round-trips on re-render.
  function stageOptions(currentStage) {
    const opts = stages.slice();
    const current = currentStage ? String(currentStage) : "";
    if (current && opts.indexOf(current) === -1) {
      opts.push(current);
    }
    return opts;
  }

  function render() {
    const sorted = sortApplications();
    list.textContent = "";

    if (!sorted.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent =
        "No applications logged yet. Submitting a form on a whitelisted job board will record it here.";
      list.appendChild(li);
      return;
    }

    for (const app of sorted) {
      list.appendChild(buildRow(app));
    }
  }

  function buildRow(app) {
    const li = document.createElement("li");
    li.className = "application";

    const info = document.createElement("div");
    info.className = "app-info";

    const company = document.createElement("span");
    company.className = "app-company";
    company.textContent = companyLabel(app);
    info.appendChild(company);

    const title = titleLine(app);
    if (title) {
      const titleEl = document.createElement("span");
      titleEl.className = "app-title";
      titleEl.textContent = title;
      info.appendChild(titleEl);
    }

    const meta = document.createElement("div");
    meta.className = "app-meta";

    const dateText = formatDate(app.appliedAt);
    if (dateText) {
      const dateEl = document.createElement("span");
      dateEl.className = "app-date";
      dateEl.textContent = dateText;
      meta.appendChild(dateEl);
    }

    const stageSelect = document.createElement("select");
    stageSelect.className = "stage-select";
    stageSelect.setAttribute("aria-label", "Stage for " + companyLabel(app));
    for (const label of stageOptions(app.stage)) {
      const opt = document.createElement("option");
      opt.value = label;
      opt.textContent = label;
      stageSelect.appendChild(opt);
    }
    stageSelect.value = app.stage ? String(app.stage) : "";
    stageSelect.addEventListener("change", async () => {
      const stage = stageSelect.value;
      if (stage === String(app.stage || "")) return;
      try {
        const res = await browser.runtime.sendMessage({
          type: "form-filler:setApplicationStage",
          id: app.id,
          stage: stage
        });
        if (!res || !res.ok) {
          ui.setStatus(errorText(res, "Could not update the stage."));
          load(); // re-render restores the previous stage
          return;
        }
        ui.setStatus("Stage updated.");
        load();
      } catch (err) {
        handleError(err);
        load();
      }
    });

    const buttons = document.createElement("div");
    buttons.className = "app-buttons";

    // Company correction, first in the row's action group. The prompt
    // defaults to the raw stored company (empty when the row falls back to
    // the title), never the fallback text, so a wrong or missing company is
    // replaced from scratch.
    const companyEdit = document.createElement("button");
    companyEdit.type = "button";
    companyEdit.className = "btn btn-sm";
    companyEdit.textContent = "Edit";
    companyEdit.title = "Edit company name";
    companyEdit.addEventListener("click", async () => {
      const raw = await ui.showPrompt(
        "Company name:",
        app.company ? String(app.company) : ""
      );
      if (raw === null) return; // cancel: do nothing
      const company = String(raw).trim();
      try {
        const res = await browser.runtime.sendMessage({
          type: "form-filler:setApplicationCompany",
          id: app.id,
          company: company
        });
        if (!res || !res.ok) {
          ui.setStatus(errorText(res, "Could not update the company."));
          load(); // re-render restores the prior label
          return;
        }
        ui.setStatus("Company updated.");
        load();
      } catch (err) {
        handleError(err);
        load();
      }
    });
    buttons.appendChild(companyEdit);

    if (app.url && String(app.url).trim()) {
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "btn btn-sm";
      openBtn.textContent = "Open";
      openBtn.title = "Open application";
      openBtn.addEventListener("click", () => {
        browser.tabs
          .create({ url: String(app.url).trim() })
          .catch(() => {
            ui.setStatus("Could not open the application.");
          });
      });
      buttons.appendChild(openBtn);
    }

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn btn-sm";
    deleteBtn.textContent = "Delete";
    deleteBtn.title = "Delete application";
    deleteBtn.addEventListener("click", async () => {
      if (!(await ui.showConfirm("Delete this application?"))) return;
      try {
        const res = await browser.runtime.sendMessage({
          type: "form-filler:deleteApplication",
          id: app.id
        });
        if (!res || !res.ok) {
          ui.setStatus(errorText(res, "Could not delete the application."));
          return;
        }
        ui.setStatus("Application deleted.");
        load();
      } catch (err) {
        handleError(err);
      }
    });
    buttons.appendChild(deleteBtn);

    meta.appendChild(stageSelect);
    meta.appendChild(buttons);

    li.appendChild(info);
    li.appendChild(meta);
    return li;
  }

  sortSelect.addEventListener("change", render);

  load();
})();
