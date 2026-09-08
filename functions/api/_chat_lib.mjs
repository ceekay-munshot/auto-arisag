// Pure, dependency-free logic for the "Chat with this dashboard" feature.
//
// Everything here is deliberately side-effect-free so it can be unit tested
// under plain Node (`node --test`) AND bundled into the Cloudflare Pages
// Function at functions/api/chat.js. The `_` filename prefix tells Cloudflare
// Pages this is a helper, not a route.
//
// The design mirrors how the rest of this repo treats its data: the dashboard
// JSON is the single source of truth, every fact already ships with a source
// URL, and nothing is invented. These helpers walk *any* dashboard payload
// generically — there is nothing hard-coded to the India Auto dashboard.

// ---------------------------------------------------------------------------
// Slug safety
// ---------------------------------------------------------------------------

// Which dashboard to answer from is chosen by a slug that maps to
// data/<slug>.json. Because that flows into a file path we whitelist hard:
// lowercase letters, digits, underscore and hyphen only, must start
// alphanumeric, max 64 chars. Anything else is rejected (returns null) so a
// caller can never traverse paths (../, absolute paths, URLs, null bytes).
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const DEFAULT_SLUG = "investor_dashboard";

export function sanitizeSlug(raw, fallback = DEFAULT_SLUG) {
  // Missing / blank → fall back to the default dashboard rather than error.
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "string") return null;
  let slug = raw.trim().toLowerCase();
  if (!slug) return fallback;
  // Tolerate a caller passing "<slug>.json"; strip the extension once.
  if (slug.endsWith(".json")) slug = slug.slice(0, -5);
  // Reject explicit traversal attempts up front for clarity (the whitelist
  // below would catch them anyway).
  if (slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
    return null;
  }
  return SLUG_RE.test(slug) ? slug : null;
}

export function dataPathForSlug(slug) {
  return `/data/${slug}.json`;
}

// ---------------------------------------------------------------------------
// Source URLs (the "never-invent" allow-list)
// ---------------------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s"'<>)\]}]+/gi;

export function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

// Trim trailing punctuation that commonly clings to a URL when it is copied
// out of prose (a comma, a full stop, a closing bracket/quote).
export function cleanUrl(url) {
  if (typeof url !== "string") return "";
  let u = url.trim();
  u = u.replace(/[).,;:'"\]}>]+$/, "");
  return u;
}

// Build the allow-list from the *raw* JSON text. Every source URL in the data
// is citable; nothing outside this set may survive in a reply. Working off the
// raw text (rather than a second deep object walk) keeps this cheap on the
// 6 MB+ payloads this repo produces, and every URL lives in a JSON string so
// the delimiting quote bounds the match cleanly.
export function extractAllowlist(rawText) {
  const set = new Set();
  if (typeof rawText !== "string") return set;
  const matches = rawText.match(URL_RE) || [];
  for (const m of matches) {
    const u = cleanUrl(m);
    if (u) set.add(u);
  }
  return set;
}

export function hostnameLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Grounded context builder
// ---------------------------------------------------------------------------

// Keys used as the human-facing label at the head of a fact line (not repeated
// among the facts themselves).
const LABEL_KEYS = ["label", "title", "name", "heading", "metric", "question"];

// Keys that hold a source URL for the fact(s) in their subtree.
const SOURCE_KEYS = [
  "source_url", "summary_source_url", "url", "yahoo_url", "cta_url",
];

// Keys we never recurse into or emit — noisy, chart-only, or huge — so the
// budget is spent on facts an investor would actually ask about.
const SKIP_KEYS = new Set([
  "chart_colors", "background", "palette", "series", "points", "coords",
  "sparkline", "geometry", "svg", "path", "d", "css", "style", "filters",
]);

// Low-signal scalar keys we drop from fact lines (identifiers, styling).
const NOISE_KEYS = new Set([
  "id", "tone", "slug", "key", "icon", "generated_at", "index", "order",
]);

function isNoiseKey(k) {
  return NOISE_KEYS.has(k) || /colou?r/i.test(k);
}

const MAX_FACT_LEN = 500;

function isScalar(v) {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

function fmtScalar(v) {
  if (v === null) return "";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v).replace(/\s+/g, " ").trim();
}

// Find a source URL directly on an object (not deep) so a fact inherits the
// nearest enclosing source.
function localSourceUrl(obj) {
  if (!obj || typeof obj !== "object") return "";
  for (const k of SOURCE_KEYS) {
    if (isHttpUrl(obj[k])) return cleanUrl(obj[k]);
  }
  // source_meta: { url } is the repo's common nested shape.
  const meta = obj.source_meta;
  if (meta && typeof meta === "object" && isHttpUrl(meta.url)) {
    return cleanUrl(meta.url);
  }
  return "";
}

// Render a single object's scalar facts into one compact line, e.g.
//   "Latest Retail: 24.23 lakh — +17.51% YoY | -6.48% MoM  [src: https://fada.in/...]"
function renderFactLine(obj, inheritedSrc) {
  let label = "";
  for (const k of LABEL_KEYS) {
    if (typeof obj[k] === "string" && obj[k].trim()) { label = obj[k]; break; }
  }
  // Emit every scalar fact on this object (this is what keeps the walker
  // generic — no per-dashboard whitelist), skipping the label, source, noise
  // and chart-only keys.
  const facts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (LABEL_KEYS.includes(k) || SOURCE_KEYS.includes(k)) continue;
    if (SKIP_KEYS.has(k) || isNoiseKey(k)) continue;
    if (!isScalar(v)) continue;
    let val = fmtScalar(v);
    if (val === "" || val.toLowerCase() === "none") continue;
    if (val.length > MAX_FACT_LEN) val = val.slice(0, MAX_FACT_LEN) + "…";
    facts.push(`${k}=${val}`);
  }
  if (!label && facts.length === 0) return "";
  const src = localSourceUrl(obj) || inheritedSrc || "";
  const head = label ? `${fmtScalar(label)}: ` : "";
  const body = facts.join(" | ");
  const cite = src ? `  [src: ${src}]` : "";
  return `${head}${body}${cite}`.trim();
}

