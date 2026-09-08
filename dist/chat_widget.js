// "Chat with this dashboard" — floating launcher icon + popup widget.
//
// Vanilla JS, no dependencies, self-contained. Loaded as its own <script>
// after app.js. It posts to the /api/chat Pages Function and answers ONLY from
// the currently-open dashboard's data (with an optional web-search supplement).
// Nothing here is hard-coded to a specific dashboard: the slug, name and
// starter questions are all derived at runtime from what's loaded.
(function () {
  "use strict";

  var ENDPOINT = "/api/chat";
  var OPEN_KEY = "dashChatOpen";
  var MAX_HISTORY = 16;

  var state = { open: false, webOn: false, sending: false, started: false };
  var history = []; // [{role:'user'|'assistant', content:'...'}]
  var nodes = {};

  // --- helpers -------------------------------------------------------------

  function dashboardSlug() {
    return (
      window.__DASHBOARD_SLUG__ ||
      (document.body && document.body.dataset && document.body.dataset.dashboardSlug) ||
      "investor_dashboard"
    );
  }

  function dashboardName() {
    var d = window.dashboardData;
    return (d && (d.title || d.name)) || "this dashboard";
  }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") n.className = attrs[k];
        else if (k === "text") n.textContent = attrs[k];
        else if (k === "html") n.innerHTML = attrs[k];
        else n.setAttribute(k, attrs[k]);
      });
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  // Derive 3–4 starter questions from whatever this dashboard actually holds.
  function deriveStarters(d) {
    var out = [];
    function add(q) { if (q && out.indexOf(q) === -1 && out.length < 4) out.push(q); }
    if (d && typeof d === "object") {
      var cards = d.summary && d.summary.cards;
      if (Array.isArray(cards)) {
        cards.slice(0, 2).forEach(function (c) {
          if (c && c.label) add("What's the latest " + c.label + "?");
        });
      }
      if (d.modules && typeof d.modules === "object") {
        Object.keys(d.modules).forEach(function (k) {
          var m = d.modules[k];
          if (m && (m.available === true || m.available === "True") && m.title) {
            add("Summarise " + m.title + ".");
          }
        });
      }
      if (d.news) add("Any recent news in the data?");
      if (d.earnings_calendar) add("When are the next earnings?");
      if (d.oem_stocks) add("How have the listed stocks moved?");
    }
    ["What does this dashboard track?", "What's the latest headline number?", "Which sources does it use?"]
      .forEach(add);
    return out.slice(0, 4);
  }

  function scrollLog() {
    if (nodes.log) nodes.log.scrollTop = nodes.log.scrollHeight;
  }

  // --- message rendering ---------------------------------------------------

  function paragraphs(text) {
    return String(text == null ? "" : text)
      .split(/\n{2,}/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function addMessage(role, text, sources) {
    var cls = role === "user" ? "user" : role === "error" ? "error" : "bot";
    var msg = el("div", { class: "dash-chat-msg " + cls });
    paragraphs(text).forEach(function (p) { msg.appendChild(el("p", { text: p })); });
    if (msg.childNodes.length === 0) msg.appendChild(el("p", { text: String(text || "") }));

    if (cls === "bot" && Array.isArray(sources) && sources.length) {
      var wrap = el("div", { class: "dash-chat-sources" });
      sources.forEach(function (s) {
        if (!s || !s.url) return;
        var a = el("a", {
          class: "dash-chat-chip",
          href: s.url,
          target: "_blank",
          rel: "noopener noreferrer",
          title: s.url,
        });
        a.appendChild(el("span", { text: s.label || s.url }));
        wrap.appendChild(a);
      });
      msg.appendChild(wrap);
    }
    nodes.log.appendChild(msg);
    scrollLog();
    return msg;
  }

  function addTyping() {
    var t = el("div", { class: "dash-chat-msg bot" }, [
      el("div", { class: "dash-chat-typing", html: "<i></i><i></i><i></i>" }),
    ]);
    nodes.log.appendChild(t);
    scrollLog();
    return t;
  }

  function hideStarters() {
    if (nodes.starters) nodes.starters.classList.add("is-hidden");
  }

  // --- send ----------------------------------------------------------------

  function updateSendDisabled() {
    if (nodes.send) nodes.send.disabled = state.sending || !nodes.input.value.trim();
  }

  function send(text) {
    text = (text || "").trim();
    if (!text || state.sending) return;

    hideStarters();
    var prior = history.slice(); // turns before this question
    addMessage("user", text);
    history.push({ role: "user", content: text });

    nodes.input.value = "";
    autoGrow();
    state.sending = true;
    updateSendDisabled();
    var typing = addTyping();

    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: dashboardSlug(),
        question: text,
        history: prior,
        web: state.webOn,
      }),
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (data) {
        typing.remove();
        var answer = (data && data.answer) || "I couldn't find an answer for that. Try rephrasing?";
        var sources = data && Array.isArray(data.sources) ? data.sources : [];
        addMessage("bot", answer, sources);
        history.push({ role: "assistant", content: answer });
        if (history.length > MAX_HISTORY) history = history.slice(history.length - MAX_HISTORY);
      })
      .catch(function () {
        typing.remove();
        addMessage("error", "I can't reach the assistant right now — please try again in a moment.");
      })
      .then(function () {
        state.sending = false;
        updateSendDisabled();
        scrollLog();
        try { nodes.input.focus(); } catch (e) {}
      });
  }

  // --- open / close --------------------------------------------------------

  function ensureWelcome() {
    if (state.started) return;
    state.started = true;
    var name = dashboardName();
    addMessage(
      "bot",
      "Hi! I answer questions about the " + name + " dashboard using only its own data, and I cite the sources for every claim.\n\nFlip on “Search the web” below to blend in a few live results too."
    );
    // Starter questions derived from the loaded data.
    var starters = deriveStarters(window.dashboardData);
    nodes.starters.innerHTML = "";
    starters.forEach(function (q) {
      var b = el("button", { class: "dash-chat-starter", type: "button", text: q });
      b.addEventListener("click", function () { send(q); });
      nodes.starters.appendChild(b);
    });
    nodes.starters.classList.remove("is-hidden");
  }

  function openPanel() {
    state.open = true;
    nodes.panel.classList.add("is-open");
    nodes.launcher.classList.add("is-hidden");
    nodes.launcher.setAttribute("aria-expanded", "true");
    ensureWelcome();
    try { sessionStorage.setItem(OPEN_KEY, "1"); } catch (e) {}
    try { nodes.input.focus(); } catch (e) {}
  }

  function closePanel() {
    state.open = false;
    nodes.panel.classList.remove("is-open");
    nodes.launcher.classList.remove("is-hidden");
    nodes.launcher.setAttribute("aria-expanded", "false");
    try { sessionStorage.setItem(OPEN_KEY, "0"); } catch (e) {}
  }

  function autoGrow() {
    var i = nodes.input;
    i.style.height = "auto";
    i.style.height = Math.min(i.scrollHeight, 96) + "px";
  }

  // --- build ---------------------------------------------------------------

  var ICON_CHAT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.6-.8L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z"/></svg>';
  var ICON_SEND =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

  function build() {
    if (document.querySelector(".dash-chat-launcher")) return; // guard double-init

    nodes.launcher = el("button", {
      class: "dash-chat-launcher",
      type: "button",
      "aria-label": "Chat with this dashboard",
      "aria-expanded": "false",
      html: ICON_CHAT,
    });
    nodes.launcher.addEventListener("click", openPanel);

    nodes.log = el("div", { class: "dash-chat-log" });
    nodes.starters = el("div", { class: "dash-chat-starters is-hidden" });

    var close = el("button", { class: "dash-chat-close", type: "button", "aria-label": "Close chat", text: "×" });
    close.addEventListener("click", closePanel);

    var header = el("div", { class: "dash-chat-header" }, [
      el("span", { class: "dash-chat-dot" }),
      el("div", { class: "dash-chat-heading" }, [
        el("strong", { text: "Ask this dashboard" }),
        el("span", { text: "Answers from its data, with sources" }),
      ]),
      close,
    ]);

    // web toggle
    var toggleInput = el("input", { type: "checkbox", "aria-label": "Search the web" });
    toggleInput.addEventListener("change", function () { state.webOn = toggleInput.checked; });
    nodes.toggleInput = toggleInput;
    var toggle = el("label", { class: "dash-chat-toggle" }, [
      toggleInput,
      el("span", { class: "dash-chat-switch" }),
      el("span", { text: "Search the web" }),
      el("span", { class: "dash-chat-hint", text: "· off = this dashboard only" }),
    ]);

    nodes.input = el("textarea", {
      class: "dash-chat-input",
      rows: "1",
      placeholder: "Ask about this dashboard…",
      "aria-label": "Your question",
    });
    nodes.input.addEventListener("input", function () { autoGrow(); updateSendDisabled(); });
    nodes.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send(nodes.input.value);
      }
    });

    nodes.send = el("button", { class: "dash-chat-send", type: "button", "aria-label": "Send", html: ICON_SEND });
    nodes.send.disabled = true;
    nodes.send.addEventListener("click", function () { send(nodes.input.value); });

    var foot = el("div", { class: "dash-chat-foot" }, [
      toggle,
      el("div", { class: "dash-chat-inputrow" }, [nodes.input, nodes.send]),
    ]);

    nodes.panel = el("div", {
      class: "dash-chat-panel",
      role: "dialog",
      "aria-label": "Chat with this dashboard",
    }, [header, nodes.log, nodes.starters, foot]);

    document.body.appendChild(nodes.launcher);
    document.body.appendChild(nodes.panel);

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && state.open) closePanel();
    });

    // Restore open/closed state for this browser session.
    var wasOpen = false;
    try { wasOpen = sessionStorage.getItem(OPEN_KEY) === "1"; } catch (e) {}
    if (wasOpen) openPanel();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
