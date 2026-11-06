// Chat panel UI. Talks to the extension only through postMessage.
(function () {
  const vscode = acquireVsCodeApi();
  const $messages = document.getElementById("messages");
  const $composer = document.getElementById("composer");
  const $input = document.getElementById("input");
  const $send = document.getElementById("send");
  const $stop = document.getElementById("stop");
  const $tokens = document.getElementById("tokens");
  const $meter = document.getElementById("meter");
  const cards = new Map(); // edit/command id → card element
  let busy = false;
  let thinking = null;

  // ---------- helpers ----------
  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === "class") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value);
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function escapeHtml(text) {
    return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // Small, safe Markdown: code blocks, inline code, bold, headings, bullet lists, paragraphs
  function markdown(text) {
    const parts = escapeHtml(text).split(/```[^\n]*\n?([\s\S]*?)```/g);
    return parts
      .map((part, i) => {
        if (i % 2 === 1) return `<pre><code>${part.replace(/\n$/, "")}</code></pre>`;
        const inline = (s) => s.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
        return part
          .split(/\n{2,}/)
          .map((block) => {
            const lines = block.split("\n").filter((l) => l.trim());
            if (!lines.length) return "";
            if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
              return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`).join("")}</ul>`;
            }
            const heading = lines[0].match(/^#{1,4}\s+(.*)/);
            if (heading && lines.length === 1) return `<h4>${inline(heading[1])}</h4>`;
            return `<p>${lines.map(inline).join("<br>")}</p>`;
          })
          .join("");
      })
      .join("");
  }

  function atBottom() {
    return $messages.scrollHeight - $messages.scrollTop - $messages.clientHeight < 80;
  }

  function add(node) {
    const stick = atBottom();
    if (thinking && thinking.parentNode) $messages.insertBefore(node, thinking);
    else $messages.append(node);
    if (stick) $messages.scrollTop = $messages.scrollHeight;
    return node;
  }

  function button(label, onclick, kind) {
    return h("button", { type: "button", class: kind || "", onclick }, label);
  }

  function setBusy(value) {
    busy = value;
    $send.disabled = value;
    $stop.hidden = !value;
    if (value && !thinking) {
      thinking = h("div", { class: "thinking" }, h("span", { class: "dots" }), "Working");
      add(thinking);
    } else if (!value && thinking) {
      thinking.remove();
      thinking = null;
    }
    // A stopped run can leave a reply mid-sentence: stop its cursor blinking
    if (!value) {
      for (const s of streams.values()) {
        if (s.frame) cancelAnimationFrame(s.frame);
        s.node.classList.remove("streaming");
        s.node.innerHTML = markdown(s.text);
      }
      streams.clear();
    }
  }

  // ---------- welcome ----------
  // Same robot as media/robot.svg (dark blue on a light tile), inlined so no extra file load is needed
  const ROBOT_SVG =
    '<svg viewBox="0 0 128 128" width="40" height="40" aria-hidden="true"><rect width="128" height="128" rx="28" fill="#e8eefc"/>' +
    '<g fill="#1e3a8a"><rect x="61" y="14" width="6" height="16" rx="3"/><circle cx="64" cy="14" r="7"/>' +
    '<rect x="14" y="50" width="10" height="26" rx="5"/><rect x="104" y="50" width="10" height="26" rx="5"/>' +
    '<rect x="22" y="28" width="84" height="62" rx="18"/><rect x="40" y="92" width="48" height="20" rx="8"/></g>' +
    '<g fill="#fff"><circle cx="46" cy="56" r="9"/><circle cx="82" cy="56" r="9"/><rect x="46" y="72" width="36" height="7" rx="3.5"/></g>' +
    '<g fill="#1e3a8a"><circle cx="48" cy="57" r="4"/><circle cx="84" cy="57" r="4"/></g></svg>';

  function robot() {
    const span = h("span", { class: "robot" });
    span.innerHTML = ROBOT_SVG; // static markup, never user content
    return span;
  }

  function welcome() {
    const examples = [
      "My page shows NaN instead of the total. Can you fix it?",
      "Check my recent changes for anything that could break",
      "What does the average function do?",
    ];
    add(
      h(
        "section",
        { class: "welcome" },
        h("div", { class: "welcome-title" }, robot(), h("h3", {}, "DebugWise")),
        h("p", {}, "Describe a bug in your own words. I'll find it, ask before changing anything, then explain what happened and teach you the idea behind it."),
        h(
          "div",
          { class: "examples" },
          examples.map((text) => button(text, () => submit(text), "example"))
        )
      )
    );
  }

  // ---------- messages ----------
  function message(role, text) {
    if (role === "user") return add(h("div", { class: "msg user" }, text));
    if (role === "status") return add(h("div", { class: "msg status" }, text));
    if (role === "error") return add(h("div", { class: "msg error", role: "alert" }, text));
    const node = h("div", { class: "msg assistant" });
    node.innerHTML = markdown(text);
    return add(node);
  }

  // ---------- activity: what the agent is looking at ----------
  const ACTIVITY_ICON = { analyze: "◎", list: "☰", read: "▤", check: "✓" };

  function fileLink(path, line) {
    return h(
      "a",
      {
        href: "#",
        class: "file-link",
        title: `Open ${path}${line ? ` at line ${line}` : ""}`,
        onclick: (event) => {
          event.preventDefault();
          vscode.postMessage({ type: "openFile", path, line });
        },
      },
      path
    );
  }

  // "Read demo/math.js lines 1–20": make the file name inside the title clickable
  function activityTitle(m) {
    if (!m.path || !m.title.includes(m.path)) return m.title;
    const [beforePath, afterPath] = m.title.split(m.path);
    return [beforePath, fileLink(m.path, m.line), afterPath];
  }

  function activity(m) {
    const row = h("span", { class: "activity-row" }, h("span", { class: "activity-icon", "aria-hidden": "true" }, ACTIVITY_ICON[m.kind] || "•"), h("span", {}, activityTitle(m)));
    if (!m.detail) return add(h("div", { class: `activity ${m.kind}` }, row));
    return add(
      h("details", { class: `activity ${m.kind}` }, h("summary", {}, row), h("pre", { class: "activity-detail" }, m.detail))
    );
  }

  // ---------- inline diff ----------
  const MAX_DIFF_LINES = 40;

  function inlineDiff(hunks) {
    const rows = [];
    let shown = 0;
    let hidden = 0;
    hunks.forEach((hunk, index) => {
      if (index > 0) rows.push(h("div", { class: "diff-gap" }, "⋯"));
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      for (const line of hunk.lines) {
        const sign = line[0];
        const number = sign === "-" ? oldLine++ : sign === "+" ? newLine++ : (oldLine++, newLine++);
        if (shown >= MAX_DIFF_LINES) {
          hidden++;
          continue;
        }
        shown++;
        const kind = sign === "+" ? "add" : sign === "-" ? "del" : "ctx";
        rows.push(
          h(
            "div",
            { class: `diff-line ${kind}` },
            h("span", { class: "diff-num" }, String(number)),
            h("span", { class: "diff-sign", "aria-label": kind === "add" ? "added" : kind === "del" ? "removed" : "" }, sign === " " ? "" : sign),
            h("span", { class: "diff-text" }, line.slice(1) || " ")
          )
        );
      }
    });
    if (hidden) rows.push(h("div", { class: "diff-gap" }, `… ${hidden} more line(s). Use View diff to see everything`));
    return h("div", { class: "diff", role: "group", "aria-label": "Changed lines" }, rows);
  }

  // ---------- streaming replies ----------
  const streams = new Map(); // reply id → { node, text, frame }

  // Close an unfinished ``` block so a half-written reply still renders cleanly
  function renderPartial(text) {
    const fences = (text.match(/```/g) || []).length;
    return markdown(fences % 2 ? `${text}\n\`\`\`` : text);
  }

  function assistantDelta(m) {
    let s = streams.get(m.id);
    if (!s) {
      s = { node: add(h("div", { class: "msg assistant streaming" })), text: "", frame: 0 };
      streams.set(m.id, s);
    }
    s.text += m.delta;
    // Redraw at most once per frame, however fast the pieces arrive
    if (!s.frame) {
      s.frame = requestAnimationFrame(() => {
        s.frame = 0;
        const stick = atBottom();
        s.node.innerHTML = renderPartial(s.text);
        if (stick) $messages.scrollTop = $messages.scrollHeight;
      });
    }
  }

  function assistantDone(m) {
    const s = streams.get(m.id);
    if (!s) return message("assistant", m.text); // nothing streamed: show it whole
    if (s.frame) cancelAnimationFrame(s.frame);
    streams.delete(m.id);
    s.node.classList.remove("streaming");
    s.node.innerHTML = markdown(m.text || s.text);
  }

  // ---------- edit cards ----------
  const RISK_LABEL = { low: "Low risk", medium: "Medium risk", high: "High risk" };

  function editCard(m) {
    const actions = h("div", { class: "actions" });
    const notice = h("div", { class: "notice", hidden: true });
    const status = h("div", { class: "card-status" }, "Waiting for your approval");
    const card = h(
      "article",
      { class: `card edit risk-${m.risk.level}` },
      h(
        "header",
        {},
        h("span", { class: "card-title" }, "Proposed edit"),
        h("span", { class: `badge ${m.risk.level}` }, RISK_LABEL[m.risk.level])
      ),
      h(
        "div",
        { class: "where" },
        fileLink(m.path, m.hunks && m.hunks[0] ? m.hunks[0].newStart : undefined),
        " · ",
        m.functionName ? ["function ", h("code", {}, m.functionName)] : "outside any function"
      ),
      m.hunks && m.hunks.length ? inlineDiff(m.hunks) : null,
      h("ul", { class: "reasons" }, m.risk.reasons.map((r) => h("li", {}, r))),
      status,
      notice,
      actions
    );
    card._parts = { actions, status, notice, id: m.id };
    cards.set(m.id, card);
    renderEditActions(card, "pending");
    add(card);
  }

  function renderEditActions(card, state) {
    const { actions, id } = card._parts;
    const diff = button("View diff", () => vscode.postMessage({ type: "viewDiff", id }), "secondary");
    actions.replaceChildren();
    if (state === "pending") {
      actions.append(
        diff,
        button("Approve", () => vscode.postMessage({ type: "approveEdit", id })),
        button("Reject", () => vscode.postMessage({ type: "rejectEdit", id }), "secondary")
      );
    } else if (state === "applied") {
      actions.append(diff, button("Undo this change", () => vscode.postMessage({ type: "undoEdit", id }), "secondary"));
    } else {
      actions.append(diff);
    }
  }

  const EDIT_STATUS = {
    applying: "Applying…",
    applied: "✓ Applied",
    rejected: "✕ Rejected. The file was not changed",
    undone: "↩ Undone. The file is back to how it was",
    failed: "Couldn't apply this edit",
  };

  function editStatus(m) {
    const card = cards.get(m.id);
    if (!card) return;
    card._parts.status.textContent = m.note && m.status !== "undone" ? `${EDIT_STATUS[m.status]}: ${m.note}` : EDIT_STATUS[m.status];
    card._parts.notice.hidden = true;
    card.dataset.state = m.status;
    renderEditActions(card, m.status === "applying" ? "none" : m.status);
  }

  function cardNotice(m) {
    const card = cards.get(m.id);
    if (!card) return;
    card._parts.notice.textContent = m.text;
    card._parts.notice.hidden = false;
  }

  // ---------- command cards ----------
  function commandCard(m) {
    const actions = h(
      "div",
      { class: "actions" },
      button("Approve", () => vscode.postMessage({ type: "approveCommand", id: m.id })),
      button("Reject", () => vscode.postMessage({ type: "rejectCommand", id: m.id }), "secondary")
    );
    const status = h("div", { class: "card-status" }, "Waiting for your approval");
    const output = h("div", {});
    const card = h(
      "article",
      { class: "card command" },
      h("header", {}, h("span", { class: "card-title" }, "Run a command?")),
      h("pre", { class: "cmd" }, h("code", {}, m.cmd)),
      status,
      actions,
      output
    );
    card._parts = { actions, status, output };
    cards.set(m.id, card);
    add(card);
  }

  const COMMAND_STATUS = { running: "Running…", done: "✓ Finished", failed: "✕ Failed", rejected: "✕ Not run" };

  function commandStatus(m) {
    const card = cards.get(m.id);
    if (!card) return;
    card._parts.status.textContent = COMMAND_STATUS[m.status];
    card._parts.actions.replaceChildren();
    if (m.output !== undefined) {
      card._parts.output.replaceChildren(
        h("details", {}, h("summary", {}, "Output"), h("pre", { class: "output" }, m.output || "(no output)"))
      );
    }
  }

  // ---------- explanation + lesson ----------
  function explanation(m) {
    const e = m.explanation;
    const section = (title, body) => h("section", {}, h("h4", {}, title), h("p", {}, body));
    const lesson = h(
      "details",
      { class: "lesson" },
      h("summary", {}, h("span", { class: "lesson-label" }, "Lesson"), e.concept.name),
      h("p", {}, e.concept.explanation),
      h("p", {}, h("strong", {}, "Think of it like this: "), e.concept.analogy),
      h("p", {}, h("strong", {}, "In your code: "), e.concept.in_your_code),
      e.key_terms.length
        ? h(
            "div",
            {},
            h("h4", {}, "Words to know"),
            h("dl", {}, e.key_terms.map((t) => [h("dt", {}, t.term), h("dd", {}, t.meaning)]))
          )
        : null,
      h("div", { class: "quiz" }, h("h4", {}, "Check your understanding"), h("p", {}, e.check_your_understanding))
    );

    add(
      h(
        "article",
        { class: "card explanation" },
        h("header", {}, h("span", { class: "card-title" }, "What happened")),
        h("p", { class: "headline" }, e.headline),
        section("What went wrong", e.what_went_wrong),
        section("What change caused it", e.what_change_caused_it),
        section("How it was fixed", e.how_it_was_fixed),
        section("Other code that depends on this", e.ripple_effects),
        m.openProblems.length
          ? h(
              "div",
              { class: "notice" },
              h("strong", {}, "Still worth checking:"),
              h("ul", {}, m.openProblems.map((p) => h("li", {}, p)))
            )
          : null,
        h("p", { class: "files" }, "Files changed: ", m.files.map((f, i) => [i ? ", " : "", h("code", {}, f)])),
        lesson
      )
    );
  }

  function needsKey() {
    add(
      h(
        "article",
        { class: "card" },
        h("header", {}, h("span", { class: "card-title" }, "Connect to OpenAI")),
        h("p", {}, "Add your OpenAI API key to start. It's stored in VS Code's secure storage, not in your project."),
        h("div", { class: "actions" }, button("Set API key", () => vscode.postMessage({ type: "setKey" })))
      )
    );
  }

  // ---------- sending ----------
  function submit(text) {
    text = (text ?? $input.value).trim();
    if (!text || busy) return;
    $messages.querySelector(".welcome")?.remove();
    message("user", text);
    $input.value = "";
    setBusy(true);
    vscode.postMessage({ type: "prompt", text });
  }

  $composer.addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
  });
  $input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  $stop.addEventListener("click", () => vscode.postMessage({ type: "stop" }));

  // ---------- messages from the extension ----------
  window.addEventListener("message", ({ data: m }) => {
    switch (m.type) {
      case "message":
        return message(m.role, m.text);
      case "activity":
        return activity(m);
      case "assistantDelta":
        return assistantDelta(m);
      case "assistantDone":
        return assistantDone(m);
      case "editCard":
        return editCard(m);
      case "editStatus":
        return editStatus(m);
      case "editNotice":
        return cardNotice(m);
      case "commandCard":
        return commandCard(m);
      case "commandStatus":
        return commandStatus(m);
      case "explanation":
        return explanation(m);
      case "usage":
        $tokens.textContent = m.total.toLocaleString();
        $meter.title = `${m.input.toLocaleString()} sent, ${m.output.toLocaleString()} received`;
        return;
      case "busy":
        return setBusy(m.busy);
      case "project": {
        const $project = document.getElementById("project");
        $project.replaceChildren(m.name ? ["Working in: ", h("strong", {}, m.name)] : "No folder open");
        $project.title = m.path || "";
        return;
      }
      case "needsKey":
        return needsKey();
      case "keySaved":
        return message("status", "API key saved. Send your message again.");
      case "clear":
        $messages.replaceChildren();
        cards.clear();
        thinking = null;
        setBusy(false);
        $tokens.textContent = "0";
        $meter.title = "Tokens sent to and received from the AI in this chat";
        return welcome();
    }
  });

  welcome();
  $input.focus();
})();
