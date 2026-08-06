/**
 * Form Filler — background module. Registers with the Job App Toolkit core and
 * owns:
 *  - popup quick actions ("Fill Page" and "Add Current Field");
 *  - page-level context-menu actions ("Add all fields", "Fill page");
 *  - request handlers used by the module options page and the in-page
 *    per-field buttons;
 *  - an auto-grown whitelist of hostnames the user filled from the popup.
 *
 * All fill/capture logic lives in the content script; this script mediates
 * storage, in-page feedback and tab targeting.
 */
(function () {
  "use strict";

  const MODULE_ID = "form-filler";

  // Context-menu ids: page-level actions ("add all fields", "fill page") plus
  // the per-field "Answer with AI" item (targets the right-clicked editable
  // element); the remaining per-field flows live on the in-page buttons.
  const MENU = {
    root: MODULE_ID + "-menu",
    addAll: MODULE_ID + "-add-all-fields",
    fillPage: MODULE_ID + "-fill-page",
    aiAnswer: MODULE_ID + "-ai-answer"
  };

  // Lowercased hostname without the leading "www." prefix; "" when the URL is
  // unparsable. Domains the user fills from the popup are whitelisted so the
  // in-page per-field buttons stay available on them.
  function normalizeHostname(urlStr) {
    try {
      return new URL(urlStr).hostname.toLowerCase().replace(/^www\./, "");
    } catch (err) {
      return "";
    }
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
    const totals = { filled: 0, skipped: 0, unmatched: 0, skippedNames: [] };
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
      if (Array.isArray(res.skippedNames)) totals.skippedNames.push(...res.skippedNames);
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
        if (Array.isArray(forced.skippedNames)) totals.skippedNames.push(...forced.skippedNames);
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

  // Build a fill toast message; when nothing was filled, include the skipped
  // field names so the user can see exactly what the code considers "already filled".
  function fillSummary(res) {
    let msg = "Filled " + res.filled + ", skipped " + res.skipped;
    if (res.unmatched) msg += ", unmatched " + res.unmatched;
    if (res.filled === 0 && Array.isArray(res.skippedNames) && res.skippedNames.length) {
      const names = res.skippedNames.slice(0, 5).join(", ");
      const more = res.skippedNames.length > 5 ? ", \u2026" : "";
      msg += " (already has data: " + names + more + ")";
    }
    msg += ".";
    return msg;
  }

  // ------------------------------------------------------------------
  // AI answers (context-menu "Answer with AI")
  // ------------------------------------------------------------------

  // The API key and the bulky background entries live in browser.storage.local
  // (the sync quota can't hold them); the endpoint and model live in module
  // data, edited on the module's options page.
  const AI_KEY_LOCAL = "jtk-form-filler-ai-key";
  const AI_CONTEXT_LOCAL = "jtk-form-filler-ai-context";
  // Keep in sync with the DEFAULT_AI_INSTRUCTIONS constant in
  // modules/form-filler/options.js — the options page shows it as the built-in
  // default in the editable instructions field.
  const DEFAULT_AI_INSTRUCTIONS =
    "You are a job-application assistant writing answers for a candidate. " +
    "Write in the first person, be specific and concrete, and never invent " +
    "facts that are not present in the background information. Keep a " +
    "professional, natural tone, like a good cover letter or interview " +
    "answer. Output plain text only: no markdown formatting, no leading " +
    "label, no quotes around the answer.";
  const AI_MAX_TOKENS = 600;
  // Timeouts for the AI answer flow. Mutable (and exported) so harnesses can
  // shrink them; call = per-request cap, flow = overall cap across generation,
  // judge and the corrective retry (3 sequential per-call caps could otherwise
  // reach 180s before the spinner is hidden). Read at call/schedule time.
  const aiTimeouts = { call: 60000, flow: 90000 };

  // Trim AI output to fit a field's maxlength: cut at the last whitespace run
  // before the limit when that lands mid-word (a word-boundary cut), else
  // hard-slice; never return a string longer than maxLength. A null maxLength
  // means no limit.
  function truncateForField(text, maxLength) {
    const s = String(text);
    if (maxLength == null || s.length <= maxLength) return s.trim();
    let cut = s.slice(0, maxLength);
    const m = cut.match(/\s+\S*$/);
    if (m && m.index > 0) cut = cut.slice(0, m.index);
    return cut.trim();
  }

  // Build the system + user messages for the AI answer flow. `entries` are the
  // user's stored { title, body } background entries (empty bodies are
  // dropped); `fieldInfo` is the captured field description, so the question,
  // page context and any length constraints reach the model. `instructions`
  // is the user-editable system prompt from the options page; when empty (or
  // whitespace-only) the built-in default is used byte-identical. The user
  // message is fixed.
  function buildPrompt(entries, fieldInfo, instructions) {
    fieldInfo = fieldInfo || {};
    const system =
      instructions && instructions.trim()
        ? instructions.trim()
        : DEFAULT_AI_INSTRUCTIONS;

    const usable = (Array.isArray(entries) ? entries : []).filter(
      (e) => e && typeof e.body === "string" && e.body.trim() !== ""
    );
    const backgroundText = usable
      .map(function (e) {
        const title = (e.title && String(e.title).trim()) || "Untitled";
        return "- " + title + ": " + e.body.trim();
      })
      .join("\n");
    const questionText = fieldInfo.fieldLabel || fieldInfo.name || "";
    const contextText = fieldInfo.pageTitle
      ? "Context: applying via " + fieldInfo.pageTitle
      : "";
    const maxLengthText =
      typeof fieldInfo.maxLength === "number" && fieldInfo.maxLength > 0
        ? "Limit your response to less than " + fieldInfo.maxLength + " characters."
        : "";
    const singleLineText = fieldInfo.singleLine
      ? "This is a single-line text field; answer in one short sentence, " +
        "ideally under 120 characters."
      : "";

    // Default user message: fixed scaffolding; the "Constraints:" section is
    // only present when the field actually has constraints.
    const lines = ["Background:"];
    if (backgroundText) lines.push(backgroundText);
    lines.push("", "Question: " + questionText);
    if (contextText) lines.push(contextText);
    if (maxLengthText || singleLineText) {
      lines.push("Constraints:");
      if (maxLengthText) lines.push(maxLengthText);
      if (singleLineText) lines.push(singleLineText);
    }
    lines.push("Answer with only the text to insert into the field \u2014 nothing else.");
    const user = lines.join("\n");

    return { system: system, user: user };
  }

  // Deterministic self-check of a generated answer against the captured field
  // constraints. Returns an array of human-readable violation strings (empty
  // when the answer is clean).
  function runDeterministicChecks(text, fieldInfo) {
    const violations = [];
    const s = String(text == null ? "" : text);
    if (!s.trim()) violations.push("the answer was empty");
    if (
      fieldInfo &&
      typeof fieldInfo.maxLength === "number" &&
      fieldInfo.maxLength > 0 &&
      s.length > fieldInfo.maxLength
    ) {
      violations.push(
        "the answer was longer than the field's " + fieldInfo.maxLength + " character limit"
      );
    }
    if (fieldInfo && fieldInfo.singleLine && (s.indexOf("\r") !== -1 || s.indexOf("\n") !== -1)) {
      violations.push("the answer contained newlines in a single-line field");
    }
    return violations;
  }

  // Static system prompt for the LLM judge. Deliberately NOT user-editable:
  // the editable instructions field stays purely static and all dynamic info
  // (question, background, constraints) lives in the assembled user message.
  const JUDGE_SYSTEM =
    "You are evaluating whether a job-application answer follows the given " +
    "instructions and constraints. Reply with exactly PASS or FAIL: <one short " +
    "reason>. Be strict about explicit constraints such as character limits " +
    "and single-line output.";

  // Build the judge messages: the static judge system prompt plus a user
  // message that re-states the answerer instructions, the original request
  // (which already carries the question, background and constraints) and the
  // candidate answer.
  function buildJudgeMessages(system, user, answer) {
    return {
      system: JUDGE_SYSTEM,
      user:
        "Instructions:\n" + system +
        "\n\nOriginal request:\n" + user +
        "\n\nCandidate answer:\n" + answer +
        "\n\nDoes the candidate answer follow the instructions and constraints? " +
        "Reply with exactly PASS or FAIL: <one short reason>."
    };
  }

  // Parse a judge verdict into { pass, reason }. "PASS" (case-insensitive,
  // optionally followed by a non-letter) wins; "FAIL..." carries the trimmed
  // reason (capped at 200 chars); anything else is an unclear evaluation.
  function parseJudgeResult(text) {
    const s = String(text == null ? "" : text).trim();
    if (/^PASS\b/i.test(s)) return { pass: true, reason: "" };
    if (/^FAIL\b/i.test(s)) {
      const reason = s
        .replace(/^FAIL\b/i, "")
        .replace(/^[\s:\u2014\u2013-]+/, "")
        .trim()
        .slice(0, 200);
      return { pass: false, reason: reason };
    }
    return { pass: false, reason: "Unclear evaluation result." };
  }

  // Build the single user message for the one corrective retry: hands the
  // model the critique and asks for a fixed answer.
  function buildRetryMessages(system, user, priorAnswer, feedback) {
    return [
      {
        role: "user",
        content:
          "Your previous answer did not follow the instructions. Problems: " +
          feedback +
          ". Rewrite the answer fixing these problems. Answer with only the " +
          "text to insert into the field \u2014 nothing else."
      }
    ];
  }

  // POST the message list to an OpenAI-compatible chat/completions endpoint.
  // Aborts after aiTimeouts.call so a slow endpoint surfaces a friendly error
  // instead of hanging the menu flow. Only max_tokens is sent
  // (max_completion_tokens would 400 on older API surfaces). `maxTokens` and
  // `temperature` override the defaults (AI_MAX_TOKENS, 0.7) — the LLM judge
  // runs on a small budget with temperature 0. `signal` (optional) lets the
  // overall flow deadline abort this request too: if already aborted the
  // internal controller aborts immediately, else a listener forwards the
  // abort. Abort is idempotent, so it is safe if both timers fire.
  async function callLLM(endpoint, apiKey, model, messages, maxTokens, temperature, signal) {
    const controller = new AbortController();
    const timer = setTimeout(function () {
      controller.abort();
    }, aiTimeouts.call);
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener("abort", function () {
          controller.abort();
        });
      }
    }
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
          temperature: typeof temperature === "number" ? temperature : 0.7,
          max_tokens: typeof maxTokens === "number" ? maxTokens : AI_MAX_TOKENS
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        let snippet = "";
        try {
          snippet = (await res.text()).trim().slice(0, 120);
        } catch (err) {
          // Keep the bare status line.
        }
        throw new Error("HTTP " + res.status + " \u2014 " + snippet);
      }
      const data = await res.json();
      const content =
        data && data.choices && data.choices[0] && data.choices[0].message
          ? data.choices[0].message.content
          : null;
      if (typeof content !== "string" || content.trim() === "") {
        throw new Error("The API returned no answer.");
      }
      return content.trim();
    } finally {
      clearTimeout(timer);
    }
  }

  // Read the AI configuration persisted by the options page: endpoint and
  // model live in module data; the API key and the background entries live in
  // storage.local, with a fallback to the legacy module-data entries until the
  // options page has migrated them.
  async function readAIConfig(api) {
    const data = await api.getModuleData(MODULE_ID);
    const [kr, ctx] = await Promise.all([
      browser.storage.local.get(AI_KEY_LOCAL),
      browser.storage.local.get(AI_CONTEXT_LOCAL)
    ]);
    const localEntries = Array.isArray(ctx[AI_CONTEXT_LOCAL]) ? ctx[AI_CONTEXT_LOCAL] : [];
    return {
      endpoint: data.aiEndpoint,
      model: data.aiModel,
      entries: localEntries.length
        ? localEntries
        : Array.isArray(data.aiContext) ? data.aiContext : [],
      apiKey: kr[AI_KEY_LOCAL] || "",
      instructions: data.aiInstructions || ""
    };
  }

  // Context-menu "Answer with AI" flow: capture the right-clicked field, build
  // a prompt from the stored background entries, call the configured endpoint,
  // self-check the answer (deterministic checks, then an LLM judge) with at
  // most one corrective retry, truncate to the field's maxlength, fill the
  // field and toast the outcome. A spinner on the target field covers the AI
  // work. Text fields only; fills overwrite any existing text by design.
  async function answerFieldWithAI(info, tab, api) {
    const captured = await sendToContent(
      tab,
      { type: "form-filler:getAIFieldInfo", targetElementId: info.targetElementId },
      info.frameId
    );
    if (!captured || !captured.ok) {
      api.notify(
        tab.id,
        "Job App Toolkit",
        (captured && captured.error) || "Could not read the field you right-clicked."
      );
      return;
    }
    if (captured.tagName === "SELECT" || captured.type === "checkbox") {
      api.notify(tab.id, "Job App Toolkit", "AI can only fill text fields.");
      return;
    }
    const question = captured.fieldLabel || captured.name || "";
    if (!question) {
      api.notify(tab.id, "Job App Toolkit", "Could not determine the question for this field.");
      return;
    }
    const config = await readAIConfig(api);
    if (!config.apiKey) {
      api.notify(tab.id, "Job App Toolkit", "Set your API key in the Form Filler options page.");
      return;
    }
    if (!config.endpoint) {
      api.notify(tab.id, "Job App Toolkit", "Set an API endpoint in the Form Filler options page.");
      return;
    }
    if (!config.model) {
      api.notify(tab.id, "Job App Toolkit", "Set a model in the Form Filler options page.");
      return;
    }
    const usable = config.entries.some(
      (e) => e && typeof e.body === "string" && e.body.trim() !== ""
    );
    if (!usable) {
      api.notify(
        tab.id,
        "Job App Toolkit",
        "Add your experience and projects in the Form Filler options page first."
      );
      return;
    }
    api.notify(tab.id, "Job App Toolkit", 'Asking AI: "' + question + '"\u2026');
    console.log(
      "[Form Filler] AI request: " + config.endpoint + " (model " + config.model + ")"
    );
    console.log(
      "[Form Filler] AI capture: maxLength=" +
        (captured.maxLength == null ? "none" : captured.maxLength) +
        (config.instructions && config.instructions.trim()
          ? " | custom instructions (" + config.instructions.trim().length + " chars)"
          : " | default instructions")
    );

    const prompt = buildPrompt(config.entries, captured, config.instructions);
    // Spinner on the target field while the AI work runs; hidden on every
    // terminal path below (API error, fill failure, success). It stays visible
    // across evaluation and the corrective retry (no hide between attempts).
    sendToContent(
      tab,
      { type: "form-filler:aiSpinner", show: true, targetElementId: info.targetElementId },
      info.frameId
    );

    // Overall flow deadline: the spinner must never sit through the full worst
    // case (generation + judge + retry, each up to aiTimeouts.call). The timer
    // is cleared in the finally below, which also covers the fill path, so a
    // late fire can't toast a false timeout after a successful fill.
    const flowAbort = new AbortController();
    let flowTimedOut = false;
    const flowTimer = setTimeout(function () {
      flowTimedOut = true;
      flowAbort.abort();
    }, aiTimeouts.flow);

    let text;
    let retries = 0;
    try {
      try {
        text = await callLLM(
          config.endpoint,
          config.apiKey,
          config.model,
          [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user }
          ],
          undefined,
          undefined,
          flowAbort.signal
        );

        // Hybrid self-check: deterministic checks first, then an LLM judge,
        // then at most ONE corrective retry when either finds a problem.
        let violations = runDeterministicChecks(text, captured);
        let feedback = violations.length ? violations.join("; ") : null;
        if (!feedback) {
          // LLM judge — only when the deterministic checks are clean.
          try {
            const judgeMessages = buildJudgeMessages(prompt.system, prompt.user, text);
            const judge = await callLLM(
              config.endpoint,
              config.apiKey,
              config.model,
              [
                { role: "system", content: judgeMessages.system },
                { role: "user", content: judgeMessages.user }
              ],
              120,
              0,
              flowAbort.signal
            );
            const res = parseJudgeResult(judge);
            if (!res.pass) feedback = res.reason;
          } catch (err) {
            // Fail-open: a broken judge never blocks a usable answer — unless
            // the overall flow deadline fired, in which case surface the
            // timeout instead of filling the original answer.
            if (flowAbort.signal.aborted) throw err;
            console.error("[Form Filler] AI judge failed (filling answer anyway):", err);
          }
        }
        if (feedback) {
          retries = 1;
          console.log("[Form Filler] AI self-check failed, retrying: " + feedback.slice(0, 200));
          const retryMessages = [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
            { role: "assistant", content: text },
            ...buildRetryMessages(prompt.system, prompt.user, text, feedback)
          ];
          text = await callLLM(
            config.endpoint,
            config.apiKey,
            config.model,
            retryMessages,
            undefined,
            undefined,
            flowAbort.signal
          );
          const still = runDeterministicChecks(text, captured);
          if (still.length) console.warn("[Form Filler] AI retry still violates: " + still.join("; "));
        }
      } catch (err) {
        console.error("[Form Filler] AI answer failed:", err);
        sendToContent(
          tab,
          { type: "form-filler:aiSpinner", show: false, targetElementId: info.targetElementId },
          info.frameId
        );
        const msg =
          flowTimedOut === true
            ? "AI answer timed out after " + Math.round(aiTimeouts.flow / 1000) + " seconds."
            : err && err.name === "AbortError"
              ? "AI answer timed out \u2014 the endpoint did not respond."
              : "AI answer failed: " + String((err && err.message) || err).slice(0, 200);
        api.notify(tab.id, "Job App Toolkit", msg);
        return;
      }

      if (flowAbort.signal.aborted) {
        // Deadline fired between the last LLM call and the fill.
        sendToContent(
          tab,
          { type: "form-filler:aiSpinner", show: false, targetElementId: info.targetElementId },
          info.frameId
        );
        api.notify(
          tab.id,
          "Job App Toolkit",
          "AI answer timed out after " + Math.round(aiTimeouts.flow / 1000) + " seconds."
        );
        return;
      }

      let answer = text;
      if (captured.singleLine) answer = answer.replace(/\r?\n/g, " "); // harden single-line
      answer = truncateForField(answer, captured.maxLength); // final truncation
      console.log(
        "[Form Filler] AI answer: " + text.length + " chars raw -> " + answer.length +
          " chars after truncation (maxLength " +
          (captured.maxLength == null ? "none" : captured.maxLength) + ")" +
          (retries ? " (retried 1x)" : "")
      );
      const filled = await sendToContent(
        tab,
        { type: "form-filler:fillAIField", targetElementId: info.targetElementId, value: answer },
        info.frameId
      );
      if (!filled || !filled.ok) {
        console.warn("[Form Filler] fillAIField response:", filled);
        sendToContent(
          tab,
          { type: "form-filler:aiSpinner", show: false, targetElementId: info.targetElementId },
          info.frameId
        );
        api.notify(
          tab.id,
          "Job App Toolkit",
          "Could not fill the field: " + ((filled && filled.error) || "field no longer available")
        );
        return;
      }
      sendToContent(
        tab,
        { type: "form-filler:aiSpinner", show: false, targetElementId: info.targetElementId },
        info.frameId
      );
      console.log(
        "[Form Filler] AI filled \"" + question + "\" (" + answer.length + " chars)."
      );
      api.notify(
        tab.id,
        "Job App Toolkit",
        'Filled "' + question + '"' + (answer.length < text.length ? " (truncated to fit)." : ".")
      );
    } finally {
      clearTimeout(flowTimer);
    }
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
    // Auto-whitelist the domain so the in-page per-field buttons keep working
    // there; done even when the page reported 0 filled fields, as long as it
    // responded. Shallow merge preserves profiles/activeProfile.
    await ensureDomainWhitelisted(api, tab, data);
    const msg = fillSummary(res);
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

  // Add a single field to the active profile from an in-page per-field button.
  // The content script toasts the returned message itself, so no api.notify
  // call here.
  async function addFieldAction(api, field) {
    if (!field || typeof field !== "object") {
      return { ok: false, error: "Invalid field payload." };
    }
    if (typeof field.name !== "string" || field.name === "") {
      return { ok: false, error: "Field name is required." };
    }
    if (typeof field.value !== "string" || field.value === "") {
      return { ok: false, error: "Field value is required." };
    }
    const data = await api.getModuleData(MODULE_ID);
    const profileName = data.activeProfile;
    if (!profileName || !data.profiles || !data.profiles[profileName]) {
      return { ok: false, error: "No active profile. Open the Form Filler options page." };
    }
    const profile = data.profiles[profileName];
    profile.fields = profile.fields || {};
    const label = field.fieldLabel || field.name;
    const exists = Object.prototype.hasOwnProperty.call(profile.fields, field.name);
    profile.fields[field.name] = { value: field.value, label: label };
    await api.setModuleData(MODULE_ID, {
      profiles: data.profiles,
      activeProfile: data.activeProfile
    });
    return {
      ok: true,
      message: exists
        ? 'Updated "' + label + '" in profile "' + profileName + '".'
        : 'Added "' + label + '" to profile "' + profileName + '".'
    };
  }

  // ------------------------------------------------------------------
  // Context menu (page-level actions)
  // ------------------------------------------------------------------

  // Register the menu items under the core root menu: the page-level actions
  // plus the per-field "Answer with AI" item (which targets the right-clicked
  // editable element); the remaining per-field flows live on the in-page
  // buttons.
  function createContextMenu(api) {
    browser.contextMenus.create({
      id: MENU.root,
      title: "Form Filler",
      parentId: api.MENU_ROOT_ID,
      contexts: ["all"]
    });
    browser.contextMenus.create({
      id: MENU.addAll,
      title: "Add all fields to profile",
      parentId: MENU.root,
      contexts: ["all"]
    });
    browser.contextMenus.create({
      id: MENU.fillPage,
      title: "Fill page from profile",
      parentId: MENU.root,
      contexts: ["all"]
    });
    browser.contextMenus.create({
      id: MENU.aiAnswer,
      title: "Answer with AI",
      parentId: MENU.root,
      contexts: ["editable"]
    });
    return [MENU.root, MENU.addAll, MENU.fillPage, MENU.aiAnswer];
  }

  // Add the tab's hostname to the module whitelist once, so the in-page
  // per-field buttons stay available on the domain. No-op when the URL is
  // unparsable or the host is already whitelisted.
  async function ensureDomainWhitelisted(api, tab, data) {
    const host = normalizeHostname(tab.url);
    if (!host) return;
    data.whitelist = Array.isArray(data.whitelist) ? data.whitelist.slice() : [];
    if (data.whitelist.indexOf(host) !== -1) return;
    data.whitelist.push(host);
    await api.setModuleData(MODULE_ID, { whitelist: data.whitelist });
  }

  // Menu click dispatch. The core calls this for every module on every menu
  // click, so no-op unless the id is one of ours; the root item itself is a
  // no-op.
  async function handleMenuClick(info, tab, api) {
    if (
      !info ||
      (info.menuItemId !== MENU.root &&
        info.menuItemId !== MENU.addAll &&
        info.menuItemId !== MENU.fillPage &&
        info.menuItemId !== MENU.aiAnswer)
    ) {
      return;
    }
    if (!tab || typeof tab.id !== "number") {
      console.warn("[Form Filler] menu click without a valid tab");
      return;
    }
    // The AI flow needs no active profile: it answers from the stored
    // background entries and its own config, so handle it before the profile
    // checks.
    if (info.menuItemId === MENU.aiAnswer) {
      await answerFieldWithAI(info, tab, api);
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

    if (info.menuItemId === MENU.fillPage) {
      const res = await fillPageAcrossFrames(tab, profile.fields || {});
      if (!res) {
        api.notify(tab.id, "Job App Toolkit", "Cannot fill on this page.");
        return;
      }
      await ensureDomainWhitelisted(api, tab, data);
      api.notify(tab.id, "Job App Toolkit", fillSummary(res));
      return;
    }

    if (info.menuItemId === MENU.addAll) {
      const res = await collectFieldsFromTab(tab, profile.fields || {});
      if (!res) {
        api.notify(tab.id, "Job App Toolkit", "Cannot read fields on this page.");
        return;
      }
      const msg = await mergeCollectedFields(api, data, profileName, res);
      api.notify(tab.id, "Job App Toolkit", msg);
      return;
    }
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
    if (message.type === "form-filler:addField") {
      return addFieldAction(api, message.field);
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
    handleMessage: handleMessage,
    createContextMenu: createContextMenu,
    handleMenuClick: handleMenuClick,
    quickActions: [
      { id: "fill-page", label: "Fill Page", handler: fillPageAction },
      { id: "add-field", label: "Add Current Field", handler: captureActiveField },
      { id: "add-all-fields", label: "Add All Fields", handler: addAllFieldsAction }
    ]
  });

  // Expose the pure AI helpers for the jsdom harnesses (they eval this file
  // against a stub browser and need a handle on the functions).
  window.jobAppToolkit = window.jobAppToolkit || {};
  window.jobAppToolkit.formFillerAi = {
    truncateForField: truncateForField,
    buildPrompt: buildPrompt,
    callLLM: callLLM,
    runDeterministicChecks: runDeterministicChecks,
    buildJudgeMessages: buildJudgeMessages,
    parseJudgeResult: parseJudgeResult,
    buildRetryMessages: buildRetryMessages,
    timeouts: aiTimeouts
  };
})();
