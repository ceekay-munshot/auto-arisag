// Dependency-free tests for the pure chat logic.
//
// Run with:   npm test        (see package.json)
//        or:   node --test
//
// These cover the security- and correctness-critical pure functions only —
// no network, no mocks, no dependencies.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeSlug,
  extractAllowlist,
  buildContext,
  filterSources,
  parseModelReply,
  shapeHistory,
  normalizeWebResults,
  buildWebBlock,
  DEFAULT_SLUG,
} from "../functions/api/_chat_lib.mjs";

// A tiny, realistic dashboard payload with real numbers + inline source URLs.
const SAMPLE = {
  title: "India Auto Demand Monitor",
  as_of_date: "2026-09-07",
  subtitle: "Official-first dashboard.",
  summary: {
    cards: [
      {
        label: "Latest Retail",
        value: "2423201",
        display: "24.23 lakh",
        change: "+17.51% YoY",
        source_url: "https://www.fada.in/press-release/august-2026",
      },
    ],
  },
  modules: {
    wholesale: {
      title: "Wholesale Lens",
      source_meta: { name: "SIAM", url: "https://www.siam.in/wholesale-feb-2026" },
      latest_month: "2026-02",
      latest_units: "1987654",
    },
  },
};

// ---------------------------------------------------------------------------
// 1. Slug safety
// ---------------------------------------------------------------------------

test("sanitizeSlug accepts clean slugs and normalises case", () => {
  assert.equal(sanitizeSlug("investor_dashboard"), "investor_dashboard");
  assert.equal(sanitizeSlug("Auto-F1"), "auto-f1");
  assert.equal(sanitizeSlug("dash123"), "dash123");
});

test("sanitizeSlug strips a trailing .json", () => {
  assert.equal(sanitizeSlug("investor_dashboard.json"), "investor_dashboard");
});

test("sanitizeSlug falls back to default when empty/missing", () => {
  assert.equal(sanitizeSlug(undefined), DEFAULT_SLUG);
  assert.equal(sanitizeSlug(null), DEFAULT_SLUG);
  assert.equal(sanitizeSlug(""), DEFAULT_SLUG);
  assert.equal(sanitizeSlug("   "), DEFAULT_SLUG);
});

test("sanitizeSlug rejects path traversal and unsafe characters", () => {
  assert.equal(sanitizeSlug("../secrets"), null);
  assert.equal(sanitizeSlug("../../etc/passwd"), null);
  assert.equal(sanitizeSlug("foo/bar"), null);
  assert.equal(sanitizeSlug("foo\\bar"), null);
  assert.equal(sanitizeSlug("a b"), null);
  assert.equal(sanitizeSlug("drop;table"), null);
  assert.equal(sanitizeSlug("http://evil.com/x"), null);
  assert.equal(sanitizeSlug("x".repeat(65)), null);
  assert.equal(sanitizeSlug(42), null);
});

// ---------------------------------------------------------------------------
// 2. Grounded context carries real numbers + inline source URLs
// ---------------------------------------------------------------------------

test("buildContext includes real figures and inline source URLs", () => {
  const ctx = buildContext(SAMPLE, { name: SAMPLE.title });
  // Real numbers from the data appear.
  assert.match(ctx, /24\.23 lakh/);
  assert.match(ctx, /\+17\.51% YoY/);
  assert.match(ctx, /1987654/);
  // Inline source URLs appear next to the facts.
  assert.match(ctx, /\[src: https:\/\/www\.fada\.in\/press-release\/august-2026\]/);
  assert.match(ctx, /\[src: https:\/\/www\.siam\.in\/wholesale-feb-2026\]/);
  // The dashboard name is stated.
  assert.match(ctx, /India Auto Demand Monitor/);
});

test("buildContext respects the character budget", () => {
  // A wide object (many keys, not one array) so the per-list sample cap does
  // not short-circuit before the character budget is exercised.
  const big = { title: "Big", groups: {} };
  for (let i = 0; i < 5000; i++) {
    big.groups[`grp_${i}`] = { label: `Row ${i}`, value: String(i), source_url: `https://ex.com/${i}` };
  }
  const ctx = buildContext(big, { name: "Big", maxChars: 4000 });
  assert.ok(ctx.length <= 4400, `context should stay near budget, got ${ctx.length}`);
  assert.match(ctx, /trimmed/); // "section trimmed" or "context trimmed"
});

