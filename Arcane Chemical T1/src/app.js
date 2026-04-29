const PAGES = [
  ["overview", "Overview"],
  ["event", "Iran-Israel Event"],
  ["operations", "Operations & Assets"],
  ["bromine", "Bromine Intelligence"],
  ["salt", "Industrial Salt Intelligence"],
  ["derivatives", "Derivatives / SOP / New Businesses"],
  ["trade", "Trade, Customers, Geography & Global Supply"],
  ["costs", "Cost Drivers & Sensitivities"],
  ["price-history", "Price History & Simulation"],
  ["forecast", "Forecasting & Scenarios"],
  ["capex", "Capex, Subsidiaries & Future Projects"],
];
const SCENARIO_PAGES = new Set(["costs", "forecast"]);
const LIVE_REFRESH_PAGES = new Set(["bromine", "salt", "trade", "price-history"]);
const LOCAL_REFRESH_HOST_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)$/;
const FIRECRAWL_API_KEY = window.__FIRECRAWL_API_KEY__ || "fc-203d41c5b1984cdabee2a7564572efea";

const state = { d: null, page: "overview", scenario: "base", selectedEventId: null, selectedMixPeriod: null, overrides: resetOverrides(), priceInputs: null, charts: new Map(), pending: [], sources: new Map(), refreshingLive: false };
const dom = {
  brandTitle: document.getElementById("brand-title"),
  brandCopy: document.getElementById("brand-copy"),
  sourceStamp: document.getElementById("source-stamp"),
  buildStamp: document.getElementById("build-stamp"),
  hero: document.querySelector(".hero"),
  heroTitle: document.getElementById("hero-title"),
  heroText: document.getElementById("hero-text"),
  heroUpdates: document.getElementById("hero-updates"),
  heroMetrics: document.getElementById("hero-metrics"),
  sidebarNav: document.getElementById("sidebar-nav"),
  toolbar: document.querySelector(".toolbar"),
  toolbarStatus: document.getElementById("toolbar-status"),
  scenarioSelect: document.getElementById("scenario-select"),
  liveRefresh: document.getElementById("live-refresh"),
  downloadAll: document.getElementById("download-all"),
  pageContainer: document.getElementById("page-container"),
  loadingMask: document.getElementById("loading-mask"),
  loadingText: document.getElementById("loading-text"),
  sourceModal: document.getElementById("source-modal"),
  sourceModalBody: document.getElementById("source-modal-body"),
  sourceModalTitle: document.getElementById("source-modal-title"),
  sourceModalClose: document.getElementById("source-modal-close"),
};
const BUILD_ID = window.__BUILD_ID__ || "dev";

document.addEventListener("DOMContentLoaded", init);
window.addEventListener("resize", () => state.charts.forEach((c) => c.resize()));

async function init() {
  if (window.self !== window.top || new URLSearchParams(window.location.search).get("embed") === "1") document.body.classList.add("embed-mode");
  try {
    load(true, "Loading Archean research dashboard...");
    const d = await fetchDashboardPayload(BUILD_ID);
    applyDashboardPayload(d);
    bindGlobal();
    renderAll();
  } catch (e) {
    fail(e);
  } finally {
    load(false);
  }
}

function bindGlobal() {
  dom.scenarioSelect.onchange = (e) => { state.scenario = e.target.value; state.overrides = resetOverrides(); renderHero(); renderToolbar(`Scenario preset changed to ${scenarioLabel()}.`); renderPage(); };
  dom.liveRefresh.onclick = () => refreshLiveData();
  dom.downloadAll.onclick = () => exportCurrent();
  dom.sourceModalClose.onclick = closeSourceModal;
  document.querySelectorAll("[data-source-close]").forEach((el) => el.onclick = closeSourceModal);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSourceModal(); });
}