// Walk any dashboard payload and emit short grounded lines with inline source
// URLs, staying under a character budget (~48k ≈ 12k tokens). Long arrays are
// sampled (first N) so one giant history series can't crowd everything else
// out. Generic: it inspects shape, never specific section names.
export function buildContext(data, options = {}) {
  const {
    name = "this dashboard",
    maxChars = 48000,
    listCap = 8,
    maxDepth = 8,
    sectionFloor = 1000,
  } = options;

  const lines = [];
  let used = 0;
  let globalFull = false;
  let sectionUsed = 0;
  let sectionCap = Infinity;
  let sectionFull = false;

  // Writes a line if there is room in BOTH the global budget and the current
  // section's fair share. Running out of the section's share stops that section
  // only; running out of the global budget stops everything.
  function push(line, indent) {
    if (globalFull || sectionFull || line === "" || line == null) {
      // Still allow explicit blank spacer lines through when there's room.
      if (line !== "" || globalFull || sectionFull) return;
    }
    const text = `${"  ".repeat(indent)}${line}`;
    const len = text.length + 1;
    if (used + len > maxChars) { globalFull = true; return; }
    if (sectionUsed + len > sectionCap) { sectionFull = true; return; }
    lines.push(text);
    used += len;
    sectionUsed += len;
  }

  function walk(node, indent, inheritedSrc, depth) {
    if (globalFull || sectionFull || depth > maxDepth) return;
    const src = localSourceUrl(node) || inheritedSrc;

    if (Array.isArray(node)) {
      const shown = node.slice(0, listCap);
      for (const item of shown) {
        if (globalFull || sectionFull) break;
        if (isScalar(item)) {
          const v = fmtScalar(item);
          if (v) push(`- ${v}`, indent);
        } else {
          walk(item, indent, src, depth + 1);
        }
      }
      if (node.length > shown.length) {
        push(`… (+${node.length - shown.length} more)`, indent);
      }
      return;
    }

    if (node && typeof node === "object") {
      // Emit this object's own facts first, then descend into nested groups.
      const line = renderFactLine(node, src);
      if (line) push(line, indent);

      for (const [k, v] of Object.entries(node)) {
        if (globalFull || sectionFull) break;
        if (SKIP_KEYS.has(k) || SOURCE_KEYS.includes(k) || k === "source_meta") {
          continue;
        }
        if (isScalar(v)) continue; // already captured by renderFactLine
        push(`${k}:`, indent + 1);
        walk(v, indent + 2, src, depth + 1);
      }
    }
  }

  lines.push(`DASHBOARD: ${name}`);
  used += name.length + 12;
  if (data && typeof data === "object") {
    if (data.as_of_date) { const l = `As of: ${fmtScalar(data.as_of_date)}`; lines.push(l); used += l.length + 1; }
    if (data.subtitle) { const l = fmtScalar(data.subtitle); lines.push(l); used += l.length + 1; }

    // Fair-share budgeting: every top-level section gets a slice of what's
    // left, so a huge section (e.g. modules) can't starve later ones (news,
    // stocks, earnings) of grounding. Leftover from small sections rolls
    // forward to the ones still to come.
    const sections = Object.entries(data).filter(([k, v]) =>
      !["title", "subtitle", "as_of_date", "generated_at"].includes(k) &&
      !SKIP_KEYS.has(k) && !isScalar(v));
    let remaining = sections.length;
    for (const [k, v] of sections) {
      if (globalFull) break;
      sectionCap = Math.max(sectionFloor, Math.floor((maxChars - used) / Math.max(1, remaining)));
      sectionUsed = 0;
      sectionFull = false;
      remaining -= 1;
      push("", 0);
      push(`## ${k}`, 0);
      walk(v, 0, "", 1);
      if (sectionFull) lines.push("  … (section trimmed)");
    }
  }
  if (globalFull) lines.push("… (context trimmed to fit the token budget)");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Web search results (supplementary, when the toggle is ON)
// ---------------------------------------------------------------------------

// Normalise whatever a search API returns into {title, url, snippet} rows and
// keep only ones with a real http(s) URL. Kept pure so the never-fail wrapper
// in chat.js can call the network and hand the parsed body straight here.
export function normalizeWebResults(payload, cap = 6) {
  const rows = [];
  const arr =
    (payload && Array.isArray(payload.data) && payload.data) ||
    (payload && Array.isArray(payload.results) && payload.results) ||
    (Array.isArray(payload) ? payload : []);
  for (const r of arr) {
    if (!r || typeof r !== "object") continue;
    const url = cleanUrl(r.url || r.link || "");
    if (!isHttpUrl(url)) continue;
    rows.push({
      title: (r.title || r.name || hostnameLabel(url)).toString().trim(),
      url,
      snippet: (r.description || r.snippet || r.content || "")
        .toString().replace(/\s+/g, " ").trim().slice(0, 300),
    });
    if (rows.length >= cap) break;
  }
  return rows;
}

// The labelled block appended to the context, plus the URLs to add to the
// allow-list, when web search is on.
export function buildWebBlock(rows) {
  if (!rows || rows.length === 0) return "";
  const lines = [
    "WEB SEARCH RESULTS (supplementary only — prefer the dashboard data;",
    "use these only to fill gaps or add recency):",
  ];
  rows.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}  [src: ${r.url}]`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// System prompt (STEP 3 — the heart of the grounding)
// ---------------------------------------------------------------------------

export function buildSystemPrompt({ name = "this dashboard", web = false } = {}) {
  const grounding = web
    ? [
        `You are a research assistant for the "${name}" dashboard.`,
        "Use the dashboard data below as your PRIMARY source. Live web search",
        "results are also provided — use them ONLY to supplement or add",
        "recency; do not use any other outside knowledge. If neither the",
        "dashboard data nor the web results cover the question, say so plainly",
        `(e.g. "The dashboard data doesn't cover that.").`,
      ]
    : [
        `You are a research assistant for the "${name}" dashboard.`,
        "Answer using ONLY the dashboard data below. Do not use outside",
        "knowledge. If the answer isn't in the data, say so plainly (e.g.",
        `"The dashboard data doesn't cover that.") — never guess or invent`,
        "figures, names or sources.",
      ];
  return [
    ...grounding,
    "",
    "Cite the source URL for each claim, drawing the URL only from the",
    "provided data (or, when present, the web results). Write in plain",
    "English, concise and direct. Prefer specific numbers from the data over",
    "vague statements.",
    "",
    "Return ONLY strict JSON, with no prose and no code fences:",
    '{"answer":"...","sources":[{"label":"...","url":"..."}],"in_data":true|false}',
    "The sources array lists only what you actually used, with URLs copied",
    "verbatim from the material above. If the answer isn't available in the",
    "material, set in_data=false and sources=[].",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Conversation history shaping
// ---------------------------------------------------------------------------

function normalizeTurn(item) {
  if (!item || typeof item !== "object") return null;
  // Shape A: {role, content|text}
  if (item.role) {
    const role = item.role === "assistant" || item.role === "bot" ? "assistant"
      : item.role === "user" || item.role === "human" ? "user" : null;
    const content = (item.content ?? item.text ?? item.answer ?? item.message ?? "")
      .toString();
    if (!role || !content.trim()) return null;
    return { role, content: content.trim() };
  }
  return null;
}

// Turn a loose history array + the new question into a strictly alternating
// user/assistant list that ALWAYS ends on the new user question. Repairs
// doubled roles (keeps the latest of a run) and guarantees the sequence starts
// with a user turn.
export function shapeHistory(history, question, maxTurns = 12) {
  const raw = Array.isArray(history) ? history : [];
  const expanded = [];
  for (const item of raw) {
    // Support {question, answer} pairs too.
    if (item && typeof item === "object" && !item.role &&
        (item.question || item.answer)) {
      if (item.question) expanded.push({ role: "user", content: String(item.question).trim() });
      if (item.answer) expanded.push({ role: "assistant", content: String(item.answer).trim() });
      continue;
    }
    const t = normalizeTurn(item);
    if (t) expanded.push(t);
  }

  // Collapse consecutive same-role turns to keep strict alternation.
  const alt = [];
  for (const turn of expanded) {
    if (!turn.content) continue;
    if (alt.length && alt[alt.length - 1].role === turn.role) {
      alt[alt.length - 1] = turn; // keep the most recent of a run
    } else {
      alt.push(turn);
    }
  }
  // Must start on a user turn.
  while (alt.length && alt[0].role !== "user") alt.shift();
  // History should hand off to the new user question, so drop a dangling
  // trailing user turn (it would double up with the question).
  while (alt.length && alt[alt.length - 1].role === "user") alt.pop();

  // Cap the number of prior turns (keep the most recent, preserving alternation
  // by trimming from the front on a user boundary).
  let trimmed = alt;
  if (alt.length > maxTurns) {
    trimmed = alt.slice(alt.length - maxTurns);
    while (trimmed.length && trimmed[0].role !== "user") trimmed.shift();
  }

  const q = (question ?? "").toString().trim();
  return [...trimmed, { role: "user", content: q || "(no question provided)" }];
}

// ---------------------------------------------------------------------------
// Reply parsing + never-invent filtering
// ---------------------------------------------------------------------------

// Keep only sources whose URL is in the allow-list, de-duped, with a friendly
// label fallback. This is the never-invent gate.
export function filterSources(sources, allowlist) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(sources)) return out;
  for (const s of sources) {
    if (!s) continue;
    const url = cleanUrl(typeof s === "string" ? s : s.url || "");
    if (!isHttpUrl(url) || !allowlist.has(url) || seen.has(url)) continue;
    seen.add(url);
    const label =
      (typeof s === "object" && s.label && String(s.label).trim()) ||
      hostnameLabel(url);
    out.push({ label, url });
  }
  return out;
}

function sliceJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

// Robustly turn the model's raw text into {answer, sources}. Handles: clean
// JSON; JSON wrapped in prose or ```fences```; and total JSON failure (falls
// back to the raw text as the answer and recovers any allow-listed URLs it
// mentioned). Honours in_data=false → no sources. Never throws.
export function parseModelReply(rawText, allowlist) {
  const text = (rawText ?? "").toString().trim();
  const empty = { answer: "", sources: [] };
  if (!text) return empty;

  const candidates = [];
  candidates.push(text);
  const fenced = text.replace(/```(?:json)?/gi, "").trim();
  if (fenced !== text) candidates.push(fenced);
  const sliced = sliceJsonObject(fenced) || sliceJsonObject(text);
  if (sliced) candidates.push(sliced);

  for (const cand of candidates) {
    try {
      const obj = JSON.parse(cand);
      if (obj && typeof obj === "object" && !Array.isArray(obj) && "answer" in obj) {
        const answer = (obj.answer ?? "").toString().trim();
        const inData = obj.in_data !== false; // default true unless explicitly false
        const sources = inData ? filterSources(obj.sources, allowlist) : [];
        return { answer: answer || text, sources };
      }
    } catch {
      // try the next candidate
    }
  }

  // No parseable JSON — use the raw text and recover any real URLs it named.
  const recovered = [];
  const seen = new Set();
  for (const m of text.match(URL_RE) || []) {
    const u = cleanUrl(m);
    if (isHttpUrl(u) && allowlist.has(u) && !seen.has(u)) {
      seen.add(u);
      recovered.push({ label: hostnameLabel(u), url: u });
    }
  }
  return { answer: text, sources: recovered };
}