test("buildContext spreads the budget across every top-level section", () => {
  // Two sections: a huge one and a small one. The small one must still appear
  // (fair-share budgeting), not be starved by the huge one walked first.
  const payload = { title: "T", huge: {}, tiny: { label: "Important", value: "42", source_url: "https://x.com/y" } };
  for (let i = 0; i < 3000; i++) {
    payload.huge[`k${i}`] = { label: `H${i}`, value: String(i), source_url: `https://h.com/${i}` };
  }
  const ctx = buildContext(payload, { name: "T", maxChars: 8000 });
  assert.match(ctx, /## tiny/);
  assert.match(ctx, /Important: value=42/);
  assert.match(ctx, /\[src: https:\/\/x\.com\/y\]/);
});

// ---------------------------------------------------------------------------
// 3. Never-invent filter (keeps a real URL, drops a fake one)
// ---------------------------------------------------------------------------

test("filterSources keeps allow-listed URLs and drops invented ones", () => {
  const allow = extractAllowlist(JSON.stringify(SAMPLE));
  const sources = [
    { label: "FADA", url: "https://www.fada.in/press-release/august-2026" }, // real
    { label: "Made up", url: "https://totally-invented.example/report" },     // fake
    { label: "SIAM", url: "https://www.siam.in/wholesale-feb-2026" },         // real
  ];
  const kept = filterSources(sources, allow);
  const urls = kept.map((s) => s.url);
  assert.ok(urls.includes("https://www.fada.in/press-release/august-2026"));
  assert.ok(urls.includes("https://www.siam.in/wholesale-feb-2026"));
  assert.ok(!urls.includes("https://totally-invented.example/report"));
  assert.equal(kept.length, 2);
});

test("filterSources de-dupes repeated URLs", () => {
  const allow = new Set(["https://a.com/x"]);
  const kept = filterSources(
    [
      { label: "A", url: "https://a.com/x" },
      { label: "A again", url: "https://a.com/x" },
    ],
    allow,
  );
  assert.equal(kept.length, 1);
});

test("parseModelReply strips fake sources even from valid JSON", () => {
  const allow = extractAllowlist(JSON.stringify(SAMPLE));
  const raw = JSON.stringify({
    answer: "Retail was 24.23 lakh in Aug 2026.",
    sources: [
      { label: "FADA", url: "https://www.fada.in/press-release/august-2026" },
      { label: "Fake", url: "https://fake.example/oops" },
    ],
    in_data: true,
  });
  const out = parseModelReply(raw, allow);
  assert.equal(out.sources.length, 1);
  assert.equal(out.sources[0].url, "https://www.fada.in/press-release/august-2026");
});

test("parseModelReply recovers JSON wrapped in prose / code fences", () => {
  const allow = new Set(["https://a.com/x"]);
  const raw =
    "Sure! Here you go:\n```json\n" +
    JSON.stringify({ answer: "Hi", sources: [{ label: "A", url: "https://a.com/x" }], in_data: true }) +
    "\n```\nHope that helps.";
  const out = parseModelReply(raw, allow);
  assert.equal(out.answer, "Hi");
  assert.equal(out.sources[0].url, "https://a.com/x");
});

test("parseModelReply falls back to raw text and recovers allow-listed URLs", () => {
  const allow = new Set(["https://a.com/x"]);
  const out = parseModelReply(
    "Not JSON at all, but see https://a.com/x and https://evil.com/y",
    allow,
  );
  assert.match(out.answer, /Not JSON at all/);
  assert.equal(out.sources.length, 1);
  assert.equal(out.sources[0].url, "https://a.com/x");
});

// ---------------------------------------------------------------------------
// 4. Out-of-scope → empty sources
// ---------------------------------------------------------------------------

test("parseModelReply returns no sources when in_data is false", () => {
  const allow = extractAllowlist(JSON.stringify(SAMPLE));
  const raw = JSON.stringify({
    answer: "The dashboard data doesn't cover that.",
    sources: [{ label: "FADA", url: "https://www.fada.in/press-release/august-2026" }],
    in_data: false,
  });
  const out = parseModelReply(raw, allow);
  assert.equal(out.sources.length, 0);
  assert.match(out.answer, /doesn't cover that/);
});

// ---------------------------------------------------------------------------
// 5. History shaping (alternating, ends on the user turn)
// ---------------------------------------------------------------------------

test("shapeHistory yields alternating turns ending on the new question", () => {
  const history = [
    { role: "user", content: "What was retail?" },
    { role: "assistant", content: "24.23 lakh." },
  ];
  const shaped = shapeHistory(history, "And wholesale?");
  // Ends on the new user question.
  assert.equal(shaped[shaped.length - 1].role, "user");
  assert.equal(shaped[shaped.length - 1].content, "And wholesale?");
  // Strictly alternating.
  for (let i = 1; i < shaped.length; i++) {
    assert.notEqual(shaped[i].role, shaped[i - 1].role);
  }
  // Starts on a user turn.
  assert.equal(shaped[0].role, "user");
});

test("shapeHistory repairs doubled roles and drops a dangling user turn", () => {
  const history = [
    { role: "user", content: "first" },
    { role: "user", content: "second (replaces first)" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "dangling — should be dropped" },
  ];
  const shaped = shapeHistory(history, "real question");
  for (let i = 1; i < shaped.length; i++) {
    assert.notEqual(shaped[i].role, shaped[i - 1].role);
  }
  assert.equal(shaped[shaped.length - 1].content, "real question");
  // The dangling user turn must not appear before the question.
  assert.ok(!shaped.slice(0, -1).some((t) => t.content.startsWith("dangling")));
});

test("shapeHistory accepts {question, answer} pairs", () => {
  const shaped = shapeHistory(
    [{ question: "Q1", answer: "A1" }],
    "Q2",
  );
  assert.deepEqual(shaped, [
    { role: "user", content: "Q1" },
    { role: "assistant", content: "A1" },
    { role: "user", content: "Q2" },
  ]);
});

test("shapeHistory handles empty history", () => {
  const shaped = shapeHistory([], "only question");
  assert.deepEqual(shaped, [{ role: "user", content: "only question" }]);
});

// ---------------------------------------------------------------------------
// 6. Web results normalisation (supplementary block + allow-list URLs)
// ---------------------------------------------------------------------------

test("normalizeWebResults keeps rows with real URLs and caps the count", () => {
  const payload = {
    data: [
      { title: "One", url: "https://news.example/1", description: "first" },
      { title: "No URL", description: "dropped" },
      { title: "Two", url: "https://news.example/2", description: "second" },
    ],
  };
  const rows = normalizeWebResults(payload, 6);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, "https://news.example/1");

  const block = buildWebBlock(rows);
  assert.match(block, /supplementary only/i);
  assert.match(block, /\[src: https:\/\/news\.example\/1\]/);
});