async function fetchDashboardPayload(versionToken) {
  const r = await fetch(`./data/dashboard.json?v=${encodeURIComponent(versionToken)}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`Dashboard payload request failed with ${r.status}.`);
  return r.json();
}

function applyDashboardPayload(d, preserve = {}) {
  state.d = { meta: d.meta || {}, company: d.company || {}, overview: d.overview || {}, events: d.events || {}, tables: d.tables || {}, trade: d.trade_summary || {}, priceModule: d.price_module || null, sensitivity: d.sensitivity || {}, assumptions: d.forecast_assumptions || {}, methodology: d.methodology || {}, sourcesList: Array.isArray(d.sources) ? d.sources : [] };
  state.sources = new Map(state.d.sourcesList.map((s) => [s.id, s]));
  const scenarioKeys = Object.keys(state.d.assumptions);
  state.scenario = preserve.scenario && state.d.assumptions[preserve.scenario] ? preserve.scenario : (scenarioKeys[0] || "base");
  const eventIds = new Set((state.d.events.items || []).map((item) => item.id));
  state.selectedEventId = preserve.selectedEventId && eventIds.has(preserve.selectedEventId)
    ? preserve.selectedEventId
    : (state.d.events.default_event_id || (state.d.events.items || [])[0]?.id || null);
  const mixPeriodsSet = new Set((state.d.overview.mix_history || []).map((item) => item.period));
  state.selectedMixPeriod = preserve.selectedMixPeriod && mixPeriodsSet.has(preserve.selectedMixPeriod)
    ? preserve.selectedMixPeriod
    : ((state.d.overview.mix_history || []).find((item) => item.period === "9MFY26")?.period || (state.d.overview.mix_history || []).slice(-1)[0]?.period || null);
  state.priceInputs = buildEditablePriceInputs(state.d.priceModule, preserve.priceInputs);
}

function renderAll() { renderSidebar(); renderScenario(); renderBrand(); renderHero(); renderToolbar(); renderPage(); bindSourceButtons(); }

function renderSidebar() {
  dom.sidebarNav.innerHTML = PAGES.map(([id, label]) => `<button class="nav-button ${state.page === id ? "is-active" : ""}" type="button" data-page="${id}"><span class="subtle-label">Research view</span><strong>${esc(label)}</strong><span class="meta-copy">${esc(label)}</span></button>`).join("");
  dom.sidebarNav.querySelectorAll("[data-page]").forEach((b) => b.onclick = () => { state.page = b.getAttribute("data-page"); renderSidebar(); renderScenario(); renderHero(); renderToolbar(`${pageName()} loaded.`); renderPage(); window.scrollTo({ top: 0, behavior: "smooth" }); });
}

function renderScenario() {
  dom.scenarioSelect.innerHTML = Object.keys(state.d.assumptions).map((k) => `<option value="${k}" ${k === state.scenario ? "selected" : ""}>${esc(state.d.assumptions[k].label || k)}</option>`).join("");
  dom.scenarioSelect.hidden = !pageUsesScenario();
}
function renderBrand() {
  dom.brandTitle.textContent = `${state.d.company.short_name || "Archean"} Research Dashboard`;
  dom.brandCopy.textContent = `${state.d.company.sector || "Specialty marine chemicals"} | Latest verified period ${state.d.company.latest_update_label || "not available"}.`;
  dom.sourceStamp.textContent = `${state.d.sourcesList.length} registered sources`;
  dom.buildStamp.textContent = `Build ${state.d.meta.build_id || BUILD_ID} | ${fmtDate(state.d.meta.generated_at)}`;
}
function renderHero() {
  const heroData = pageHeroData();
  dom.heroTitle.textContent = pageName();
  dom.heroText.textContent = heroData.summary;
  dom.hero.classList.toggle("hero--compact", false);
  const updates = (heroData.updates || []).filter((item) => item && item.text);
  dom.heroUpdates.innerHTML = updates.length ? `
    <div class="hero-updates-head">
      <p class="subtle-label">Most recent updates</p>
    </div>
    <div class="hero-updates-grid">
      ${updates.map((item) => heroUpdate(item.text, item.source_id)).join("")}
    </div>
  ` : "";
  dom.heroMetrics.innerHTML = (heroData.metrics || []).slice(0, 4).map((item) => hero(item.label, item.value, item.note, item.source_id)).join("");
  dom.heroMetrics.hidden = !dom.heroMetrics.innerHTML.trim();
  bindSourceButtons();
}
function renderToolbar(msg) {
  dom.scenarioSelect.hidden = !pageUsesScenario();
  const isPriceHistory = state.page === "price-history";
  const supportsRefresh = pageUsesLiveRefresh();
  dom.toolbar.hidden = false;
  dom.downloadAll.hidden = isPriceHistory;
  dom.downloadAll.style.display = isPriceHistory ? "none" : "";
  dom.liveRefresh.hidden = !supportsRefresh;
  dom.liveRefresh.disabled = state.refreshingLive;
  dom.liveRefresh.textContent = state.refreshingLive ? "Refreshing..." : (isPriceHistory ? "Refresh latest bromine" : "Refresh live data");
  dom.toolbarStatus.textContent = isPriceHistory
    ? (msg || `${pageName()} | Refresh latest Sunsirs bromine price and rebuild this tab.`)
    : (msg || (pageUsesScenario() ? `${pageName()} | Refresh mode ${state.d.meta.refresh_mode || "cached"} | Selected scenario ${scenarioLabel()}` : `${pageName()} | Refresh mode ${state.d.meta.refresh_mode || "cached"}`));
  dom.downloadAll.textContent = exportLabel();
}
function valueDensityClass(v) {
  const len = String(v == null ? "" : v).trim().length;
  if (len > 28) return "is-compact";
  if (len > 18) return "is-tight";
  return "";
}
function hero(t, v, n, s) {
  const density = valueDensityClass(v);
  return `<div class="metric-card ${density}"><p class="subtle-label">${esc(t)}</p><div class="metric-value">${esc(v)}</div>${n && String(n).trim() ? `<div class="metric-footnote">${esc(n)}</div>` : ""}${src(s)}</div>`;
}
function heroUpdate(text, sourceId) { return `<div class="hero-update-card"><p class="note-copy">${esc(text)}</p>${src(sourceId)}</div>`; }
function pageHeroData() {
  const f = latestFinancial();
  const brom = latestSeg("Bromine");
  const salt = latestSeg("Industrial Salt");
  const deriv = latestSeg("Bromine Derivatives");
  const sop = latestSeg("Sulphate of Potash");
  const facts = state.d.overview.facts || {};
    const trade = state.d.trade || {};
    const bromineTradeYear = trade.bromine_latest_reliable_year || 2024;
    const bromineTradeImportSource = trade.bromine_latest_reliable_import_source_id || "wits-ind-bromine-2024-import";
    const bromineTradeExportSource = trade.bromine_latest_reliable_export_source_id || "wits-ind-bromine-2024-export";
    const bromineTradeWorldSource = trade.bromine_latest_reliable_world_export_source_id || "wits-world-bromine-2024-export";
    const nextQuarter = scenarioRows()[0] || {};
    const capexRows = rows("company_capex_projects");
    const largestCapex = [...capexRows].sort((a, b) => (b.capex_amount || 0) - (a.capex_amount || 0))[0] || {};
    const back = backtest();
    const eventPage = currentEvent();

  switch (state.page) {
    case "event":
      return {
        summary: eventPage?.analysis_scope_note || "This page studies how Iran-Israel conflict affects bromine, Archean and trade routes.",
        metrics: [],
        updates: [],
      };
    case "operations":
      return {
        summary: "This page shows where Archean's plants are, what they make, and where extra output can still come from.",
        metrics: [
          { label: "Bromine plant capacity", value: "42.5 ktpa", note: "Main bromine plant at Hajipir", source_id: "archean-crisil-fy25" },
          { label: "Salt capacity", value: "6.0 mtpa", note: "Main salt platform", source_id: "archean-crisil-fy25" },
          { label: "Acume running level", value: "30% to 40%", note: "Latest management range", source_id: "archean-q3fy26-transcript" },
          { label: "Largest current project", value: largestCapex.project_name || "SiCSem", note: "Biggest capex line today", source_id: largestCapex.source || "archean-q3fy26-transcript" },
        ],
        updates: [
          { text: "Acume is still running at only 30% to 40%, so there is room to grow before the company needs another big expansion step.", source_id: "archean-q3fy26-transcript" },
          { text: "Jakhau jetty is a real operating limit because it works only in fair-weather months.", source_id: "archean-ar-fy25" },
          { text: "SiCSem is still the biggest project in the list, and site work has already started in Odisha.", source_id: "archean-q3fy26-transcript" },
        ],
      };
    case "bromine":
      return {
        summary: "This page focuses on bromine because bromine still has the biggest effect on Archean's profit.",
        metrics: [
          { label: "Q3 bromine volume", value: fmtTons(brom?.volume_tons), note: "Latest reported sales volume", source_id: brom?.source_id },
            { label: "Q3 bromine realization", value: fmtRsTon(brom?.implied_realization_per_ton), note: "Revenue per ton sold", source_id: brom?.source_id },
          { label: "Bromine backlog", value: fmtTons(facts.bromine_backlog_tons), note: "Management update after Q3", source_id: "archean-q3fy26-transcript" },
          { label: "Base next-quarter EBITDA", value: fmtRs(nextQuarter.predicted_ebitda), note: "Current model view", source_id: "derived-model" },
        ],
        updates: [
          { text: "Management said demand is healthy, but actual bromine volume stayed weak. That means the problem still looks more internal than market-wide.", source_id: "archean-q3fy26-transcript" },
          { text: "Q3 bromine volume stayed well below the Q1 level, so output recovery still matters more than a small price move.", source_id: "archean-q3fy26-presentation" },
          { text: `India remained a net bromine importer in the latest reliable full-year trade data (${bromineTradeYear}), which supports the idea that local demand can absorb more output once plants run better.`, source_id: bromineTradeImportSource },
        ],
      };
    case "salt":
      return {
        summary: "This page shows why salt matters: it brings steady volume, supports plant use, and helps keep cash flow moving even when bromine is weak.",
        metrics: [
          { label: "Q3 salt volume", value: fmtTons(salt?.volume_tons), note: "Latest reported sales volume", source_id: salt?.source_id },
            { label: "Q3 salt realization", value: fmtRsTon(salt?.implied_realization_per_ton), note: "Revenue per ton sold", source_id: salt?.source_id },
          { label: "Salt guidance", value: `${fmtCompact(facts.salt_guidance_mt)} mt`, note: "Management target for FY26", source_id: "archean-q3fy26-transcript" },
          { label: "Sojitz offtake", value: "2.2 mtpa", note: "Long-term contract base", source_id: "archean-crisil-fy25" },
        ],
        updates: [
          { text: "Q3 salt volume moved back above 1 million tons, which helped steady the business while bromine stayed weak.", source_id: "archean-q3fy26-presentation" },
          { text: "The salt business now has 6.0 million tons of capacity, so there is still room to push more volume through the system.", source_id: "archean-crisil-fy25" },
          { text: "China remained the biggest destination in India's salt export data, so shipping routes still matter a lot here.", source_id: "wits-ind-salt-2024-export" },
        ],
      };
    case "derivatives":
      return {
        summary: "This page separates businesses that are already earning revenue from projects that are still early or uncertain.",
        metrics: [
          { label: "Acume revenue", value: fmtRs(deriv?.revenue), note: "Latest disclosed downstream revenue", source_id: deriv?.source_id },
          { label: "Acume volume", value: fmtTons(deriv?.volume_tons), note: "Latest disclosed downstream volume", source_id: deriv?.source_id },
          { label: "SOP revenue", value: fmtRs(sop?.revenue), note: "Still small today", source_id: sop?.source_id },
          { label: "Acume running level", value: "30% to 40%", note: "Latest management range", source_id: "archean-q3fy26-transcript" },
        ],
        updates: [
          { text: "Acume is still in the early scale-up phase, with running levels only around 30% to 40%.", source_id: "archean-q3fy26-transcript" },
          { text: "SOP has finished pilot work, but plant-scale trials are still the key next step.", source_id: "archean-q2fy26-transcript" },
          { text: "Mudchemie has started at an initial commercial scale, but approvals and certifications are still ongoing.", source_id: "archean-q3fy26-presentation" },
        ],
      };
    case "trade":
      return {
        summary: "This page combines customer concentration, destination mix, import dependence and global bromine supply context in one place.",
        metrics: [
          { label: "Export share", value: fmtPct(facts.export_share_pct), note: "Latest disclosed mix", source_id: "archean-q3fy26-presentation" },
          { label: "Largest customer", value: fmtPct(facts.largest_customer_pct), note: "Single-customer exposure", source_id: "archean-q3fy26-presentation" },
          { label: "India bromine position", value: "Net importer", note: `Latest reliable full-year trade data (${bromineTradeYear})`, source_id: bromineTradeImportSource },
          { label: "India global export share", value: fmtPct((trade.india_bromine_share_series || []).slice(-1)[0]?.india_bromine_export_share_pct), note: `Share of world bromine exports in ${bromineTradeYear}`, source_id: bromineTradeWorldSource },
        ],
        updates: [
          { text: "Archean remains export-led, so freight and destination demand still matter a lot.", source_id: "archean-q3fy26-presentation" },
          { text: "India still has no close listed bromine peer, so India trade position is the better benchmark lens.", source_id: "derived-model" },
          { text: `India still imported more bromine than it exported in the latest reliable full-year (${bromineTradeYear}).`, source_id: bromineTradeImportSource },
        ],
      };
    case "costs":
      return {
        summary: "This page shows what moves margins most: bromine realization, bromine volume, freight, power and weather risk.",
        metrics: [
          { label: "Q3 EBITDA margin", value: fmtPct(f?.ebitda_margin), note: "Latest reported margin", source_id: f?.source_id },
          { label: "Bromine realization change", value: fmtSignedPct(state.overrides.brominePriceShiftPct), note: "Current manual change", source_id: "derived-model" },
          { label: "Freight stress", value: `${state.overrides.freightStressBps} bps`, note: "Current manual change", source_id: "derived-model" },
          { label: "Base next-quarter EBITDA", value: fmtRs(nextQuarter.predicted_ebitda), note: "Current model view", source_id: "derived-model" },
        ],
        updates: [
          { text: "The latest reported EBITDA margin stayed under pressure because bromine output is still not back to normal.", source_id: f?.source_id },
          { text: "The model keeps freight, FX, power and monsoon stress visible instead of hiding them inside one number.", source_id: "derived-model" },
          { text: "Salt helps support the system, but bromine still does most of the heavy lifting for profit.", source_id: "derived-model" },
        ],
      };
    case "price-history":
      return {
        summary: "This page is a file-ready UI shell for bromine and industrial salt price history plus simple forward simulation.",
        metrics: [],
        updates: [],
      };
      case "forecast":
        return {
          summary: "This page shows what the next 4 to 8 quarters could look like under bull, base and bear cases.",
          metrics: [
            { label: `${scenarioLabel()} next-quarter revenue`, value: fmtRs(nextQuarter.predicted_revenue), note: "Current model view", source_id: "derived-model" },
            { label: `${scenarioLabel()} next-quarter EBITDA`, value: fmtRs(nextQuarter.predicted_ebitda), note: "Current model view", source_id: "derived-model" },
            { label: `${scenarioLabel()} next-quarter margin`, value: fmtPct(nextQuarter.predicted_margin), note: "Current model view", source_id: "derived-model" },
            { label: "Backtest quality", value: back.badge, note: "How much history the model has", source_id: "derived-model" },
          ],
          updates: [
            { text: "The model now shows the next four quarters directly on the page, not just an abstract scenario summary.", source_id: "derived-model" },
            { text: "Bull, base and bear cases stay visible together so you can compare them quarter by quarter.", source_id: "derived-model" },
            { text: back.summary, source_id: "derived-model" },
          ],
        };
    case "capex":
      return {
        summary: "This page shows which projects already earn money, which are just starting up, and which are still long-term bets.",
        metrics: [
          { label: "Total disclosed capex", value: `${round(sum(capexRows.map((r) => r.capex_amount)), 1)} Rs cr`, note: "Active and announced projects", source_id: "archean-ar-fy25" },
          { label: "Largest project", value: largestCapex.project_name || "SiCSem", note: "Biggest capex line", source_id: largestCapex.source || "archean-q3fy26-transcript" },
          { label: "Project already earning", value: "Acume", note: "Current downstream business with revenue", source_id: "archean-q3fy26-transcript" },
          { label: "Longer-term project", value: "SiCSem / Offgrid", note: "Still not part of near-term earnings", source_id: "archean-q3fy26-presentation" },
        ],
        updates: [
          { text: "SiCSem remains the biggest project in the list, and management says site execution is already underway.", source_id: "archean-q3fy26-transcript" },
          { text: "Acume is the clearest example of a project that already has revenue today.", source_id: "archean-q3fy26-transcript" },
          { text: "Mudchemie has started commercial operations at an initial scale, but it is still going through customer approvals.", source_id: "archean-q3fy26-presentation" },
        ],
      };
      case "overview":
      default:
        return {
          summary: "This page gives the shortest version of what is happening at Archean right now.",
        metrics: [
          { label: "Q3 FY26 revenue", value: fmtRs(f?.revenue_total), note: "Consolidated reported revenue", source_id: f?.source_id },
          { label: "Q3 FY26 EBITDA margin", value: fmtPct(f?.ebitda_margin), note: "Consolidated reported margin", source_id: f?.source_id },
          { label: "Bromine volume", value: fmtTons(brom?.volume_tons), note: `${brom?.period || "Latest"} segment volume`, source_id: brom?.source_id },
          { label: `${scenarioLabel()} next-quarter EBITDA`, value: fmtRs(nextQuarter.predicted_ebitda), note: "Current model estimate", source_id: "derived-model" },
        ],
          updates: (facts.notes || []).slice(0, 3).map((item) => ({ text: item.body, source_id: item.source_id })),
        };
    }
  }

function renderPage() {
  state.charts.forEach((c) => c.dispose()); state.charts.clear(); state.pending = [];
  dom.pageContainer.classList.toggle("page-container--compact", false);
  dom.pageContainer.innerHTML = `<article class="page-card">${VIEW[state.page]()}</article>`;
  dom.pageContainer.querySelectorAll("[data-export-table]").forEach((b) => b.onclick = () => exportName(b.getAttribute("data-export-table")));
  dom.pageContainer.querySelectorAll("[data-control]").forEach((i) => i.oninput = () => { state.overrides[i.getAttribute("data-control")] = Number(i.value); renderHero(); renderToolbar(`Scenario overrides updated for ${scenarioLabel()}.`); renderPage(); });
  dom.pageContainer.querySelectorAll("[data-price-input-key]").forEach((i) => i.onchange = () => {
    const commodity = i.getAttribute("data-price-commodity");
    const key = i.getAttribute("data-price-input-key");
    if (!commodity || !key || !state.priceInputs?.[commodity]) return;
    state.priceInputs[commodity][key] = i.value;
    renderToolbar(`${commodity === "bromine" ? "Bromine" : "Industrial salt"} model inputs updated.`);
    renderPage();
  });
  dom.pageContainer.querySelectorAll("[data-event-select]").forEach((i) => i.onchange = () => { state.selectedEventId = i.value; renderHero(); renderToolbar(`${currentEvent()?.selector_label || "Event"} loaded.`); renderPage(); });
  dom.pageContainer.querySelectorAll("[data-event-refresh]").forEach((b) => b.onclick = () => refreshLiveData());
  dom.pageContainer.querySelectorAll("[data-mix-select]").forEach((i) => i.onchange = () => { state.selectedMixPeriod = i.value; renderToolbar(`Overview mix changed to ${currentMixPeriod()?.label || i.value}.`); renderPage(); });
  state.pending.forEach(([id, option]) => { const el = document.getElementById(id); if (!el || !window.echarts) return; const c = window.echarts.init(el); c.setOption(option); state.charts.set(id, c); });
  bindSourceButtons();
}
const VIEW = {
  overview: () => {
    const f = latestFinancial(), o = state.d.overview, k = o.kpis || [], map = o.business_map || [], notes = o.facts?.notes || [], selectedMix = currentMixPeriod(), mixSegments = (selectedMix?.segments || []).filter((r) => (r.revenue_mn || 0) > 0);
    add("ov1", pie(mixSegments.map((r) => ({ name: r.name, value: r.revenue_mn })), selectedMix?.source_id || "archean-q3fy26-presentation"));
    add("ov2", combo(quarters().map((r) => r.period), quarters().map((r) => r.revenue_total), quarters().map((r) => r.ebitda_margin), f?.source_id, "EBITDA margin (%)"));
    return `<section class="grid-3">${map.map((m) => `<div class="summary-card"><p class="subtle-label">${esc(m.stage)}</p><h4>${esc(m.name)}</h4><p class="card-caption">${esc(m.note)}</p></div>`).join("")}</section>
      <section class="chart-grid"><div class="chart-card"><div class="chart-head"><div><p class="subtle-label">Chart</p><h4>Revenue mix by business line</h4><p class="insight-copy">${esc(selectedMix?.period === "9MFY26" ? "Use the selector to compare FY22 to FY25 and 9M FY26. The nine-month view uses the reported bromine and salt split plus a residual bucket for the rest." : `Use the selector to compare FY22, FY23, FY24, FY25 and 9M FY26. ${selectedMix?.label || "This"} view comes from the official annual-report product split.`)}</p></div><div class="source-inline-row"><select data-mix-select>${mixPeriods().map((item) => `<option value="${esc(item.period)}" ${item.period === selectedMix?.period ? "selected" : ""}>${esc(item.label)}</option>`).join("")}</select>${src(selectedMix?.source_id || "archean-q3fy26-presentation")}</div></div><div class="chart-target" id="ov1"></div><p class="metric-footnote">${esc(selectedMix?.note || "")}</p></div>${chart("ov2", "Quarterly revenue and EBITDA margin", "Q3 FY26 revenue recovered sequentially, but margin still lagged because bromine getting back to normal output remains incomplete.", [f?.source_id])}</section>
        <section class="grid-4">${k.map((x) => `<div class="metric-card"><p class="subtle-label">${esc(x.label)}</p><div class="metric-value">${esc(fmtKpi(x.value, x.unit))}</div>${kpiNote(x.label) ? `<div class="metric-footnote">${esc(kpiNote(x.label))}</div>` : ""}${src(x.source_id)}</div>`).join("")}</section>
      <section class="note-grid">${notes.map((n) => note(n.title, n.body, n.source_id)).join("")}</section>
      ${tableCard("Current-quarter operating snapshot", "Key reported facts, stripped of dead widgets.", [["Metric", "metric"], ["Q3 FY26", "value"], ["Source", "source"]], [{ metric: "Consolidated revenue", value: fmtRs(f?.revenue_total), source: sourceName(f?.source_id) }, { metric: "Consolidated EBITDA", value: fmtRs(f?.ebitda), source: sourceName(f?.source_id) }, { metric: "Consolidated PAT", value: fmtRs(f?.pat), source: sourceName(f?.source_id) }, { metric: "Export share", value: fmtPct(o.facts?.export_share_pct), source: sourceName("archean-q3fy26-presentation") }, { metric: "Largest customer share", value: fmtPct(o.facts?.largest_customer_pct), source: sourceName("archean-q3fy26-presentation") }, { metric: "Top 10 customer share", value: fmtPct(o.facts?.top_10_customer_pct), source: sourceName("archean-q3fy26-presentation") }], "overview_snapshot")}`;
  },
  event: () => eventPage(),
  operations: () => {
    const a = rows("plant_asset_register"), c = rows("company_capacity_utilization"), x = rows("company_capex_projects");
    const capacityChartRows = c.map((r) => ({ label: r.asset_name.replace(" facility", "").replace(" complex", ""), installed: round((r.installed_capacity || 0) / 1000, 1), expansion: round((r.expansion_capacity || 0) / 1000, 1) }));
      const capexChartRows = [...x].filter((r) => r.capex_amount != null).sort((m, n) => (n.capex_amount || 0) - (m.capex_amount || 0));
    const capacityChart = stack(capacityChartRows.map((r) => r.label), [capacityChartRows.map((r) => r.installed), capacityChartRows.map((r) => r.expansion)], ["Current", "Planned"], ["#103f34", "#d39d52"], "archean-crisil-fy25", true);
    capacityChart.grid = { top: 40, left: 220, right: 88, bottom: 52 };
    capacityChart.xAxis.name = "Capacity (ktpa)";
    capacityChart.xAxis.nameLocation = "middle";
    capacityChart.xAxis.nameGap = 34;
    capacityChart.yAxis.axisLabel.width = 175;
    capacityChart.yAxis.name = "Asset";
    capacityChart.yAxis.nameLocation = "middle";
    capacityChart.yAxis.nameGap = 146;
    capacityChart.xAxis.axisLabel.formatter = (v) => fmtChartCompact(v);
    capacityChart.tooltip.formatter = (p) => {
      const items = Array.isArray(p) ? p : [p];
      const head = items[0]?.axisValueLabel || "";
      return `<strong>${esc(head)}</strong><br>${items.map((item) => `${item.marker || ""}${esc(item.seriesName)}: ${esc(`${fmtChartCompact(item.value)} ktpa`)}`).join("<br>")}<br><span style="color:#6e655c;font-size:12px;">Source: ${esc(sourceName("archean-crisil-fy25"))}</span>`;
    };
    capacityChart.series[0].label.position = "insideRight";
    capacityChart.series[0].label.color = "#f7fff8";
    capacityChart.series[0].label.formatter = (p) => p.value ? `${fmtChartCompact(p.value)} ktpa` : "";
    capacityChart.series[1].label.position = "right";
    capacityChart.series[1].label.color = "#6e655c";
    capacityChart.series[1].label.formatter = (p) => p.value ? `${fmtChartCompact(p.value)} ktpa` : "";
    add("op1", capacityChart);
    add("op2", bar(capexChartRows.map((r) => r.project_name), capexChartRows.map((r) => r.capex_amount), "Capex (Rs cr)", "#a86916", "archean-ar-fy25", true));
      return `<section class="summary-card"><p class="subtle-label">Process flow</p><h4>How the business turns brine into products</h4><div class="process-flow"><div class="flow-node"><strong>Brine</strong><span class="card-caption">Salt water from the Rann of Kutch.</span></div><div class="flow-arrow">?</div><div class="flow-node"><strong>Salt</strong><span class="card-caption">High-volume base business.</span></div><div class="flow-arrow">?</div><div class="flow-node"><strong>Bromine</strong><span class="card-caption">Higher-value chemical made from the same resource.</span></div><div class="flow-arrow">?</div><div class="flow-node"><strong>Derivatives / SOP</strong><span class="card-caption">Products made from bromine or salt.</span></div><div class="flow-arrow">?</div><div class="flow-node"><strong>Future businesses</strong><span class="card-caption">Mud chemicals, batteries and semiconductors.</span></div></div></section>
      <section class="chart-grid">${chart("op1", "Yearly capacity by asset", "Values are shown in thousand tons per year. Salt is much larger by volume, while bromine is smaller but more valuable.", ["archean-crisil-fy25", "archean-ar-fy25", "archean-q3fy26-transcript"])}${chart("op2", "Where the company is spending money", "SiCSem is the biggest project by far. The other projects are much smaller and closer to the core chemicals business.", ["archean-crisil-fy25", "archean-q2fy26-transcript", "archean-q3fy26-presentation"])}</section>
      <section class="grid-3 grid-3up">${a.map((r) => `<div class="note-card"><p class="subtle-label">${esc(r.state)}</p><h4>${esc(r.plant_name)}</h4><p class="note-copy">${esc(r.process_description)}</p><div class="tag-row"><span class="tag">${esc(r.product_line)}</span><span class="tag is-warn">${esc(r.project_status)}</span></div><p class="metric-footnote">Transport risk: ${esc(r.logistics_dependency)}</p><div class="source-inline-row">${(r.source_ids || [r.source_id]).filter(Boolean).map((s, i) => src(s, i === 0 ? "Source" : `Source ${i + 1}`)).join("")}</div></div>`).join("")}</section>
      ${tableCard("Plant list", "Hajipir is the main operating asset, and Jakhau remains an important logistics link.", [["Plant", "plant_name"], ["Location", "exact_location"], ["Product line", "product_line"], ["Status", "project_status"], ["Logistics dependency", "logistics_dependency"]], a, "plant_asset_register", "plant_asset_register")}
      ${tableCard("Capacity and running levels", "If the company did not publish actual plant output, the dashboard says so clearly and shows only a sales volume-based proxy.", [["Asset", "asset_name"], ["Product", "product"], ["Installed capacity", "installed"], ["Current plant running level", "current"], ["Historical plant running level", "historical_utilization"], ["Source note", "source_note"]], c.map((r) => ({ ...r, installed: `${fmtCompact(r.installed_capacity)} ${r.unit}`, current: r.current_utilization_display || (r.current_utilization == null ? "Not disclosed" : fmtPct(r.current_utilization)) })), "capacity_utilization", "company_capacity_utilization")}`;
  },
  bromine: () => segmentPage("Bromine", "brom", "Bromine still matters most because small changes here can move profit a lot."),
  salt: () => segmentPage("Industrial Salt", "salt", "Salt matters because it brings steady volume and supports earnings, not just because it is large."),
  derivatives: () => {
      const s = rows("company_subsidiaries_and_investments"), c = rows("company_capex_projects"), d = latestSeg("Bromine Derivatives"), p = latestSeg("Sulphate of Potash"), scores = subsidiaryScoreRows(s);
    add("de1", bar(["Bromine derivatives", "SOP"], [d?.revenue || 0, p?.revenue || 0], "Q3 FY26 revenue (Rs mn)", "#103f34", "archean-q3fy26-transcript"));
    add("de2", bar(scores.map((r) => r.name), scores.map((r) => r.score), "Stage score", "#a86916", "derived-optionality", true));
      return `<section class="chart-grid">${chart("de1", "Current downstream contribution", "Acume has visible revenue today, but SOP is still a plant-trial story rather than a current earnings contributor.", ["archean-q3fy26-transcript"])}${chart("de2", "How close each platform is to revenue", "The Idealis mud-chemicals structure is shown as one platform here because Archean approved the merger of Idealis Chemicals into Idealis Mudchemie on March 19, 2026, with legal completion still pending.", ["derived-optionality", "archean-idealis-merger-mar-2026"])}</section><section class="note-grid">${note("Bromine-to-derivatives logic", "Acume matters because it deepens captive bromine consumption and raises value per ton, not because it is already large enough to replace the core bromine segment.", "archean-crisil-fy25")}${note("SOP status", "Pilot trials are complete, but plant-scale trial timing remains the real key next step. The dashboard therefore treats SOP as proven chemistry with unproven commercial scale.", "archean-q2fy26-transcript")}${note("Mudchemie path", "Mudchemie has started at an initial commercial scale, and Archean has now approved the merger of Idealis Chemicals into Idealis Mudchemie to simplify the group structure and consolidate mud-chemical operations.", "archean-idealis-merger-mar-2026")}</section>${tableCard("Subsidiaries and investment tracker", "Every related business is classified by operating stage so the investor can separate proven earnings, near-term scale-up and longer-duration option value.", [["Name", "name"], ["Business", "business"], ["Stake", "stake"], ["Status", "status"], ["Revenue stage", "revenue_stage"], ["Scale-up view", "expected_scale_up"]], s, "subsidiary_tracker", "company_subsidiaries_and_investments")}${tableCard("New-business capex tracker", "Hard capex commitments stay visible beside their strategic rationale so future upside is not framed as costless upside.", [["Project", "project_name"], ["Segment", "business_segment"], ["Capex (Rs cr)", "capex_amount"], ["Status", "status"], ["Expected completion", "expected_completion"], ["Strategic rationale", "strategic_rationale"]], c, "new_business_capex", "company_capex_projects")}`;
  },
  trade: () => tradePage(),
  costs: () => costsPage(),
  "price-history": () => priceHistoryPage(),
  forecast: () => forecastPage(),
  capex: () => capexPage(),
};

function priceHistoryPage() {
  const priceModule = state.d.priceModule || mockPriceModuleData();
  const bromine = priceModule.bromine;
  const salt = priceModule.salt;
  const bromineInputs = state.priceInputs?.bromine || buildEditablePriceInputs(priceModule).bromine;
  const saltInputs = state.priceInputs?.salt || buildEditablePriceInputs(priceModule).salt;
  const bromineKpis = priceKpis("Bromine", bromine);
  const saltKpis = priceKpis("Industrial Salt", salt);
  add("ph1", line(bromine.history.map((r) => r.period), bromine.history.map((r) => r.price), bromine.series_name || "Bromine price (Rs/ton)", "#103f34", primarySourceId(bromine)));
  add("ph2", line(salt.history.map((r) => r.period), salt.history.map((r) => r.price), salt.series_name || "Industrial salt price (Rs/ton)", "#a86916", salt.source_id || "derived-model"));
  add("ph3", historySimulationChart(bromine.history, bromineInputs, bromine.series_name || "Bromine price (Rs/ton)", primarySourceId(bromine)));
  add("ph4", historySimulationChart(salt.history, saltInputs, salt.series_name || "Industrial salt price (Rs/ton)", salt.source_id || "derived-model"));

  return `<section class="price-kpi-grid">
    ${[...bromineKpis.map((item) => ({ ...item, source_id: primarySourceId(bromine) })), ...saltKpis.map((item) => ({ ...item, source_id: salt.source_id || "derived-model" }))].map((item) => `<div class="metric-card metric-card--compact"><p class="subtle-label">${esc(item.label)}</p><div class="metric-value">${esc(item.value)}</div><div class="metric-footnote">${esc(item.note)}</div>${src(item.source_id)}</div>`).join("")}
  </section>
  <section class="chart-grid chart-grid-2up">
    ${chart("ph1", "Bromine price history", "Daily workbook data is condensed to weekly closes here so the trend stays readable while keeping the latest workbook range intact in the KPI cards.", sourceIdList(bromine))}
    ${chart("ph2", "Industrial salt price history", "Daily workbook data is condensed to weekly closes here so the trend stays readable while keeping the latest workbook range intact in the KPI cards.", [salt.source_id || "derived-model"])}
  </section>
  <section class="chart-grid chart-grid-2up">
    ${chart("ph3", "Bromine simulation", "Bull, base and bear lines extend from the latest weekly close into the next 3 quarters using the simple growth inputs shown below.", [...sourceIdList(bromine), "derived-model"])}
    ${chart("ph4", "Industrial salt simulation", "Bull, base and bear lines extend from the latest weekly close into the next 3 quarters using the simple growth inputs shown below.", [salt.source_id || "derived-model", "derived-model"])}
  </section>
  <section class="grid-2">
    ${priceInputCard("Bromine model inputs", "bromine", bromineInputs, primarySourceId(bromine))}
    ${priceInputCard("Industrial salt model inputs", "salt", saltInputs, salt.source_id || "derived-model")}
  </section>`;
}

function mockPriceModuleData() {
  return {
    bromine: {
      history: [
        { period: "Q4 FY24", price: 238000 },
        { period: "Q1 FY25", price: 245500 },
        { period: "Q2 FY25", price: 252000 },
        { period: "Q3 FY25", price: 249500 },
        { period: "Q4 FY25", price: 236000 },
        { period: "Q1 FY26", price: 231500 },
        { period: "Q2 FY26", price: 228000 },
        { period: "Q3 FY26", price: 240500 },
      ],
      inputs: {
        startingPrice: "Rs 240,500/ton",
        lookback: "8 quarters",
        bullGrowth: "+6.0% QoQ",
        baseGrowth: "+2.5% QoQ",
        bearGrowth: "-3.0% QoQ",
        volatility: "8% placeholder range",
      },
    },
    salt: {
      history: [
        { period: "Q4 FY24", price: 1480 },
        { period: "Q1 FY25", price: 1535 },
        { period: "Q2 FY25", price: 1620 },
        { period: "Q3 FY25", price: 1715 },
        { period: "Q4 FY25", price: 1660 },
        { period: "Q1 FY26", price: 1625 },
        { period: "Q2 FY26", price: 1685 },
        { period: "Q3 FY26", price: 1795 },
      ],
      inputs: {
        startingPrice: "Rs 1,795/ton",
        lookback: "8 quarters",
        bullGrowth: "+4.0% QoQ",
        baseGrowth: "+1.5% QoQ",
        bearGrowth: "-2.0% QoQ",
        volatility: "5% placeholder range",
      },
    },
  };
}

function priceKpis(name, series) {
  const history = Array.isArray(series?.history) ? series.history : [];
  const stats = series?.stats || {};
  const latest = stats.latest ?? history[history.length - 1]?.price ?? 0;
  const previous = history[history.length - 2]?.price ?? latest;
  const high = stats.high ?? (history.length ? Math.max(...history.map((r) => r.price)) : 0);
  const low = stats.low ?? (history.length ? Math.min(...history.map((r) => r.price)) : 0);
  const changePct = stats.change_pct ?? (previous ? ((latest - previous) / previous) * 100 : null);
  return [
    { label: `${name} latest INR price`, value: fmtRsTon(latest), note: stats.latest_label || `Latest close: ${history[history.length - 1]?.period || "latest point"}` },
    { label: `${name} change %`, value: fmtSignedPct(changePct), note: stats.change_label || `Move versus ${history[history.length - 2]?.period || "prior point"}` },
    { label: `${name} period high`, value: fmtRsTon(high), note: stats.range_label || `High across ${history.length} points` },
    { label: `${name} period low`, value: fmtRsTon(low), note: stats.range_label || `Low across ${history.length} points` },
  ];
}

function priceInputCard(title, commodity, inputs, sourceId) {
  return `<section class="table-card price-input-card"><div class="table-head"><div><p class="subtle-label">Model inputs</p><h4>${esc(title)}</h4><p class="table-copy">Simple fields only. These can be driven directly from file-based pricing inputs later.</p></div><div class="source-inline-row">${src(sourceId)}${src("derived-model", "Model")}</div></div><div class="price-input-grid">
    ${priceInputField(commodity, "starting_price", "Starting price (Rs/ton)", inputs.starting_price, "number")}
    ${priceInputField(commodity, "lookback_period", "Lookback period", inputs.lookback_period, "text")}
    ${priceInputField(commodity, "bull_growth_pct", "Bull growth %", inputs.bull_growth_pct, "number", 0.1)}
    ${priceInputField(commodity, "base_growth_pct", "Base growth %", inputs.base_growth_pct, "number", 0.1)}
    ${priceInputField(commodity, "bear_growth_pct", "Bear growth %", inputs.bear_growth_pct, "number", 0.1)}
    ${priceInputField(commodity, "volatility", "Range / volatility", inputs.volatility, "text")}
  </div></section>`;
}

function priceInputField(commodity, key, label, value, type = "text", step = "any") {
  const attrStep = type === "number" ? ` step="${esc(String(step))}"` : "";
  return `<label class="price-input-field"><span>${esc(label)}</span><input type="${esc(type)}" value="${esc(value)}" data-price-commodity="${esc(commodity)}" data-price-input-key="${esc(key)}"${attrStep}></label>`;
}

function historySimulationChart(history, inputs, seriesName, source) {
  const historyLabels = history.map((r) => r.period);
  const futureLabels = nextQuarterLabels(history);
  const labels = [...historyLabels, ...futureLabels];
  const latest = Number(inputs?.starting_price) || history[history.length - 1]?.price || 0;
  const historySeries = [...history.map((r) => r.price), null, null, null];
  const bull = buildForwardSeries(history.length, latest, quarterGrowthSteps(inputs.bull_growth_pct));
  const basePath = buildForwardSeries(history.length, latest, quarterGrowthSteps(inputs.base_growth_pct));
  const bear = buildForwardSeries(history.length, latest, quarterGrowthSteps(inputs.bear_growth_pct));
  const b = base(source);
  return {
    ...b,
    legend: { top: 8, textStyle: { color: "#6e655c" } },
    xAxis: { ...b.xAxis, type: "category", data: labels },
    yAxis: {
      ...b.yAxis,
      type: "value",
      axisLabel: {
        ...b.yAxis.axisLabel,
        formatter(v) { return fmtChartCompact(v); },
      },
    },
    series: [
      { name: seriesName, type: "line", data: historySeries, smooth: true, symbolSize: 7, lineStyle: { width: 3, color: "#103f34" }, itemStyle: { color: "#103f34" }, areaStyle: { color: "rgba(16,63,52,0.06)" } },
      { name: "Bull case (Rs/ton)", type: "line", data: bull, smooth: true, symbolSize: 7, connectNulls: true, lineStyle: { width: 3, type: "dashed", color: "#c48a26" }, itemStyle: { color: "#c48a26" } },
      { name: "Base case (Rs/ton)", type: "line", data: basePath, smooth: true, symbolSize: 7, connectNulls: true, lineStyle: { width: 3, type: "dashed", color: "#4d7c70" }, itemStyle: { color: "#4d7c70" } },
      { name: "Bear case (Rs/ton)", type: "line", data: bear, smooth: true, symbolSize: 7, connectNulls: true, lineStyle: { width: 3, type: "dashed", color: "#8a3d25" }, itemStyle: { color: "#8a3d25" } },
    ],
  };
}

function quarterGrowthSteps(growthPct) {
  const pct = Number(growthPct || 0);
  return [1, 2, 3].map(() => 1 + pct / 100);
}

function nextQuarterLabels(history) {
  const lastDate = history[history.length - 1]?.date ? new Date(history[history.length - 1].date) : new Date();
  if (Number.isNaN(lastDate.getTime())) return ["Next quarter 1", "Next quarter 2", "Next quarter 3"];
  const quarterEndMonths = [2, 5, 8, 11];
  const labels = [];
  let year = lastDate.getUTCFullYear();
  let quarterIndex = quarterEndMonths.findIndex((month) => month >= lastDate.getUTCMonth());
  if (quarterIndex === -1) {
    quarterIndex = 0;
    year += 1;
  }
  for (let i = 0; i < 3; i += 1) {
    const month = quarterEndMonths[quarterIndex];
    labels.push(new Date(Date.UTC(year, month, 1)).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }));
    quarterIndex += 1;
    if (quarterIndex > 3) {
      quarterIndex = 0;
      year += 1;
    }
  }
  return labels;
}

function buildForwardSeries(historyLength, startValue, growthSteps) {
  let current = startValue;
  const output = Array.from({ length: historyLength - 1 }, () => null);
  output.push(startValue);
  growthSteps.forEach((step) => {
    current *= step;
    output.push(round(current, 0));
  });
  return output;
}

function buildEditablePriceInputs(priceModule, preserved = null) {
  const module = priceModule || mockPriceModuleData();
  const buildOne = (series, keep = {}) => {
    const latest = Number(series?.stats?.latest ?? series?.history?.[series.history.length - 1]?.price ?? 0);
    return {
      starting_price: keep.starting_price ?? latest,
      lookback_period: keep.lookback_period ?? (series?.inputs?.lookback || `${series?.history?.length || 0} weekly points`),
      bull_growth_pct: keep.bull_growth_pct ?? (series?.inputs?.bull_growth_pct ?? 0),
      base_growth_pct: keep.base_growth_pct ?? (series?.inputs?.base_growth_pct ?? 0),
      bear_growth_pct: keep.bear_growth_pct ?? (series?.inputs?.bear_growth_pct ?? 0),
      volatility: keep.volatility ?? (series?.inputs?.volatility || ""),
    };
  };
  return {
    bromine: buildOne(module?.bromine, preserved?.bromine || {}),
    salt: buildOne(module?.salt, preserved?.salt || {}),
  };
}

function sourceIdList(series) {
  if (Array.isArray(series?.source_ids) && series.source_ids.length) return series.source_ids;
  return [series?.source_id || "derived-model"];
}

function primarySourceId(series) {
  return sourceIdList(series)[sourceIdList(series).length - 1];
}

function eventPage() {
  const e = currentEvent();
  if (!e) return "";
  return `${eventSelectorCard(e)}${e.id === "iran_israel_2026_current" ? currentWarEventPage(e) : historicalWarEventPage(e)}`;
}

function eventSelectorCard(e) {
  const canRefresh = e.id === "iran_israel_2026_current";
  return `<section class="table-card event-switcher"><div class="table-head"><div><p class="subtle-label">Event view</p><h4>${esc(e.selector_label || "Conflict view")}</h4>${helperLine("table-copy", e.data_cutoff_label || "")}</div><div class="toolbar-actions"><select data-event-select>${eventItems().map((item) => `<option value="${esc(item.id)}" ${item.id === e.id ? "selected" : ""}>${esc(item.selector_label || item.page_label || item.id)}</option>`).join("")}</select>${canRefresh ? `<button class="secondary-button" type="button" data-event-refresh ${state.refreshingLive ? "disabled" : ""}>${state.refreshingLive ? "Refreshing..." : "Refresh live data"}</button>` : ""}</div></div><div class="tag-row"><span class="tag">${esc(e.status || "Event")}</span><span class="tag is-warn">${esc(e.analysis_window_label || "")}</span></div></section>`;
}

async function refreshLiveData() {
  if (state.refreshingLive) return;
  state.refreshingLive = true;
  renderPage();
  renderToolbar("Refreshing latest linked data...");
  load(true, "Refreshing latest linked data...");
  try {
    const currentState = { scenario: state.scenario, selectedEventId: state.selectedEventId, selectedMixPeriod: state.selectedMixPeriod };
    const response = await fetch("./api/refresh-event", { method: "POST", cache: "no-store" });
    if (response.ok) {
      const result = await response.json().catch(() => ({}));
      if (!result.ok && result.error) throw new Error(result.error);
      const d = await fetchDashboardPayload(`${BUILD_ID}-${Date.now()}`);
      applyDashboardPayload(d, currentState);
      renderAll();
      renderToolbar(state.page === "price-history" ? "Latest bromine price refreshed." : "Live linked data refreshed.");
      return;
    }
    await refreshLiveDataClientSide(currentState);
    renderAll();
    renderToolbar(state.page === "price-history" ? "Latest bromine price refreshed." : "Live linked data refreshed.");
  } catch (e) {
    renderToolbar(`Live refresh failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    state.refreshingLive = false;
    load(false);
    renderPage();
  }
}

