// Cloudflare Pages Function — POST /api/chat
//
// "Chat with this dashboard": grounded Q&A over ONE dashboard's own data, with
// clickable source links and an optional web-search supplement. Deploys with
// the site (no separate server) because Pages compiles /functions automatically.
//
// Hard guarantees (see README):
//  - GROUNDED + CITE-OR-ADMIT: answers only from the dashboard data; out of
//    scope → an honest "not in the data".
//  - NEVER-INVENT: any source URL not in the data (or the web results, when the
//    toggle is on) is stripped before responding.
//  - NEVER-FAIL: every error path returns a friendly { answer } with HTTP 200 —
//    never a 500, never a stack trace to the user.
//  - GENERIC: works for any data/<slug>.json in this repo; nothing hard-coded.
//  - SAFE: the slug is sanitised; secrets come from env, never the repo.
//
// Secrets / config (set once in the Cloudflare Pages project — see README):
//   ANTHROPIC_API_KEY  (required for real answers; without it chat degrades to
//                       a friendly "try again" and the rest of the site works)
//   CHAT_MODEL         (optional, default "claude-opus-5")
//   FIRECRAWL_API_KEY  (optional; enables the "Search the web" toggle)

import {
  sanitizeSlug,
  dataPathForSlug,
  extractAllowlist,
  buildContext,
  buildSystemPrompt,
  shapeHistory,
  parseModelReply,
  normalizeWebResults,
  buildWebBlock,
  DEFAULT_SLUG,
} from "./_chat_lib.mjs";

const MODEL_DEFAULT = "claude-opus-5";
const MAX_QUESTION_CHARS = 2000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

// A friendly answer with no sources, always HTTP 200. This is the never-fail
// shape every error path funnels into.
function friendly(message) {
  return json({ answer: message, sources: [] });
}

async function loadDashboardText(env, request, slug) {
  const target = new URL(dataPathForSlug(slug), request.url).toString();
  try {
    // Prefer the Pages ASSETS binding (direct static read); fall back to a
    // same-origin fetch, which Pages also serves from the deployed assets.
    let resp;
    if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
      resp = await env.ASSETS.fetch(new Request(target));
    } else {
      resp = await fetch(target, { cf: { cacheTtl: 300 } });
    }
    if (!resp || !resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

// Live web search via Firecrawl (the token this repo already uses). Never
// throws and never fails the request: any problem → [] and we answer from the
// dashboard data alone.
async function webSearch(env, query) {
  const key = env && env.FIRECRAWL_API_KEY;
  if (!key || !query) return [];
  try {
    const resp = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, limit: 6 }),
    });
    if (!resp || !resp.ok) return [];
    const data = await resp.json();
    return normalizeWebResults(data, 6);
  } catch {
    return [];
  }
}

// Call Claude via raw HTTPS (no SDK, so the site keeps its zero-build static
// deploy). Returns { text } on success or { error } otherwise — the caller maps
// either into a friendly 200.
async function callClaude(env, system, messages) {
  const key = env && env.ANTHROPIC_API_KEY;
  if (!key) return { error: "no_key" };
  const model = (env && env.CHAT_MODEL) || MODEL_DEFAULT;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, max_tokens: 1500, system, messages }),
    });
    if (!resp || !resp.ok) return { error: `status_${resp ? resp.status : "network"}` };
    const data = await resp.json();
    const text = Array.isArray(data.content)
      ? data.content
          .filter((b) => b && b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("")
          .trim()
      : "";
    return { text, stop_reason: data.stop_reason };
  } catch {
    return { error: "network" };
  }
}

export async function onRequestPost({ request, env }) {
  try {
    // --- parse body defensively -------------------------------------------
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const rawSlug = body.slug ?? body.id ?? DEFAULT_SLUG;
    const question = (body.question ?? body.q ?? "").toString().slice(0, MAX_QUESTION_CHARS).trim();
    const history = Array.isArray(body.history) ? body.history : [];
    const web = body.web === true || body.web === "true" || body.web === 1;

    if (!question) {
      return friendly("Ask me anything about this dashboard's data and I'll answer with sources.");
    }

    // --- sanitise + load ---------------------------------------------------
    const slug = sanitizeSlug(rawSlug);
    if (!slug) {
      return friendly("I couldn't recognise that dashboard, so I can't answer from its data.");
    }
    const rawText = await loadDashboardText(env, request, slug);
    if (!rawText) {
      return friendly("I couldn't load that dashboard's data right now, so I can't answer from it yet. Please try again in a moment.");
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      return friendly("That dashboard's data looks unreadable right now, so I can't answer from it. Please try again shortly.");
    }

    const name = (data && (data.title || data.name)) || slug;

    // --- allow-list (never-invent set) + grounded context -----------------
    const allowlist = extractAllowlist(rawText);
    const context = buildContext(data, { name });

    // --- optional web supplement (never-fail) ------------------------------
    let webBlock = "";
    if (web) {
      const rows = await webSearch(env, `${name}: ${question}`);
      if (rows.length) {
        webBlock = buildWebBlock(rows);
        for (const r of rows) allowlist.add(r.url);
      }
    }

    // --- build the request -------------------------------------------------
    const system = [
      buildSystemPrompt({ name, web: web && Boolean(webBlock) }),
      "",
      "=== DASHBOARD DATA (the only facts you may use) ===",
      context,
      webBlock ? "\n=== WEB SEARCH RESULTS ===\n" + webBlock : "",
    ].join("\n");

    const messages = shapeHistory(history, question);

    // --- call the model ----------------------------------------------------
    const result = await callClaude(env, system, messages);
    if (result.error === "no_key") {
      return friendly("The chat assistant isn't switched on yet (its API key hasn't been set). The rest of the dashboard works as normal — please check back soon.");
    }
    if (result.error) {
      return friendly("I'm having trouble reaching the assistant right now. Please try again in a moment.");
    }
    if (!result.text) {
      return friendly("I couldn't produce an answer for that one. Try rephrasing, or ask about a specific figure on the dashboard.");
    }

    // --- parse + never-invent filter --------------------------------------
    const { answer, sources } = parseModelReply(result.text, allowlist);
    return json({
      answer: answer || "The dashboard data doesn't cover that.",
      sources,
    });
  } catch {
    // Absolute backstop — the user always gets a calm 200.
    return friendly("Something went wrong on my side. Please try again in a moment.");
  }
}

// Non-POST requests get a calm JSON note rather than an error page.
export async function onRequest({ request }) {
  if (request.method === "POST") {
    // Should be handled by onRequestPost; here only as a safety net.
    return friendly("Send your question as a POST request.");
  }
  return json({
    ok: true,
    endpoint: "/api/chat",
    method: "POST",
    accepts: { slug: "string", question: "string", history: "array", web: "boolean" },
  });
}