async function refreshLiveDataClientSide(currentState) {
  if (state.page === "price-history") {
    await refreshPriceModuleBrowser();
  }
  if (state.page === "event") {
    await refreshCurrentWarBrowser();
  }
  state.d.meta = { ...(state.d.meta || {}), refresh_mode: "browser-live" };
  state.priceInputs = buildEditablePriceInputs(state.d.priceModule, state.priceInputs);
  if (state.d.priceModule?.bromine?.stats?.latest != null) state.priceInputs.bromine.starting_price = state.d.priceModule.bromine.stats.latest;
  if (state.d.priceModule?.salt?.stats?.latest != null) state.priceInputs.salt.starting_price = state.d.priceModule.salt.stats.latest;
  state.scenario = currentState.scenario || state.scenario;
  state.selectedEventId = currentState.selectedEventId || state.selectedEventId;
  state.selectedMixPeriod = currentState.selectedMixPeriod || state.selectedMixPeriod;
}

async function fetchMirrorText(url) {
  const target = `https://r.jina.ai/http://${String(url).replace(/^https?:\/\//, "")}`;
  const response = await fetch(target, { cache: "no-store" });
  if (!response.ok) throw new Error(`Mirror fetch failed with ${response.status}.`);
  return response.text();
}

async function fetchFirecrawlMarkdown(url, kind) {
  const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url, formats: kind === "equity" ? ["markdown"] : ["markdown", "html"] }),
  });
  if (!response.ok) throw new Error(`Firecrawl refresh failed with ${response.status}.`);
  const payload = await response.json();
  const data = payload?.data || {};
  return [data.markdown, data.html].filter(Boolean).join("\n");
}

function parseSunSirsRows(text, commodityLabel) {
  const rows = [];
  const escaped = commodityLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escaped}\\s+Chemical\\s+([0-9]+(?:\\.[0-9]+)?)\\s+(\\d{4}-\\d{2}-\\d{2})`, "gmi");
  for (const match of text.matchAll(pattern)) {
    rows.push({ date: match[2], price_cny_per_ton: Number(match[1]) });
  }
  return rows;
}

function parseInvestingHistoryRows(textBlob, kind) {
  const rows = [];
  const pattern = /\|\s*([A-Z][a-z]{2}\s+\d{2},\s+\d{4})\s*\|\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\|\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\|\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\|\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\|\s*([^|]*)\|\s*([+\-]?[0-9.]+%)\s*\|/gm;
  for (const match of textBlob.matchAll(pattern)) {
    const rawDate = match[1];
    const price = Number(String(match[2]).replaceAll(",", ""));
    const isoDate = new Date(`${rawDate} UTC`);
    if (Number.isNaN(isoDate.getTime()) || Number.isNaN(price)) continue;
    const date = isoDate.toISOString().slice(0, 10);
    const row = { date, source_kind: kind };
    if (kind === "equity") {
      row.close_price_inr = round(price, 2);
    } else {
      row.brent_usd_per_bbl = round(price, 2);
      row.label = new Date(date).toLocaleDateString(undefined, { month: "short", day: "2-digit" });
    }
    rows.push(row);
  }
  return rows;
}

function mergeTimeSeriesRows(baseRows, liveRows, dateKey = "date") {
  const merged = new Map();
  (baseRows || []).forEach((row) => merged.set(String(row?.[dateKey] || ""), { ...row }));
  (liveRows || []).forEach((row) => merged.set(String(row?.[dateKey] || ""), { ...row }));
  return Array.from(merged.values())
    .filter((row) => row && row[dateKey])
    .sort((a, b) => String(a[dateKey]).localeCompare(String(b[dateKey])));
}

async function latestBrowserFxRate() {
  const endpoints = [
    "https://api.frankfurter.app/latest?from=CNY&to=INR",
    "https://open.er-api.com/v6/latest/CNY",
  ];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) continue;
      const payload = await response.json();
      if (payload?.rates?.INR) return Number(payload.rates.INR);
      if (payload?.rates?.INR_CNY) return 1 / Number(payload.rates.INR_CNY);
      if (payload?.conversion_rates?.INR) return Number(payload.conversion_rates.INR);
    } catch (e) {
      continue;
    }
  }
  return null;
}

async function refreshPriceModuleBrowser() {
  const current = state.d.priceModule || {};
  const bromineText = await fetchMirrorText("https://www.sunsirs.com/uk/prodetail-643.html");
  const saltText = await fetchMirrorText("https://www.sunsirs.com/uk/prodetail-1520.html");
  const bromineRows = parseSunSirsRows(bromineText, "Bromine");
  const saltRows = parseSunSirsRows(saltText, "industrial salt");
  if (!bromineRows.length || !saltRows.length) throw new Error("Live SunSirs price rows could not be parsed.");
  const fxRate = await latestBrowserFxRate();
  if (!fxRate) throw new Error("Latest CNY/INR rate could not be loaded.");
  const nextPriceModule = JSON.parse(JSON.stringify(current));
  for (const [key, liveRows] of [["bromine", bromineRows], ["salt", saltRows]]) {
    const series = nextPriceModule[key];
    if (!series) continue;
    const latestLive = liveRows.sort((a, b) => a.date.localeCompare(b.date)).slice(-1)[0];
    const livePriceInr = round(Number(latestLive.price_cny_per_ton) * Number(fxRate), 0);
    const lastPoint = Array.isArray(series.history) ? series.history[series.history.length - 1] : null;
    const history = Array.isArray(series.history) ? series.history.slice() : [];
    if (!lastPoint || lastPoint.date !== latestLive.date) {
      history.push({ period: new Date(`${latestLive.date}T00:00:00Z`).toLocaleDateString(undefined, { day: "2-digit", month: "short" }), date: latestLive.date, price: livePriceInr });
    } else {
      history[history.length - 1] = { ...lastPoint, price: livePriceInr, date: latestLive.date, period: new Date(`${latestLive.date}T00:00:00Z`).toLocaleDateString(undefined, { day: "2-digit", month: "short" }) };
    }
    const prices = history.map((r) => Number(r.price)).filter((v) => !Number.isNaN(v));
    const previous = prices.length > 1 ? prices[prices.length - 2] : livePriceInr;
    series.history = history;
    series.stats = {
      ...(series.stats || {}),
      latest: livePriceInr,
      change_pct: previous ? round(((livePriceInr - previous) / previous) * 100.0, 1) : null,
      high: prices.length ? Math.max(...prices, livePriceInr) : livePriceInr,
      low: prices.length ? Math.min(...prices, livePriceInr) : livePriceInr,
      latest_label: `${new Date(`${latestLive.date}T00:00:00Z`).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })} live update`,
      change_label: `vs ${series.history[series.history.length - 2]?.date || "prior point"}`,
      range_label: `${history[0]?.date || latestLive.date} to ${latestLive.date}`,
      fx_label: `Latest live FX used: ${round(fxRate, 3)} INR/CNY`,
      fx_rate: round(fxRate, 3),
    };
    series.inputs = {
      ...(series.inputs || {}),
      startingPrice: `Rs ${round(livePriceInr, 0).toLocaleString()}/ton`,
    };
  }
  state.d.priceModule = nextPriceModule;
}

async function refreshCurrentWarBrowser() {
  const current = currentEvent();
  if (!current || current.id !== "iran_israel_2026_current") return;
  const [aciMarkdown, brentMarkdown, newsMarkdown] = await Promise.all([
    fetchFirecrawlMarkdown("https://www.investing.com/equities/archean-chemical-industries-historical-data", "equity"),
    fetchFirecrawlMarkdown("https://www.investing.com/commodities/brent-oil-historical-data", "commodity"),
    fetchFirecrawlMarkdown("https://au.investing.com/news/commodities-news", "news"),
  ]);
  const aciRows = parseInvestingHistoryRows(aciMarkdown, "equity");
  const brentRows = parseInvestingHistoryRows(brentMarkdown, "commodity");
  const newsRows = [];
  const newsPattern = /- \[(?<title>[^\]]+)\]\((?<url>https:\/\/au\.investing\.com\/news\/commodities-news\/[^\)]+)\)\s+(?<summary>.*?)(?:\n\s*-\s*By(?<publisher>[^•\n]+)•(?<age>[^\n]+))/gs;
  for (const match of newsMarkdown.matchAll(newsPattern)) {
    const title = String(match.groups?.title || "").trim();
    const url = String(match.groups?.url || "").trim();
    const summary = String(match.groups?.summary || "").replace(/\s+/g, " ").trim();
    if (!title || !url) continue;
    newsRows.push({
      title,
      url,
      publisher: String(match.groups?.publisher || "Investing.com / Reuters").trim() || "Investing.com / Reuters",
      age: String(match.groups?.age || "Latest").trim() || "Latest",
      summary: summary.slice(0, 220),
      source_id: "investing-au-commodities-feed-live",
    });
  }
  const updatedShare = mergeTimeSeriesRows(current.share_price_window || [], aciRows, "date");
  const updatedOil = mergeTimeSeriesRows(current.oil_shock_window || [], brentRows, "date");
  const latestShare = updatedShare[updatedShare.length - 1];
  const latestOil = updatedOil[updatedOil.length - 1];
  const updatedTimeline = (Array.isArray(current.timeline) ? current.timeline.slice() : []).filter((item) => item?.title !== "Latest live market refresh");
  if (latestShare && latestOil) {
    updatedTimeline.push({
      date: latestShare.date,
      title: "Latest live market refresh",
      detail: `ACI close ${Number(latestShare.close_price_inr).toLocaleString()} and Brent ${Number(latestOil.brent_usd_per_bbl).toFixed(2)} USD/bbl updated from live public sources.`,
    });
  }
  current.share_price_window = updatedShare.map((row) => ({ ...row, source_id: "investing-archean-history-live" }));
  current.oil_shock_window = updatedOil.map((row) => ({ ...row, source_id: "investing-brent-history-live" }));
  current.live_market_headlines = newsRows;
  current.timeline = updatedTimeline;
  current.data_cutoff_label = latestShare && latestOil ? `Latest accessible market cut-off: ${new Date(latestShare.date).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "2-digit" })} for Archean share price; ${new Date(latestOil.date).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "2-digit" })} for Brent oil.` : current.data_cutoff_label;
  const eventIdx = (state.d.events.items || []).findIndex((item) => item.id === current.id);
  if (eventIdx >= 0) state.d.events.items[eventIdx] = current;
  state.d.events.default_event_id = current.id;
}

function currentWarEventPage(e) {
  const share = e.share_price_window || [];
  const imports = e.import_dependency || [];
  const balance = e.trade_balance || [];
  const brom = e.archean_bromine_quarters || [];
  const bromineProxy = e.bromine_price_proxy || [];
  const oil = e.oil_shock_window || [];
  const timeline = e.timeline || [];
  const shareSources = (e.share_price_source_ids || unique(share.map((r) => r.source_id).filter(Boolean)));
  const oilSources = (e.oil_price_source_ids || unique(oil.map((r) => r.source_id).filter(Boolean)));
  const liveHeadlines = e.live_market_headlines || [];
  const latestShare = share[share.length - 1] || {};
  const firstShare = share[0] || {};
  const latestOil = oil[oil.length - 1] || {};
  const firstOil = oil[0] || {};
  const aciMove = firstShare?.close_price_inr && latestShare?.close_price_inr ? round(((Number(latestShare.close_price_inr) - Number(firstShare.close_price_inr)) / Number(firstShare.close_price_inr)) * 100, 1) : null;
  const brentMove = firstOil?.brent_usd_per_bbl && latestOil?.brent_usd_per_bbl ? round(((Number(latestOil.brent_usd_per_bbl) - Number(firstOil.brent_usd_per_bbl)) / Number(firstOil.brent_usd_per_bbl)) * 100, 1) : null;
  const latestHeadlineCount = liveHeadlines.length ? `${liveHeadlines.length} stories` : "No live stories";

  add("evc1", line(share.map((r) => r.date.slice(5)), share.map((r) => r.close_price_inr), "ACI close price (Rs)", "#103f34", shareSources[0] || "equitypandit-aci-history"));
  add("evc2", line(oil.map((r) => r.date.slice(5)), oil.map((r) => r.brent_usd_per_bbl), "Brent crude (USD/bbl)", "#a86916", oilSources[0] || "reuters-oil-energy-facilities-mar19-2026"));
  add("evc3", stack(imports.map((r) => String(r.year)), [imports.map((r) => r.israel_usd_mn), imports.map((r) => r.jordan_usd_mn), imports.map((r) => r.other_usd_mn)], ["Israel", "Jordan", "Other"], ["#103f34", "#a86916", "#d9d4c8"], "wits-ind-bromine-2024-import", false, { valueAxisName: "Share of import value (%)", categoryAxisName: "Year" }));
  add("evc4", lines(balance.map((r) => String(r.year)), [{ name: "Imports (USD mn)", data: balance.map((r) => r.imports_usd_mn) }, { name: "Exports (USD mn)", data: balance.map((r) => r.exports_usd_mn) }], "wits-ind-bromine-2024-export"));
  add("evc5", lines(["Feb 2026", "Mar 2026"], unique(bromineProxy.map((r) => r.market)).map((market) => ({ name: market, data: ["Feb 2026", "Mar 2026"].map((period) => (bromineProxy.find((r) => r.market === market && r.period === period) || {}).price_usd_per_kg || null) })), "businessanalytiq-bromine-mar-2026"));
  add("evc6", lines(brom.map((r) => r.period), [{ name: "Bromine volume (tons)", data: brom.map((r) => r.volume_tons) }, { name: "Realization (Rs/ton)", data: brom.map((r) => r.implied_realization_per_ton), yAxisIndex: 1 }], brom[brom.length - 1]?.source_id || "archean-q3fy26-presentation"));

  return `<section class="grid-4">
    ${card("Latest ACI close", latestShare.close_price_inr != null ? `Rs ${round(latestShare.close_price_inr, 0).toLocaleString()}` : "-", `${latestShare.date ? new Date(latestShare.date).toLocaleDateString(undefined, { month: "short", day: "2-digit", year: "numeric" }) : "Live window"}`, shareSources[0] || "investing-archean-history-live")}
    ${card("ACI move in window", aciMove != null ? fmtPct(aciMove) : "-", "From first to latest point in this live window", "derived-model")}
    ${card("Latest Brent close", latestOil.brent_usd_per_bbl != null ? `$${round(latestOil.brent_usd_per_bbl, 2).toLocaleString()}/bbl` : "-", `${latestOil.date ? new Date(latestOil.date).toLocaleDateString(undefined, { month: "short", day: "2-digit", year: "numeric" }) : "Live window"}`, oilSources[0] || "investing-brent-history-live")}
    ${card("Brent move in window", brentMove != null ? fmtPct(brentMove) : "-", "From first to latest point in this live window", "derived-model")}
  </section>
  <section class="chart-grid chart-grid-2up">${chart("evc1", "Archean share price through the current war", "ACI sold off hard in the first few sessions, but the latest accessible close has already moved back above the pre-war close. That tells you the market sees a shock, not a broken business.", shareSources.length ? shareSources : ["equitypandit-aci-history"])}${chart("evc2", "Oil shock through the same window", "Oil moved much faster than bromine itself. That is the cleanest sign that the first-order shock is logistics and energy, not a straight bromine price spike.", oilSources.length ? oilSources : ["reuters-iran-oil-risk-feb20-2026", "reuters-oil-shipping-shock-2026", "reuters-hormuz-oil-mar16-2026", "reuters-oil-energy-facilities-mar19-2026"])}</section>
  <section class="chart-grid chart-grid-2up">${chart("evc3", "India's bromine import dependence before the current war", "The latest reliable official trade year is still 2024. India depended on Israel and Jordan for 91.9% of bromine import value before the current war even began.", ["wits-ind-bromine-2022-import", "wits-ind-bromine-2023-import", "wits-ind-bromine-2024-import"], true)}${chart("evc4", "India bromine imports versus exports", "India entered the current war as a net importer, not as an export-surplus market. That matters because any supply disruption can tighten the local market quickly once local output improves.", ["wits-ind-bromine-2022-export", "wits-ind-bromine-2024-import"])}</section>
  <section class="chart-grid chart-grid-2up">${chart("evc5", "Bromine price proxy before versus after the war start", "This is the key message: the March bromine proxy moved only slightly even as oil, insurance and shipping moved sharply. So far, the current war has looked more like a route-and-cost shock than a full bromine price breakout.", ["businessanalytiq-bromine-mar-2026"], true)}${chart("evc6", "Archean bromine volume versus realization (Rs/ton)", "Archean entered the current war with bromine output already below its Q1 FY26 level. That means the company still needs to fix internal output to fully benefit from any outside supply shock.", ["archean-q1fy26-presentation", "archean-q3fy26-presentation"])}</section>
  ${liveHeadlines.length ? `<section class="table-card"><div class="table-head"><div><p class="subtle-label">Latest headlines</p><h4>Fresh war-linked commodities news</h4><p class="table-copy">This block updates when you click refresh. It pulls the latest Iran-Israel, Hormuz, shipping and oil headlines from Investing AU commodities news.</p></div><div class="source-inline-row">${src("investing-au-commodities-feed-live")}</div></div><table><thead><tr><th>Headline</th><th>Publisher</th><th>Published</th><th>What it says</th></tr></thead><tbody>${liveHeadlines.map((row) => `<tr><td><a class="source-link" href="${esc(row.url || "")}" target="_blank" rel="noreferrer">${esc(row.title || "")}</a></td><td>${esc(row.publisher || "")}</td><td>${esc(row.age || "")}</td><td>${esc(row.summary || "")}</td></tr>`).join("")}</tbody></table></section>` : ""}
  ${tableCard("Conflict timeline used in this page", "Because the war is still running, the timeline focuses on dated market checkpoints rather than pretending the whole outcome is already known.", [["Date", "date"], ["Event", "title"], ["Why it matters", "detail"]], timeline, e.timeline_table_name, e.timeline_table_name)}
  <section class="note-grid">${note("Was this current war predictable?", "Partly yes. Reuters reported that specialist advisers were already assigning high odds to military action before the strikes, so this was not a pure surprise event for serious market desks.", "reuters-iran-war-predictability-2026")}${note("What this likely means for industry margins", "Near-term margin pressure in bromine-linked trade looks more cost-led than price-led. Oil jumped more than 50% from the pre-war level to the March peak, while the March bromine price proxy moved only about 1% month on month.", "reuters-oil-energy-facilities-mar19-2026")}${note("What this likely means for Archean margins", "Archean has 79% export exposure and entered the war with bromine output already below normal. So the company does not automatically win from the conflict. It first needs enough output and contract repricing to outrun freight, insurance and energy pressure.", "archean-q3fy26-presentation")}</section>
  <section class="warning-banner-card warning-banner-card--full export-disclaimer-card"><div class="warning-banner-icon">!</div><div class="warning-banner-copy"><p class="subtle-label">Disclaimer</p><h4 class="warning-banner-title">Recent open-source export/import data for this product could not be reliably sourced at the required level of freshness.</h4><p class="note-copy">The publicly accessible WITS link currently reflects older data. If you have a more recent Excel file or come across a better open source, this section will be updated accordingly. Feedback is always welcome.</p></div></section>`;
}

function historicalWarEventPage(e) {
  const share = e.share_price_window || [];
  const imports = e.import_dependency || [];
  const balance = e.trade_balance || [];
  const brom = e.archean_bromine_quarters || [];
  const margin = e.archean_margin_quarters || [];
  const icl = e.icl_industrial_products || [];
  const brominePrices = e.bromine_price_markets || [];
  const timeline = e.timeline || [];

  add("evh1", line(share.map((r) => r.date.slice(5)), share.map((r) => r.close_price_inr), "ACI close price (Rs)", "#103f34", "equitypandit-aci-history"));
  add("evh2", stack(imports.map((r) => String(r.year)), [imports.map((r) => r.israel_usd_mn), imports.map((r) => r.jordan_usd_mn), imports.map((r) => r.other_usd_mn)], ["Israel", "Jordan", "Other"], ["#103f34", "#a86916", "#d9d4c8"], "wits-ind-bromine-2024-import"));
  add("evh3", lines(balance.map((r) => String(r.year)), [{ name: "Imports (USD mn)", data: balance.map((r) => r.imports_usd_mn) }, { name: "Exports (USD mn)", data: balance.map((r) => r.exports_usd_mn) }], "wits-ind-bromine-2024-export"));
  add("evh4", lines(brom.map((r) => r.period), [{ name: "Bromine volume (tons)", data: brom.map((r) => r.volume_tons) }, { name: "Realization (Rs/ton)", data: brom.map((r) => r.implied_realization_per_ton), yAxisIndex: 1 }], brom[brom.length - 1]?.source_id || "archean-q3fy26-presentation"));
  add("evh5", lines(margin.map((r) => r.period), [{ name: "EBITDA margin (%)", data: margin.map((r) => r.ebitda_margin) }, { name: "Bromine volume (tons)", data: brom.map((r) => r.volume_tons), yAxisIndex: 1 }], "archean-q3fy26-presentation"));
  add("evh6", lines(icl.map((r) => r.period), [{ name: "ICL sales (USD mn)", data: icl.map((r) => r.sales_usd_mn) }, { name: "ICL EBITDA margin (%)", data: icl.map((r) => r.ebitda_margin_pct), yAxisIndex: 1 }], "icl-q3-2025-results"));
  add("evh7", lines(["Q2 2025", "Q3 2025", "Q4 2025"], unique(brominePrices.map((r) => r.market)).map((market) => ({ name: market, data: ["Q2 2025", "Q3 2025", "Q4 2025"].map((period) => (brominePrices.find((r) => r.market === market && r.period === period) || {}).price_usd_per_ton || null) })), "chemanalyst-bromine-2025"));

  return `<section class="grid-2">${note("Was this earlier event predictable?", "Partly yes. Bromine market notes were already flagging geopolitical risk before the June 13 strikes, so this was not a clean bolt-from-blue for the supply chain.", "chemanalyst-israel-bromine-apr-2025")}${note("What Archean later said", "Archean told investors in February 2026 that it had not heard any significant customer shift from Israel to India and saw no immediate upside from that earlier conflict.", "archean-q3fy26-transcript")}</section>
  <section class="chart-grid chart-grid-2up">${chart("evh1", "ACI share price through the June 2025 war window", "The stock fell during the event, but it was back near the pre-war level by month-end. That is why this older event is better read as a risk spike than as a lasting business break.", ["equitypandit-aci-history"])}${chart("evh2", "India's bromine import dependence on Israel and Jordan", "India was already heavily dependent on Israel and Jordan before the June 2025 war. That is why the conflict mattered even without a clean customs follow-through.", ["wits-ind-bromine-2022-import", "wits-ind-bromine-2023-import", "wits-ind-bromine-2024-import"], true)}</section>
  <section class="chart-grid chart-grid-2up">${chart("evh3", "India bromine imports versus exports", "India moved from net export value in 2022 to net import value by 2023 and 2024. Archean went into the 2025 event from a weaker India trade position, not a stronger one.", ["wits-ind-bromine-2022-export", "wits-ind-bromine-2024-import"])}${chart("evh4", "Archean bromine volume versus realization (Rs/ton)", "The key company read is simple: realization improved, but volume did not. That means later weakness was not mainly a pricing problem.", ["archean-q1fy26-presentation", "archean-q3fy26-presentation"])}</section>
  <section class="chart-grid chart-grid-2up">${chart("evh5", "Archean margin versus bromine volume", "Margins held up in the war quarter and then fell later as bromine tonnage dropped. That points much more to internal operating limits than to the 2025 event itself.", ["archean-q1fy26-presentation", "archean-q3fy26-presentation"])}${chart("evh6", "Israeli peer check: ICL Industrial Products", "ICL's industrial-products business stayed relatively stable through 2025. That argues against a major physical collapse in the Israeli bromine chain during the older event window.", ["icl-q1-2025-results", "icl-q2-2025-results", "icl-q3-2025-results"])}</section>
  <section class="grid-2">${chart("evh7", "Bromine price proxies after the June 2025 war", "Pricing did firm later in 2025, but the pattern looks more like gradual tightening and freight effects than an instant June supply shock.", ["chemanalyst-bromine-2025", "pricewatch-bromine-q4-2025"])}${note("Can the customs shift already be proved?", "Not yet. The 2025 annual India bromine import page is still blank in WITS, so the dashboard stops at the latest reliable full-year import mix and company commentary instead of forcing a fake post-war customs conclusion.", "wits-ind-bromine-2025-import")}</section>
  ${tableCard("Conflict timeline used in this page", "These are the dated checkpoints used for the older event read.", [["Date", "date"], ["Event", "title"], ["Why it matters", "detail"]], timeline, e.timeline_table_name, e.timeline_table_name)}
  <section class="note-grid">${note("What happened to margins in the industry?", "The cleaner read from ICL is that Israeli bromine-linked earnings did not collapse. Margins stayed in the low-20s, which suggests the industry saw risk premium and logistics stress more than a full supply freeze.", "icl-q3-2025-results")}${note("What happened to Archean's margin?", "Archean's consolidated EBITDA margin was 28.7% in Q1FY26 and then fell to 23.5% by Q3FY26 even though bromine realization improved. The missing piece was volume, not price.", "archean-q3fy26-presentation")}${note("What the older page is really saying", "The 2025 war mattered because it raised risk around a supply chain that India already depends on. But the later earnings damage at Archean still came more from internal bromine output than from a missed war-driven price windfall.", "derived-model")}</section>`;
}

function segmentPage(name, key, desc) {
  const s = rows("company_segment_metrics").filter((r) => r.product_segment === name && r.period_type === "quarter").sort((a, b) => period(a.period) - period(b.period));
  const q = s[s.length - 1], trade = state.d.trade;
  const bromineTradeYear = trade.bromine_latest_reliable_year || 2024;
  const bromineImportProxy = trade.india_bromine_import_world_latest_reliable || trade.india_bromine_import_world_2024;
  const bromineImportSource = trade.bromine_latest_reliable_import_source_id || "wits-ind-bromine-2024-import";
  add(`${key}1`, bar(s.map((r) => r.period), s.map((r) => r.volume_tons), `${name} volume`, "#103f34", "archean-q3fy26-presentation"));
  add(`${key}2`, combo(s.map((r) => r.period), s.map((r) => r.revenue), s.map((r) => r.implied_realization_per_ton), "archean-q3fy26-presentation"));
  if (key === "brom") {
    const b = bridge(name, "Q3FY26", q?.yoy_revenue != null ? "Q3FY25" : "Q2FY26"), p = [round((q?.implied_realization_per_ton || 0) / 83, 1), round(bromineImportProxy?.unit_value_usd_per_ton || 0, 1)];
        add(`${key}3`, impactBars(b.rows.slice(1, -1), b.source_id, { valueAxisName: "Change in revenue (Rs mn)", categoryAxisName: "Bridge step" })); add(`${key}4`, bar(["Archean Q3 FY26", `India ${bromineTradeYear} import proxy`], p, "USD per ton", "#103f34", bromineImportSource, false, { valueAxisName: "Price (USD/ton)", categoryAxisName: "Comparison" })); add(`${key}5`, bromineSensitivitySimple(state.d.sensitivity.bromine_price_vs_utilization || [])); add(`${key}6`, lines(scenarioRows().map((r) => r.period), [{ name: "Bromine realization (Rs '000/ton)", data: scenarioRows().map((r) => r.bromine_price_assumption) }, { name: "Bromine volume (tons)", data: scenarioRows().map((r) => r.bromine_volume_assumption), yAxisIndex: 1 }], "derived-model"));
        return `<section class="chart-grid">${chart(`${key}1`, "Quarterly bromine volume", "Bromine sales volume fell sharply from Q1 to Q3 FY26, which is the clearest sign that current weakness is not only about pricing.", ["archean-q1fy26-transcript", "archean-q2fy26-transcript", "archean-q3fy26-presentation"])}${chart(`${key}2`, "Quarterly bromine revenue and realization (Rs/ton)", "Revenue pressure has come from both lower output and lower realization per ton, but the volume collapse has been the bigger swing inside FY26.", ["archean-q1fy26-transcript", "archean-q2fy26-transcript", "archean-q3fy26-presentation"])}${chart(`${key}3`, "What changed in bromine revenue?", `From ${b.rows[0]?.name || "last period"} to ${b.rows[b.rows.length - 1]?.name || "this period"}, revenue moved from ${fmtRs(b.rows[0]?.value)} to ${fmtRs(b.rows[b.rows.length - 1]?.value)}. Bars below zero hurt revenue. Lower volume was the biggest drag.`, [b.source_id], true)}${chart(`${key}4`, "Archean realization versus external price proxy", `The external comparator shown here is India's latest reliable full-year bromine import unit value (${bromineTradeYear}), so it is a trade proxy rather than a spot benchmark.`, [bromineImportSource, "archean-q3fy26-presentation", "derived-model"], true)}</section><section class="grid-2">${note("Simple read", `Bromine revenue moved from ${fmtRs(b.rows[0]?.value)} in ${b.rows[0]?.name || "the earlier period"} to ${fmtRs(b.rows[b.rows.length - 1]?.value)} in ${b.rows[b.rows.length - 1]?.name || "the latest period"}. The biggest drag was lower volume, while realization per ton was a smaller drag.`, b.source_id)}${note("Current diagnosis", "Management continues to describe demand and order-book conditions as healthy, while actual bromine sales volume fell sharply. That points to internal output getting back to normal output as the main near-term issue.", "archean-q3fy26-transcript")}</section><section class="chart-grid">${chart(`${key}5`, "If bromine realization or plant running improves, what happens to EBITDA?", "Read left to right. A move to the right means better realization. A higher line means better plant running. Higher and further right is better for EBITDA.", ["derived-model"])}${chart(`${key}6`, `${scenarioLabel()} bromine realization and volume path`, "The selected scenario keeps realization and volume visible so the forecast is challengeable rather than black-box.", ["derived-model"])}</section>${tableCard("Bromine segment drill-down", "Reported, derived and implied values remain visible so the user can audit how the dashboard treats revenue, volume and realization quarter by quarter.", [["Period", "period"], ["Revenue (Rs mn)", "rev"], ["Volume (tons)", "vol"], ["Realization (Rs/ton)", "real"], ["Status", "status"]], s.map((r) => ({ ...r, rev: fmtRs(r.revenue), vol: fmtTons(r.volume_tons), real: fmtRsTon(r.implied_realization_per_ton) })), "bromine_segment_metrics", "company_segment_metrics")}`;
  }
  const headroom = ((q?.volume_tons || 0) * 4) / 1000000, p = [round((q?.implied_realization_per_ton || 0) / 83, 1), round(trade.india_salt_world_2024?.unit_value_usd_per_ton || 0, 1)];
  add(`${key}3`, bar((trade.india_salt_exports_2024 || []).map((r) => r.importer_country), (trade.india_salt_exports_2024 || []).map((r) => round(r.trade_value_usd / 1000000, 1)), "Trade value (USD mn)", "#103f34", "wits-ind-salt-2024-export", true));
  add(`${key}4`, bar(["Archean Q3 FY26", "India 2024 export proxy"], p, "USD per ton", "#a86916", "wits-ind-salt-2024-export"));
  add(`${key}5`, saltFreightSensitivity(state.d.sensitivity.salt_volume_vs_freight || []));
      return `<section class="chart-grid chart-grid-2up">${chart(`${key}1`, "Quarterly salt volume", "Salt moved back above the 1 million ton run-rate in Q3 FY26, which is why it remains the throughput ballast when bromine underperforms.", ["archean-q1fy26-transcript", "archean-q2fy26-transcript", "archean-q3fy26-presentation"])}${chart(`${key}2`, "Quarterly salt revenue and realization (Rs/ton)", "Realization remains thin versus bromine economics, but the scale matters for asset use and fixed-cost absorption.", ["archean-q1fy26-transcript", "archean-q2fy26-transcript", "archean-q3fy26-presentation"])}${chart(`${key}3`, "India salt export destinations", "China dominates India's export flow, which makes Archean's salt platform highly exposed to destination-side shipping economics.", ["wits-ind-salt-2024-export"])}${chart(`${key}4`, "Archean salt realization versus trade proxy", "This comparison is directional only: Archean's company realization is converted to USD per ton using the model base FX for comparability against customs data.", ["wits-ind-salt-2024-export", "archean-q3fy26-presentation", "derived-model"], true)}</section><section class="note-grid">${note("Headroom view", `Annualized Q3 sales volume implies ${round((headroom / 6.0) * 100, 1)}% of rated salt capacity. Archean still has room to scale volumes before another headline expansion step.`, "archean-crisil-fy25")}${note("Demand drivers", "Industrial salt still links into chlor-alkali, chemicals, dyes, textiles, glass and water-treatment chains, which is why volume durability matters even when price is soft.", "wits-ind-salt-2024-export")}${note("Margin relevance", "Low realization does not mean low strategic value. Salt helps keep the marine-chemicals system full and supports logistics and fixed-cost absorption.", "derived-model")}</section><section class="chart-grid">${chart(`${key}5`, "If salt volume changes, what happens to EBITDA?", "Read this left to right. More salt volume helps EBITDA. Higher freight-cost lines sit lower because transport eats into profit.", ["derived-model"])}${mini("Top salt destinations", trade.india_salt_exports_2024 || [], "importer_country", "trade_value_usd", "wits-ind-salt-2024-export")}</section>${tableCard("Industrial salt drill-down", "Volume, realization and destination context stay connected in one place.", [["Period", "period"], ["Revenue (Rs mn)", "rev"], ["Volume (tons)", "vol"], ["Realization (Rs/ton)", "real"], ["Status", "status"]], s.map((r) => ({ ...r, rev: fmtRs(r.revenue), vol: fmtTons(r.volume_tons), real: fmtRsTon(r.implied_realization_per_ton) })), "salt_segment_metrics", "company_segment_metrics")}`;
}

function tradePage() {
  const f = state.d.overview.facts || {};
  const t = state.d.trade;
  const reliableYear = t.bromine_latest_reliable_year || 2024;
  const availableYear = t.bromine_latest_available_year || reliableYear;
  const worldSource = t.bromine_latest_reliable_world_export_source_id || "wits-world-bromine-2024-export";
  const importSource = t.bromine_latest_reliable_import_source_id || "wits-ind-bromine-2024-import";
  const exportSource = t.bromine_latest_reliable_export_source_id || "wits-ind-bromine-2024-export";
  const warningSource = (t.bromine_trade_warning_source_ids || [])[2] || "wits-world-bromine-2025-export";
  const worldExports = t.world_bromine_exports_latest_reliable || t.world_bromine_exports_2024 || [];
  const shareSeries = (t.india_bromine_share_series || []).filter((r) => r.india_bromine_export_share_pct != null);
  const imports = t.india_bromine_imports_latest_reliable || t.india_bromine_imports_2024 || [];
  const bromineExports = t.india_bromine_exports_latest_reliable || t.india_bromine_exports_2024 || [];
  const topExporters = worldExports.slice(0, 6);
  const priceRows = topExporters.filter((r) => r.unit_value_usd_per_ton != null).slice(0, 5);
  const p = rows("peer_metrics");
  const peer = p[0] || {};
  const indiaExport = t.india_bromine_world_latest_reliable || t.india_bromine_world_2024 || {};
  const indiaImport = t.india_bromine_import_world_latest_reliable || t.india_bromine_import_world_2024 || {};
  const importGap = (indiaImport.trade_value_usd || 0) - (indiaExport.trade_value_usd || 0);
  const customerRows = rows("customer_disclosure");
  const namedCustomer = customerRows.find((r) => r.rank_label === "1") || customerRows[0] || {};
  const relationshipCount = f.top_10_relationships_over_5y || 7;
  const peerRows = p.map((r) => ({
    peer_name: r.peer_name,
    geography: r.geography,
    bromine_exposure: r.bromine_exposure,
    revenue: r.segment_revenue == null ? "N/A" : `${round(r.segment_revenue, 1)} USD mn`,
    ebitda: r.segment_ebitda == null ? "N/A" : `${round(r.segment_ebitda, 1)} USD mn`,
    margin: fmtPct(r.segment_margin),
    why_useful: `${r.production_commentary} ${r.pricing_commentary}`.trim(),
    source: sourceName(r.source),
  }));
  const disclosureRows = customerRows.map((r) => ({
    rank: esc(r.rank_label),
    customer: esc(r.customer_name),
    country: esc(r.country),
    business: esc(r.business),
    exposure: r.sales_exposure_pct != null
      ? `<span class="tag ${r.sales_exposure_pct >= 40 ? "is-warn" : ""}">${esc(fmtPct(r.sales_exposure_pct))} of sales</span>`
      : `<span class="tag">Not individually disclosed</span>`,
    status: `<span class="tag ${/not publicly disclosed/i.test(r.disclosure_status || "") ? "" : "is-warn"}">${esc(r.disclosure_status)}</span>`,
  }));

  add("tr1", pie([{ name: "Export", value: f.export_share_pct || 0 }, { name: "Domestic", value: 100 - (f.export_share_pct || 0) }], "archean-q3fy26-presentation"));
  add("tr2", stack(["Exposure mix"], [[f.largest_customer_pct || 0], [(f.top_10_customer_pct || 0) - (f.largest_customer_pct || 0)], [(f.top_20_customer_pct || 0) - (f.top_10_customer_pct || 0)], [100 - (f.top_20_customer_pct || 0)]], ["Largest", "Top 10 rest", "Top 20 rest", "Others"], ["#103f34", "#42665d", "#d39d52", "#d9d4c8"], "archean-q3fy26-presentation", true, { valueAxisName: "Share of sales (%)", categoryAxisName: "Customer bucket" }));
  add("tr3", bar(imports.map((r) => r.exporter_country), imports.map((r) => round(r.trade_value_usd / 1000000, 2)), "Trade value (USD mn)", "#a86916", importSource));
  add("tr4", bar(topExporters.map((r) => r.exporter_country), topExporters.map((r) => round(r.trade_value_usd / 1000000, 1)), "Trade value (USD mn)", "#103f34", worldSource));
  if (shareSeries.length) add("tr5", line(shareSeries.map((r) => String(r.year)), shareSeries.map((r) => r.india_bromine_export_share_pct), "India share of global bromine exports (%)", "#a86916", worldSource));
  add("tr6", bar(bromineExports.map((r) => r.importer_country), bromineExports.map((r) => round(r.trade_value_usd / 1000000, 2)), "Trade value (USD mn)", "#42665d", exportSource, true));
  if (peer.segment_margin != null) add("tr7", bar(["Archean consolidated Q3 FY26", "ICL Industrial Products FY25"], [latestFinancial()?.ebitda_margin || 0, peer.segment_margin || 0], "EBITDA margin (%)", "#103f34", "icl-industrial-products-fy25"));
  if (priceRows.length) add("tr8", bar(priceRows.map((r) => r.exporter_country), priceRows.map((r) => round(r.unit_value_usd_per_ton, 0)), "USD per ton", "#a86916", worldSource, true));

  return `<section class="chart-grid chart-grid-2up">
    ${chart("tr1", "Export versus domestic mix", "Archean remains export-led, so destination demand and freight still matter.", ["archean-q3fy26-presentation"])}
    ${chart("tr2", "Customer concentration", "Concentration remains high enough for account timing to move a quarter.", ["archean-q3fy26-presentation"], true)}
    ${chart("tr3", "India bromine imports by source country", `This uses India's latest reliable full-year import data (CY${reliableYear}).`, [importSource, warningSource])}
    ${chart("tr4", "Global bromine exporters", `These bars use the latest reliable full-year world data (CY${reliableYear}).`, [worldSource, warningSource])}
    ${shareSeries.length ? chart("tr5", "India share of global bromine exports", `Share trend through CY${reliableYear}.`, [worldSource, warningSource], true) : ""}
    ${chart("tr6", "India bromine export destinations", `Destination mix in the latest reliable full-year (CY${reliableYear}).`, [exportSource], true)}
    ${peer.segment_margin != null ? chart("tr7", "Archean margin versus ICL reference", "Useful benchmark check, not a perfect like-for-like.", ["icl-industrial-products-fy25", "archean-q3fy26-presentation"], true) : ""}
    ${priceRows.length ? chart("tr8", "Major exporter unit value", `Unit value comparison across main exporters in CY${reliableYear}.`, [worldSource], true) : ""}
  </section>
  <section class="note-grid">
    ${note("Why India net-import status matters", `India remained a net bromine importer in CY${reliableYear}. That supports room for local share gains if Archean normalizes output.`, importSource)}
    ${note("Peer framing", "There is no close listed Indian bromine peer in the verified set. The best read is India trade context plus ICL as the global financial benchmark.", "derived-model")}
    ${note("Coverage warning", t.bromine_trade_warning || `CY${availableYear} bromine annual trade coverage is incomplete, so this page uses CY${reliableYear} as the latest reliable full-year set.`, warningSource)}
  </section>
  ${tableCard("Customer concentration summary", "High-signal concentration view based on disclosed company figures.", [["Bucket", "bucket"], ["Exposure", "exposure"]], [{ bucket: "Largest customer", exposure: fmtPct(f.largest_customer_pct) }, { bucket: "Top 10 customers", exposure: fmtPct(f.top_10_customer_pct) }, { bucket: "Top 20 customers", exposure: fmtPct(f.top_20_customer_pct) }, { bucket: "Rest of customer base", exposure: fmtPct(100 - (f.top_20_customer_pct || 0)) }], "customer_concentration")}
  <section class="grid-2">
    ${card("Largest named customer", namedCustomer.customer_name || "Sojitz", `${namedCustomer.country || "Japan"} | ${namedCustomer.business || "Trading conglomerate"} | ${fmtPct(namedCustomer.sales_exposure_pct)} of sales`, namedCustomer.source_id || "archean-q3fy26-presentation", "is-warning")}
    ${card("Other top-10 relationship block", "Names not publicly disclosed", `${fmtPct((f.top_10_customer_pct || 0) - (f.largest_customer_pct || 0))} of sales sits in the rest of the top-10 bucket. ${relationshipCount} of the top 10 customer relationships are older than five years.`, "archean-q3fy26-presentation", "is-accent")}
  </section>
  ${tableCard("India bromine trade snapshot", "Single non-duplicate table for India trade position and global share context.", [["Item", "item"], ["Current read", "value"]], [{ item: `India bromine exports in CY${reliableYear}`, value: `${round((indiaExport.trade_value_usd || 0) / 1000000, 1)} USD mn` }, { item: `India bromine imports in CY${reliableYear}`, value: `${round((indiaImport.trade_value_usd || 0) / 1000000, 1)} USD mn` }, { item: "Net import gap", value: `${round(importGap / 1000000, 1)} USD mn` }, { item: `India share of global bromine exports in CY${reliableYear}`, value: fmtPct(shareSeries[shareSeries.length - 1]?.india_bromine_export_share_pct) }], "trade_bromine_country", "trade_bromine_country")}
  ${tableCard("Top-customer disclosure view", "The company publicly names Sojitz; the rest of top-10 concentration is disclosed without names.", [["Rank", "rank"], ["Customer", "customer"], ["Country", "country"], ["Business", "business"], ["Sales exposure", "exposure"], ["Disclosure", "status"]], disclosureRows, "customer_disclosure", "customer_disclosure", true)}
  ${tableCard("Financial peer reference", "Only peer rows with useful, source-backed context are included.", [["Peer", "peer_name"], ["Geography", "geography"], ["Bromine exposure", "bromine_exposure"], ["Revenue", "revenue"], ["EBITDA", "ebitda"], ["Margin", "margin"], ["Why it is useful", "why_useful"], ["Source", "source"]], peerRows, "peer_metrics", "peer_metrics")}
  <section class="warning-banner-card warning-banner-card--full export-disclaimer-card"><div class="warning-banner-icon">!</div><div class="warning-banner-copy"><p class="subtle-label">Disclaimer</p><h4 class="warning-banner-title">Recent open-source export/import data for this product could not be reliably sourced at the required level of freshness.</h4><p class="note-copy">The publicly accessible WITS link currently reflects older data. If you have a more recent Excel file or come across a better open source, this section will be updated accordingly. Feedback is always welcome.</p></div></section>`;
}

function costsPage() {
  const s = scenarioRows();
  const b = ebitdaBridgeRows();

  add("co1", waterfall(b.rows, b.formula, b.source_id));
  add("co2", line(s.map((r) => r.period), s.map((r) => r.predicted_margin), "Predicted EBITDA margin (%)", "#103f34", "derived-model"));

    return `<section class="grid-2"><div class="table-card"><div class="table-head"><div><p class="subtle-label">Scenario controls</p><h4>What if these inputs move?</h4><p class="table-copy">These sliders change the visible model output right away. They are user controls, not reported facts.</p></div></div><div class="slider-grid">${controls()}</div></div><div class="table-card scenario-panel"><div class="table-head"><div><p class="subtle-label">Scenario output</p><h4>Result for the next quarter</h4><p class="table-copy">This uses the selected scenario plus your current slider changes.</p></div></div><div class="scenario-output is-summary">${scenario("Revenue", fmtRs(s[0]?.predicted_revenue))}${scenario("EBITDA", fmtRs(s[0]?.predicted_ebitda))}${scenario("EBITDA margin", fmtPct(s[0]?.predicted_margin))}${scenario("PAT", fmtRs(s[0]?.predicted_pat))}</div><div class="tag-row"><span class="tag">Derived output</span><span class="tag is-warn">Not company guidance</span></div></div></section>
    <section class="chart-grid">${chart("co1", "Quarterly EBITDA bridge", "The latest drop in EBITDA came from both lower revenue and weaker margin. That is why bromine recovery matters so much.", [latestFinancial()?.source_id])}${chart("co2", "Forward EBITDA margin path", "If bromine volume improves, margin can recover quickly. If freight, power or monsoon stress rises, that recovery gets slower.", ["derived-model"])}</section>
    <section class="note-grid">${note("Why some cost charts are missing", "A full verified local history for FX, freight and rainfall is not yet loaded end to end. Those weak charts are omitted instead of guessed.", "derived-model")}${note("How this model works", "The model starts with bromine, salt and derivatives assumptions, then applies margin assumptions and risk penalties. Nothing is hidden.", "derived-model")}${note("Main margin message", "Salt supports the system, but bromine still does most of the heavy lifting for earnings. That is why small bromine changes can move EBITDA a lot.", "derived-model")}</section>`;
}

function forecastPage() {
  const live = scenarioRows(3);
  const back = backtest();
  const presetKeys = Object.keys(state.d.assumptions);
  const scenarioMap = Object.fromEntries(presetKeys.map((k) => [k, scenarioRowsFor(k, 3, k === activeScenarioKey())]));
  const all = presetKeys.flatMap((k) => scenarioMap[k]);
  const conf = confidence(all);
  const snapshots = presetKeys.map((k) => scenarioSnapshot(k, scenarioMap[k]));
  const first4 = live.slice(0, 4);
  const compareRows = first4.map((r, i) => ({
    period: r.period,
    base_ebitda: fmtRs(scenarioMap.base?.[i]?.predicted_ebitda),
    bull_ebitda: fmtRs(scenarioMap.bull?.[i]?.predicted_ebitda),
    bear_ebitda: fmtRs(scenarioMap.bear?.[i]?.predicted_ebitda),
    base_margin: fmtPct(scenarioMap.base?.[i]?.predicted_margin),
  }));

  add("fo1", band(conf.map((r) => r.period), conf.map((r) => r.low), conf.map((r) => r.base), conf.map((r) => r.high), "derived-model"));
  add("fo2", lines(live.map((r) => r.period), presetKeys.map((k) => ({ name: `${state.d.assumptions[k].label || k} EBITDA`, data: (scenarioMap[k] || []).map((r) => r.predicted_ebitda) })), "derived-model"));
  add("fo3", lines(live.map((r) => r.period), [{ name: "Bromine realization (Rs '000/ton)", data: live.map((r) => r.bromine_price_assumption) }, { name: "Bromine volume (tons)", data: live.map((r) => r.bromine_volume_assumption), yAxisIndex: 1 }], "derived-model"));
  add("fo4", lines(live.map((r) => r.period), [{ name: "Salt realization (Rs/ton)", data: live.map((r) => r.salt_realization_assumption) }, { name: "Salt volume (tons)", data: live.map((r) => r.salt_volume_assumption), yAxisIndex: 1 }], "derived-model"));

    return `<section class="grid-3">${snapshots.map((snap) => `<div class="note-card"><p class="subtle-label">Scenario summary</p><h4>${esc(snap.label)} case in plain English</h4><ul class="bullet-list">${scenarioBullets(snap.name).map((item) => `<li>${esc(item)}</li>`).join("")}</ul><div class="tag-row"><span class="tag">Next-quarter EBITDA ${esc(fmtRs(snap.next_ebitda))}</span><span class="tag is-warn">4-quarter EBITDA ${esc(fmtRs(snap.four_quarter_ebitda))}</span></div></div>`).join("")}</section>
    <section class="chart-grid chart-grid-2up">${chart("fo1", "Revenue range by scenario", "This shaded band now starts from the live bromine and salt prices in the price tab, then carries bull, base and bear revenue across the next 3 quarters.", ["derived-model"])}${chart("fo2", "EBITDA by scenario", "Bull sits highest, bear sits lowest, and base stays in the middle. All three now start from the latest price-tab realization inputs.", ["derived-model"])}${chart("fo3", `${scenarioLabel()} bromine realization and volume path`, "This keeps bromine realization and bromine volume together so you can see how the current price-tab starting point flows into the next 3 quarters.", ["derived-model"])}${chart("fo4", `${scenarioLabel()} salt realization and volume path`, "Salt now follows the same live price-tab link, so future salt revenue and EBITDA support update from the current salt price input.", ["derived-model"])}</section>
    <section class="grid-2"><div class="table-card"><div class="table-head"><div><p class="subtle-label">Assumption editor</p><h4>Change the current scenario live</h4><p class="table-copy">The sliders below change the selected scenario on this page right away.</p></div><button class="export-button" type="button" data-export-table="model_output">Export model output CSV</button></div><div class="slider-grid">${controls()}</div><div class="tag-row"><span class="tag">Transparent model</span><span class="tag is-warn">Forecasts are derived, not reported</span></div></div>${tableCard("Next 3 quarters for the selected scenario", "This live forecast now starts from the latest bromine and salt prices in the Price History & Simulation tab.", [["Period", "period"], ["Bromine realization", "bp"], ["Salt realization", "sp"], ["Bromine volume", "bv"], ["Salt volume", "sv"], ["Revenue", "rev"], ["EBITDA", "eb"], ["Margin", "m"], ["PAT", "pat"]], live.map((r) => ({ ...r, bp: `${round(r.bromine_price_assumption, 1)}k Rs/ton`, sp: fmtRsTon(r.salt_realization_assumption), bv: fmtTons(r.bromine_volume_assumption), sv: fmtTons(r.salt_volume_assumption), rev: fmtRs(r.predicted_revenue), eb: fmtRs(r.predicted_ebitda), m: fmtPct(r.predicted_margin), pat: fmtRs(r.predicted_pat) })), "model_output", "model_output")}</section>
    <section class="note-grid">${note("What has to go right in the bull case", "Bromine volumes need to recover faster, prices need to keep improving, and derivatives need to scale without a cost shock.", "derived-model")}${note("What the base case assumes", "Bromine improves step by step, salt keeps supporting throughput, and there is no major freight, FX or monsoon shock.", "derived-model")}${note("What can drive the bear case", "A slow bromine recovery, weak price follow-through, and higher freight or weather stress can all keep margins under pressure.", "derived-model")}</section>
    ${tableCard("Scenario comparison for the next 3 quarters", "This gives a direct bull, base and bear read for each upcoming quarter using the live price-tab starting points.", [["Period", "period"], ["Base EBITDA", "base_ebitda"], ["Bull EBITDA", "bull_ebitda"], ["Bear EBITDA", "bear_ebitda"], ["Base margin", "base_margin"]], compareRows, "model_output", "model_output")}
    <section class="note-grid">${note("Backtest quality", back.summary, "derived-model")}${note("Backtest detail", back.detail, "derived-model")}${note("Export support", "Every major model table here can be downloaded, so you can move the assumptions and outputs into your own sheet quickly.", "derived-model")}</section>`;
}

function capexPage() { const c = rows("company_capex_projects"), chartCapex = c.filter((r) => r.capex_amount != null), s = rows("company_subsidiaries_and_investments"), score = subsidiaryScoreRows(s); add("ca1", bar(chartCapex.map((r) => r.project_name), chartCapex.map((r) => r.capex_amount), "Capex (Rs cr)", "#103f34", "archean-ar-fy25")); add("ca2", bar(score.map((r) => r.name), score.map((r) => r.score), "Stage score", "#a86916", "derived-optionality", true)); return `<section class="chart-grid">${chart("ca1", "Project size by disclosed spend", "Only projects with a disclosed amount are shown in the bar chart. The new Gujarat jetty MoU stays in the table because the company has not disclosed a capex number yet.", ["archean-ar-fy25", "archean-gujarat-jetty-mou-feb-2026", "archean-q3fy26-transcript"])}${chart("ca2", "How close each platform is to revenue", "The Idealis mud-chemicals structure is shown as one platform here because Archean approved the merger of Idealis Chemicals into Idealis Mudchemie on March 19, 2026, with legal completion still pending.", ["derived-optionality", "archean-idealis-merger-mar-2026"])}</section><section class="note-grid">${note("Simple status view", "Earning now: Acume. Starting up: Mudchemie. Being built: SiCSem. The Gujarat jetty is a logistics project, not a product line.", "derived-optionality")}${note("Latest company update", "Archean's board approved the merger of Idealis Chemicals into Idealis Mudchemie on March 19, 2026 to simplify the group structure and consolidate chemical and mud-chemical operations. The legal merger is still pending.", "archean-idealis-merger-mar-2026")}${note("Strategic related business map", "Bromine feeds derivatives directly, supports oilfield chemistry related business, and links chemically into zinc-bromide storage. SiC is a separate platform with lower immediate linkage to the core brine chain.", "derived-optionality")}</section>${tableCard("Capex project tracker", "Project amounts stay at the last disclosed number. Status text is refreshed to the latest company update where available.", [["Project", "project_name"], ["Segment", "business_segment"], ["Capex (Rs cr)", "capex_amount"], ["Current timeline note", "expected_start"], ["Current status", "status"], ["Latest timing view", "expected_completion"], ["Capacity addition", "expected_capacity_addition"]], c, "capex_projects", "company_capex_projects")}${tableCard("Subsidiary and future upside tracker", "Strategic adjacencies stay visible but are not confused with current operating earnings.", [["Name", "name"], ["Business", "business"], ["Stake", "stake"], ["Status", "status"], ["Revenue stage", "revenue_stage"], ["Strategic link", "strategic_link_to_core_bromine_business"]], s, "subsidiaries_and_investments", "company_subsidiaries_and_investments")}`; }
function sourcesPage() { const s = state.d.sourcesList; return `${head("Trust layer", "Source Library / Methodology", "Every important number keeps a source trail, and weak source chains are shown as omissions instead of fake certainty.")}<section class="grid-3">${card("Latest verified company period", state.d.company.latest_update_label || "Unknown", "Concrete reporting date matters more than vague 'latest' language.", "archean-q3fy26-presentation")}${card("Source count", String(s.length), "Every important metric keeps a source trail or is marked derived.", "derived-model")}${card("Refresh mode", state.d.meta.refresh_mode || "cached", "Hosted verification is still separate from local build verification.", "derived-model", "is-warning")}</section>${tableCard("Source library", "Each source records type, reporting period, fetch date and extraction scope so the user can audit what the dashboard is actually built on.", [["Name", "nameLink"], ["Type", "type"], ["Reporting period", "reporting_period"], ["Fetch date", "fetch_date"], ["Fields extracted", "fields"]], s.map((r) => ({ ...r, nameLink: r.local_doc_url || r.local_text_url || r.url ? `<a class="source-link" href="${esc(r.local_doc_url || r.local_text_url || r.url)}" target="_blank" rel="noreferrer">${esc(r.name)}</a>` : esc(r.name), fields: esc((r.fields_extracted || []).join(", ")) })), "source_registry", null, true)}<section class="grid-2"><div class="source-card markdown-block"><p class="subtle-label">Methodology</p><h4>Derived metric notes</h4><pre class="pre-block">${esc(state.d.methodology.methodology_markdown || "Methodology note not available.")}</pre></div><div class="source-card markdown-block"><p class="subtle-label">Data dictionary</p><h4>Normalized table definitions</h4><pre class="pre-block">${esc(state.d.methodology.data_dictionary_markdown || "Data dictionary not available.")}</pre></div></section><section class="note-grid">${note("Warning labels", "Reported facts, derived metrics and model estimates are intentionally kept separate. Optionality is not mixed into current earnings unless it is already operating.", "derived-model")}${note("Omitted weak modules", "Continuous external bromine spot series, full FX history and rainfall-production correlation were omitted in this local build because the verified source chain is not complete enough yet.", "derived-model")}${note("Source jump", "Use the source table links to open the exact filings and external tables behind the dashboard's high-signal modules.", "derived-model")}</section>`; }
function rows(n) { return Array.isArray(state.d.tables[n]) ? state.d.tables[n] : []; }
function mixPeriods() { return Array.isArray(state.d.overview?.mix_history) ? state.d.overview.mix_history : []; }
function currentMixPeriod() { return mixPeriods().find((item) => item.period === state.selectedMixPeriod) || mixPeriods().slice(-1)[0] || null; }
function eventItems() { return Array.isArray(state.d.events?.items) ? state.d.events.items : []; }
function currentEvent() { return eventItems().find((item) => item.id === state.selectedEventId) || eventItems()[0] || null; }
function quarters() { return rows("company_quarterly_financials").filter((r) => r.reported_basis === "consolidated" && r.period_type === "quarter").sort((a, b) => period(a.period) - period(b.period)); }
function latestFinancial() { return quarters().slice(-1)[0] || null; }
function latestSeg(n) { return rows("company_segment_metrics").filter((r) => r.product_segment === n && r.period_type === "quarter").sort((a, b) => period(a.period) - period(b.period)).slice(-1)[0] || null; }
function period(p) { const m = /^Q(\d)FY(\d{2})$/.exec(p || ""); return m ? Number(m[2]) * 10 + Number(m[1]) : 0; }
function pageUsesScenario() { return SCENARIO_PAGES.has(state.page); }
function pageUsesLiveRefresh() {
  if (window.location.protocol === "file:") return false;
  if (state.page === "event" || state.page === "price-history") return true;
  return LIVE_REFRESH_PAGES.has(state.page) && LOCAL_REFRESH_HOST_RE.test(window.location.hostname || "");
}
function defaultScenarioKey() { return state.d.assumptions.base ? "base" : Object.keys(state.d.assumptions)[0] || state.scenario; }
function activeScenarioKey() { return pageUsesScenario() ? state.scenario : defaultScenarioKey(); }
function scenarioLabel() { const key = activeScenarioKey(); return state.d.assumptions[key]?.label || key; }
function pageName() { return (PAGES.find((p) => p[0] === state.page) || [null, "Overview"])[1]; }
function exportLabel() { return { overview: "Export overview CSV", event: "Export event CSV", operations: "Export assets CSV", bromine: "Export bromine CSV", salt: "Export salt CSV", derivatives: "Export new-business CSV", trade: "Export trade/global CSV", costs: "Export scenario CSV", "price-history": "Export page CSV", forecast: "Export model CSV", capex: "Export capex CSV" }[state.page] || "Export page CSV"; }
function resetOverrides() { return { brominePriceShiftPct: 0, bromineVolumeShiftPct: 0, saltPriceShiftPct: 0, saltVolumeShiftPct: 0, derivativeUtilShiftPct: 0, freightStressBps: 0, fxStressBps: 0, powerStressBps: 0, monsoonStressBps: 0 }; }
function currentCfgFor(scenarioKey = activeScenarioKey(), applyOverrides = scenarioKey === activeScenarioKey()) {
  const a = state.d.assumptions[scenarioKey] || {};
  const bromineInputs = state.priceInputs?.bromine || {};
  const saltInputs = state.priceInputs?.salt || {};
  const currentBromine = latestSeg("Bromine");
  const currentSalt = latestSeg("Industrial Salt");
  const growthKey = `${scenarioKey}_growth_pct`;
  const bromineGrowth = Number(bromineInputs[growthKey] ?? a.bromine_realization_growth_qoq_pct ?? 0);
  const saltGrowth = Number(saltInputs[growthKey] ?? a.salt_realization_growth_qoq_pct ?? 0);
  return {
    ...a,
    bromine_realization_start_rs_ton: Number(bromineInputs.starting_price || currentBromine?.implied_realization_per_ton || 0),
    salt_realization_start_rs_ton: Number(saltInputs.starting_price || currentSalt?.implied_realization_per_ton || 0),
    bromine_realization_growth_qoq_pct: bromineGrowth + (applyOverrides ? state.overrides.brominePriceShiftPct : 0),
    bromine_volume_start_tons: Math.max(0, Number(currentBromine?.volume_tons || 0) * (1 + (applyOverrides ? state.overrides.bromineVolumeShiftPct : 0) / 100)),
    salt_realization_growth_qoq_pct: saltGrowth + (applyOverrides ? state.overrides.saltPriceShiftPct : 0),
    salt_volume_start_tons: Math.max(0, Number(currentSalt?.volume_tons || 0) * (1 + (applyOverrides ? state.overrides.saltVolumeShiftPct : 0) / 100)),
    derivatives_revenue_start_mn: Math.max(0, Number(a.derivatives_revenue_start_mn || latestSeg("Bromine Derivatives")?.revenue || 0) * (1 + (applyOverrides ? state.overrides.derivativeUtilShiftPct : 0) / 100)),
    freight_stress_bps: Number(a.freight_stress_bps || 0) + (applyOverrides ? state.overrides.freightStressBps : 0),
    fx_stress_bps: Number(a.fx_stress_bps || 0) + (applyOverrides ? state.overrides.fxStressBps : 0),
    power_stress_bps: Number(a.power_stress_bps || 0) + (applyOverrides ? state.overrides.powerStressBps : 0),
    monsoon_stress_bps: Number(a.monsoon_stress_bps || 0) + (applyOverrides ? state.overrides.monsoonStressBps : 0),
  };
}
function currentCfg() { return currentCfgFor(activeScenarioKey(), true); }
function scenarioRowsFor(scenarioKey = activeScenarioKey(), count = 8, applyOverrides = scenarioKey === activeScenarioKey()) { const c = currentCfgFor(scenarioKey, applyOverrides), b = latestSeg("Bromine"), s = latestSeg("Industrial Salt"), d = latestSeg("Bromine Derivatives"); if (!b || !s || !d) return []; let bp = Number(c.bromine_realization_start_rs_ton || b.implied_realization_per_ton || 0), bv = Number(c.bromine_volume_start_tons || 0), sp = Number(c.salt_realization_start_rs_ton || s.implied_realization_per_ton || 0), sv = Number(c.salt_volume_start_tons || 0), dr = Number(c.derivatives_revenue_start_mn || d.revenue || 0); const out = []; nextPeriods(count).forEach((p) => { bv *= 1 + (c.bromine_volume_growth_qoq_pct || 0) / 100; sv *= 1 + (c.salt_volume_growth_qoq_pct || 0) / 100; const br = bp * bv / 1000000, sr = sp * sv / 1000000, rev = br + sr + dr; let eb = br * ((c.bromine_ebitda_margin_pct || 0) / 100) + sr * ((c.salt_ebitda_margin_pct || 0) / 100) + dr * ((c.derivatives_ebitda_margin_pct || 0) / 100) - (c.corporate_cost_mn || 0); eb *= 1 - (((c.freight_stress_bps || 0) + (c.fx_stress_bps || 0) + (c.power_stress_bps || 0) + (c.monsoon_stress_bps || 0)) / 10000); const pat = (eb - 238 - 45) * (1 - (c.tax_rate_pct || 0) / 100); out.push({ period: p, scenario_name: scenarioKey, bromine_price_assumption: round(bp / 1000, 1), bromine_volume_assumption: round(bv, 0), salt_realization_assumption: round(sp, 0), salt_volume_assumption: round(sv, 0), predicted_revenue: round(rev, 1), predicted_ebitda: round(eb, 1), predicted_margin: round((eb / rev) * 100, 1), predicted_pat: round(pat, 1) }); bp *= 1 + (c.bromine_realization_growth_qoq_pct || 0) / 100; sp *= 1 + (c.salt_realization_growth_qoq_pct || 0) / 100; dr *= 1 + (c.derivatives_growth_qoq_pct || 0) / 100; }); return out; }
function scenarioRows(count = 8) { return scenarioRowsFor(activeScenarioKey(), count, true); }
function rowsBy(k) { return rows("model_output").filter((r) => r.scenario_name === k); }
function nextPeriods(n) { let q = 4, y = 2026, out = []; for (let i = 0; i < n; i += 1) { out.push(`Q${q}FY${String(y).slice(-2)}`); q += 1; if (q === 5) { q = 1; y += 1; } } return out; }
function bridge(seg, cur, prev) {
  const a = rows("company_segment_metrics").find((r) => r.product_segment === seg && r.period === cur), b = rows("company_segment_metrics").find((r) => r.product_segment === seg && r.period === prev);
  if (!a || !b) return { rows: [], formula: "", source_id: "derived-model" };
  const ve = ((a.volume_tons - b.volume_tons) * b.implied_realization_per_ton) / 1000000, pe = ((a.implied_realization_per_ton - b.implied_realization_per_ton) * b.volume_tons) / 1000000, re = a.revenue - b.revenue - ve - pe;
  const moveName = (label, value, goodWord, badWord) => `${value >= 0 ? goodWord : badWord} ${label}`;
  return {
    formula: "Start revenue, then show what volume, price, and smaller other items added or took away.",
    source_id: a.source_id,
    rows: [
      { name: `${prev} revenue`, value: b.revenue, absolute: true },
      { name: moveName("volume", ve, "Higher", "Lower"), value: round(ve, 1) },
      { name: moveName("price", pe, "Better", "Weaker"), value: round(pe, 1) },
      { name: moveName("other items", re, "Better", "Weaker"), value: round(re, 1) },
      { name: `${cur} revenue`, value: a.revenue, absolute: true },
    ],
  };
}
function ebitdaBridgeRows() { const q = quarters(); if (q.length < 2) return { rows: [], formula: "", source_id: "derived-model" }; const a = q[q.length - 2], b = q[q.length - 1], re = b.revenue_total - a.revenue_total, me = ((b.ebitda_margin - a.ebitda_margin) * b.revenue_total) / 100, x = b.ebitda - a.ebitda - re - me; return { formula: "Start EBITDA + revenue effect + margin effect + residual = current EBITDA.", source_id: b.source_id, rows: [{ name: `${a.period} EBITDA`, value: a.ebitda, absolute: true }, { name: "Revenue effect", value: round(re, 1) }, { name: "Margin effect", value: round(me, 1) }, { name: "Residual", value: round(x, 1) }, { name: `${b.period} EBITDA`, value: b.ebitda, absolute: true }] }; }
function confidence(all) { return unique(all.map((r) => r.period)).map((p) => { const r = all.filter((x) => x.period === p), b = r.find((x) => x.scenario_name === "base") || r[0] || {}; return { period: p, low: Math.min(...r.map((x) => x.predicted_revenue)), base: b.predicted_revenue, high: Math.max(...r.map((x) => x.predicted_revenue)) }; }); }
function backtest() { const a = rows("company_segment_metrics").find((r) => r.product_segment === "Bromine" && r.period === "Q2FY26"), b = rows("company_segment_metrics").find((r) => r.product_segment === "Bromine" && r.period === "Q3FY26"); if (!a || !b) return { badge: "Insufficient history", summary: "Too little verified history for a meaningful backtest.", detail: "The current local dataset does not support a robust historical backtest, so the dashboard does not fake one." }; return { badge: "Directional only", summary: "Single-period check only; the segment history is still too short for a full rolling backtest.", detail: `A simple Q2 to Q3 holdout shows realization moved by ${fmtSignedRs(b.implied_realization_per_ton - a.implied_realization_per_ton)} per ton and volume by ${fmtSignedTons(b.volume_tons - a.volume_tons)}.` }; }
function scenarioSnapshot(name, scenarioData = null) { const rs = scenarioData || rowsBy(name), first = rs[0] || {}, first4 = rs.slice(0, 4); return { name, label: state.d.assumptions[name]?.label || name, next_ebitda: first.predicted_ebitda, four_quarter_ebitda: round(sum(first4.map((r) => r.predicted_ebitda)), 1) }; }
function scenarioBullets(name) { const a = state.d.assumptions[name] || {}, trend = (v) => v > 0 ? `up ${Math.abs(v)}% QoQ` : v < 0 ? `down ${Math.abs(v)}% QoQ` : "flat QoQ", currentBromine = latestSeg("Bromine"), currentSalt = latestSeg("Industrial Salt"); return [`Bromine realization starts ${trend(a.bromine_realization_growth_qoq_pct || 0)}.`, `Bromine volume starts from the current Q3 FY26 reported base of ${fmtTons(currentBromine?.volume_tons)} and then trends ${trend(a.bromine_volume_growth_qoq_pct || 0)}.`, `Salt volume starts from the current Q3 FY26 reported base of ${fmtTons(currentSalt?.volume_tons)} and then trends ${trend(a.salt_volume_growth_qoq_pct || 0)}.`, `Derivative revenue starts near ${fmtRs(a.derivatives_revenue_start_mn)} and then trends ${trend(a.derivatives_growth_qoq_pct || 0)}.`, `Stress settings: freight ${a.freight_stress_bps || 0} bps, FX ${a.fx_stress_bps || 0} bps, power ${a.power_stress_bps || 0} bps, monsoon ${a.monsoon_stress_bps || 0} bps.`]; }
function subsidiaryScoreRows(rowsList) {
  const rawScore = (status) => /operating|ramping/i.test(status) ? 90 : /early commercial|initial commercial|trials/i.test(status) ? 70 : /under construction|approved|site execution/i.test(status) ? 60 : 40;
  const out = [];
  let idealisBucket = null;
  rowsList.forEach((r) => {
    if (/Idealis Chemicals Private Limited|Idealis Mudchemie Private Limited/i.test(r.name || "")) {
      if (!idealisBucket) {
        idealisBucket = {
          name: "Idealis mud chemicals platform",
          score: rawScore(r.status || ""),
        };
      } else {
        idealisBucket.score = Math.max(idealisBucket.score, rawScore(r.status || ""));
      }
      return;
    }
    out.push({ name: r.name, score: rawScore(r.status || "") });
  });
  if (idealisBucket) out.push(idealisBucket);
  return out;
}
function helperLine(cls, text) { return text && String(text).trim() ? `<p class="${cls}">${esc(text)}</p>` : ""; }
function head(t, s, d) { return `<div class="page-head"><p class="eyebrow">${esc(t)}</p><h3>${esc(s)}</h3>${helperLine("meta-copy", d)}</div>`; }
function card(t, v, n, s, c = "") {
  const density = valueDensityClass(v || "N/A");
  return `<div class="summary-card ${c} ${density}"><p class="subtle-label">${esc(t)}</p><div class="card-value">${esc(v || "N/A")}</div>${helperLine("card-caption", n)}${src(s)}</div>`;
}
function note(t, n, s) { return `<div class="note-card"><p class="subtle-label">Insight</p><h4>${esc(t)}</h4><p class="note-copy">${esc(n)}</p>${src(s)}</div>`; }
function chart(id, t, n, ss, c = false) { return `<div class="chart-card"><div class="chart-head"><div><p class="subtle-label">Chart</p><h4>${esc(t)}</h4>${helperLine("insight-copy", n)}</div><div class="source-inline-row">${(ss || []).map((s, i) => src(s, i === 0 ? "Source" : `Source ${i + 1}`)).join("")}</div></div><div class="chart-target ${c ? "is-compact" : ""}" id="${id}"></div></div>`; }
function mini(t, rs, k, v, sid, n = "") { return `<div class="table-card"><div class="table-head"><div><p class="subtle-label">Trade drill-down</p><h4>${esc(t)}</h4>${helperLine("table-copy", n)}</div>${src(sid)}</div><table><thead><tr><th>Country</th><th>Trade value (USD mn)</th><th>Unit value (USD/ton)</th></tr></thead><tbody>${rs.slice(0, 6).map((r) => `<tr><td>${esc(r[k])}</td><td>${esc(String(round(r[v] / 1000000, 2)))}</td><td>${esc(String(round(r.unit_value_usd_per_ton, 1)))}</td></tr>`).join("")}</tbody></table></div>`; }
function tableCard(t, n, cols, data, exp, table, html = false) { if (!data || !data.length) return ""; const dense = (table || exp) === "model_output" || cols.length >= 8; return `<section class="table-card ${dense ? "table-card--dense" : ""}"><div class="table-head"><div><p class="subtle-label">Table</p><h4>${esc(t)}</h4>${helperLine("table-copy", n)}</div><button class="export-button" type="button" data-export-table="${esc(table || exp)}">Export CSV</button></div><table><thead><tr>${cols.map(([x]) => `<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>${data.map((r) => `<tr>${cols.map(([, k]) => `<td>${html ? r[k] ?? "" : esc(r[k] == null ? "" : String(r[k]))}</td>`).join("")}</tr>`).join("")}</tbody></table></section>`; }
function controls() { return [["Bromine realization shift", "brominePriceShiftPct", -20, 20, 1, state.overrides.brominePriceShiftPct, "%"], ["Bromine volume shift", "bromineVolumeShiftPct", -20, 20, 1, state.overrides.bromineVolumeShiftPct, "%"], ["Salt realization shift", "saltPriceShiftPct", -10, 10, 1, state.overrides.saltPriceShiftPct, "%"], ["Salt volume shift", "saltVolumeShiftPct", -15, 15, 1, state.overrides.saltVolumeShiftPct, "%"], ["Derivative plant running level shift", "derivativeUtilShiftPct", -20, 30, 1, state.overrides.derivativeUtilShiftPct, "%"], ["Freight stress", "freightStressBps", -40, 160, 10, state.overrides.freightStressBps, "bps"], ["FX stress", "fxStressBps", -100, 100, 5, state.overrides.fxStressBps, "bps"], ["Power stress", "powerStressBps", -50, 120, 10, state.overrides.powerStressBps, "bps"], ["Monsoon stress", "monsoonStressBps", 0, 150, 10, state.overrides.monsoonStressBps, "bps"]].map(([l, k, min, max, step, val, u]) => `<label class="slider-row"><div class="slider-head"><span>${esc(l)}</span><strong>${esc(`${val}${u}`)}</strong></div><input type="range" min="${min}" max="${max}" step="${step}" value="${val}" data-control="${k}"></label>`).join(""); }
function scenario(t, v) { return `<div class="scenario-card ${valueDensityClass(v)}"><p class="subtle-label">${esc(t)}</p><div class="scenario-value">${esc(formatScenarioValue(v))}</div></div>`; }
function formatScenarioValue(v) { return String(v == null ? "N/A" : v).replace(/ /g, "\u00A0"); }
function src(id, label = "Source") { if (!id) return ""; if (id === "derived-model") return `<div class="source-slot"><button class="source-button is-derived" type="button" data-source-id="${esc(id)}" title="Derived model">${esc(label === "Source" ? "Model" : label)}</button></div>`; const s = state.sources.get(id); if (!s) return `<div class="source-slot"><span class="source-button is-disabled" title="${esc(id)}">${esc(label)}</span></div>`; return `<div class="source-slot"><button class="source-button" type="button" data-source-id="${esc(id)}" title="${esc(s.name)}">${esc(label)}</button></div>`; }
function sourceName(id) { if (id === "derived-model") return "Derived model"; return state.sources.get(id)?.name || id || "Unknown"; }
function sourcePrimaryUrl(meta) { return meta?.local_doc_url || meta?.local_text_url || meta?.url || ""; }
function bindSourceButtons() { document.querySelectorAll("[data-source-id]").forEach((b) => { b.onclick = () => openSourceModal(b.getAttribute("data-source-id")); }); }
function openSourceModal(sourceId) {
  if (!sourceId) return;
  if (sourceId === "derived-model") {
    dom.sourceModalTitle.textContent = "Derived Model";
    dom.sourceModalBody.innerHTML = `<div class="source-view-grid"><div class="source-view-card"><p class="subtle-label">Type</p><h4>Model output</h4><p class="note-copy">This number or chart is derived inside the dashboard from visible assumptions or reported inputs. It is not a direct company filing line item.</p></div></div>`;
    dom.sourceModal.classList.remove("is-hidden");
    dom.sourceModal.setAttribute("aria-hidden", "false");
    return;
  }
  const meta = state.sources.get(sourceId);
  const payload = meta || { id: sourceId, name: sourceId };
  const docButton = payload.local_doc_url ? `<a class="secondary-button" href="${esc(payload.local_doc_url)}" target="_blank" rel="noreferrer">Open cached document</a>` : "";
  const textButton = payload.local_text_url ? `<a class="secondary-button" href="${esc(payload.local_text_url)}" target="_blank" rel="noreferrer">Open cached text</a>` : "";
  const copyButton = payload.url ? `<button class="secondary-button" type="button" data-copy-source-url="${esc(payload.url)}">Copy original URL</button>` : "";
  const primaryUrl = sourcePrimaryUrl(payload);
  dom.sourceModalTitle.textContent = payload.name || "Source";
  dom.sourceModalBody.innerHTML = `
    <div class="source-view-grid">
      <div class="source-view-card">
        <p class="subtle-label">Source</p>
        <h4>${esc(payload.name || sourceId)}</h4>
        <p class="note-copy">${esc(payload.reporting_period || "Reporting period not available")}</p>
        <div class="tag-row">
          <span class="tag">${esc(payload.type || "Unknown type")}</span>
          <span class="tag">${esc(payload.published_date || "No published date")}</span>
          <span class="tag">${esc(`Fetched ${payload.fetch_date || "unknown"}`)}</span>
        </div>
      </div>
      <div class="source-view-card">
        <p class="subtle-label">Fields extracted</p>
        <ul class="bullet-list">${(payload.fields_extracted || []).map((item) => `<li>${esc(item)}</li>`).join("") || "<li>No extracted field list available.</li>"}</ul>
      </div>
    </div>
    <div class="source-view-actions">${docButton}${textButton}${copyButton}</div>
    ${primaryUrl ? `<div class="source-view-card"><p class="subtle-label">Original or cached link</p><p class="source-url">${esc(primaryUrl)}</p><p class="metric-footnote">${payload.local_doc_url || payload.local_text_url ? "Use the cached file above for static hosting compatibility." : "The original URL is shown for traceability."}</p></div>` : ""}
    ${payload.excerpt ? `<div class="source-view-card"><p class="subtle-label">Cached excerpt</p><pre class="pre-block source-excerpt">${esc(payload.excerpt)}</pre></div>` : `<div class="source-view-card"><p class="subtle-label">Cached excerpt</p><p class="note-copy">No local text excerpt is cached for this source yet.</p></div>`}
  `;
  dom.sourceModalBody.querySelectorAll("[data-copy-source-url]").forEach((btn) => btn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(btn.getAttribute("data-copy-source-url") || "");
      renderToolbar("Source URL copied.");
    } catch (e) {
      renderToolbar("Could not copy source URL.");
    }
  });
  dom.sourceModal.classList.remove("is-hidden");
  dom.sourceModal.setAttribute("aria-hidden", "false");
}
function closeSourceModal() {
  dom.sourceModal.classList.add("is-hidden");
  dom.sourceModal.setAttribute("aria-hidden", "true");
}
function kpiNote(l) { return { "Bromine volume": "Latest reported segment sales volume", "Bromine realization": "Revenue divided by segment tonnage", "Industrial salt volume": "Latest reported segment sales volume", "Industrial salt realization": "Revenue divided by segment tonnage", "Consolidated EBITDA margin": "Reported consolidated margin", "Acume plant running level": "Management commentary band", "Bromine backlog": "Transcript commentary", "India bromine trade position": "From customs trade flows" }[l] || ""; }
function add(id, option) { state.pending.push([id, option]); }
function exportCurrent() { exportName({ overview: "company_quarterly_financials", event: currentEvent()?.summary_table_name || "event_iran_israel_2026_current_summary", operations: "plant_asset_register", bromine: "company_segment_metrics", salt: "trade_salt_country", derivatives: "company_subsidiaries_and_investments", trade: "trade_bromine_country", costs: "model_output", "price-history": "company_quarterly_financials", forecast: "model_output", capex: "company_capex_projects" }[state.page] || "company_quarterly_financials"); }
function exportName(name) { const data = name === "source_registry" ? state.d.sourcesList : rows(name); if (!data.length) return renderToolbar("No exportable rows were available for this view."); const headers = unique(data.flatMap((r) => Object.keys(r))); const csv = [headers.join(","), ...data.map((r) => headers.map((h) => `"${String(r[h] == null ? "" : r[h]).replace(/"/g, '""')}"`).join(","))].join("\n"); const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `${name}.csv`; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url); renderToolbar(`Downloaded ${name}.csv`); }
function fail(e) { const m = e instanceof Error ? e.message : String(e); dom.brandCopy.textContent = "Dashboard load failed."; dom.heroTitle.textContent = "Dashboard payload unavailable"; dom.heroText.textContent = m; dom.toolbarStatus.textContent = "The canonical dashboard payload could not be loaded."; dom.pageContainer.innerHTML = `<article class="page-card"><div class="note-card"><p class="subtle-label">Load failure</p><h4>Canonical output missing or invalid</h4><p class="note-copy">${esc(m)}</p></div></article>`; }
function load(on, text) { if (text) dom.loadingText.textContent = text; dom.loadingMask.classList.toggle("is-hidden", !on); }
function base(source) { return { animationDuration: 420, textStyle: { fontFamily: "Aptos, Segoe UI, sans-serif", color: "#2b241d" }, grid: { top: 52, left: 56, right: 32, bottom: 48 }, tooltip: { trigger: "axis", backgroundColor: "rgba(255,252,246,0.98)", borderColor: "rgba(16,63,52,0.18)", textStyle: { color: "#2b241d" }, extraCssText: "box-shadow: 0 18px 45px rgba(79,61,40,0.18);", formatter(p) { const a = Array.isArray(p) ? p : [p], f = a[0] || {}; return `<strong>${f.axisValueLabel || f.name || ""}</strong><br>${a.map((x) => `${x.marker || ""}${x.seriesName}: ${formatSeriesValue(x.seriesName, x.value)}`).join("<br>")}<br><span style="color:#6e655c;font-size:12px;">Source: ${esc(sourceName(source))}</span>`; } }, xAxis: { axisLine: { lineStyle: { color: "rgba(43,36,29,0.18)" } }, axisLabel: { color: "#6e655c" } }, yAxis: { splitLine: { lineStyle: { color: "rgba(43,36,29,0.08)" } }, axisLabel: { color: "#6e655c" } } }; }
function bar(labels, data, name, color, source, horiz = false, opts = {}) { const b = base(source), valueAxis = { ...b.yAxis, type: "value", name: opts.valueAxisName || "", nameLocation: "middle", nameGap: opts.valueAxisName ? 42 : undefined, axisLabel: { ...b.yAxis.axisLabel, formatter(v) { return opts.valueFormatter ? opts.valueFormatter(v) : fmtChartCompact(v); } } }, categoryAxis = { ...b.xAxis, type: "category", data: labels, name: opts.categoryAxisName || "", nameLocation: "middle", nameGap: opts.categoryAxisName ? 32 : undefined, axisLabel: { ...b.xAxis.axisLabel, interval: 0, width: opts.categoryAxisWidth || (horiz ? 150 : 110), overflow: "break" } }, series = [{ name, type: "bar", data, label: { show: true, position: horiz ? "right" : "top", color: "#6e655c", formatter(p) { return opts.labelFormatter ? opts.labelFormatter(p.value, p) : fmtChartCompact(p.value); } }, itemStyle: { color, borderRadius: horiz ? [0, 8, 8, 0] : [8, 8, 0, 0] } }]; return horiz ? { ...b, grid: opts.grid || { top: 28, left: 190, right: 40, bottom: 44 }, xAxis: valueAxis, yAxis: categoryAxis, series } : { ...b, xAxis: categoryAxis, yAxis: valueAxis, series }; }
function line(labels, data, name, color, source) { const b = base(source); return { ...b, xAxis: { ...b.xAxis, type: "category", data: labels }, yAxis: { ...b.yAxis, type: "value" }, series: [{ name, type: "line", smooth: true, data, symbolSize: 8, lineStyle: { width: 3, color }, itemStyle: { color }, areaStyle: { color: "rgba(16,63,52,0.08)" } }] }; }
function combo(labels, bars, ln, source, lineName = "Realization (Rs/ton)") { const b = base(source); return { ...b, legend: { top: 8, textStyle: { color: "#6e655c" } }, xAxis: { ...b.xAxis, type: "category", data: labels }, yAxis: [{ ...b.yAxis, type: "value" }, { ...b.yAxis, type: "value" }], series: [{ name: "Revenue (Rs mn)", type: "bar", data: bars, itemStyle: { color: "#d39d52", borderRadius: [8, 8, 0, 0] } }, { name: lineName, type: "line", yAxisIndex: 1, smooth: true, data: ln, symbolSize: 8, lineStyle: { width: 3, color: "#103f34" }, itemStyle: { color: "#103f34" } }] }; }
function lines(labels, series, source) { const b = base(source), c = ["#103f34", "#a86916", "#42665d", "#8a3d25"]; return { ...b, legend: { top: 8, textStyle: { color: "#6e655c" } }, xAxis: { ...b.xAxis, type: "category", data: labels }, yAxis: [{ ...b.yAxis, type: "value" }, { ...b.yAxis, type: "value" }, { ...b.yAxis, type: "value", show: false }], series: series.map((s, i) => ({ ...s, type: "line", smooth: true, symbolSize: 7, yAxisIndex: s.yAxisIndex || 0, lineStyle: { width: 3, color: c[i % c.length] }, itemStyle: { color: c[i % c.length] } })) }; }
function pie(data, source) { return { ...base(source), tooltip: { trigger: "item", formatter(p) { return `<strong>${p.name}</strong><br>${p.value.toLocaleString()}<br>${p.percent}%<br><span style="color:#6e655c;font-size:12px;">Source: ${esc(sourceName(source))}</span>`; } }, legend: { bottom: 0, textStyle: { color: "#6e655c" } }, series: [{ type: "pie", radius: ["48%", "72%"], center: ["50%", "44%"], label: { color: "#2b241d", formatter: "{b}\n{d}%" }, data }] }; }
function stack(labels, stacks, names, colors, source, horiz = false, opts = {}) { const b = base(source), valueAxis = { ...b.yAxis, type: "value", name: opts.valueAxisName || "", nameLocation: "middle", nameGap: opts.valueAxisName ? 42 : undefined, axisLabel: { ...b.yAxis.axisLabel, formatter(v) { return opts.valueFormatter ? opts.valueFormatter(v) : fmtChartCompact(v); } } }, categoryAxis = { ...b.xAxis, type: "category", data: labels, name: opts.categoryAxisName || "", nameLocation: "middle", nameGap: opts.categoryAxisName ? 32 : undefined, axisLabel: { ...b.xAxis.axisLabel, interval: 0, width: opts.categoryAxisWidth || (horiz ? 150 : 110), overflow: "break" } }, series = stacks.map((d, i) => ({ name: names[i], type: "bar", stack: "t", data: d, label: { show: true, position: horiz ? "right" : "top", color: "#6e655c", formatter(p) { return opts.labelFormatter ? opts.labelFormatter(p.value, p) : (p.value ? fmtChartCompact(p.value) : ""); } }, itemStyle: { color: colors[i % colors.length], borderRadius: horiz ? [0, 8, 8, 0] : [6, 6, 0, 0] } })); return horiz ? { ...b, legend: { top: 8, textStyle: { color: "#6e655c" } }, grid: opts.grid || { top: 36, left: 190, right: 40, bottom: 44 }, xAxis: valueAxis, yAxis: categoryAxis, series } : { ...b, legend: { top: 8, textStyle: { color: "#6e655c" } }, xAxis: categoryAxis, yAxis: valueAxis, series }; }
function waterfall(rows, formula, source, opts = {}) {
  const labels = rows.map((r) => r.name), vals = rows.map((r) => r.value);
  let run = 0;
  const baseArr = [];
  rows.forEach((r) => { if (r.absolute) { baseArr.push(0); run = r.value; } else { baseArr.push(run); run += r.value; } });
  const b = base(source);
  return {
    ...b,
    grid: opts.grid || { top: 42, left: 60, right: 28, bottom: 72 },
    tooltip: {
      trigger: "axis",
      formatter(p) {
        const i = p[1]?.dataIndex ?? 0;
        const row = rows[i] || {};
        const valueLabel = row.absolute ? fmtRs(vals[i]) : fmtSignedRs(vals[i]);
        return `<strong>${esc(labels[i])}</strong><br>${esc(valueLabel)}<br><span style="color:#6e655c;font-size:12px;">${esc(formula)}</span><br><span style="color:#6e655c;font-size:12px;">Source: ${esc(sourceName(source))}</span>`;
      },
    },
    xAxis: {
      ...b.xAxis,
      type: "category",
      data: labels,
      name: opts.categoryAxisName || "",
      nameLocation: "middle",
      nameGap: opts.categoryAxisName ? 38 : undefined,
      axisLabel: {
        ...b.xAxis.axisLabel,
        interval: 0,
        width: 96,
        overflow: "break",
      },
    },
    yAxis: {
      ...b.yAxis,
      type: "value",
      name: opts.valueAxisName || "",
      nameLocation: "middle",
      nameGap: opts.valueAxisName ? 46 : undefined,
      axisLabel: {
        ...b.yAxis.axisLabel,
        formatter(v) { return fmtChartCompact(v); },
      },
    },
    series: [
      { type: "bar", stack: "t", itemStyle: { color: "transparent" }, data: baseArr },
      {
        type: "bar",
        stack: "t",
        data: vals,
        label: {
          show: true,
          position: "top",
          color: "#6e655c",
          formatter(p) {
            const row = rows[p.dataIndex] || {};
            return row.absolute ? fmtChartCompact(p.value) : (p.value > 0 ? "+" : "") + fmtChartCompact(p.value);
          },
        },
        itemStyle: {
          color(p) {
            const r = rows[p.dataIndex];
            return r.absolute ? "#103f34" : r.value >= 0 ? "#5d8b79" : "#8a3d25";
          },
          borderRadius: [8, 8, 0, 0],
        },
      },
    ],
  };
}
function impactBars(rows, source, opts = {}) {
  const labels = rows.map((r) => r.name);
  const vals = rows.map((r) => r.value);
  const b = base(source);
  return {
    ...b,
    grid: opts.grid || { top: 26, left: 170, right: 88, bottom: 52 },
    tooltip: {
      trigger: "axis",
      formatter(p) {
        const i = p[0]?.dataIndex ?? 0;
        return `<strong>${esc(labels[i] || "")}</strong><br>${esc(fmtSignedRs(vals[i]))}<br><span style="color:#6e655c;font-size:12px;">Source: ${esc(sourceName(source))}</span>`;
      },
    },
    xAxis: {
      ...b.xAxis,
      type: "value",
      splitNumber: 4,
      name: opts.valueAxisName || "",
      nameLocation: "middle",
      nameGap: opts.valueAxisName ? 46 : undefined,
      axisLabel: {
        ...b.xAxis.axisLabel,
        fontSize: 11,
        hideOverlap: true,
        margin: 12,
        formatter(v) { return fmtChartCompact(v); },
      },
    },
    yAxis: {
      ...b.yAxis,
      type: "category",
      data: labels,
      name: opts.categoryAxisName || "",
      nameLocation: "middle",
      nameGap: opts.categoryAxisName ? 126 : undefined,
      axisLabel: {
        ...b.yAxis.axisLabel,
        fontSize: 12,
        interval: 0,
        width: opts.categoryAxisWidth || 140,
        overflow: "break",
      },
    },
    series: [{
      type: "bar",
      data: vals,
      label: {
        show: true,
        position: "right",
        color: "#6e655c",
        fontSize: 12,
        distance: 8,
        formatter(p) { return fmtSignedRs(p.value); },
      },
      itemStyle: {
        color(p) { return p.value >= 0 ? "#5d8b79" : "#8a3d25"; },
        borderRadius: [0, 8, 8, 0],
      },
    }],
  };
}
function saltFreightSensitivity(data) {
  const volumeShifts = unique(data.map((r) => r.salt_volume_shift_pct)).sort((a, b) => a - b);
  const freightLevels = unique(data.map((r) => r.freight_bps)).sort((a, b) => a - b);
  const colors = ["#103f34", "#42665d", "#7b8f6b", "#d39d52", "#8a3d25"];
  const b = base("derived-model");
  return {
    ...b,
    legend: { top: 8, textStyle: { color: "#6e655c" } },
    grid: { top: 48, left: 56, right: 28, bottom: 54 },
    xAxis: {
      ...b.xAxis,
      type: "category",
      data: volumeShifts.map((v) => `${v > 0 ? "+" : ""}${v}%`),
      name: "Salt volume change",
      nameLocation: "middle",
      nameGap: 34,
    },
    yAxis: {
      ...b.yAxis,
      type: "value",
      name: "EBITDA (Rs mn)",
      nameLocation: "middle",
      nameGap: 48,
      axisLabel: {
        ...b.yAxis.axisLabel,
        formatter(v) { return fmtChartCompact(v); },
      },
    },
    tooltip: {
      trigger: "axis",
      formatter(p) {
        const items = Array.isArray(p) ? p : [p];
        const head = items[0]?.axisValueLabel || "";
        return `<strong>${esc(head)} salt volume change</strong><br>${items.map((item) => `${item.marker || ""}${esc(item.seriesName)}: ${esc(fmtRs(item.value))}`).join("<br>")}<br><span style="color:#6e655c;font-size:12px;">Source: ${esc(sourceName("derived-model"))}</span>`;
      },
    },
    series: freightLevels.map((bps, index) => ({
      name: bps === 0 ? "No freight rise" : `Freight +${bps} bps`,
      type: "line",
      smooth: false,
      symbolSize: 7,
      data: volumeShifts.map((shift) => data.find((row) => row.salt_volume_shift_pct === shift && row.freight_bps === bps)?.ebitda_mn ?? null),
      lineStyle: { width: 3, color: colors[index % colors.length] },
      itemStyle: { color: colors[index % colors.length] },
    })),
  };
  }
  function heat(data, x, y, v, xn, yn) { const xs = unique(data.map((r) => r[x])).sort((a, b) => a - b), ys = unique(data.map((r) => r[y])).sort((a, b) => a - b); return { ...base("derived-model"), tooltip: { position: "top", formatter(p) { return `${xn}: ${p.value[0]}<br>${yn}: ${p.value[1]}<br>EBITDA (Rs mn): ${p.value[2]}`; } }, grid: { top: 54, left: 70, right: 24, bottom: 54 }, xAxis: { type: "category", data: xs, name: xn, nameLocation: "middle", nameGap: 34 }, yAxis: { type: "category", data: ys, name: yn, nameLocation: "middle", nameGap: 48 }, visualMap: { min: Math.min(...data.map((r) => r[v])), max: Math.max(...data.map((r) => r[v])), calculable: true, orient: "horizontal", left: "center", bottom: 6 }, series: [{ type: "heatmap", data: data.map((r) => [r[x], r[y], r[v]]), label: { show: true, color: "#2b241d", formatter(p) { return round(p.value[2], 0); } } }] }; }
function bromineSensitivitySimple(data) {
  const realizationChanges = unique(data.map((r) => r.price_shift_pct)).sort((a, b) => a - b);
  const runningLevels = unique(data.map((r) => r.utilization_pct)).sort((a, b) => a - b);
  const colors = ["#8a3d25", "#a86916", "#42665d", "#103f34", "#0e2f28"];
  const b = base("derived-model");
  return {
    ...b,
    legend: { top: 8, textStyle: { color: "#6e655c" } },
    grid: { top: 48, left: 56, right: 28, bottom: 54 },
    xAxis: {
      ...b.xAxis,
      type: "category",
      data: realizationChanges.map((v) => `${v > 0 ? "+" : ""}${v}%`),
      name: "Bromine realization change",
      nameLocation: "middle",
      nameGap: 34,
    },
    yAxis: {
      ...b.yAxis,
      type: "value",
      name: "EBITDA (Rs mn)",
      nameLocation: "middle",
      nameGap: 48,
      axisLabel: {
        ...b.yAxis.axisLabel,
        formatter(v) { return fmtChartCompact(v); },
      },
    },
    tooltip: {
      trigger: "axis",
      formatter(p) {
        const items = Array.isArray(p) ? p : [p];
        const head = items[0]?.axisValueLabel || "";
        return `<strong>${esc(head)} bromine realization change</strong><br>${items.map((item) => `${item.marker || ""}${esc(item.seriesName)}: ${esc(fmtRs(item.value))}`).join("<br>")}<br><span style="color:#6e655c;font-size:12px;">Source: ${esc(sourceName("derived-model"))}</span>`;
      },
    },
    series: runningLevels.map((level, index) => ({
      name: `${level}% plant running`,
      type: "line",
      smooth: false,
      symbolSize: 7,
      data: realizationChanges.map((shift) => data.find((row) => row.price_shift_pct === shift && row.utilization_pct === level)?.ebitda_mn ?? null),
      lineStyle: { width: 3, color: colors[index % colors.length] },
      itemStyle: { color: colors[index % colors.length] },
    })),
  };
}
function band(labels, low, mid, high, source) { const b = base(source); return { ...b, legend: { top: 8 }, xAxis: { ...b.xAxis, type: "category", data: labels }, yAxis: { ...b.yAxis, type: "value" }, series: [{ name: "Low", type: "line", data: low, lineStyle: { opacity: 0 }, stack: "band", symbol: "none" }, { name: "Band", type: "line", data: high.map((x, i) => x - low[i]), lineStyle: { opacity: 0 }, areaStyle: { color: "rgba(16,63,52,0.12)" }, stack: "band", symbol: "none" }, { name: "Revenue (Rs mn)", type: "line", data: mid, smooth: true, symbolSize: 8, lineStyle: { width: 3, color: "#103f34" }, itemStyle: { color: "#103f34" } }] }; }

function unique(a) { return Array.from(new Set(a)); }
function sum(a) { return a.reduce((x, y) => x + (Number(y) || 0), 0); }
function round(v, d) { return v == null || Number.isNaN(Number(v)) ? null : Number(Number(v).toFixed(d)); }
function fmtDate(v) { if (!v) return "Unknown time"; const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v) : `${d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`; }
function fmtPct(v) { return v == null || Number.isNaN(Number(v)) ? "N/A" : `${round(v, 1)}%`; }
function fmtSignedPct(v) { return v == null || Number.isNaN(Number(v)) ? "N/A" : `${v > 0 ? "+" : ""}${round(v, 1)}%`; }
function fmtBps(v) { return v == null || Number.isNaN(Number(v)) ? "N/A" : `${v > 0 ? "+" : ""}${round(v, 0)} bps`; }
function fmtTons(v) { if (v == null || Number.isNaN(Number(v))) return "N/A"; if (Number(v) >= 1000000) return `${round(Number(v) / 1000000, 2)} mn tons`; return `${round(Number(v), 0).toLocaleString()} tons`; }
function fmtSignedTons(v) { return v == null || Number.isNaN(Number(v)) ? "N/A" : `${v > 0 ? "+" : ""}${Math.round(v).toLocaleString()} tons`; }
function fmtRs(v) { return v == null || Number.isNaN(Number(v)) ? "N/A" : `Rs ${round(Number(v), 1).toLocaleString()} mn`; }
function fmtRsTon(v) { return v == null || Number.isNaN(Number(v)) ? "N/A" : `Rs ${round(Number(v), 0).toLocaleString()}/ton`; }
function fmtSignedRs(v) { return v == null || Number.isNaN(Number(v)) ? "N/A" : `${v > 0 ? "+" : ""}Rs ${round(v, 0).toLocaleString()}`; }
function fmtChartCompact(v) { if (v == null || Number.isNaN(Number(v))) return "N/A"; const n = Number(v), abs = Math.abs(n); if (abs >= 1000000) return `${round(n / 1000000, 1)}m`; if (abs >= 10000) return `${round(n / 1000, 0)}k`; if (abs >= 1000) return Math.round(n).toLocaleString(); return Number.isInteger(n) ? String(n) : String(round(n, 1)); }
function fmtCompact(v) { if (v == null || Number.isNaN(Number(v))) return "N/A"; if (Number(v) >= 1000000) return String(round(Number(v) / 1000000, 2)); if (Number(v) >= 1000) return String(round(Number(v) / 1000, 1)); return String(v); }
function fmtKpi(v, u) { if (typeof v === "string") return u ? `${v} ${u}`.trim() : v; if (u === "tons") return fmtTons(v); if (u === "Rs/ton") return fmtRsTon(v); if (u === "%") return fmtPct(v); return v == null ? "N/A" : `${Number(v).toLocaleString()} ${u || ""}`.trim(); }
function formatSeriesValue(name, value) {
  if (value == null || Number.isNaN(Number(value))) return "N/A";
  const num = Number(value);
  const label = String(name || "").toLowerCase();
  if (label.includes("rs '000/ton")) return `${round(num, 1)}k Rs/ton`;
  if (label.includes("rs/ton")) return fmtRsTon(num);
  if (label.includes("usd/kg")) return `${round(num, 2).toLocaleString()} USD/kg`;
  if (label.includes("usd/ton")) return `${round(num, 1).toLocaleString()} USD/ton`;
  if (label.includes("usd mn")) return `${round(num, 1).toLocaleString()} USD mn`;
  if (label.includes("usd/bbl")) return `${round(num, 2).toLocaleString()} USD/bbl`;
  if (label.includes("margin") || label.includes("(%)") || label.includes("share of global")) return fmtPct(num);
  if (label.includes("bps")) return fmtBps(num);
  if (label.includes("tons")) return fmtTons(num);
  if (label.includes("revenue") || label.includes("ebitda") || label.includes("pat")) return fmtRs(num);
  if (label.includes("close price (rs)") || label.includes("share price")) return `Rs ${round(num, 2).toLocaleString()}`;
  return num.toLocaleString();
}
function esc(v) { return String(v == null ? "" : v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }




