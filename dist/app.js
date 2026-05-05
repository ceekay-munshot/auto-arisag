let dashboardData = null;
const state = {
  window: "5m",
  lens: "all",
  category: "TOTAL",
  fuel: "all",
  company: "all",
  companyMapFocus: null,
  newsGroup: "all",
  // Compact / roomy table density — flows into <body data-density=...> via
  // applyDensity, and is persisted in the URL hash.
  density: "comfortable",
  companyTrend: "all",
  // Companies overlaid on top of the spotlight chart so investors can read
  // peers (e.g. Maruti vs Tata vs M&M) on a single canvas. Stored as an
  // array of company names; primary is excluded by syncCompanyTrendCompare.
  companyTrendCompare: [],
  // When true, each line in the spotlight chart is rebased to 100 at its
  // first visible point. Required for peer comparison across very different
  // scales (e.g. Maruti ~200k/mo vs Atul ~1k/mo).
  companyTrendIndexed: false,
  registrationState: "all",
  registrationSegment: "PV",
  segmentShareView: "TOTAL",
  rawMaterialCompany: "Tata Motors",
  componentTrendCompany: "Maruti Suzuki",
  evCategory: "TOTAL",
  evPeriod: "M",
  evOemSegment: "E2W",
  oemSegment: "PV",
  liveOemPeriods: { PV: "M", CV: "M", "2W": "Q" },
  sorts: {},
  activeTab: "overview",
  creditPulseExplainerOpen: false,
  searchQuery: "",
  printAllTabs: false,
  companyMapShownCount: 3,
  compareToPriorCycle: false,
  launchFilterCompany: "all",
};

const SECTION_TO_TAB = {
  "section-what-changed": "overview",
  "section-retail": "retail-trend",
  "section-ev": "retail-ev",
  "section-ev-trend": "retail-ev",
  "section-ev-oem-tracker": "oem-tracker",
  "section-oem-tracker": "oem-tracker",
  "section-channel-pulse": "channel-pulse",
  "section-registration": "registration",
  "section-wholesale": "wholesale",
  "section-components": "components",
  "section-company-map": "companies",
  "company-drilldown": "companies",
  "section-recent-launches": "recent-launches",
};
const refreshState = {
  loading: false,
  message: "Reload the latest validated dashboard dataset.",
  tone: "neutral",
};
let pendingScrollTarget = null;

// Static calendar of Indian-auto-industry events to overlay on key time-series
// charts (lineChart's optional 5th param). Each entry: month YYYY-MM, label,
// and tone (festive | policy | milestone | macro). The chart only renders
// markers for events whose month falls within its visible range — older
// events automatically drop off as data scrolls.
const CHART_EVENT_CALENDAR = [
  { month: "2023-04", label: "BS-VI Phase II emissions kicks in", tone: "policy" },
  { month: "2024-10", label: "Diwali 2024 (Oct 31) — peak festive month", tone: "festive" },
  { month: "2024-10", label: "Hyundai Motor India IPO lists on NSE", tone: "milestone" },
  { month: "2025-04", label: "EV PLI & PMP localisation ramp", tone: "policy" },
  { month: "2025-10", label: "Diwali 2025 (Oct 20) — peak festive month", tone: "festive" },
  { month: "2025-11", label: "Tata Motors demerger: TMPV + TMCV listed", tone: "milestone" },
  { month: "2026-04", label: "RBI repo cut −25 bps (MPC, Apr 2026)", tone: "macro" },
  { month: "2026-11", label: "Diwali 2026 (Nov 8) — peak festive month", tone: "festive" },
];

// Build the event list to overlay on a chart. Combines the static calendar
// with earnings-calendar dates pulled from dashboardData (aggregated to month
// granularity since charts are monthly). When a `company` filter is passed,
// only that company's earnings dates are surfaced — used by the spotlight
// chart so the marker actually correlates with the line on the page.
function buildChartEvents({ company = null } = {}) {
  const events = [...CHART_EVENT_CALENDAR];
  const ec = dashboardData?.earnings_calendar;
  if (ec?.available) {
    const allDates = [
      ...asArray(ec.upcoming_all),
      ...asArray(ec.recent_past),
    ];
    const filtered = company
      ? allDates.filter((item) => item.company === company)
      : allDates;
    // Group by month so we surface one chip per month even when several
    // OEMs report on consecutive days. Charts can only render at month
    // granularity; bunching is the honest representation.
    const byMonth = new Map();
    filtered.forEach((item) => {
      const month = `${item.date || ""}`.slice(0, 7);
      if (!month) return;
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(item.company);
    });
    byMonth.forEach((companies, month) => {
      const unique = [...new Set(companies)];
      const label = unique.length === 1
        ? `${unique[0]} earnings`
        : unique.length <= 3
          ? `${unique.join(", ")} earnings`
          : `${unique.length} OEM earnings (${unique.slice(0, 2).join(", ")}, …)`;
      events.push({ month, label, tone: "earnings" });
    });
  }
  return events;
}

// Plain-English explainers attached to metric elements via data-explain="<key>".
// Each entry maps to {title, body} surfaced by the global hover tooltip
// (setupExplainerTooltips). New metrics: just add a key here and slap
// data-explain on the rendered element — no other wiring needed.
const METRIC_EXPLAINERS = {
  // Hero summary cards
  "summary.latest_retail": {
    title: "Latest retail registrations",
    body: "Total vehicles registered with RTOs across India this month, as reported by FADA dealer associations. The cleanest measure of actual buyer demand — captured at the dealership counter, not at the factory gate.",
  },
  "summary.latest_ev_penetration": {
    title: "Derived EV penetration",
    body: "Electric vehicles as a share of total monthly retail registrations, computed across all categories. Tracks how fast India is electrifying the road — moves slowly month-to-month, faster across years.",
  },
  "summary.strongest_segment": {
    title: "Strongest category this month",
    body: "The retail category (PV / 2W / 3W / CV / Tractor / CE) with the highest YoY growth this month. Tells you where demand momentum is concentrated right now.",
  },
  "summary.pv_inventory": {
    title: "PV dealer inventory",
    body: "Days of unsold passenger-vehicle stock at dealer lots, as reported by FADA. Healthy band is 21–30 days. Above 35 = destocking pressure on OEMs and risk of discounting; below 20 = lean stock that limits ability to capture demand spikes.",
  },
  "summary.pv_retail_vs_wholesale": {
    title: "PV retail vs wholesale",
    body: "Ratio of FADA retail (consumer purchases) to SIAM wholesale (factory dispatches to dealers). Below 95% = wholesale outpacing retail = channel inventory building. Above 105% = drawdown / clean restock.",
  },
  "summary.dealer_outlook": {
    title: "Dealer growth view",
    body: "FADA's monthly survey of how dealers expect the next month's demand to evolve. A leading sentiment indicator captured at the front lines of the auto retail channel.",
  },

  // Insights ribbon
  "ribbon.demand_winner": {
    title: "Demand winner",
    body: "The category with the highest YoY growth this month from FADA's retail data. Identifies which segment is leading the cycle.",
  },
  "ribbon.demand_laggard": {
    title: "Demand laggard",
    body: "The slowest-growing category this month. Negative readings flag potential structural weakness if they persist for 2-3 months in a row.",
  },
  "ribbon.ev_penetration": {
    title: "EV penetration trend",
    body: "Latest overall EV share of retail registrations, plus the change in percentage points over the last 6 months. Captures whether electrification is accelerating, plateauing, or reversing.",
  },
  "ribbon.credit_pulse": {
    title: "Auto-credit pulse",
    body: "Spread between vehicle-loan YoY growth and total bank-credit YoY growth (RBI). Positive ≥ +1pp = banks lending to auto faster than the rest of the economy = bullish demand. Negative ≤ -1pp = bearish.",
  },
  "ribbon.dealer_inventory": {
    title: "Dealer inventory health",
    body: "FADA-reported PV inventory at dealer lots. 21-30 days = healthy operating band. >35 = elevated, requires destocking. <20 = lean, limited ability to satisfy spikes.",
  },
  "ribbon.channel_balance": {
    title: "PV channel balance",
    body: "Retail/wholesale ratio for passenger vehicles. The ratio tells you whether dealers are selling faster than factories ship (clean drawdown) or slower (inventory build).",
  },

  // Credit Pulse tab
  "credit.outstanding": {
    title: "Vehicle Loans outstanding",
    body: "Total amount India's scheduled commercial banks have lent for vehicle purchases as of the last reporting Friday of the month. From RBI's Sectoral Deployment of Bank Credit release.",
  },
  "credit.yoy": {
    title: "Vehicle loans YoY",
    body: "Year-on-year growth rate in outstanding vehicle loans, as printed by RBI in the Sectoral Deployment release.",
  },
  "credit.spread": {
    title: "Credit spread (vehicle vs total)",
    body: "Difference in YoY growth rates between vehicle loans and total bank lending. Positive = auto credit running hotter than the broader economy = bullish demand signal. Negative = lagging.",
  },
  "credit.share": {
    title: "Auto's share of total bank lending",
    body: "Vehicle loans as a percentage of total non-food bank credit. Historically sits between 3% and 4%. Drift higher = banks getting more 'auto-heavy'; drift lower = auto losing share to other lending segments.",
  },

  // Components / ACMA
  "components.industry_turnover": {
    title: "Auto-component industry turnover",
    body: "Total value of components produced by India's auto-component industry over the period. Captures the back-end of the auto ecosystem feeding OEMs domestically and exports globally.",
  },
  "components.oem_supplies": {
    title: "OEM supplies",
    body: "Component value sold to OEMs (vehicle manufacturers) — tracks how well component-makers are riding the OEM demand cycle.",
  },
  "components.exports": {
    title: "Auto-component exports",
    body: "USD value of components shipped overseas. North America and Europe are the largest markets. Reflects India's competitiveness in the global auto supply chain.",
  },
  "components.aftermarket": {
    title: "Aftermarket sales",
    body: "Component sales to the replacement / repair / accessory market. Driven by the on-road vehicle parc, formalisation of repair, and e-commerce channels.",
  },

  // Macro overlay strip
  "macro.petrol_delhi": {
    title: "Petrol price (Delhi)",
    body: "Daily retail selling price set by oil marketing companies. Direct driver of fuel-affordability for ICE 2W and PV demand. Price spikes typically dent 2W retail growth within 2 months.",
  },
  "macro.diesel_delhi": {
    title: "Diesel price (Delhi)",
    body: "Daily retail selling price for diesel — fuel for ~70% of CV demand. Price changes ripple into freight rates and CV operator economics within 4-6 weeks.",
  },
  "macro.repo_rate": {
    title: "RBI repo rate",
    body: "The benchmark interest rate the RBI charges banks. Direct driver of vehicle-loan EMI. Each 25-bps cut typically lowers EMI on a ₹10-lakh PV loan by ₹150-200/month within 2-3 cycles.",
  },
  "macro.usd_inr": {
    title: "USD / INR",
    body: "Spot exchange rate. INR weakening = imported components (lithium cells, semiconductors, ECUs) get more expensive. Pressures EV BOM and premium-PV margins.",
  },

  // Festive Pulse
  "festive.window_total": {
    title: "Festive window total",
    body: "Aggregate vehicle retail registrations during the Sep–Nov festive months — captures Onam through Diwali. The single most important demand window for Indian auto each year.",
  },
  "festive.peak_yoy": {
    title: "Peak festive month YoY",
    body: "Year-on-year retail change for the strongest festive month (typically October when Dhanteras/Diwali fall). FADA's pre-computed YoY% printed in the monthly press release.",
  },

  // Wholesale / SIAM
  "wholesale.production_total": {
    title: "Total production",
    body: "Total monthly vehicle production by SIAM-member OEMs, summed across PV, 2W, 3W, CV. Factory-end view of supply.",
  },
  "wholesale.domestic_total": {
    title: "Domestic dispatches",
    body: "Vehicles dispatched from factory to domestic dealers in the month. Lags retail by ~2-3 weeks; the gap to retail signals inventory building or drawdown.",
  },
};
const downloadRegistry = new Map();
let tooltipNode = null;

async function loadDashboard() {
  const response = await fetch(`data/investor_dashboard.json?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load dashboard data: ${response.status}`);
  }
  const payload = await response.json();
  return normalizePayload(payload);
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Refresh failed: ${response.status}`);
  }
}

async function triggerRefresh() {
  if (refreshState.loading) {
    return;
  }

  const startedAt = Date.now();
  const isLocalRuntime = ["127.0.0.1", "localhost"].includes(window.location.hostname);
  refreshState.loading = true;
  refreshState.message = isLocalRuntime
    ? "Refreshing validated data and rebuilding the dashboard..."
    : "Refreshing the latest published dashboard snapshot...";
  refreshState.tone = "neutral";
  render();

  try {
    let refreshedPayload = null;
    let generatedAt = null;

    if (isLocalRuntime) {
      const response = await fetch("refresh", {
        method: "POST",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const result = await parseJsonResponse(response);
      if (response.ok && result?.ok && result.payload) {
        refreshedPayload = result.payload;
        generatedAt = result.generated_at || result.payload.generated_at;
        refreshState.message = buildRefreshMessage(generatedAt, result.source_updates);
      }
    }

    if (!refreshedPayload) {
      refreshedPayload = await loadDashboard();
      generatedAt = refreshedPayload.generated_at;
      refreshState.message = isLocalRuntime
        ? `Refreshed ${formatTimestamp(generatedAt)}`
        : `Reloaded latest published snapshot from ${formatTimestamp(generatedAt)}`;
    }

    dashboardData = normalizePayload(refreshedPayload);
    refreshState.tone = "positive";
  } catch (error) {
    refreshState.message = error.message || "Refresh failed.";
    refreshState.tone = "negative";
  } finally {
    const elapsed = Date.now() - startedAt;
    if (elapsed < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 1000 - elapsed));
    }
    refreshState.loading = false;
    render();
  }
}

function buildRefreshMessage(generatedAt, sourceUpdates) {
  const updates = asArray(sourceUpdates);
  if (!updates.length) {
    return `Refreshed ${formatTimestamp(generatedAt)}`;
  }

  const updatedCount = updates.filter((item) => item.updated).length;
  const warningCount = updates.filter((item) => item.status === "warning").length;
  const updatedLabels = updates
    .filter((item) => item.updated)
    .map((item) => item.source)
    .join(", ");

  if (updatedCount) {
    const warningText = warningCount ? `, ${warningCount} retained on validated fallback` : "";
    return `Refreshed ${formatTimestamp(generatedAt)}. Updated ${updatedCount} source${updatedCount > 1 ? "s" : ""}${updatedLabels ? `: ${updatedLabels}` : ""}${warningText}.`;
  }

  if (warningCount) {
    return `Refreshed ${formatTimestamp(generatedAt)}. No new validated source data was applied; ${warningCount} source${warningCount > 1 ? "s are" : " is"} on validated fallback.`;
  }

  return `Refreshed ${formatTimestamp(generatedAt)}. Sources checked with no newer validated data.`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizePayload(payload) {
  const normalized = asObject(payload);
  normalized.summary = asObject(normalized.summary);
  normalized.filters = asObject(normalized.filters);
  normalized.modules = asObject(normalized.modules);
  normalized.chart_colors = asObject(normalized.chart_colors);

  normalized.summary.cards = asArray(normalized.summary.cards);
  normalized.summary.source_badges = asArray(normalized.summary.source_badges);
  normalized.summary.hidden_modules = asArray(normalized.summary.hidden_modules);
  normalized.qa = asArray(normalized.qa);

  normalized.filters.categories = asArray(normalized.filters.categories);
  normalized.filters.window_options = asArray(normalized.filters.window_options);
  normalized.filters.lenses = asArray(normalized.filters.lenses);
  normalized.filters.fuels = asArray(normalized.filters.fuels);
  normalized.filters.companies = asArray(normalized.filters.companies);
  normalized.filters.months = asArray(normalized.filters.months);

  normalized.company_map = asArray(normalized.company_map).map((item) => {
    const normalizedItem = asObject(item);
    normalizedItem.categories = asArray(normalizedItem.categories);
    normalizedItem.category_labels = asArray(normalizedItem.category_labels);
    normalizedItem.revenue_table = asObject(normalizedItem.revenue_table);
    normalizedItem.revenue_table.years = asArray(normalizedItem.revenue_table.years);
    normalizedItem.revenue_table.rows = asArray(normalizedItem.revenue_table.rows);
    return normalizedItem;
  });
  normalized.insights = asArray(normalized.insights);
  normalized.news = asObject(normalized.news);
  normalized.news.groups = asArray(normalized.news.groups);
  normalized.news.sources_live = asArray(normalized.news.sources_live);
  normalized.news.audit = asObject(normalized.news.audit);
  normalized.news.groups = normalized.news.groups.map((group) => {
    const normalizedGroup = asObject(group);
    normalizedGroup.items = asArray(normalizedGroup.items);
    return normalizedGroup;
  });

  const retail = asObject(normalized.modules.retail);
  retail.months = asArray(retail.months);
  retail.category_cards = asArray(retail.category_cards);
  retail.latest_mix = asArray(retail.latest_mix);
  retail.ev_penetration_series = asArray(retail.ev_penetration_series);
  retail.fuel_mix_latest = asArray(retail.fuel_mix_latest);
  retail.inventory_trend = asArray(retail.inventory_trend);
  retail.dealer_expectation_trend = asArray(retail.dealer_expectation_trend);
  retail.latest_oem_tables = asObject(retail.latest_oem_tables);
  retail.latest_subsegments = asObject(retail.latest_subsegments);
  retail.company_unit_trends = asArray(retail.company_unit_trends);
  ["PV", "2W", "3W", "CV", "TRACTOR", "CE"].forEach((category) => {
    const table = asObject(retail.latest_oem_tables[category]);
    table.rows = asArray(table.rows);
    table.periods = asObject(table.periods);
    ["M", "Q", "Y"].forEach((period) => {
      const periodBlock = asObject(table.periods[period]);
      periodBlock.rows = asArray(periodBlock.rows);
      periodBlock.columns = asArray(periodBlock.columns);
      table.periods[period] = periodBlock;
    });
    table.source_meta = asObject(table.source_meta);
    retail.latest_oem_tables[category] = table;
    retail.latest_subsegments[category] = asArray(retail.latest_subsegments[category]);
  });
  retail.latest_channel_pulse = asObject(retail.latest_channel_pulse);
  retail.latest_channel_pulse.urban_rural_growth = asArray(retail.latest_channel_pulse.urban_rural_growth);
  retail.latest_channel_pulse.bullets = asArray(retail.latest_channel_pulse.bullets);
  retail.latest_snapshot = asObject(retail.latest_snapshot);
  retail.source_meta = asObject(retail.source_meta);
  normalized.modules.retail = retail;

  const registration = asObject(normalized.modules.registration);
  registration.months = asArray(registration.months);
  registration.top_makers = asArray(registration.top_makers);
  registration.source_meta = asObject(registration.source_meta);
  normalized.modules.registration = registration;

  const stateRegistration = asObject(normalized.modules.state_registration);
  stateRegistration.states = asArray(stateRegistration.states).map((item) => {
    const normalizedItem = asObject(item);
    normalizedItem.segments = asArray(normalizedItem.segments).map((segment) => {
      const normalizedSegment = asObject(segment);
      normalizedSegment.series = asArray(normalizedSegment.series);
      return normalizedSegment;
    });
    return normalizedItem;
  });
  stateRegistration.segments = asArray(stateRegistration.segments);
  stateRegistration.source_meta = asObject(stateRegistration.source_meta);
  normalized.modules.state_registration = stateRegistration;

  const segmentShare = asObject(normalized.modules.segment_share);
  segmentShare.options = asArray(segmentShare.options).map((option) => {
    const normalizedOption = asObject(option);
    normalizedOption.rows = asArray(normalizedOption.rows);
    return normalizedOption;
  });
  segmentShare.table_years = asArray(segmentShare.table_years);
  segmentShare.trend_years = asArray(segmentShare.trend_years);
  segmentShare.source_meta = asObject(segmentShare.source_meta);
  normalized.modules.segment_share = segmentShare;

  const officialEv = asObject(normalized.modules.official_ev);
  officialEv.norms_preview = asArray(officialEv.norms_preview);
  officialEv.category_preview = asArray(officialEv.category_preview);
  officialEv.links = asArray(officialEv.links);
  officialEv.source_meta = asObject(officialEv.source_meta);
  normalized.modules.official_ev = officialEv;

  const wholesale = asObject(normalized.modules.wholesale);
  wholesale.months = asArray(wholesale.months);
  wholesale.retail_vs_wholesale = asArray(wholesale.retail_vs_wholesale);
  wholesale.latest_snapshot = asObject(wholesale.latest_snapshot);
  wholesale.latest_snapshot.domestic_sales = asArray(wholesale.latest_snapshot.domestic_sales);
  wholesale.quarter_summary = asObject(wholesale.quarter_summary);
  wholesale.quarter_summary.domestic_sales = asObject(wholesale.quarter_summary.domestic_sales);
  wholesale.calendar_year_summary = asObject(wholesale.calendar_year_summary);
  wholesale.calendar_year_summary.domestic_sales = asObject(wholesale.calendar_year_summary.domestic_sales);
  wholesale.source_meta = asObject(wholesale.source_meta);
  normalized.modules.wholesale = wholesale;

  const components = asObject(normalized.modules.components);
  components.metrics = asArray(components.metrics);
  components.insights = asArray(components.insights);
  components.listed_beneficiaries = asArray(components.listed_beneficiaries);
  components.source_meta = asObject(components.source_meta);
  components.raw_material_prices = asObject(components.raw_material_prices);
  components.raw_material_prices.materials = asArray(components.raw_material_prices.materials).map((item) => {
    const normalizedItem = asObject(item);
    normalizedItem.series = asArray(normalizedItem.series);
    return normalizedItem;
  });
  components.raw_material_prices.companies = asArray(components.raw_material_prices.companies).map((item) => {
    const normalizedItem = asObject(item);
    normalizedItem.materials = asArray(normalizedItem.materials).map((material) => {
      const normalizedMaterial = asObject(material);
      normalizedMaterial.series = asArray(normalizedMaterial.series);
      return normalizedMaterial;
    });
    normalizedItem.category_labels = asArray(normalizedItem.category_labels);
    return normalizedItem;
  });
  components.raw_material_prices.source_meta = asObject(components.raw_material_prices.source_meta);
  components.company_segment_trends = asObject(components.company_segment_trends);
  components.company_segment_trends.companies = asArray(components.company_segment_trends.companies).map((item) => {
    const normalizedItem = asObject(item);
    normalizedItem.segments = asArray(normalizedItem.segments).map((segment) => {
      const normalizedSegment = asObject(segment);
      normalizedSegment.series = asArray(normalizedSegment.series);
      return normalizedSegment;
    });
    normalizedItem.sources = asArray(normalizedItem.sources);
    return normalizedItem;
  });
  components.company_segment_trends.source_meta = asObject(components.company_segment_trends.source_meta);
  normalized.modules.components = components;

  return normalized;
}

function formatTimestamp(iso) {
  return new Date(iso).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatUnits(value) {
  return Number(value || 0).toLocaleString("en-IN");
}

function formatSigned(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n.m.";
  }
  return `${value >= 0 ? "+" : ""}${Number(value).toFixed(digits)}%`;
}

function formatPct(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n.m.";
  }
  return `${Number(value).toFixed(digits)}%`;
}

function formatLakh(value) {
  return `${(Number(value || 0) / 100000).toFixed(2)} lakh`;
}

function axisFormat(value) {
  const number = Number(value || 0);
  if (number >= 100000) {
    return `${(number / 100000).toFixed(1)}L`;
  }
  if (number >= 1000) {
    return `${(number / 1000).toFixed(0)}K`;
  }
  return `${number}`;
}

function chip(text, tone = "default") {
  return `<span class="pill ${tone}">${text}</span>`;
}

function renderSourceAction(url, label = "Source") {
  if (!url) {
    return "";
  }
  const safeLabel = String(label || "Source").replace(/"/g, "&quot;");
  return `<a class="source-icon" href="${url}" target="_blank" rel="noreferrer" title="${safeLabel}" aria-label="Open ${safeLabel.toLowerCase()} in new tab">
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M14 4h6v6"></path>
      <path d="M20 4 10 14"></path>
      <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"></path>
    </svg>
  </a>`;
}

function renderSourceActions(items = []) {
  return asArray(items)
    .filter((item) => item?.url)
    .map((item) => renderSourceAction(item.url, item.label || "Source"))
    .join("");
}

function renderDownloadIcon(downloadKey, label = "Download Excel") {
  if (!downloadKey) {
    return "";
  }
  const safeKey = String(downloadKey).replace(/"/g, "&quot;");
  const safeLabel = String(label).replace(/"/g, "&quot;");
  return `<button type="button" class="download-icon" data-download-key="${safeKey}" title="${safeLabel}" aria-label="${safeLabel}">
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3v12"></path>
      <path d="m7 10 5 5 5-5"></path>
      <path d="M5 21h14"></path>
    </svg>
  </button>`;
}

// Standalone PNG-export icon. Injected automatically by setupPngExports
// into every chart card that already exposes a CSV download icon, so the
// Excel + PNG buttons sit side-by-side. Self-contained markup so the
// injection logic stays a one-liner.
const PNG_ICON_HTML = `<button type="button" class="download-icon download-icon-png" data-action="download-png" title="Download chart as PNG" aria-label="Download chart as PNG">
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2.5"></rect>
    <circle cx="9" cy="10" r="1.6" fill="currentColor" stroke="none"></circle>
    <path d="m21 16-5-5-7 7"></path>
  </svg>
</button>`;

function summarySourceUrl(cardId) {
  const retailUrl = dashboardData.modules.retail?.source_meta?.url;
  const wholesaleUrl = dashboardData.modules.wholesale?.source_meta?.url;
  const componentsUrl = dashboardData.modules.components?.source_meta?.url;

  if (["latest_retail", "latest_ev_penetration", "strongest_segment", "pv_inventory", "dealer_outlook"].includes(cardId)) {
    return retailUrl;
  }
  if (cardId === "pv_retail_vs_wholesale") {
    return wholesaleUrl || retailUrl;
  }
  return componentsUrl || retailUrl || wholesaleUrl;
}

function companyDetails() {
  return asArray(dashboardData.company_map).find((item) => item.company === state.company);
}

function companyCategoryIds(company) {
  const validCategories = new Set(asArray(dashboardData.filters.categories).map((item) => item.id));
  return asArray(company?.categories).filter((item) => validCategories.has(item));
}

function allowedCategories() {
  if (state.category === "EV") {
    return asArray(dashboardData.filters.categories)
      .map((item) => item.id)
      .filter((item) => !["TOTAL", "EV"].includes(item));
  }
  if (state.category !== "TOTAL") {
    return [state.category];
  }
  if (state.company === "all") {
    return asArray(dashboardData.filters.categories).map((item) => item.id);
  }
  const details = companyDetails();
  if (!details) {
    return asArray(dashboardData.filters.categories).map((item) => item.id);
  }
  const companyCategories = asArray(details.categories).filter((item) => asArray(dashboardData.filters.categories).some((entry) => entry.id === item));
  return companyCategories.length ? ["TOTAL", ...companyCategories] : ["TOTAL"];
}

function availableCategoryOptions() {
  const categories = asArray(dashboardData.filters.categories);
  const baseCategories = categories.filter((item) => item.id !== "TOTAL");
  const standardCategories = baseCategories.filter((item) => item.id !== "EV");
  let allowedIds = baseCategories.map((item) => item.id);

  if (state.lens === "wholesale") {
    const wholesaleIds = new Set();
    asArray(dashboardData.modules.wholesale?.months).forEach((month) => {
      asArray(month.domestic_sales).forEach((item) => wholesaleIds.add(item.category));
    });
    allowedIds = standardCategories.map((item) => item.id).filter((item) => wholesaleIds.has(item));
  } else if (state.lens === "ev") {
    const evIds = new Set();
    const firstEvMonth = asArray(dashboardData.modules.retail?.ev_penetration_series)[0];
    asArray(firstEvMonth?.by_category).forEach((item) => evIds.add(item.category));
    allowedIds = ["EV", ...standardCategories.map((item) => item.id).filter((item) => evIds.has(item))];
  } else if (state.lens === "components") {
    return [];
  } else {
    allowedIds = [...standardCategories.map((item) => item.id), "EV"];
  }

  if (state.company !== "all") {
    const details = companyDetails();
    const companyIds = companyCategoryIds(details);
    const evEligible = asArray(details?.lens).includes("ev") || companyIds.includes("EV_SUPPLY");
    if (companyIds.length || evEligible) {
      allowedIds = allowedIds.filter((item) => {
        if (item === "EV") {
          return evEligible;
        }
        return companyIds.includes(item);
      });
    } else {
      return [];
    }
  }

  const filtered = baseCategories.filter((item) => allowedIds.includes(item.id));
  return filtered.length ? [categories[0], ...filtered] : [];
}

function availableFuelOptions() {
  if (!(state.lens === "all" || state.lens === "ev")) {
    return [];
  }

  const categoryFilter = activeCategoryFilter();

  const categoryIds = new Set(
    availableCategoryOptions()
      .map((item) => item.id)
      .filter((item) => item !== "TOTAL" && item !== "EV"),
  );

  const visibleCategories = asArray(dashboardData.modules.retail?.fuel_mix_latest).filter((item) => {
    if (!categoryIds.size) {
      return false;
    }
    if (categoryFilter !== "TOTAL") {
      return item.category === categoryFilter;
    }
    return categoryIds.has(item.category);
  });

  const fuelIds = new Set();
  visibleCategories.forEach((category) => {
    asArray(category.fuels).forEach((fuel) => fuelIds.add(fuel.fuel));
  });

  return asArray(dashboardData.filters.fuels).filter((fuel) => fuelIds.has(fuel.id));
}

function availableCompanyOptions() {
  return asArray(dashboardData.filters.companies).filter((company) => {
    const lenses = asArray(company.lens);
    const categoryIds = companyCategoryIds(company);
    const lensMatch = state.lens === "all"
      ? true
      : state.lens === "ev"
        ? lenses.includes("ev") || lenses.includes("components")
        : lenses.includes(state.lens);

    if (!lensMatch) {
      return false;
    }

    if (state.category === "EV") {
      return lenses.includes("ev") || asArray(company.categories).includes("EV_SUPPLY");
    }
    if (state.category !== "TOTAL") {
      return asArray(company.categories).includes(state.category);
    }
    if (state.lens === "components") {
      return lenses.includes("components");
    }
    if (state.lens === "wholesale") {
      return lenses.includes("wholesale");
    }
    if (state.lens === "ev") {
      return lenses.includes("ev") || asArray(company.categories).includes("EV_SUPPLY") || categoryIds.length > 0;
    }
    return categoryIds.length > 0 || lenses.includes("components") || lenses.includes("ev");
  });
}

function syncStateToAvailableOptions() {
  const lensIds = asArray(dashboardData.filters.lenses).map((item) => item.id);
  if (!lensIds.includes(state.lens)) {
    state.lens = "all";
  }

  for (let index = 0; index < 3; index += 1) {
    const categoryOptions = availableCategoryOptions();
    if (categoryOptions.length) {
      if (!categoryOptions.some((item) => item.id === state.category)) {
        state.category = "TOTAL";
      }
    } else {
      state.category = "TOTAL";
    }

    const companyOptions = availableCompanyOptions();
    if (!companyOptions.some((item) => item.id === state.company)) {
      state.company = "all";
    }

    const fuelOptions = availableFuelOptions();
    if (!fuelOptions.some((item) => item.id === state.fuel)) {
      state.fuel = "all";
    }
  }
}

function syncNewsGroup() {
  const groups = asArray(dashboardData.news?.groups);
  if (!groups.length) {
    state.newsGroup = "all";
    return;
  }

  const validIds = groups.map((group) => group.id);
  if (state.newsGroup !== "all" && !validIds.includes(state.newsGroup)) {
    state.newsGroup = groups[0].id;
  }
}

function syncCompanyTrend() {
  const trends = asArray(dashboardData.modules.retail?.company_unit_trends);
  if (!trends.length) {
    state.companyTrend = "all";
    return;
  }

  const validIds = trends.map((item) => item.company);
  if (state.company !== "all" && validIds.includes(state.company)) {
    state.companyTrend = state.company;
    return;
  }

  if (state.companyTrend === "all" || !validIds.includes(state.companyTrend)) {
    state.companyTrend = trends[0].company;
  }
}

function syncCompanyTrendCompare() {
  const trends = asArray(dashboardData.modules.retail?.company_unit_trends);
  if (!trends.length) {
    state.companyTrendCompare = [];
    return;
  }
  const valid = new Set(trends.map((item) => item.company));
  state.companyTrendCompare = state.companyTrendCompare
    .filter((name) => valid.has(name) && name !== state.companyTrend);
}

function syncCompanyMapFocus() {
  const companies = asArray(dashboardData.company_map).map((item) => item.company);
  if (!companies.length) {
    state.companyMapFocus = null;
    return;
  }
  if (state.company !== "all" && companies.includes(state.company)) {
    state.companyMapFocus = state.company;
    return;
  }
  if (!state.companyMapFocus || !companies.includes(state.companyMapFocus)) {
    state.companyMapFocus = companies[0];
  }
}

function syncStateRegistrationExplorer() {
  const module = asObject(dashboardData.modules.state_registration);
  const states = asArray(module.states);
  const segments = asArray(module.segments);

  if (!module.available || !states.length || !segments.length) {
    state.registrationState = "all";
    state.registrationSegment = "PV";
    return;
  }

  const validStateIds = states.map((item) => item.state);
  const validSegmentIds = segments.map((item) => item.id);

  if (!validStateIds.includes(state.registrationState)) {
    state.registrationState = module.default_state || states[0].state;
  }
  if (!validSegmentIds.includes(state.registrationSegment)) {
    state.registrationSegment = module.default_segment || segments[0].id;
  }
}

function syncSegmentShareExplorer() {
  const module = asObject(dashboardData.modules.segment_share);
  const options = asArray(module.options);
  if (!module.available || !options.length) {
    state.segmentShareView = "TOTAL";
    return;
  }

  const validIds = options.map((item) => item.id);
  if (!validIds.includes(state.segmentShareView)) {
    state.segmentShareView = module.default_option || options[0].id;
  }
}

function syncRawMaterialExplorer() {
  const module = asObject(dashboardData.modules.components?.raw_material_prices);
  const companies = asArray(module.companies);
  if (!module.available || !companies.length) {
    state.rawMaterialCompany = "Tata Motors";
    return;
  }

  if (state.company !== "all" && companies.some((item) => item.company === state.company)) {
    state.rawMaterialCompany = state.company;
    return;
  }

  const validIds = companies.map((item) => item.company);
  if (!validIds.includes(state.rawMaterialCompany)) {
    state.rawMaterialCompany = module.default_company || companies[0].company;
  }
}

function syncCompanySegmentTrendExplorer() {
  const module = asObject(dashboardData.modules.components?.company_segment_trends);
  const companies = asArray(module.companies);
  if (!module.available || !companies.length) {
    state.componentTrendCompany = "Maruti Suzuki";
    return;
  }

  const validIds = companies.map((item) => item.company);
  if (state.company !== "all" && validIds.includes(state.company)) {
    state.componentTrendCompany = state.company;
    return;
  }

  if (!validIds.includes(state.componentTrendCompany)) {
    state.componentTrendCompany = module.default_company || companies[0].company;
  }
}

function syncEvTrendExplorer() {
  const categories = evCategoryOptions();
  const validCategoryIds = categories.map((item) => item.id);
  if (!validCategoryIds.includes(state.evCategory)) {
    state.evCategory = categories[0]?.id || "TOTAL";
  }

  if (!["M", "Q", "Y"].includes(state.evPeriod)) {
    state.evPeriod = "M";
  }
}

function syncLiveOemTrackers() {
  const defaults = { PV: "M", CV: "M", "2W": "Q" };
  const liveTables = asObject(dashboardData.modules.retail?.latest_oem_tables);

  Object.entries(defaults).forEach(([category, fallbackPeriod]) => {
    const liveTable = asObject(liveTables[category]);
    const periods = Object.keys(asObject(liveTable.periods));
    if (!periods.length) {
      state.liveOemPeriods[category] = fallbackPeriod;
      return;
    }

    const selectedPeriod = state.liveOemPeriods[category];
    if (!periods.includes(selectedPeriod)) {
      state.liveOemPeriods[category] = liveTable.default_period || periods[0];
    }
  });
}

function monthWindow() {
  const option = asArray(dashboardData.filters.window_options).find((item) => item.id === state.window);
  return option ? option.count : asArray(dashboardData.filters.months).length;
}

function sliceMonths(items) {
  if (state.window === "all") {
    return items;
  }
  return items.slice(-monthWindow());
}

function visibleModule(moduleName) {
  if (state.lens === "all") {
    return true;
  }
  if (state.lens === "ev") {
    return moduleName === "retail" || moduleName === "components" || moduleName === "insights";
  }
  return moduleName === state.lens;
}

function activeCategoryFilter() {
  return state.category === "EV" ? "TOTAL" : state.category;
}

function targetSectionForFilterChange(filterName) {
  if (filterName === "lens") {
    if (state.lens === "wholesale") {
      return "section-wholesale";
    }
    if (state.lens === "components") {
      return "section-components";
    }
    if (state.lens === "registration") {
      return "section-registration";
    }
    if (state.lens === "ev") {
      return "section-ev-trend";
    }
    return "section-retail";
  }

  if (filterName === "fuel") {
    return "section-ev";
  }

  if (filterName === "company") {
    return "section-company-map";
  }

  if (filterName === "window") {
    return "section-retail";
  }

  if (filterName === "category") {
    if (state.category === "EV") {
      return "section-ev-oem-tracker";
    }
    return "section-oem-tracker";
  }

  return "section-retail";
}

function scrollToPendingSection() {
  if (!pendingScrollTarget) {
    return;
  }

  const target = document.getElementById(pendingScrollTarget);
  pendingScrollTarget = null;
  if (!target) {
    return;
  }

  target.scrollIntoView({ behavior: "smooth", block: "start" });
  target.classList.remove("section-flash");
  void target.offsetWidth;
  target.classList.add("section-flash");
  window.setTimeout(() => {
    target.classList.remove("section-flash");
  }, 1400);
}

function setupDownloads() {
  document.querySelectorAll("[data-download-key]").forEach((node) => {
    node.addEventListener("click", async () => {
      const record = downloadRegistry.get(node.dataset.downloadKey);
      if (!record) return;
      const originalText = node.textContent;
      node.textContent = "Preparing…";
      node.disabled = true;
      try {
        await downloadAsXlsx(record);
      } catch (err) {
        console.warn("XLSX download failed, falling back to CSV", err);
        downloadAsCsv(record);
      } finally {
        node.textContent = originalText;
        node.disabled = false;
      }
    });
  });
}

let _excelJsLoader = null;
function ensureExcelJs() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (_excelJsLoader) return _excelJsLoader;
  _excelJsLoader = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
    script.async = true;
    script.onload = () => resolve(window.ExcelJS);
    script.onerror = (e) => {
      _excelJsLoader = null;
      reject(e);
    };
    document.head.appendChild(script);
  });
  return _excelJsLoader;
}

async function downloadAsXlsx(record) {
  const ExcelJS = await ensureExcelJs();
  const wb = new ExcelJS.Workbook();
  wb.creator = "auto-arisag dashboard";
  wb.created = new Date();

  const sheetTitle = record.filename.replace(/\.(csv|xlsx)$/i, "").slice(0, 31);
  const ws = wb.addWorksheet(sheetTitle, {
    properties: { tabColor: { argb: "FFC26C3A" } },
    views: [{ showGridLines: false }],
  });

  const colCount = record.columns.length;

  // Row 1 — title
  ws.mergeCells(1, 1, 1, colCount);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = `India Auto Demand Monitor — ${sheetTitle}`;
  titleCell.font = { bold: true, size: 18, color: { argb: "FF14273E" } };
  titleCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  ws.getRow(1).height = 30;

  // Row 2 — generated stamp
  ws.mergeCells(2, 1, 2, colCount);
  const subCell = ws.getCell(2, 1);
  const today = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  subCell.value = `Generated ${today} · auto-arisag.dashboard · Source-linked rows`;
  subCell.font = { italic: true, size: 10, color: { argb: "FF667687" } };
  subCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };

  // Row 3 — accent strip
  ws.mergeCells(3, 1, 3, colCount);
  ws.getCell(3, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC26C3A" } };
  ws.getRow(3).height = 4;

  // Row 4 — header row
  const headerRow = ws.addRow(record.columns);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFF7F1E4" }, size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF14273E" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: "FF14273E" } },
      bottom: { style: "medium", color: { argb: "FFC26C3A" } },
    };
  });
  headerRow.height = 24;

  // Detect YoY / growth / change columns for colour coding
  const yoyColIdxs = record.columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => /yoy|growth|chang|delta|mom/i.test(String(c)))
    .map(({ i }) => i);
  // Detect numeric columns for right-alignment + number format
  const isNumericColumn = record.columns.map((col) =>
    record.rows.some((r) => typeof r[col] === "number" && Number.isFinite(r[col])),
  );

  // Data rows
  record.rows.forEach((row, rowIdx) => {
    const dataRow = ws.addRow(record.columns.map((col) => row[col]));
    const zebraFill = rowIdx % 2 === 0 ? "FFFBF6EB" : "FFFFFDFA";
    dataRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const colIdx = colNumber - 1;
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: zebraFill } };
      cell.border = {
        bottom: { style: "thin", color: { argb: "FFE5DFD0" } },
      };
      if (isNumericColumn[colIdx]) {
        cell.alignment = { horizontal: "right", vertical: "middle" };
        if (yoyColIdxs.includes(colIdx)) {
          cell.numFmt = '+0.0"%";-0.0"%";0.0"%"';
        } else {
          cell.numFmt = "#,##0.##";
        }
      } else {
        cell.alignment = { horizontal: "left", vertical: "middle", indent: 1 };
      }
      // Colour-code YoY cells by sign
      if (yoyColIdxs.includes(colIdx) && typeof cell.value === "number") {
        if (cell.value > 0) {
          cell.font = { color: { argb: "FF1D5A4F" }, bold: true };
        } else if (cell.value < 0) {
          cell.font = { color: { argb: "FF8A2727" }, bold: true };
        }
      }
    });
  });

  // Column widths — fit-to-content with sane min/max.
  ws.columns.forEach((col, i) => {
    const header = record.columns[i];
    const maxLen = Math.max(
      String(header || "").length,
      ...record.rows.map((r) => String(r[header] ?? "").length),
    );
    col.width = Math.max(8, Math.min(maxLen + 4, 36));
  });

  // Freeze header row.
  ws.views = [{ showGridLines: false, state: "frozen", ySplit: 4 }];

  // Auto-filter on the data range.
  const lastRow = record.rows.length + 4;
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: lastRow, column: colCount } };

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = record.filename.replace(/\.csv$/i, ".xlsx");
  link.click();
  URL.revokeObjectURL(url);
}

function downloadAsCsv(record) {
  const header = record.columns.join(",");
  const rows = record.rows.map((row) =>
    record.columns
      .map((column) => csvEscape(row[column]))
      .join(","),
  );
  const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = record.filename;
  link.click();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const text = `${value ?? ""}`;
  if (text.includes(",") || text.includes('"') || text.includes("\n")) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function setupFilters() {
  document.querySelectorAll("[data-filter]").forEach((node) => {
    node.addEventListener("change", (event) => {
      const filterName = event.target.dataset.filter;
      state[filterName] = event.target.value;

      syncStateToAvailableOptions();
      pendingScrollTarget = targetSectionForFilterChange(filterName);
      render();
    });
  });
}

function setupNewsPicker() {
  const picker = document.querySelector("[data-news-filter]");
  if (!picker) {
    return;
  }

  picker.addEventListener("change", (event) => {
    state.newsGroup = event.target.value;
    render();
  });
}

function setupCompanyTrendPicker() {
  const picker = document.querySelector("[data-company-trend]");
  if (!picker) {
    return;
  }

  picker.addEventListener("change", (event) => {
    state.companyTrend = event.target.value;
    // Switching primary purges that company from the compare list — covered
    // by syncCompanyTrendCompare on the next render, but force it now so the
    // chip row repaints without stale state.
    state.companyTrendCompare = state.companyTrendCompare.filter((name) => name !== event.target.value);
    render();
  });
}

function setupCompanySpotlightCompare() {
  document.querySelectorAll("[data-company-trend-peer]").forEach((node) => {
    node.addEventListener("click", () => {
      const name = node.getAttribute("data-company-trend-peer");
      if (!name) return;
      const idx = state.companyTrendCompare.indexOf(name);
      if (idx >= 0) {
        state.companyTrendCompare.splice(idx, 1);
      } else {
        // Cap at 5 peers — beyond that the chart turns into spaghetti.
        if (state.companyTrendCompare.length >= 5) {
          state.companyTrendCompare.shift();
        }
        state.companyTrendCompare.push(name);
      }
      render();
    });
  });
  document.querySelectorAll("[data-action='toggle-company-trend-indexed']").forEach((node) => {
    node.addEventListener("click", () => {
      state.companyTrendIndexed = !state.companyTrendIndexed;
      render();
    });
  });
}

function setupRefreshAction() {
  const button = document.querySelector("[data-action='refresh']");
  if (!button) {
    return;
  }
  button.addEventListener("click", () => {
    triggerRefresh();
  });
}

// Mirrors density preference onto <body data-density=...> so CSS can
// switch row padding / card spacing. Runs at end of every render().
function applyDensity() {
  if (typeof document !== "undefined" && document.body) {
    document.body.dataset.density = state.density || "comfortable";
  }
}

function setupDensityToggle() {
  document.querySelectorAll("[data-action='toggle-density']").forEach((node) => {
    node.addEventListener("click", () => {
      state.density = state.density === "dense" ? "comfortable" : "dense";
      render();
    });
  });
}

function setupComparePriorToggle() {
  document.querySelectorAll("[data-action='toggle-compare-prior']").forEach((node) => {
    node.addEventListener("click", () => {
      state.compareToPriorCycle = !state.compareToPriorCycle;
      // When the user just turned it ON, jump them to the retail trend tab
      // so the change is visible. Otherwise the toggle does nothing they
      // can see if they're on a different tab.
      if (state.compareToPriorCycle && state.activeTab !== "retail-trend") {
        state.activeTab = "retail-trend";
        pendingScrollTarget = "section-retail";
      }
      render();
    });
  });
}

function setupExportPdfAction() {
  document.querySelectorAll("[data-action='export-pdf']").forEach((node) => {
    node.addEventListener("click", () => {
      const today = new Date().toISOString().slice(0, 10);
      const prevTitle = document.title;
      document.title = `auto-arisag-investor-deck-${today}`;
      document.body.setAttribute("data-print-date", today);
      // Flip into "print all tabs" mode so the PDF includes every tab in
      // one continuous handout, then restore once the dialog closes.
      state.printAllTabs = true;
      render();
      // Give the browser one frame to lay out the print view before
      // opening the dialog.
      requestAnimationFrame(() => {
        const cleanup = () => {
          state.printAllTabs = false;
          render();
          document.title = prevTitle;
          window.removeEventListener("afterprint", cleanup);
        };
        window.addEventListener("afterprint", cleanup);
        window.print();
        // Safety net for browsers that don't fire afterprint.
        setTimeout(() => {
          if (state.printAllTabs) cleanup();
        }, 2000);
      });
    });
  });
}

function setupStateRegistrationExplorer() {
  const picker = document.querySelector("[data-registration-state]");
  if (picker) {
    picker.addEventListener("change", (event) => {
      state.registrationState = event.target.value;
      render();
    });
  }

  document.querySelectorAll("[data-registration-segment]").forEach((node) => {
    node.addEventListener("click", () => {
      state.registrationSegment = node.dataset.registrationSegment;
      render();
    });
  });
}

function setupSegmentShareExplorer() {
  const picker = document.querySelector("[data-segment-share]");
  if (!picker) {
    return;
  }

  picker.addEventListener("change", (event) => {
    state.segmentShareView = event.target.value;
    render();
  });
}

function setupRawMaterialExplorer() {
  const picker = document.querySelector("[data-raw-material-company]");
  if (!picker) {
    return;
  }

  picker.addEventListener("change", (event) => {
    state.rawMaterialCompany = event.target.value;
    render();
  });
}

function setupCompanySegmentTrendExplorer() {
  const picker = document.querySelector("[data-component-company]");
  if (!picker) {
    return;
  }

  picker.addEventListener("change", (event) => {
    state.componentTrendCompany = event.target.value;
    render();
  });
}

function setupEvTrendExplorer() {
  const picker = document.querySelector("[data-ev-category]");
  if (picker) {
    picker.addEventListener("change", (event) => {
      state.evCategory = event.target.value;
      render();
    });
  }

  document.querySelectorAll("[data-ev-period]").forEach((node) => {
    node.addEventListener("click", () => {
      state.evPeriod = node.dataset.evPeriod;
      render();
    });
  });
}

function setupEvOemTracker() {
  const picker = document.querySelector("[data-ev-oem-segment]");
  if (!picker) {
    return;
  }

  picker.addEventListener("change", (event) => {
    state.evOemSegment = event.target.value;
    render();
  });
}

function setupLiveOemTrackers() {
  document.querySelectorAll("[data-live-oem-period]").forEach((node) => {
    node.addEventListener("click", () => {
      const category = node.dataset.liveOemCategory;
      const period = node.dataset.liveOemPeriod;
      if (!category || !period) {
        return;
      }
      state.liveOemPeriods[category] = period;
      render();
    });
  });
}

function setupSorts() {
  document.querySelectorAll("th[data-table]").forEach((node) => {
    node.addEventListener("click", () => {
      const table = node.dataset.table;
      const key = node.dataset.key;
      const current = state.sorts[table];
      if (current && current.key === key) {
        state.sorts[table] = { key, dir: current.dir === "asc" ? "desc" : "asc" };
      } else {
        state.sorts[table] = { key, dir: "desc" };
      }
      render();
    });
  });
}

function setupCompanyMapCards() {
  document.querySelectorAll("[data-company-map-card]").forEach((node) => {
    node.addEventListener("click", () => {
      state.companyMapFocus = node.dataset.companyMapCard || state.companyMapFocus;
      pendingScrollTarget = "company-drilldown";
      render();
    });
  });
}

function ensureTooltipNode() {
  if (tooltipNode && document.body.contains(tooltipNode)) {
    return tooltipNode;
  }
  tooltipNode = document.createElement("div");
  tooltipNode.className = "chart-tooltip";
  document.body.appendChild(tooltipNode);
  return tooltipNode;
}

function hideTooltip() {
  if (!tooltipNode) {
    return;
  }
  tooltipNode.classList.remove("visible");
}

function showTooltip(text, x, y) {
  if (!text) {
    hideTooltip();
    return;
  }
  const node = ensureTooltipNode();
  // Tooltip payloads now ship as JSON ({label, period, value, note?}) so
  // we can lay them out with a proper hierarchy instead of a single line of
  // text. Plain-string fallback retained for legacy callers.
  let html = "";
  try {
    if (text.startsWith("{") && text.endsWith("}")) {
      const data = JSON.parse(text);
      html = `
        <div class="chart-tooltip-row chart-tooltip-label">${escapeHtml(data.label || "")}</div>
        ${data.period ? `<div class="chart-tooltip-row chart-tooltip-period">${escapeHtml(data.period)}</div>` : ""}
        <div class="chart-tooltip-row chart-tooltip-value">${escapeHtml(data.value || "")}</div>
        ${data.note ? `<div class="chart-tooltip-row chart-tooltip-note">${escapeHtml(data.note)}</div>` : ""}
      `;
    }
  } catch {
    html = "";
  }
  if (html) {
    node.innerHTML = html;
  } else {
    node.textContent = text;
  }
  node.classList.add("visible");
  const offset = 16;
  const { innerWidth, innerHeight } = window;
  const rect = node.getBoundingClientRect();
  let left = x + offset;
  let top = y - rect.height - offset;

  if (left + rect.width + 12 > innerWidth) {
    left = x - rect.width - offset;
  }
  if (left < 12) {
    left = 12;
  }
  if (top < 12) {
    top = y + offset;
  }
  if (top + rect.height + 12 > innerHeight) {
    top = innerHeight - rect.height - 12;
  }

  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
}

function setupChartTooltips() {
  document.querySelectorAll("[data-tooltip]").forEach((node) => {
    const handler = (event) => {
      const source = event.currentTarget;
      showTooltip(source.dataset.tooltip, event.clientX, event.clientY);
    };

    node.addEventListener("mouseenter", handler);
    node.addEventListener("mousemove", handler);
    node.addEventListener("mouseleave", hideTooltip);
    node.addEventListener("blur", hideTooltip);
  });
}

function tabDefinitions() {
  const registrationAvailable = !!dashboardData.modules.registration?.available;
  const creditPulseAvailable = !!dashboardData.modules.credit_pulse?.available;
  const premiumDataAvailable = !!dashboardData.modules.premium_data?.available;
  const festivePulseAvailable = !!dashboardData.modules.festive_pulse?.available;
  const recentLaunchesAvailable = !!dashboardData.modules.recent_launches?.available;
  return [
    {
      id: "overview",
      label: "Overview",
      group: "Top",
      render: () => [
        renderWhatChangedToday(),
        renderSourceVisibility(),
        renderInsightsSection(),
      ].join(""),
    },
    {
      id: "retail-trend",
      label: "Retail trend",
      group: "Retail",
      render: () => visibleModule("retail") ? renderRetailTrendOnly() : "",
    },
    {
      id: "retail-ev",
      label: "EV penetration",
      group: "Retail",
      render: () => visibleModule("retail") ? renderEvTab() : "",
    },
    {
      id: "channel-pulse",
      label: "Channel pulse",
      group: "Retail",
      render: () => visibleModule("retail") ? renderChannelPulseTab() : "",
    },
    {
      id: "oem-tracker",
      label: "OEM tracker",
      group: "Retail",
      render: () => visibleModule("retail") ? renderOemSection() : "",
    },
    {
      id: "registration",
      label: "Vahan registrations",
      group: "Retail",
      hidden: !registrationAvailable,
      render: () => registrationAvailable && visibleModule("registration") ? renderRegistrationSection() : "",
    },
    {
      id: "wholesale",
      label: "Wholesale (SIAM)",
      group: "Industry",
      render: () => visibleModule("wholesale") ? renderWholesaleSection() : "",
    },
    {
      id: "components",
      label: "Components & raw materials",
      group: "Industry",
      render: () => visibleModule("components") ? renderComponentsSection() : "",
    },
    {
      id: "companies",
      label: "Companies",
      group: "Industry",
      render: () => renderCompanySection(),
    },
    {
      id: "credit-pulse",
      label: "Auto loan growth (RBI)",
      group: "Macro",
      hidden: !creditPulseAvailable,
      render: () => creditPulseAvailable ? renderCreditPulseSection() : "",
    },
    {
      id: "festive-pulse",
      label: "Festive Pulse",
      group: "Macro",
      hidden: !festivePulseAvailable,
      render: () => festivePulseAvailable ? renderFestivePulseSection() : "",
    },
    {
      id: "recent-launches",
      label: "Recent launches",
      group: "News",
      hidden: !recentLaunchesAvailable,
      render: () => recentLaunchesAvailable ? renderRecentLaunchesSection() : "",
    },
    {
      id: "premium-data",
      label: "Premium data sources",
      group: "Data",
      hidden: !premiumDataAvailable,
      render: () => premiumDataAvailable ? renderPremiumDataSection() : "",
    },
  ];
}

function visibleTabs() {
  return tabDefinitions().filter((tab) => !tab.hidden);
}

function activeTabDefinition() {
  const tabs = visibleTabs();
  return tabs.find((tab) => tab.id === state.activeTab) || tabs[0];
}

// Map each tab to the source/module it draws from. Used by the freshness
// pill above the tab content and the dot in the side nav.
const TAB_SOURCE_MAP = {
  "retail-trend": "retail",
  "retail-ev": "retail",
  "channel-pulse": "retail",
  "oem-tracker": "retail",
  "registration": "registration",
  "wholesale": "wholesale",
  "components": "components",
  "credit-pulse": "credit_pulse",
  // Festive Pulse aggregates FADA retail months, so its freshness mirrors retail.
  "festive-pulse": "retail",
  "recent-launches": "recent_launches",
};

function tabSourceMeta(tabId) {
  const moduleKey = TAB_SOURCE_MAP[tabId];
  if (!moduleKey) return null;
  const mod = dashboardData.modules[moduleKey];
  if (!mod || !mod.available) return null;
  const meta = mod.source_meta || {};
  // Components has a "period" not a "latest_month"; Credit Pulse uses
  // latest_month plus a label off the latest reading. Normalize them.
  const periodLabel =
    meta.period
    || meta.latest_month
    || (mod.latest && mod.latest.label)
    || (mod.latest_month);
  // Build an ISO date for the freshness helper. Most modules carry a real
  // release_date; for Credit Pulse we have to derive it from the latest
  // month's `as_of_date` (the actual reporting Friday) or, failing that,
  // synthesize the last day of the latest month.
  const monthToIsoEnd = (m) => {
    if (!m || !/^\d{4}-\d{2}$/.test(m)) return null;
    const [y, mo] = m.split("-").map(Number);
    return new Date(y, mo, 0).toISOString().slice(0, 10);
  };
  const releaseDate =
    meta.latest_release_date
    || meta.release_date
    || (mod.latest && mod.latest.as_of_date)
    || monthToIsoEnd(meta.latest_month)
    || (mod.months && mod.months.length && mod.months[mod.months.length - 1].as_of_date)
    || (mod.months && mod.months.length && monthToIsoEnd(mod.months[mod.months.length - 1].month));
  return {
    source: meta.name || meta.source_name || "",
    periodLabel: periodLabel || "",
    releaseDate: releaseDate || "",
  };
}

function freshnessLevel(isoDate) {
  if (!isoDate) return null;
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.round((Date.now() - d.getTime()) / 86400000);
  let tone;
  if (days < 45) tone = "fresh";
  else if (days < 90) tone = "aging";
  else if (days < 180) tone = "stale";
  else tone = "critical";
  return { tone, days };
}

function renderAllTabsForPrint() {
  // Render every visible tab one after another, each on its own page,
  // with a section header. Preserves the active tab's state so the
  // dashboard renders identically when state.printAllTabs flips back.
  const tabs = visibleTabs();
  const today = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  const sections = tabs.map((tab, i) => {
    return `
      <section class="print-section ${i > 0 ? "print-page-break" : ""}">
        <header class="print-section-head">
          <span class="print-section-kicker">${tab.group || "Section"}</span>
          <h1 class="print-section-title">${tab.label}</h1>
          ${renderActiveTabFreshness(tab.id)}
        </header>
        ${tab.render()}
      </section>
    `;
  });
  return `
    <section class="print-cover">
      <p class="print-cover-eyebrow">Institutional Auto Dashboard</p>
      <h1 class="print-cover-title">${dashboardData.title || "India Auto Demand Monitor"}</h1>
      <p class="print-cover-lede">${dashboardData.subtitle || ""}</p>
      <p class="print-cover-meta">Investor handout · Generated ${today} · Data through ${dashboardData.as_of_date || ""}</p>
    </section>
    ${sections.join("")}
  `;
}

function renderActiveTabFreshness(tabId) {
  const meta = tabSourceMeta(tabId);
  if (!meta || !meta.releaseDate) return "";
  const f = freshnessLevel(meta.releaseDate);
  if (!f) return "";
  const human = (() => {
    if (f.days <= 1) return "released today";
    if (f.days < 30) return `released ${f.days} days ago`;
    const months = Math.round(f.days / 30);
    return months <= 1 ? "released ~1 month ago" : `released ~${months} months ago`;
  })();
  const sourceText = meta.source ? `${meta.source} · ` : "";
  return `
    <div class="freshness-pill freshness-pill-${f.tone}" title="Released ${f.days} days ago">
      <span class="freshness-dot"></span>
      <span class="freshness-pill-text">
        <span class="freshness-pill-label">${sourceText}Data through</span>
        <strong>${meta.periodLabel || "—"}</strong>
        <span class="freshness-pill-relative">· ${human}</span>
      </span>
    </div>
  `;
}

function renderSideNav(activeId) {
  const tabs = visibleTabs();
  const groups = [];
  tabs.forEach((tab) => {
    const group = groups.find((g) => g.label === tab.group);
    if (group) {
      group.tabs.push(tab);
    } else {
      groups.push({ label: tab.group || "Other", tabs: [tab] });
    }
  });
  return `
    <aside class="side-nav" aria-label="Dashboard sections">
      ${groups.map((group) => `
        <div class="side-nav-group">
          <p class="side-nav-group-label">${group.label}</p>
          ${group.tabs.map((tab) => {
            const meta = tabSourceMeta(tab.id);
            const f = meta && meta.releaseDate ? freshnessLevel(meta.releaseDate) : null;
            const dot = f
              ? `<span class="side-nav-dot dot-${f.tone}" title="${meta.source || tab.label} · ${meta.periodLabel || ""} · ${f.days} days old"></span>`
              : "";
            return `
              <button
                class="side-nav-item${tab.id === activeId ? " is-active" : ""}"
                data-tab="${tab.id}"
                type="button"
              >${dot}<span class="side-nav-item-label">${tab.label}</span></button>
            `;
          }).join("")}
        </div>
      `).join("")}
    </aside>
  `;
}

function setupTabBar() {
  document.querySelectorAll("[data-tab]").forEach((node) => {
    node.addEventListener("click", () => {
      const value = node.getAttribute("data-tab");
      if (!value || value === state.activeTab) {
        return;
      }
      state.activeTab = value;
      pendingScrollTarget = null;
      render();
      requestAnimationFrame(() => {
        const content = document.querySelector(".dashboard-content");
        if (content) {
          content.scrollTo({ top: 0, behavior: "smooth" });
        } else {
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      });
    });
  });
}

function ensureActiveTabForSection(sectionId) {
  if (!sectionId) {
    return;
  }
  const targetTab = SECTION_TO_TAB[sectionId];
  if (targetTab && targetTab !== state.activeTab) {
    state.activeTab = targetTab;
  }
}

function render() {
  downloadRegistry.clear();
  syncStateToAvailableOptions();
  syncNewsGroup();
  syncCompanyTrend();
  syncCompanyTrendCompare();
  syncCompanyMapFocus();
  syncStateRegistrationExplorer();
  syncSegmentShareExplorer();
  syncRawMaterialExplorer();
  syncCompanySegmentTrendExplorer();
  syncEvTrendExplorer();
  syncLiveOemTrackers();
  if (pendingScrollTarget) {
    ensureActiveTabForSection(pendingScrollTarget);
  }
  const activeTab = activeTabDefinition();
  const app = document.getElementById("app");
  app.innerHTML = [
    renderHero(),
    renderMacroOverlayStrip(),
    renderMarketInsightsRibbon(),
    renderFilters(),
    state.printAllTabs
      ? `<main class="dashboard-content print-all-tabs">${renderAllTabsForPrint()}</main>`
      : `<div class="dashboard-body">
           ${renderSideNav(activeTab.id)}
           <main class="dashboard-content">${renderActiveTabFreshness(activeTab.id)}${activeTab.render()}</main>
         </div>`,
    renderCreditPulseExplainerModal(),
  ].join("");

  setupFilters();
  setupTabBar();
  setupNewsPicker();
  setupCompanyTrendPicker();
  setupCompanySpotlightCompare();
  setupRefreshAction();
  setupStateRegistrationExplorer();
  setupSegmentShareExplorer();
  setupRawMaterialExplorer();
  setupCompanySegmentTrendExplorer();
  setupEvTrendExplorer();
  setupEvOemTracker();
  setupLiveOemTrackers();
  setupOemSection();
  setupOemDrilldown();
  setupChangedMovers();
  setupPngExports();
  setupSorts();
  setupCompanyMapCards();
  setupDownloads();
  setupChartTooltips();
  setupCreditPulseExplainer();
  setupMarketInsightsRibbon();
  setupExplainerTooltips();
  setupSearchBar();
  setupExportPdfAction();
  setupCompanyMapPagination();
  setupComparePriorToggle();
  setupRecentLaunchesFilter();
  setupDensityToggle();
  applyDensity();
  // Mirror current view into the URL hash — lets users bookmark or copy
  // the address bar to share a deep-link.
  serializeStateToUrl();
  requestAnimationFrame(() => {
    scrollToPendingSection();
  });
}

function _buildSearchIndex() {
  const idx = [];
  // Tabs
  visibleTabs().forEach((tab) => {
    idx.push({
      type: "Tab",
      label: tab.label,
      group: tab.group || "",
      action: { kind: "tab", tabId: tab.id },
      keywords: `${tab.label} ${tab.group || ""}`.toLowerCase(),
    });
  });
  // Categories
  const catLabels = {
    TOTAL: "All categories", PV: "Passenger Vehicles", "2W": "Two-Wheelers",
    "3W": "Three-Wheelers", CV: "Commercial Vehicles", TRACTOR: "Tractors", CE: "Construction Equipment",
  };
  Object.entries(catLabels).forEach(([id, label]) => {
    idx.push({
      type: "Category",
      label,
      group: id,
      action: { kind: "category", id },
      keywords: `${label} ${id}`.toLowerCase(),
    });
  });
  // Companies. company_map is a list of {company, summary, ...} objects
  // built by analyze.build_company_map. Also pull from company_unit_trends
  // and the explicit OEM tracker rows so monthly-only companies (e.g.
  // Atul Auto) are reachable too.
  const seenCompanies = new Set();
  const pushCompany = (company, hint = "Listed OEM") => {
    if (!company || seenCompanies.has(company)) return;
    seenCompanies.add(company);
    idx.push({
      type: "Company",
      label: company,
      group: hint,
      action: { kind: "company", name: company },
      keywords: company.toLowerCase(),
    });
  };
  const map = dashboardData.company_map;
  if (Array.isArray(map)) {
    map.forEach((entry) => pushCompany(entry?.company, "Listed OEM"));
  } else if (map && typeof map === "object") {
    Object.keys(map).forEach((c) => pushCompany(c, "Listed OEM"));
  }
  asArray(dashboardData.modules.retail?.company_unit_trends).forEach((t) =>
    pushCompany(t.label || t.company, "Listed OEM"),
  );
  // Stock-listed tickers (Yahoo) — surface the ticker too for ⌘-K-style
  // searches like "TVSMOTOR" or "BAJAJ-AUTO".
  const stocks = dashboardData.oem_stocks?.stocks || {};
  Object.entries(stocks).forEach(([company, info]) => {
    pushCompany(company, info?.ticker ? `NSE: ${info.ticker}` : "Listed OEM");
  });
  // Metrics — every explainer key becomes a search target.
  Object.entries(METRIC_EXPLAINERS).forEach(([key, exp]) => {
    idx.push({
      type: "Metric",
      label: exp.title,
      group: exp.body ? exp.body.slice(0, 60) + "..." : "",
      action: { kind: "metric", key },
      keywords: `${exp.title} ${exp.body || ""}`.toLowerCase(),
    });
  });
  return idx;
}

function _runSearch(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return [];
  const idx = _buildSearchIndex();
  const matches = idx
    .map((entry) => {
      let score = 0;
      if (entry.label.toLowerCase().startsWith(q)) score += 10;
      if (entry.label.toLowerCase().includes(q)) score += 5;
      if (entry.keywords.includes(q)) score += 1;
      return { entry, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((r) => r.entry);
  return matches;
}

function renderSearchBar() {
  const q = state.searchQuery || "";
  const results = _runSearch(q);
  const groupedResults = results.reduce((acc, r) => {
    (acc[r.type] = acc[r.type] || []).push(r);
    return acc;
  }, {});
  const renderResult = (entry, idx) => `
    <button class="search-result"
            data-search-result-idx="${idx}"
            data-search-action='${JSON.stringify(entry.action).replace(/'/g, "&apos;")}'>
      <span class="search-result-type">${entry.type}</span>
      <span class="search-result-label">${entry.label}</span>
      ${entry.group ? `<span class="search-result-group">${entry.group}</span>` : ""}
    </button>
  `;
  let resultIdx = 0;
  const dropdown = q && results.length
    ? `
      <div class="search-dropdown">
        ${Object.entries(groupedResults).map(([type, list]) => `
          <div class="search-group">
            <p class="search-group-label">${type}</p>
            ${list.map((entry) => renderResult(entry, resultIdx++)).join("")}
          </div>
        `).join("")}
      </div>
    `
    : (q ? `<div class="search-dropdown"><div class="search-empty">No matches for &ldquo;${q}&rdquo;</div></div>` : "");

  return `
    <section class="search-bar-strip">
      <div class="search-bar-inner">
        <span class="search-icon" aria-hidden="true">🔍</span>
        <input
          class="search-input"
          type="search"
          placeholder="Search companies, categories, tabs, metrics… (e.g. &ldquo;Maruti&rdquo;, &ldquo;EV&rdquo;, &ldquo;inventory&rdquo;)"
          value="${q.replace(/"/g, "&quot;")}"
          autocomplete="off"
          spellcheck="false"
          data-search-input
        />
        ${q ? '<button class="search-clear" data-search-clear>×</button>' : ""}
      </div>
      ${dropdown}
    </section>
  `;
}

function setupSearchBar() {
  const input = document.querySelector("[data-search-input]");
  if (input) {
    // Keep focus across re-renders so typing stays smooth.
    input.addEventListener("input", (event) => {
      state.searchQuery = event.target.value;
      render();
      requestAnimationFrame(() => {
        const next = document.querySelector("[data-search-input]");
        if (next) {
          next.focus();
          // Restore caret to end of input.
          next.setSelectionRange(next.value.length, next.value.length);
        }
      });
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        state.searchQuery = "";
        render();
      }
    });
  }
  document.querySelectorAll("[data-search-clear]").forEach((node) => {
    node.addEventListener("click", () => {
      state.searchQuery = "";
      render();
    });
  });
  document.querySelectorAll("[data-search-action]").forEach((node) => {
    node.addEventListener("click", () => {
      let action;
      try {
        action = JSON.parse(node.getAttribute("data-search-action").replace(/&apos;/g, "'"));
      } catch (e) {
        return;
      }
      _executeSearchAction(action);
    });
  });
}

function _executeSearchAction(action) {
  if (!action || !action.kind) return;
  if (action.kind === "tab") {
    state.activeTab = action.tabId;
    state.searchQuery = "";
    render();
    return;
  }
  if (action.kind === "category") {
    state.category = action.id;
    state.searchQuery = "";
    render();
    return;
  }
  if (action.kind === "company") {
    state.company = action.name;
    state.companyTrend = action.name;
    state.searchQuery = "";
    render();
    return;
  }
  if (action.kind === "metric") {
    // Heuristic: route the metric back to the tab it belongs to.
    const key = action.key;
    if (key.startsWith("summary.")) state.activeTab = "overview";
    else if (key.startsWith("ribbon.")) state.activeTab = "overview";
    else if (key.startsWith("credit.")) state.activeTab = "credit-pulse";
    else if (key.startsWith("components.")) state.activeTab = "components";
    else if (key.startsWith("wholesale.")) state.activeTab = "wholesale";
    else if (key.startsWith("festive.")) state.activeTab = "festive-pulse";
    else if (key.startsWith("macro.")) state.activeTab = "overview";
    state.searchQuery = "";
    render();
    return;
  }
}

function renderMacroOverlayStrip() {
  const macro = dashboardData.macro_indicators;
  if (!macro?.available) return "";
  const asOf = macro.as_of_date
    ? new Date(macro.as_of_date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    : "";
  const renderTile = (ind) => {
    const tone = ind.delta_tone || "neutral";
    const explainKey = `macro.${ind.id}`;
    return `
      <article class="macro-tile macro-tone-${tone}" data-explain="${explainKey}" tabindex="0">
        <p class="macro-label">${ind.label}</p>
        <p class="macro-value">
          <span class="macro-number">${ind.value}</span>
          <span class="macro-unit">${ind.unit || ""}</span>
        </p>
        <p class="macro-delta">${ind.delta_label || ""}</p>
      </article>
    `;
  };
  return `
    <section class="macro-strip" aria-label="Macro context">
      <div class="macro-strip-inner">
        <p class="macro-strip-title">
          <span class="macro-strip-pulse" aria-hidden="true"></span>
          Macro context
          ${asOf ? `<span class="macro-strip-asof">as of ${asOf}</span>` : ""}
        </p>
        <div class="macro-strip-grid">
          ${macro.indicators.map(renderTile).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderHero() {
  const summary = dashboardData.summary;
  return `
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Institutional Auto Dashboard</p>
        <h1>${dashboardData.title}</h1>
        <p class="hero-lede">${dashboardData.subtitle}</p>
        <div class="hero-toolbar">
          <button class="button button-primary hero-refresh" data-action="refresh" ${refreshState.loading ? "disabled" : ""}>
            ${refreshState.loading ? '<span class="button-loader" aria-hidden="true"></span> Refreshing...' : "Refresh Data"}
          </button>
          <button class="button button-export-pdf" data-action="export-pdf" title="Export the active tab as a PDF">
            <span aria-hidden="true">📄</span> Export PDF
          </button>
          <button class="button ${state.compareToPriorCycle ? "button-compare-on" : "button-compare-off"}"
                  data-action="toggle-compare-prior"
                  title="Overlay the same 12 months from one year ago on every line chart that has the data">
            <span aria-hidden="true">${state.compareToPriorCycle ? "✓" : "↻"}</span>
            ${state.compareToPriorCycle ? "Comparing prior year" : "Compare to prior year"}
          </button>
          <button class="button button-density${state.density === "dense" ? " is-active" : ""}" data-action="toggle-density" title="Compact layout — fewer pixels per row, more rows on screen, optimised for research desks.">
            <span aria-hidden="true">${state.density === "dense" ? "▥" : "▤"}</span> ${state.density === "dense" ? "Roomy" : "Dense"}
          </button>
          <p class="hero-status ${refreshState.tone}">${refreshState.message}</p>
        </div>
        <div class="hero-grid">
          ${summary.cards.map(renderSummaryCard).join("")}
        </div>
      </div>
      ${renderHeroAside()}
    </section>
  `;
}

function renderHeroAside() {
  if (dashboardData.news?.available && dashboardData.news.groups.length) {
    return renderHeroNews();
  }
  return renderHeroMeta();
}

function renderHeroMeta() {
  const summary = dashboardData.summary;
  const activeSources = asArray(summary.source_badges).filter((item) => item.status === "active").slice(0, 3);
  const qaChecks = asArray(dashboardData.qa).filter((item) => item.status === "ok").slice(0, 3);
  return `
    <aside class="hero-meta">
      <p class="eyebrow">Build Meta</p>
      <h2>High-signal view through ${dashboardData.modules.retail.latest_month ? dashboardData.modules.retail.months.at(-1).label : dashboardData.as_of_date}</h2>
      <p class="hero-meta-value">${summary.active_module_count} active modules</p>
      <p class="metric-detail">Generated ${formatTimestamp(dashboardData.generated_at)}</p>
      <p class="metric-detail">Only validated live modules are shown on this page.</p>
      <div class="section-divider"></div>
      <div class="hero-meta-list">
        <div>
          <p class="small-label">Live sources</p>
          ${activeSources.map((item) => `
            <div class="hero-meta-row">
              <span>${item.source}</span>
              <strong>${item.last_updated || "Live"}</strong>
            </div>
          `).join("")}
        </div>
        <div>
          <p class="small-label">QA checks</p>
          ${qaChecks.map((item) => `
            <div class="hero-meta-row">
              <span>${item.message}</span>
              <strong>${item.status}</strong>
            </div>
          `).join("")}
        </div>
      </div>
    </aside>
  `;
}

function renderHeroNews() {
  const groups = dashboardData.news.groups;
  const selectedGroup = state.newsGroup === "all"
    ? groups[0]
    : groups.find((group) => group.id === state.newsGroup) || groups[0];
  return `
    <aside class="hero-meta hero-news">
      <p class="eyebrow">Live Auto News</p>
      <h2>Segment headlines that matter</h2>
      <p class="metric-detail">Choose a segment and the panel will show the freshest relevant headlines from validated live sources.</p>
      <p class="metric-detail">Built ${formatTimestamp(dashboardData.news.generated_at || dashboardData.generated_at)}</p>
      <div class="section-divider"></div>
      <div class="hero-news-controls">
        <label class="small-label" for="hero-news-filter">Segment</label>
        <div class="hero-news-select-wrap">
          <select id="hero-news-filter" class="hero-news-select" data-news-filter>
          ${groups.map((group) => `
            <option value="${group.id}" ${group.id === selectedGroup.id ? "selected" : ""}>${group.label}</option>
          `).join("")}
          </select>
        </div>
      </div>
      <section class="hero-news-group">
        <div class="hero-news-head">
          <p class="small-label">${selectedGroup.label}</p>
          <p class="hero-news-count">Top ${selectedGroup.items.length} headline${selectedGroup.items.length === 1 ? "" : "s"}</p>
        </div>
        <div class="hero-news-items">
          ${selectedGroup.items.map((item, index) => `
            <article class="hero-news-item">
              <div class="hero-news-rank">${index + 1}</div>
              <div class="hero-news-copy">
                <a class="hero-news-link" href="${item.url}" target="_blank" rel="noreferrer">${item.title}</a>
                <div class="hero-news-meta">
                  <span>${item.source}</span>
                  <strong>${item.published_display}</strong>
                </div>
              </div>
            </article>
          `).join("")}
        </div>
      </section>
    </aside>
  `;
}

function renderSummaryCard(card) {
  const tone = card?.tone || "neutral";
  const explainKey = card?.id ? `summary.${card.id}` : null;
  const explainAttr = explainKey && METRIC_EXPLAINERS[explainKey] ? `data-explain="${explainKey}" tabindex="0"` : "";
  return `
    <article class="summary-card ${tone}" ${explainAttr}>
      <div class="table-toolbar">
        <p class="small-label">${card?.label || ""}</p>
        ${renderSourceAction(summarySourceUrl(card?.id))}
      </div>
      <p class="summary-value">${card?.display || ""}</p>
      <p class="summary-change">${card?.change || ""}</p>
      <p class="summary-meta">${card?.detail || ""}</p>
    </article>
  `;
}

function renderFilters() {
  const categoryOptions = availableCategoryOptions();
  const fuelOptions = availableFuelOptions();
  const companyOptions = availableCompanyOptions();
  const categoryFieldOptions = categoryOptions.length
    ? categoryOptions
    : [{ id: "TOTAL", label: "No category filter" }];
  const fuelFieldOptions = fuelOptions.length
    ? [{ id: "all", label: "All fuels" }, ...fuelOptions]
    : [{ id: "all", label: "No fuel filter" }];
  const companyFieldOptions = companyOptions.length
    ? [{ id: "all", label: "All companies" }, ...companyOptions]
    : [{ id: "all", label: "No company filter" }];
  const fields = [
    filterField("Window", "window", dashboardData.filters.window_options, state.window),
    filterField("Lens", "lens", dashboardData.filters.lenses, state.lens),
    filterField("Category", "category", categoryFieldOptions, state.category, !categoryOptions.length),
    filterField("Fuel", "fuel", fuelFieldOptions, state.fuel, !fuelOptions.length),
    filterField("Listed company", "company", companyFieldOptions, state.company, !companyOptions.length),
  ];

  return `
    <section class="filters">
      <div class="filter-card">
        <div class="panel-header">
          <div>
            <p class="section-kicker">Global Filters</p>
            <h2>Choose the lens you want on the tape</h2>
          </div>
          <p class="section-subtitle">Filters only show controls that meaningfully change the visible data.</p>
        </div>
        <div class="filter-grid">
          ${fields.join("")}
        </div>
      </div>
    </section>
  `;
}

function filterField(label, id, options, selectedValue, disabled = false) {
  return `
    <label class="filter-field ${options.length <= 1 ? "is-static" : ""}">
      <span class="filter-label">${label}</span>
      <select data-filter="${id}" ${disabled ? "disabled" : ""}>
        ${options.map((option) => `
          <option value="${option.id}" ${option.id === selectedValue ? "selected" : ""}>${option.label}</option>
        `).join("")}
      </select>
    </label>
  `;
}

// "What's moved today" — first thing investors see when they open the dashboard.
// Combines top 1D stock movers (gainers + losers) with the most recent news
// headlines so a buy-side analyst can scan the past 24 hours of auto-sector
// signal in one glance before drilling into the data lenses below.
function renderWhatChangedToday() {
  const stocks = dashboardData.oem_stocks;
  const news = dashboardData.news;
  const stocksAvailable = stocks?.available;
  const newsAvailable = news?.available;
  if (!stocksAvailable && !newsAvailable) return "";

  // Movers: blend top-3 gainers with top-2 losers so the panel shows
  // both directions of the tape. Filter rows whose 1D delta is missing.
  let moversCol = "";
  if (stocksAvailable) {
    const stockEntries = Object.entries(stocks.stocks || {})
      .filter(([, v]) => v && v.change_1d_pct !== null && v.change_1d_pct !== undefined);
    const gainers = [...stockEntries]
      .sort((a, b) => b[1].change_1d_pct - a[1].change_1d_pct)
      .slice(0, 3);
    const losers = [...stockEntries]
      .sort((a, b) => a[1].change_1d_pct - b[1].change_1d_pct)
      .filter(([name]) => !gainers.find(([gName]) => gName === name))
      .slice(0, 2);
    const movers = [...gainers, ...losers];
    const fmtPct = (v) => `${v >= 0 ? "+" : ""}${Number(v).toFixed(2)}%`;
    const tone = (v) => (v >= 0 ? "positive" : "negative");
    const arrow = (v) => (v >= 0 ? "▲" : "▼");
    const companies = asArray(dashboardData.company_map).map((item) => item.company);
    const moverRows = movers.map(([company, stock]) => {
      const linkable = companies.includes(company);
      return `
        <li class="changed-mover ${linkable ? "is-linkable" : ""}" ${linkable ? `data-company-link="${company}"` : ""}>
          <span class="changed-mover-name">${company}</span>
          <span class="changed-mover-arrow stock-tone-${tone(stock.change_1d_pct)}">${arrow(stock.change_1d_pct)}</span>
          <span class="changed-mover-pct stock-tone-${tone(stock.change_1d_pct)}">${fmtPct(stock.change_1d_pct)}</span>
        </li>
      `;
    }).join("");
    const asOf = stocks.as_of_date
      ? new Date(stocks.as_of_date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
      : "";
    moversCol = `
      <div class="changed-col">
        <div class="changed-col-head">
          <p class="small-label">Top stock movers (1D)</p>
          ${asOf ? `<span class="changed-col-meta">${asOf}</span>` : ""}
        </div>
        ${movers.length ? `<ul class="changed-mover-list">${moverRows}</ul>` : '<p class="muted">No 1D moves available yet.</p>'}
      </div>
    `;
  }

  // News: pool every group's items, rank by published_at desc, take top 5.
  // The published_display field is already pre-formatted; fall back to the
  // raw published_at for the title attr.
  let newsCol = "";
  if (newsAvailable) {
    const newsItems = (news.groups || [])
      .flatMap((group) => (group.items || []).map((item) => ({ ...item, group: group.label })))
      .sort((a, b) => `${b.published_at || ""}`.localeCompare(`${a.published_at || ""}`))
      .slice(0, 5);
    const rows = newsItems.map((item) => `
      <li class="changed-news-item">
        <a href="${item.url}" target="_blank" rel="noopener" title="${escapeHtml(item.summary || "")}">
          <span class="changed-news-meta">${item.group || ""}${item.published_display ? ` · ${item.published_display}` : ""}</span>
          <span class="changed-news-title">${escapeHtml(item.title || "")}</span>
        </a>
      </li>
    `).join("");
    newsCol = `
      <div class="changed-col">
        <div class="changed-col-head">
          <p class="small-label">Latest headlines</p>
          <span class="changed-col-meta">Past ${news.window_days || 7} days</span>
        </div>
        ${newsItems.length ? `<ul class="changed-news-list">${rows}</ul>` : '<p class="muted">No fresh headlines.</p>'}
      </div>
    `;
  }

  return `
    <section id="section-what-changed" class="section panel section-anchor">
      <div class="panel-header">
        <div>
          <p class="section-kicker">What's moved today</p>
          <h2>Top stock action and fresh sector headlines</h2>
        </div>
        <p class="section-subtitle">Click a mover to jump to its company card. Headlines open the original source in a new tab.</p>
      </div>
      <div class="changed-grid">
        ${moversCol}
        ${newsCol}
      </div>
    </section>
  `;
}

function renderSourceVisibility() {
  const badges = dashboardData.summary.source_badges.filter((badge) => badge.status !== "hidden");
  return `
    <section id="section-source-visibility" class="section panel section-anchor">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Source Visibility</p>
          <h2>Every number carries its own source and freshness stamp</h2>
        </div>
        <p class="section-subtitle">Official sources stay primary. If a lens is weak or missing, it stays off the page.</p>
      </div>
      <div class="source-grid">
        ${badges.map((badge) => `
          <article class="info-card">
            <div class="info-card-head">
              <div>
                <p class="small-label">${badge.module}</p>
                <h3>${badge.source}</h3>
              </div>
              ${chip(badge.status, badge.status === "active" ? "active" : "hidden")}
            </div>
            <p class="source-note">${badge.last_updated ? `Updated ${badge.last_updated}` : "No live update stamp"}</p>
            <p class="muted">${badge.detail}</p>
            ${badge.url ? `<p><a href="${badge.url}" target="_blank" rel="noreferrer">Open source</a></p>` : ""}
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderRetailTrendOnly() {
  const retail = dashboardData.modules.retail;
  // When the user has flipped the 'Compare to prior year' toggle and we have
  // 24+ months of aggregated history (months_extended), use the latest 12
  // months as the visible X-axis and overlay the prior-cycle values. Falls
  // back to the standard snapshot window otherwise.
  const useExtended = state.compareToPriorCycle
    && Array.isArray(retail.months_extended)
    && retail.months_extended.length >= 24;
  const months = useExtended ? retail.months_extended.slice(-12) : sliceMonths(retail.months);
  const allowed = allowedCategories();
  const companyFocused = state.company !== "all";
  const visibleCategories = retail.category_cards.filter((item) => item.category !== "TOTAL" && allowed.includes(item.category));
  const strongest = visibleCategories.length
    ? visibleCategories.reduce((best, item) => (item.yoy_pct > best.yoy_pct ? item : best), visibleCategories[0])
    : retail.latest_snapshot?.top_category_yoy;
  const weakest = visibleCategories.length
    ? visibleCategories.reduce((worst, item) => (item.yoy_pct < worst.yoy_pct ? item : worst), visibleCategories[0])
    : retail.latest_snapshot?.bottom_category_yoy;
  const chosenCategories = state.category === "TOTAL"
    ? [
        ...(companyFocused ? [] : ["TOTAL"]),
        ...retail.category_cards.filter((item) => allowed.includes(item.category)).map((item) => item.category),
      ]
    : [state.category];

  // For prior-cycle overlay: build lookup keyed by month so we can find the
  // same month-of-year a year earlier for any current X position.
  const extendedLookup = useExtended
    ? new Map(retail.months_extended.map((m) => [m.month, m]))
    : null;
  const valueForCategory = (record, category) => {
    if (!record) return null;
    if (category === "TOTAL") return record.total_units;
    return record.categories?.find((e) => e.category === category)?.units ?? null;
  };

  const trendSeries = chosenCategories
    .filter((category) => category === "TOTAL" || retail.category_cards.some((item) => item.category === category))
    .flatMap((category) => {
      const label = category === "TOTAL" ? "Total retail" : labelForCategory(category);
      const color = category === "TOTAL" ? dashboardData.chart_colors.TOTAL : dashboardData.chart_colors[category];
      const currentValues = months.map((item) => valueForCategory(item, category));
      const out = [{ label, color, values: currentValues }];
      if (useExtended && extendedLookup) {
        const priorValues = months.map((m) => {
          const [y, mo] = m.month.split("-");
          const priorId = `${parseInt(y, 10) - 1}-${mo}`;
          return valueForCategory(extendedLookup.get(priorId), category);
        });
        if (priorValues.some((v) => v !== null && v !== undefined)) {
          out.push({
            label: `${label} · prior year`,
            color,
            values: priorValues,
            dashed: true,
          });
        }
      }
      return out;
    });

  registerDownload(
    "retail-trend",
    "fada_retail_trend.csv",
    [
      "month",
      "total_units",
      "PV_units",
      "2W_units",
      "3W_units",
      "CV_units",
      "TRACTOR_units",
      "CE_units",
    ],
    months.map((item) => ({
      month: item.month,
      total_units: item.total_units,
      PV_units: item.categories.find((entry) => entry.category === "PV")?.units || 0,
      "2W_units": item.categories.find((entry) => entry.category === "2W")?.units || 0,
      "3W_units": item.categories.find((entry) => entry.category === "3W")?.units || 0,
      CV_units: item.categories.find((entry) => entry.category === "CV")?.units || 0,
      TRACTOR_units: item.categories.find((entry) => entry.category === "TRACTOR")?.units || 0,
      CE_units: item.categories.find((entry) => entry.category === "CE")?.units || 0,
    })),
  );

  return `
    <section id="section-retail" class="section panel section-anchor">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Retail Pulse</p>
          <h2>FADA retail momentum and category mix</h2>
        </div>
        <p class="section-subtitle">${retail.source_meta.note}</p>
      </div>
      <div class="panel-grid one">
        <div class="chart-card">
          <div class="chart-title-row">
            <div>
              <p class="small-label">Monthly trend${useExtended ? " · <span class=\"compare-on-pill\">Prior-year overlay ON</span>" : ""}</p>
              <h3>${companyFocused ? "Retail momentum in company-linked categories" : "Retail momentum by category"}</h3>
            </div>
            <div class="button-row">
              ${renderSourceAction(retail.source_meta.url)}
              ${renderDownloadIcon("retail-trend")}
            </div>
          </div>
          ${useExtended ? `
            <div class="compare-banner">
              <strong>Prior-year overlay active.</strong> Solid lines = the latest 12 months. Dashed lines = the same 12 months one calendar year earlier. Toggle off via the orange button in the hero.
            </div>
          ` : (state.compareToPriorCycle ? `
            <div class="compare-banner compare-banner-warn">
              <strong>Prior-year overlay requested but data isn't deep enough yet.</strong> The retail history file needs ≥24 months of OEM-history coverage. Cron extends it monthly — try again later.
            </div>
          ` : "")}
          <div class="chart-frame">
            ${lineChart(months.map((item) => item.label), trendSeries, axisFormat, formatUnits, buildChartEvents())}
          </div>
          <div class="chart-legend">
            ${trendSeries.map((series) => legendItem(series.label, series.color)).join("")}
          </div>
        </div>
        <div class="chart-card">
          <div class="chart-title-row">
            <div>
              <p class="small-label">Latest month mix</p>
              <h3>Where the retail mix sits now</h3>
            </div>
          </div>
          <div class="stack-list">
            ${retail.latest_mix
              .filter((item) => item.category !== "TOTAL")
              .filter((item) => activeCategoryFilter() === "TOTAL" || item.category === activeCategoryFilter())
              .filter((item) => allowed.includes(item.category))
              .map((item) => stackRow(item.label, item.share_pct, item.share_pct, dashboardData.chart_colors[item.category]))
              .join("")}
          </div>
          <div class="mini-insight-grid">
            <div class="mini-insight">
              <span class="small-label">Fastest YoY</span>
              <strong>${strongest?.label || "-"}</strong>
              <p>${strongest ? formatSigned(strongest.yoy_pct) : "n.m."}</p>
            </div>
            <div class="mini-insight">
              <span class="small-label">Softest YoY</span>
              <strong>${weakest?.label || "-"}</strong>
              <p>${weakest ? formatSigned(weakest.yoy_pct) : "n.m."}</p>
            </div>
          </div>
        </div>
      </div>
      <div class="section-divider"></div>
      <div class="panel-grid three category-card-grid">
        ${retail.category_cards
          .filter((item) => item.category !== "TOTAL")
          .filter((item) => activeCategoryFilter() === "TOTAL" || item.category === activeCategoryFilter())
          .filter((item) => allowed.includes(item.category))
          .map(renderCategoryCard)
          .join("")}
      </div>
    </section>
  `;
}

function renderEvTab() {
  return `
    <section id="section-retail-ev" class="section panel section-anchor">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Retail Pulse</p>
          <h2>EV penetration and fuel mix</h2>
        </div>
        <p class="section-subtitle">Derived EV share from FADA's monthly category fuel mix.</p>
      </div>
      ${renderEvSection()}
    </section>
  `;
}

function renderChannelPulseTab() {
  return `
    <section id="section-channel-pulse" class="section panel section-anchor">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Retail Pulse</p>
          <h2>Channel pulse and dealer survey</h2>
        </div>
        <p class="section-subtitle">FADA's monthly dealer survey: liquidity, sentiment, growth expectations, and the urban-rural split.</p>
      </div>
      ${renderChannelPulse()}
    </section>
  `;
}

function renderRetailSection() {
  const retail = dashboardData.modules.retail;
  const months = sliceMonths(retail.months);
  const allowed = allowedCategories();
  const companyFocused = state.company !== "all";
  const visibleCategories = retail.category_cards.filter((item) => item.category !== "TOTAL" && allowed.includes(item.category));
  const strongest = visibleCategories.length
    ? visibleCategories.reduce((best, item) => (item.yoy_pct > best.yoy_pct ? item : best), visibleCategories[0])
    : retail.latest_snapshot?.top_category_yoy;
  const weakest = visibleCategories.length
    ? visibleCategories.reduce((worst, item) => (item.yoy_pct < worst.yoy_pct ? item : worst), visibleCategories[0])
    : retail.latest_snapshot?.bottom_category_yoy;
  const chosenCategories = state.category === "TOTAL"
    ? [
        ...(companyFocused ? [] : ["TOTAL"]),
        ...retail.category_cards.filter((item) => allowed.includes(item.category)).map((item) => item.category),
      ]
    : [state.category];

  const trendSeries = chosenCategories
    .filter((category) => category === "TOTAL" || retail.category_cards.some((item) => item.category === category))
    .map((category) => {
      if (category === "TOTAL") {
        return {
          label: "Total retail",
          color: dashboardData.chart_colors.TOTAL,
          values: months.map((item) => item.total_units),
        };
      }
      return {
        label: labelForCategory(category),
        color: dashboardData.chart_colors[category],
        values: months.map((item) => item.categories.find((entry) => entry.category === category)?.units || 0),
      };
    });

  registerDownload(
    "retail-trend",
    "fada_retail_trend.csv",
    [
      "month",
      "total_units",
      "PV_units",
      "2W_units",
      "3W_units",
      "CV_units",
      "TRACTOR_units",
      "CE_units",
    ],
    months.map((item) => ({
      month: item.month,
      total_units: item.total_units,
      PV_units: item.categories.find((entry) => entry.category === "PV")?.units || 0,
      "2W_units": item.categories.find((entry) => entry.category === "2W")?.units || 0,
      "3W_units": item.categories.find((entry) => entry.category === "3W")?.units || 0,
      CV_units: item.categories.find((entry) => entry.category === "CV")?.units || 0,
      TRACTOR_units: item.categories.find((entry) => entry.category === "TRACTOR")?.units || 0,
      CE_units: item.categories.find((entry) => entry.category === "CE")?.units || 0,
    })),
  );

  return `
    <section id="section-retail" class="section panel section-anchor">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Retail Pulse</p>
          <h2>FADA retail remains the cleanest live demand lens in this build</h2>
        </div>
        <p class="section-subtitle">${retail.source_meta.note}</p>
      </div>
      <div class="panel-grid one">
        <div class="chart-card">
          <div class="chart-title-row">
            <div>
              <p class="small-label">Monthly trend</p>
              <h3>${companyFocused ? "Retail momentum in company-linked categories" : "Retail momentum by category"}</h3>
            </div>
            <div class="button-row">
              ${renderSourceAction(retail.source_meta.url)}
              ${renderDownloadIcon("retail-trend")}
            </div>
          </div>
          <div class="chart-frame">
            ${lineChart(months.map((item) => item.label), trendSeries, axisFormat, formatUnits, buildChartEvents())}
          </div>
          <div class="chart-legend">
            ${trendSeries.map((series) => legendItem(series.label, series.color)).join("")}
          </div>
        </div>
        <div class="chart-card">
          <div class="chart-title-row">
            <div>
              <p class="small-label">Latest month mix</p>
              <h3>Where the retail mix sits now</h3>
            </div>
            <div class="button-row">
              ${renderSourceAction(retail.source_meta.url)}
            </div>
          </div>
          <div class="stack-list">
            ${retail.latest_mix
              .filter((item) => item.category !== "TOTAL")
              .filter((item) => activeCategoryFilter() === "TOTAL" || item.category === activeCategoryFilter())
              .filter((item) => allowed.includes(item.category))
              .map((item) => stackRow(item.label, item.share_pct, item.share_pct, dashboardData.chart_colors[item.category]))
              .join("")}
          </div>
          <div class="mini-insight-grid">
            <div class="mini-insight">
              <span class="small-label">Fastest YoY</span>
              <strong>${strongest?.label || "-"}</strong>
              <p>${strongest ? formatSigned(strongest.yoy_pct) : "n.m."}</p>
            </div>
            <div class="mini-insight">
              <span class="small-label">Softest YoY</span>
              <strong>${weakest?.label || "-"}</strong>
              <p>${weakest ? formatSigned(weakest.yoy_pct) : "n.m."}</p>
            </div>
          </div>
        </div>
      </div>
      <div class="section-divider"></div>
      <div class="panel-grid three category-card-grid">
        ${retail.category_cards
          .filter((item) => item.category !== "TOTAL")
          .filter((item) => activeCategoryFilter() === "TOTAL" || item.category === activeCategoryFilter())
          .filter((item) => allowed.includes(item.category))
          .map(renderCategoryCard)
          .join("")}
      </div>
      <div class="section-divider"></div>
      ${renderEvSection()}
      <div class="section-divider"></div>
      ${renderChannelPulse()}
      <div class="section-divider"></div>
      ${renderOemSection()}
    </section>
  `;
}

// Point-in-time N-month growth: latest month's category units vs the same
// category N months prior. Standard buy-side multi-horizon read (3M / 6M /
// 9M = momentum across short, medium, longer horizons). Looks up by
// YYYY-MM rather than array position because months_extended has gaps and
// one bogus row where a CY total got mislabelled as a month — bad rows
// are filtered by an upper-bound sanity check on total_units.
function computeCategoryTrailingGrowth(category, monthsExtended) {
  const byMonth = new Map();
  (monthsExtended || []).forEach((m) => {
    if ((m.total_units || 0) > 10_000_000) return; // discards CY-aggregate bogus rows
    const cat = (m.categories || []).find((c) => c.category === category);
    if (!cat || typeof cat.units !== "number") return;
    byMonth.set(m.month, cat.units);
  });
  if (!byMonth.size) {
    return { g3m: null, g6m: null, g9m: null };
  }
  const sortedKeys = [...byMonth.keys()].sort();
  const latest = sortedKeys[sortedKeys.length - 1];
  const latestUnits = byMonth.get(latest);

  const shiftMonths = (yyyymm, n) => {
    const [y, m] = yyyymm.split("-").map(Number);
    let mm = m - n;
    let yy = y;
    while (mm <= 0) { mm += 12; yy -= 1; }
    return `${yy}-${String(mm).padStart(2, "0")}`;
  };

  const growthAt = (n) => {
    const priorKey = shiftMonths(latest, n);
    const prior = byMonth.get(priorKey);
    if (prior === undefined || prior === 0) return null;
    return ((latestUnits - prior) / prior) * 100;
  };

  return {
    g3m: growthAt(3),
    g6m: growthAt(6),
    g9m: growthAt(9),
  };
}

function renderGrowthBlock(label, value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return `
      <div class="stat-block">
        <span class="small-label">${label}</span>
        <strong class="neutral">n.m.</strong>
      </div>
    `;
  }
  const tone = Number(value) >= 0 ? "positive" : "negative";
  return `
    <div class="stat-block">
      <span class="small-label">${label}</span>
      <strong class="${tone}">${formatSigned(value)}</strong>
    </div>
  `;
}

function renderCategoryCard(item) {
  const monthsExtended = dashboardData.modules.retail?.months_extended || [];
  const growth = computeCategoryTrailingGrowth(item.category, monthsExtended);
  return `
    <article class="chip-card">
      <div class="chip-card-head">
        <div>
          <p class="small-label">${item.label}</p>
          <h3>${formatLakh(item.units)}</h3>
        </div>
        ${chip(`${item.share_pct.toFixed(1)}% mix`, "active")}
      </div>
      <div class="stat-inline category-growth-grid">
        ${renderGrowthBlock("MoM", item.mom_pct)}
        ${renderGrowthBlock("3M", growth.g3m)}
        ${renderGrowthBlock("6M", growth.g6m)}
        ${renderGrowthBlock("9M", growth.g9m)}
        ${renderGrowthBlock("YoY", item.yoy_pct)}
      </div>
      <p class="table-note">3M / 6M / 9M = latest month vs N months prior; YoY = vs same month a year ago. n.m. shows where months_extended history has a gap.</p>
    </article>
  `;
}

function renderEvSection() {
  const retail = dashboardData.modules.retail;
  const stateRegistration = dashboardData.modules.state_registration;
  const months = sliceMonths(retail.ev_penetration_series);
  const selectedFuel = state.fuel === "all" ? null : state.fuel;
  const latestMix = retail.fuel_mix_latest
    .filter((item) => activeCategoryFilter() === "TOTAL" || item.category === activeCategoryFilter())
    .filter((item) => allowedCategories().includes(item.category));

  const evSeries = [
    {
      label: "Overall EV penetration",
      color: dashboardData.chart_colors.EV,
      values: months.map((item) => item.overall_ev_pct),
    },
  ];
  if (activeCategoryFilter() !== "TOTAL" && ["2W", "3W", "PV", "CV"].includes(activeCategoryFilter())) {
    evSeries.push({
      label: `${labelForCategory(activeCategoryFilter())} EV share`,
      color: dashboardData.chart_colors[activeCategoryFilter()],
      values: months.map((item) => item.by_category.find((entry) => entry.category === activeCategoryFilter())?.ev_share_pct || 0),
    });
  }

  registerDownload(
    "ev-trend",
    "fada_ev_penetration.csv",
    ["month", "overall_ev_pct", "overall_ev_units"],
    months.map((item) => ({
      month: item.month,
      overall_ev_pct: item.overall_ev_pct,
      overall_ev_units: item.overall_ev_units,
    })),
  );

  return `
    <div id="section-ev" class="panel-grid one section-anchor">
      <div class="chart-card">
        <div class="chart-title-row">
          <div>
            <p class="small-label">EV dashboard</p>
            <h3>Derived EV penetration from official retail fuel mix</h3>
          </div>
          <div class="button-row">
            ${renderDownloadIcon("ev-trend")}
          </div>
        </div>
        <div class="chart-frame">
          ${lineChart(months.map((item) => item.label), evSeries, (value) => `${value.toFixed(1)}%`, (value) => formatPct(value, 2), buildChartEvents())}
        </div>
        <div class="chart-legend">
          ${evSeries.map((series) => legendItem(series.label, series.color)).join("")}
        </div>
        <p class="legend-note">Caveat: this is a retail fuel-mix derivation from FADA, not a Vahan registration series.</p>
      </div>
      <div class="chart-card">
        <div class="chart-title-row">
          <div>
            <p class="small-label">Latest fuel mix</p>
            <h3>${selectedFuel ? `${selectedFuel} share by category` : "Fuel split in the latest retail month"}</h3>
          </div>
        </div>
        <div class="fuel-list">
          ${latestMix.map((category) => {
            const fuels = selectedFuel
              ? category.fuels.filter((item) => item.fuel === selectedFuel)
              : category.fuels;
            return `
              <div class="info-card">
                <div class="info-card-head">
                  <div>
                    <p class="small-label">${category.label}</p>
                    <h3>${selectedFuel ? selectedFuel : "Fuel mix"}</h3>
                  </div>
                </div>
                <div class="fuel-list">
                  ${fuels.map((fuel) => `
                    <div class="fuel-row">
                      <span>${fuel.fuel}</span>
                      <strong>${formatPct(fuel.share_pct, 2)}</strong>
                    </div>
                  `).join("")}
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
      ${stateRegistration.available ? `
        <div class="chart-card">
          ${renderStateRegistrationExplorer()}
        </div>
      ` : ""}
      <div id="section-ev-trend" class="chart-card section-anchor">
        ${renderEvTrendExplorer()}
      </div>
    </div>
  `;
}

function evCategoryOptions() {
  return [
    { id: "TOTAL", label: "All EV" },
    { id: "2W", label: "EV 2W" },
    { id: "3W", label: "EV 3W" },
    { id: "PV", label: "EV Passenger Vehicles" },
    { id: "CV", label: "EV Commercial Vehicles" },
  ];
}

function evOemTrackerDatasets() {
  // Trade-press derived monthly EV OEM tracker. We tried wiring live
  // Parivahan Vahan (per-maker EV registrations) on Apr-May 2026 but the
  // GitHub Actions runner IP times out / gets refused on every Parivahan
  // call, so the periodised "Live Vahan EV" chip group never populates.
  // Until we route through a paid Vahan API (ExpertView, DataDelve, etc.)
  // or a runner inside India, this hand-curated trade-press tracker is the
  // EV view on the dashboard. Numbers below are pulled from each segment's
  // monthly leaderboard article and cross-checked where FADA's OEM
  // annexure exposes the same brand.
  const PAID_API_NOTE =
    "Live per-maker Vahan refresh requires a paid API (Parivahan blocks public scraping from cloud IPs); this segment's monthly leaderboard is hand-curated from trade-press reports until that's wired.";

  return [
    {
      id: "E2W",
      label: "EV 2W",
      latest_month: "Mar 2026",
      total_units: 190941,
      compare_label: "Mar 2025 units",
      growth_label: "YoY growth",
      source_name: "Autocar Professional",
      source_url: "https://www.autocarpro.in/analysis-sales/tvs-bajaj-ather-hero-vida-power-record-e-2w-sales-in-march-190941-units-131893",
      note:
        "Mar 2026 high-speed e-2W retail leaderboard from Autocar Professional (record month at 1,90,941 units). " +
        "Pure-EV brands (Ather, Ola, Greaves) cross-check against FADA's Mar 2026 2W OEM annexure. " +
        PAID_API_NOTE,
      rows: [
        { oem: "TVS Motor", units: 49304, prior_units: 30815 },
        { oem: "Bajaj Auto", units: 46246, prior_units: 35302 },
        { oem: "Ather Energy", units: 35688, prior_units: 15652 },
        { oem: "Hero Vida", units: 21434, prior_units: 5018 },
        { oem: "Ola Electric", units: 10117, prior_units: 23634 },
        { oem: "Greaves Ampere", units: 7965, prior_units: 5648 },
      ],
    },
    {
      id: "E4W",
      label: "EV 4W",
      latest_month: "Mar 2026",
      total_units: 22315,
      compare_label: "Mar 2025 units",
      growth_label: "YoY growth",
      source_name: "RushLane",
      source_url: "https://www.rushlane.com/electric-car-sales-fy-2026-tata-mg-mahindra-hyundai-byd-kia-12543567.html",
      note:
        "Mar 2026 electric-car retail leaderboard from RushLane (record month at 22,315 units). " +
        "BYD, BMW and VinFast are pure-EV in India; legacy ICE OEMs (Tata, Mahindra, MG, Hyundai, Kia, Maruti) report only their EV-portfolio units here. " +
        PAID_API_NOTE,
      rows: [
        { oem: "Tata Motors", units: 8253, prior_units: 4020 },
        { oem: "Mahindra & Mahindra", units: 5244, prior_units: 508 },
        { oem: "JSW MG Motor", units: 5141, prior_units: 3490 },
        { oem: "Maruti Suzuki", units: 940, prior_units: 0 },
        { oem: "VinFast", units: 688, prior_units: 0 },
        { oem: "Hyundai", units: 473, prior_units: 93 },
        { oem: "Kia", units: 457, prior_units: null },
        { oem: "BMW", units: 434, prior_units: 239 },
        { oem: "BYD", units: 413, prior_units: 278 },
      ],
    },
    {
      id: "E3WG",
      label: "E-3W Goods",
      latest_month: "Mar 2026",
      total_units: 3710,
      compare_label: "Feb 2026 units",
      growth_label: "MoM growth",
      source_name: "EVReporter",
      source_url: "https://evreporter.com/india-ice-vs-ev-sales-for-top-2w-3w-4w-oems-in-march-2026/",
      note:
        "Mar 2026 e-cargo 3W (L5) OEM mix from EVReporter — Mahindra Last Mile Mobility leads with the highest EV share (56.7%) among legacy 3W players. " +
        "Comparable column is Feb 2026 because OEM-level Mar 2025 L5-cargo splits aren't widely published. " +
        PAID_API_NOTE,
      rows: [
        { oem: "Mahindra Last Mile Mobility", units: 705, prior_units: 571 },
        { oem: "Bajaj Auto", units: 511, prior_units: 453 },
        { oem: "Omega Seiki", units: 412, prior_units: 377 },
        { oem: "Atul Auto", units: 305, prior_units: 287 },
        { oem: "Euler Motors", units: 220, prior_units: 201 },
        { oem: "Green Evolve", units: 168, prior_units: 151 },
      ],
    },
    {
      id: "EBUS",
      label: "E-Bus",
      latest_month: "Mar 2026",
      total_units: 720,
      compare_label: "Feb 2026 units",
      growth_label: "MoM growth",
      source_name: "Sustainable Bus / Business Today FY26 tally",
      source_url: "https://www.businesstoday.in/latest/corporate/story/hinduja-groups-switch-mobility-becomes-top-selling-e-bus-maker-in-fy26-523563-2026-04-01",
      note:
        "Mar 2026 e-bus snapshot. JBM Electric led the month; Switch Mobility (Hinduja Group / Ashok Leyland) closed FY26 as the #1 OEM at 1,166 units full year. " +
        "Comparable column is Feb 2026 because monthly Mar 2025 OEM splits weren't widely reported. " +
        PAID_API_NOTE,
      rows: [
        { oem: "JBM Electric", units: 230, prior_units: 87 },
        { oem: "Switch Mobility", units: 195, prior_units: 280 },
        { oem: "PMI Electro Mobility", units: 130, prior_units: 63 },
        { oem: "Olectra Greentech", units: 95, prior_units: 46 },
        { oem: "Tata Motors", units: 40, prior_units: 35 },
      ],
    },
  ].map((dataset) => ({
    ...dataset,
    rows: dataset.rows.map((row) => {
      const share_pct = dataset.total_units ? (row.units / dataset.total_units) * 100 : null;
      const growth_pct = row.prior_units ? ((row.units - row.prior_units) / row.prior_units) * 100 : null;
      return {
        ...row,
        share_pct,
        growth_pct,
      };
    }),
  }));
}

function renderEvOemTracker() {
  const datasets = evOemTrackerDatasets();
  const selected = datasets.find((item) => item.id === state.evOemSegment) || datasets[0];
  if (!selected) {
    return "";
  }

  const columns = [
    { key: "oem", label: "OEM" },
    { key: "units", label: "Units", type: "int" },
    { key: "prior_units", label: selected.compare_label, type: "int" },
    { key: "share_pct", label: "% share", type: "pct" },
    { key: "growth_pct", label: selected.growth_label, type: "pct" },
  ];

  registerDownload(
    "ev-oem-tracker",
    `ev_oem_tracker_${slugify(selected.label)}.csv`,
    ["oem", "units", "prior_units", "share_pct", "growth_pct"],
    selected.rows.map((row) => ({
      oem: row.oem,
      units: row.units,
      prior_units: row.prior_units,
      share_pct: row.share_pct,
      growth_pct: row.growth_pct,
    })),
  );

  return `
    <div id="section-ev-oem-tracker" class="chart-card section-anchor">
      <div class="chart-title-row">
        <div>
          <p class="small-label">EV OEM tracker</p>
          <h3>${selected.label} leaderboard for ${selected.latest_month}</h3>
        </div>
        <div class="button-row">
          ${renderSourceAction(selected.source_url)}
          ${renderDownloadIcon("ev-oem-tracker")}
        </div>
      </div>
      <label class="filter-field compact">
        <span class="small-label">EV segment</span>
        <select data-ev-oem-segment>
          ${datasets.map((item) => `
            <option value="${item.id}" ${item.id === selected.id ? "selected" : ""}>${item.label}</option>
          `).join("")}
        </select>
      </label>
      <div class="stat-inline state-explorer-stats">
        <div class="stat-block">
          <span class="small-label">Latest month</span>
          <strong>${selected.latest_month}</strong>
        </div>
        <div class="stat-block">
          <span class="small-label">${selected.label} total</span>
          <strong>${formatUnits(selected.total_units)}</strong>
        </div>
        <div class="stat-block">
          <span class="small-label">Source</span>
          <strong>${selected.source_name}</strong>
        </div>
      </div>
      ${renderTable(`ev-oem-${selected.id}`, columns, selected.rows, "compact-table")}
      <p class="legend-note">${selected.note}</p>
    </div>
  `;
}

function buildEvTrendPoints(categoryId, period) {
  const monthlyPoints = asArray(dashboardData.modules.retail?.ev_penetration_series).map((item) => ({
    month: item.month,
    label: item.label,
    units: categoryId === "TOTAL"
      ? Number(item.overall_ev_units || 0)
      : Number(asArray(item.by_category).find((entry) => entry.category === categoryId)?.ev_units || 0),
  }));

  if (period === "M") {
    return monthlyPoints;
  }

  const buckets = new Map();
  monthlyPoints.forEach((point) => {
    const key = period === "Q" ? quarterKey(point.month) : yearKey(point.month);
    const label = period === "Q" ? quarterLabel(point.month) : yearLabel(point.month);
    const current = buckets.get(key) || { key, label, units: 0 };
    current.units += point.units;
    buckets.set(key, current);
  });

  return [...buckets.values()]
    .sort((left, right) => `${left.key}`.localeCompare(`${right.key}`))
    .map((item) => ({
      month: item.key,
      label: item.label,
      units: item.units,
    }));
}

function quarterKey(month) {
  const [yearText, monthText] = `${month}`.split("-");
  const year = Number(yearText || 0);
  const monthNumber = Number(monthText || 1);
  const quarter = Math.floor((monthNumber - 1) / 3) + 1;
  return `${year}-Q${quarter}`;
}

function quarterLabel(month) {
  const [yearText, monthText] = `${month}`.split("-");
  const year = Number(yearText || 0);
  const monthNumber = Number(monthText || 1);
  const quarter = Math.floor((monthNumber - 1) / 3) + 1;
  return `Q${quarter} ${year}`;
}

function yearKey(month) {
  return `${month}`.slice(0, 4);
}

function yearLabel(month) {
  return `${month}`.slice(0, 4);
}

function periodLabel(period) {
  return {
    M: "Monthly",
    Q: "Quarterly",
    Y: "Yearly",
  }[period] || "Monthly";
}

function renderEvTrendExplorer() {
  const retail = dashboardData.modules.retail;
  const categoryOptions = evCategoryOptions();
  const selectedCategory = categoryOptions.find((item) => item.id === state.evCategory) || categoryOptions[0];
  const trendPoints = buildEvTrendPoints(selectedCategory.id, state.evPeriod);
  const latestPoint = trendPoints[trendPoints.length - 1];
  const priorPoint = trendPoints.length > 1 ? trendPoints[trendPoints.length - 2] : null;
  const sequentialPct = latestPoint && priorPoint && priorPoint.units
    ? ((latestPoint.units - priorPoint.units) / priorPoint.units) * 100
    : null;

  registerDownload(
    "ev-category-trend",
    `all_india_${slugify(selectedCategory.label)}_${state.evPeriod.toLowerCase()}_trend.csv`,
    ["period", "units"],
    trendPoints.map((item) => ({
      period: item.label,
      units: item.units,
    })),
  );

  return `
    <div class="state-explorer">
      <div class="chart-title-row state-explorer-head">
        <div>
          <p class="small-label">All-India EV trend</p>
          <h3>${selectedCategory.label} units by ${periodLabel(state.evPeriod).toLowerCase()} trend</h3>
        </div>
        <div class="button-row">
          ${renderSourceAction(retail.source_meta.url)}
          ${renderDownloadIcon("ev-category-trend")}
        </div>
      </div>
      <div class="state-explorer-controls">
        <label class="filter-field compact">
          <span class="small-label">EV segment</span>
          <select data-ev-category>
            ${categoryOptions.map((item) => `
              <option value="${item.id}" ${item.id === selectedCategory.id ? "selected" : ""}>${item.label}</option>
            `).join("")}
          </select>
        </label>
        <div class="state-segment-switch" role="tablist" aria-label="EV trend periods">
          ${["M", "Q"].map((period) => `
            <button
              type="button"
              class="button ${state.evPeriod === period ? "button-primary" : ""}"
              data-ev-period="${period}"
            >
              ${period}
            </button>
          `).join("")}
        </div>
      </div>
      <div class="stat-inline state-explorer-stats">
        <div class="stat-block">
          <span class="small-label">Latest visible period</span>
          <strong>${latestPoint?.label || "-"}</strong>
        </div>
        <div class="stat-block">
          <span class="small-label">${selectedCategory.label} units</span>
          <strong>${formatUnits(latestPoint?.units || 0)}</strong>
        </div>
        <div class="stat-block">
          <span class="small-label">${state.evPeriod === "M" ? "Sequential move" : `${periodLabel(state.evPeriod)} move`}</span>
          <strong class="${(sequentialPct || 0) >= 0 ? "positive" : "negative"}">${sequentialPct === null ? "n.m." : formatSigned(sequentialPct)}</strong>
        </div>
      </div>
      <div class="chart-frame">
        ${lineChart(
          trendPoints.map((item) => item.label),
          [{
            label: selectedCategory.label,
            color: dashboardData.chart_colors.EV,
            values: trendPoints.map((item) => item.units),
          }],
          axisFormat,
          (value) => formatUnits(value),
        )}
      </div>
      <div class="chart-legend">
        ${legendItem(selectedCategory.label, dashboardData.chart_colors.EV)}
      </div>
      <p class="legend-note">Caveat: this EV trend is derived from FADA retail fuel mix, not Vahan EV registrations. Quarterly and yearly views roll up the visible monthly retail history already validated in this dashboard.</p>
    </div>
  `;
}

function renderStateRegistrationExplorer() {
  const module = dashboardData.modules.state_registration;
  const selectedState = asArray(module.states).find((item) => item.state === state.registrationState) || module.states[0];
  const selectedSegment = asArray(selectedState?.segments).find((item) => item.segment === state.registrationSegment)
    || asArray(selectedState?.segments)[0];
  const series = sliceMonths(asArray(selectedSegment?.series));
  const latestPoint = series[series.length - 1];
  const priorPoint = series.length > 1 ? series[series.length - 2] : null;
  const delta = latestPoint && priorPoint ? latestPoint.units - priorPoint.units : null;

  registerDownload(
    "state-registration-trend",
    `vahan_${slugify(selectedState?.label || "state")}_${selectedSegment?.segment || "segment"}_trend.csv`,
    ["month", "units"],
    series.map((item) => ({
      month: item.month,
      units: item.units,
    })),
  );

  return `
    <div id="section-state-registration" class="state-explorer">
      <div class="chart-title-row state-explorer-head">
        <div>
          <p class="small-label">Statewise Vahan registrations</p>
          <h3>Pick a state and segment to see the registration trend</h3>
        </div>
        <div class="button-row">
          ${renderSourceAction(module.source_meta.url)}
          ${renderDownloadIcon("state-registration-trend")}
        </div>
      </div>
      <div class="state-explorer-controls">
        <label class="filter-field compact">
          <span class="small-label">State / UT</span>
          <select data-registration-state>
            ${module.states.map((item) => `
              <option value="${item.state}" ${item.state === selectedState?.state ? "selected" : ""}>${item.label}</option>
            `).join("")}
          </select>
        </label>
        <div class="state-segment-switch" role="tablist" aria-label="State registration segments">
          ${module.segments.map((item) => `
            <button
              type="button"
              class="button ${item.id === selectedSegment?.segment ? "button-primary" : ""}"
              data-registration-segment="${item.id}"
              aria-pressed="${item.id === selectedSegment?.segment ? "true" : "false"}"
            >
              ${item.id}
            </button>
          `).join("")}
        </div>
      </div>
      <div class="stat-inline state-explorer-stats">
        <div class="stat-block">
          <span class="small-label">Latest validated month</span>
          <strong>${module.source_meta.latest_month ? monthLabel(module.source_meta.latest_month) : "-"}</strong>
        </div>
        <div class="stat-block">
          <span class="small-label">${selectedSegment?.label || "Segment"} units</span>
          <strong>${formatUnits(latestPoint?.units || 0)}</strong>
        </div>
        <div class="stat-block">
          <span class="small-label">Sequential move</span>
          <strong class="${delta === null ? "neutral" : delta >= 0 ? "positive" : "negative"}">${delta === null ? "n.m." : `${delta >= 0 ? "+" : ""}${formatUnits(delta)}`}</strong>
        </div>
      </div>
      <div class="chart-frame compact">
        ${lineChart(
          series.map((item) => item.label),
          [
            {
              label: `${selectedState?.label || ""} ${selectedSegment?.label || ""}`.trim(),
              color: dashboardData.chart_colors[selectedSegment?.segment || "PV"] || dashboardData.chart_colors.PV,
              values: series.map((item) => item.units),
            },
          ],
          axisFormat,
          formatUnits,
        )}
      </div>
      <p class="legend-note">${module.source_meta.note}</p>
      <p class="legend-note">${module.method_note}</p>
    </div>
  `;
}

// Compute the wholesale–retail wedge per category. SIAM dispatch (wholesale)
// minus FADA registrations (retail) is the cleanest non-PV proxy for dealer
// inventory pressure: positive cumulative wedge = OEMs stuffing the channel,
// negative = dealers running stock down faster than OEMs replenish.
//
// Categories returned are limited to those present in both data sources with
// reasonable comparability — PV and 2W. (SIAM 3W excludes e-rickshaws, so the
// 3W wedge would mis-state reality; CV monthly isn't in SIAM domestic_sales.)
function computeChannelWedges() {
  const retail = dashboardData.modules.retail;
  const wholesale = dashboardData.modules.wholesale;
  if (!retail?.months?.length || !wholesale?.months?.length) return [];
  const wholesaleByMonth = new Map((wholesale.months || []).map((m) => [m.month, m]));
  const cats = ["PV", "2W"];
  return cats.map((cat) => {
    const series = (retail.months || [])
      .filter((m) => wholesaleByMonth.has(m.month))
      .slice(-6)
      .map((r) => {
        const w = wholesaleByMonth.get(r.month);
        const retailUnits = (r.categories || []).find((c) => c.category === cat)?.units || 0;
        const wholesaleUnits = (w.domestic_sales || []).find((c) => c.category === cat)?.units || 0;
        return {
          month: r.month,
          label: r.label,
          retail: retailUnits,
          wholesale: wholesaleUnits,
          wedge: wholesaleUnits - retailUnits,
        };
      });
    const cumulative = series.reduce((acc, p) => acc + p.wedge, 0);
    const avgRetail = series.length
      ? series.reduce((acc, p) => acc + p.retail, 0) / series.length
      : 0;
    // Convert cumulative wedge to implied days-of-sales so investors can
    // read it on the same axis as the FADA "PV inventory days" metric.
    const impliedDays = avgRetail > 0 ? (cumulative / avgRetail) * 30 : null;
    return {
      category: cat,
      label: labelForCategory(cat),
      series,
      cumulative,
      impliedDays,
    };
  }).filter((entry) => entry.series.length >= 3);
}

function renderChannelPulse() {
  const retail = dashboardData.modules.retail;
  const pulse = retail.latest_channel_pulse;
  const inventoryTrend = asArray(retail.inventory_trend).slice(-3);
  const expectationTrend = asArray(retail.dealer_expectation_trend).slice(-3);
  const threeWheelSubsegments = asArray(retail.latest_subsegments["3W"]);
  const cvSubsegments = asArray(retail.latest_subsegments.CV);
  const urbanRuralRows = pulse.urban_rural_growth
    .filter((item) => item.category !== "TOTAL")
    .filter((item) => activeCategoryFilter() === "TOTAL" || item.category === activeCategoryFilter())
    .map((item) => ({
      ...item,
      label: labelForCategory(item.category),
    }));
  const cards = [
    `
      <div class="chart-card channel-card">
        <div class="chart-title-row">
          <div>
            <p class="small-label">Retail channel pulse</p>
            <h3>Inventory, outlook and dealer tone</h3>
          </div>
          <div class="button-row">
            ${renderSourceAction(retail.source_meta.url)}
          </div>
        </div>
        <div class="stat-inline stat-inline-compact">
          <div class="stat-block">
            <span class="small-label">PV inventory</span>
            <strong>${pulse.inventory_days_pv} days</strong>
          </div>
          <div class="stat-block">
            <span class="small-label">Next month growth view</span>
            <strong>${formatPct(pulse.growth_expectation_next_month_pct, 2)}</strong>
          </div>
          <div class="stat-block">
            <span class="small-label">3-month growth view</span>
            <strong>${formatPct(pulse.growth_expectation_next_three_months_pct, 2)}</strong>
          </div>
          <div class="stat-block">
            <span class="small-label">Liquidity good</span>
            <strong>${formatPct(pulse.liquidity_good_pct, 2)}</strong>
          </div>
          <div class="stat-block">
            <span class="small-label">Sentiment good</span>
            <strong>${formatPct(pulse.sentiment_good_pct, 2)}</strong>
          </div>
        </div>
        <div class="channel-note-grid">
          ${pulse.bullets.map((item) => `<div class="channel-note">${item}</div>`).join("")}
        </div>
        <div class="channel-trend-grid">
          <div class="mini-table-card">
            <p class="small-label">PV inventory trend</p>
            ${inventoryTrend.map((item) => `
              <div class="hero-meta-row compact">
                <span>${item.label}</span>
                <strong>${item.days_low}-${item.days_high}d</strong>
              </div>
            `).join("")}
          </div>
          <div class="mini-table-card">
            <p class="small-label">Dealer growth trend</p>
            ${expectationTrend.map((item) => `
              <div class="hero-meta-row compact">
                <span>${item.label}</span>
                <strong>${formatPct(item.next_month_growth_pct, 1)}</strong>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    `,
  ];

  // Wholesale–retail wedge: extends the inventory health view to non-PV
  // categories where FADA doesn't publish a days-of-stock survey number.
  // Cumulative wedge over the last 6 months is converted to "implied days
  // of sales" so investors can read it on the same axis as the PV survey.
  const wedges = computeChannelWedges();
  if (wedges.length) {
    const monthLabels = wedges[0].series.map((p) => p.label);
    const wedgeMonths = `${monthLabels[0]} – ${monthLabels[monthLabels.length - 1]}`;
    const wedgeColor = (cumulative) => cumulative > 0 ? "#cc4343" : "#2f897d";
    const wedgeTone = (cumulative) => cumulative > 0 ? "negative" : "positive";
    const wedgeReading = (entry) => {
      const days = Math.abs(entry.impliedDays || 0).toFixed(1);
      if (entry.cumulative > 0) {
        return `OEMs added <strong>${formatUnits(entry.cumulative)}</strong> units to dealer stock over the past 6 months — implied <strong>${days} days</strong> of extra inventory at the current retail pace. Watch for incentive ramps and channel destocking.`;
      }
      return `Dealers ran <strong>${formatUnits(Math.abs(entry.cumulative))}</strong> units of stock down — retail outpaced wholesale by ~<strong>${days} days</strong> of supply, a healthy demand-recognition signal.`;
    };
    registerDownload(
      "channel-wedge",
      "channel_wedge_wholesale_minus_retail.csv",
      ["category", "month", "label", "retail_units", "wholesale_units", "wedge_units"],
      wedges.flatMap((entry) => entry.series.map((p) => ({
        category: entry.category,
        month: p.month,
        label: p.label,
        retail_units: p.retail,
        wholesale_units: p.wholesale,
        wedge_units: p.wedge,
      }))),
    );
    cards.push(`
      <div class="chart-card channel-card">
        <div class="chart-title-row">
          <div>
            <p class="small-label">Wholesale–retail wedge</p>
            <h3>Channel-fill proxy for non-PV inventory health · ${wedgeMonths}</h3>
          </div>
          <div class="button-row">
            ${renderDownloadIcon("channel-wedge")}
          </div>
        </div>
        <p class="table-note" style="margin: 0 0 12px;">
          SIAM dispatch minus FADA retail: positive bars mean OEMs are pushing more units into dealers than dealers are selling out (channel-fill / inventory build), negative means dealers are running stock down. Cumulative figure is converted to implied days-of-sales so the read sits on the same axis as the FADA PV inventory survey.
        </p>
        <div class="wedge-grid">
          ${wedges.map((entry) => `
            <div class="wedge-card">
              <div class="wedge-card-head">
                <strong>${entry.label}</strong>
                <span class="wedge-cumulative ${wedgeTone(entry.cumulative)}">
                  ${entry.cumulative >= 0 ? "+" : ""}${formatUnits(entry.cumulative)}
                  ${entry.impliedDays !== null ? `<span class="wedge-days">(${entry.impliedDays >= 0 ? "+" : ""}${entry.impliedDays.toFixed(1)} days)</span>` : ""}
                </span>
              </div>
              <div class="chart-frame compact">
                ${lineChart(
                  entry.series.map((p) => p.label),
                  [{ label: "Wedge (units)", color: wedgeColor(entry.cumulative), values: entry.series.map((p) => p.wedge) }],
                  axisFormat,
                  formatUnits,
                )}
              </div>
              <p class="wedge-reading">${wedgeReading(entry)}</p>
            </div>
          `).join("")}
        </div>
        <p class="table-note" style="margin: 8px 0 0;">
          Tracked for PV and 2W only — the SIAM 3W series excludes e-rickshaws (most of the actual 3W retail mix), and SIAM doesn't publish CV at monthly cadence. Tractor / CE wholesale data sit with TMA / ICEMA respectively, not yet on this dashboard.
        </p>
      </div>
    `);
  }

  if (urbanRuralRows.length) {
    cards.push(`
      <div class="chart-card channel-card">
        <div class="chart-title-row">
          <div>
            <p class="small-label">Urban vs rural</p>
            <h3>Latest YoY and MoM spread</h3>
          </div>
          <div class="button-row">
            ${renderSourceAction(retail.source_meta.url)}
          </div>
        </div>
        ${renderTable(
          "urban-rural",
          [
            { key: "label", label: "Category" },
            { key: "urban_yoy_pct", label: "Urban YoY", type: "pct" },
            { key: "rural_yoy_pct", label: "Rural YoY", type: "pct" },
            { key: "urban_mom_pct", label: "Urban MoM", type: "pct" },
            { key: "rural_mom_pct", label: "Rural MoM", type: "pct" },
          ],
          urbanRuralRows,
        )}
      </div>
    `);
  }

  if (threeWheelSubsegments.length) {
    cards.push(`
      <div class="chart-card">
        <div class="chart-title-row">
          <div>
            <p class="small-label">3W mix</p>
            <h3>Latest 3W structure</h3>
          </div>
          <div class="button-row">
            ${renderSourceAction(retail.source_meta.url)}
          </div>
        </div>
        <div class="subsegment-list">
          ${threeWheelSubsegments.map((item) => `
            <div class="subsegment-row">
              <div>
                <strong>${item.label}</strong>
                <p class="table-note">${formatSigned(item.yoy_pct)} YoY | ${formatSigned(item.mom_pct)} MoM</p>
              </div>
              <strong>${formatUnits(item.units)}</strong>
            </div>
          `).join("")}
        </div>
      </div>
    `);
  }

  if (cvSubsegments.length) {
    cards.push(`
      <div class="chart-card">
        <div class="chart-title-row">
          <div>
            <p class="small-label">CV mix</p>
            <h3>Latest CV tonnage split</h3>
          </div>
          <div class="button-row">
            ${renderSourceAction(retail.source_meta.url)}
          </div>
        </div>
        <div class="subsegment-list">
          ${cvSubsegments.map((item) => `
            <div class="subsegment-row">
              <div>
                <strong>${item.label}</strong>
                <p class="table-note">${formatSigned(item.yoy_pct)} YoY | ${formatSigned(item.mom_pct)} MoM</p>
              </div>
              <strong>${formatUnits(item.units)}</strong>
            </div>
          `).join("")}
        </div>
      </div>
    `);
  }

  return `
    <div class="panel-grid one channel-grid">
      ${cards.join("")}
    </div>
  `;
}

function oemSegmentCatalog() {
  const tables = dashboardData.modules.retail?.latest_oem_tables || {};
  const fadaCategories = ["PV", "2W", "3W", "CV", "TRACTOR", "CE"];
  const fada = fadaCategories
    .filter((category) => tables[category])
    .map((category) => ({
      id: category,
      group: "fada",
      kind: "fada",
      label: labelForCategory(category) || category,
      table: tables[category],
    }));
  // When the Parivahan Vahan refresh has populated EV maker data, surface
  // those segments via the same periodized renderer as FADA. The labels stay
  // distinct (EV 2W / EV 4W / EV 3W / EV CV) so visitors can tell the data
  // source apart at a glance.
  const liveEvSegments = [
    { id: "E2W", label: "EV 2W (Vahan)" },
    { id: "EPV", label: "EV 4W (Vahan)" },
    { id: "E3W", label: "EV 3W (Vahan)" },
    { id: "ECV", label: "EV CV (Vahan)" },
  ];
  const liveEv = liveEvSegments
    .filter((segment) => tables[segment.id])
    .map((segment) => ({
      id: segment.id,
      group: "live-ev",
      kind: "fada", // same renderer path; vahan_live tables share the periodized shape
      label: segment.label,
      table: tables[segment.id],
    }));
  // Curated trade-press EV trackers (E2W from Autocar Pro, E4W from RushLane,
  // E-3W Goods from EVReporter, E-Bus from Sustainable Bus). These stay as
  // single-month leaderboards; Vahan-backed chips above are the periodized
  // companions.
  const ev = evOemTrackerDatasets().map((dataset) => ({
    id: dataset.id,
    group: "ev",
    kind: "ev",
    label: dataset.label,
    dataset,
  }));
  return [...fada, ...liveEv, ...ev];
}

function activeOemSegment(segments) {
  return segments.find((segment) => segment.id === state.oemSegment) || segments[0];
}

function renderOemSegmentChips(segments, activeId) {
  const renderChip = (segment) => `
    <button
      class="oem-chip${segment.id === activeId ? " is-active" : ""}"
      data-oem-segment="${segment.id}"
      type="button"
    >${segment.label}</button>
  `;
  const fadaChips = segments.filter((segment) => segment.group === "fada").map(renderChip).join("");
  const liveEvChips = segments.filter((segment) => segment.group === "live-ev").map(renderChip).join("");
  const evChips = segments.filter((segment) => segment.group === "ev").map(renderChip).join("");
  return `
    <div class="oem-chip-row">
      <div class="oem-chip-group">
        <span class="oem-chip-group-label">FADA retail</span>
        <div class="oem-chip-group-items">${fadaChips}</div>
      </div>
      ${liveEvChips ? `
        <div class="oem-chip-group">
          <span class="oem-chip-group-label">Live Vahan EV</span>
          <div class="oem-chip-group-items">${liveEvChips}</div>
        </div>
      ` : ""}
      ${evChips ? `
        <div class="oem-chip-group">
          <span class="oem-chip-group-label">EV trade tracker</span>
          <div class="oem-chip-group-items">${evChips}</div>
        </div>
      ` : ""}
    </div>
  `;
}

function renderUnifiedOemTable(segment) {
  if (segment.kind === "fada") {
    const table = segment.table;
    if (table.mode === "vahan_live" || table.mode === "periodized") {
      return renderUnifiedFadaPeriodizedTable(segment.id, table);
    }
    return renderUnifiedFadaFlatTable(segment.id, table);
  }
  return renderUnifiedEvTable(segment.dataset);
}

function renderUnifiedFadaFlatTable(category, table) {
  const rows = asArray(table.rows);
  const periodLabelText = table.source_meta?.latest_label
    || dashboardData.modules.retail?.source_meta?.latest_month
    || dashboardData.modules.retail?.latest_month
    || "";
  const key = `unified-oem-${slugify(category)}`;
  registerDownload(
    key,
    `fada_${category.toLowerCase()}_oem_table.csv`,
    ["oem", "units", "prior_units", "share_pct", "share_change_pp", "unit_growth_pct"],
    rows.map((row) => ({
      oem: row.oem,
      units: row.units,
      prior_units: row.prior_units,
      share_pct: row.share_pct,
      share_change_pp: row.share_change_pp,
      unit_growth_pct: row.unit_growth_pct,
    })),
  );
  const label = table.label || labelForCategory(category) || category;
  return `
    <div class="oem-table-frame">
      <div class="oem-table-heading">
        <h3>${label}${periodLabelText ? ` · ${periodLabelText}` : ""}</h3>
        <p class="table-note">FADA YoY market share annexure. Current units shown against same month prior year.</p>
      </div>
      ${renderTable(
        key,
        [
          { key: "oem", label: "OEM" },
          { key: "units", label: "Current units", type: "int" },
          { key: "prior_units", label: "Prior-year units", type: "int" },
          { key: "share_pct", label: "Share", type: "pct" },
          { key: "share_change_pp", label: "Share Δ", type: "pp" },
          { key: "unit_growth_pct", label: "YoY", type: "pct" },
        ],
        rows,
        "oem-unified-table",
        { key: "units", dir: "desc" },
      )}
    </div>
  `;
}

function renderUnifiedFadaPeriodizedTable(category, table) {
  const periods = asObject(table.periods);
  const selectedPeriodId = state.liveOemPeriods[category] || table.default_period || Object.keys(periods)[0] || "M";
  const selectedPeriod = asObject(periods[selectedPeriodId] || periods[table.default_period] || periods.M || Object.values(periods)[0]);
  const periodId = selectedPeriod.id || selectedPeriodId || "M";
  const periodRows = asArray(selectedPeriod.rows);
  const columns = asArray(selectedPeriod.columns);
  const key = `unified-oem-${slugify(category)}-${periodId.toLowerCase()}`;
  const sourceName = table.source_meta?.name || "FADA";
  const downloadPrefix = slugify(sourceName || "oem");
  registerDownload(
    key,
    `${downloadPrefix}_${slugify(category)}_oem_${periodId.toLowerCase()}.csv`,
    columns.map((column) => column.key),
    periodRows,
  );
  const availablePeriods = ["M", "Q", "Y"].filter((period) => periods[period] && asArray(periods[period].rows).length > 0);
  const label = table.label || labelForCategory(category) || category;
  return `
    <div class="oem-table-frame">
      <div class="oem-table-heading">
        <h3>${label}${selectedPeriod.period_label ? ` · ${selectedPeriod.period_label}` : ""}</h3>
        ${availablePeriods.length > 1 ? `
          <div class="oem-period-switch">
            ${availablePeriods.map((period) => `
              <button
                class="oem-period-button${state.liveOemPeriods[category] === period ? " is-active" : ""}"
                data-live-oem-category="${category}"
                data-live-oem-period="${period}"
                type="button"
              >${period}</button>
            `).join("")}
          </div>
        ` : ""}
      </div>
      ${renderTable(key, columns, periodRows, "oem-unified-table", { key: "current_units", dir: "desc" })}
      ${selectedPeriod.note ? `<p class="table-note">${selectedPeriod.note}</p>` : ""}
    </div>
  `;
}

function renderUnifiedEvTable(dataset) {
  const key = `unified-oem-${slugify(dataset.id)}`;
  const columns = [
    { key: "oem", label: "OEM" },
    { key: "units", label: "Units", type: "int" },
    { key: "prior_units", label: dataset.compare_label, type: "int" },
    { key: "share_pct", label: "Share", type: "pct" },
    { key: "growth_pct", label: dataset.growth_label, type: "pct" },
  ];
  registerDownload(
    key,
    `ev_oem_tracker_${slugify(dataset.label)}.csv`,
    ["oem", "units", "prior_units", "share_pct", "growth_pct"],
    dataset.rows.map((row) => ({
      oem: row.oem,
      units: row.units,
      prior_units: row.prior_units,
      share_pct: row.share_pct,
      growth_pct: row.growth_pct,
    })),
  );
  return `
    <div class="oem-table-frame">
      <div class="oem-table-heading">
        <h3>${dataset.label} · ${dataset.latest_month}</h3>
        <p class="table-note">${dataset.note}</p>
      </div>
      ${renderTable(key, columns, dataset.rows, "oem-unified-table", { key: "units", dir: "desc" })}
    </div>
  `;
}

function renderUnifiedCompanySpotlight() {
  const trends = asArray(dashboardData.modules.retail?.company_unit_trends);
  if (!trends.length) {
    return "";
  }
  const visibleTrends = state.company === "all"
    ? trends
    : trends.filter((item) => item.company === state.company);
  if (!visibleTrends.length) {
    return "";
  }
  const selected = visibleTrends.find((item) => item.company === state.companyTrend) || visibleTrends[0];
  const series = asArray(selected.series).slice(-6);
  const latestPoint = series.at(-1);
  registerDownload(
    "company-unit-trend",
    `${selected.company.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_company_units.csv`,
    ["month", "label", "units", "source_url"],
    series.map((point) => ({
      month: point.month,
      label: point.label,
      units: point.units,
      source_url: point.source_url,
    })),
  );

  // Peer-overlay: build one line per primary + each compared peer, anchored to
  // the primary's time window so charts stay coherent even when peer reporting
  // cadences differ. Indexed mode rebases each line to 100 at its first visible
  // point so very different scales (Maruti ~200k vs Atul ~1k) become readable.
  const peerPalette = [
    dashboardData.chart_colors.PV,
    dashboardData.chart_colors["2W"],
    dashboardData.chart_colors["3W"],
    dashboardData.chart_colors.CV,
    dashboardData.chart_colors.TRACTOR,
    dashboardData.chart_colors.EV,
    dashboardData.chart_colors.CE,
  ];
  const primaryMonths = series.map((point) => point.month);
  const peerCompanies = state.companyTrendCompare
    .map((name) => visibleTrends.find((item) => item.company === name))
    .filter((item) => item && item.company !== selected.company);
  const buildAlignedValues = (points) => {
    const byMonth = new Map();
    asArray(points).forEach((point) => {
      if (point && point.month) byMonth.set(point.month, point.units);
    });
    return primaryMonths.map((month) => {
      const value = byMonth.get(month);
      return value === undefined || value === null ? null : value;
    });
  };
  const indexValues = (values) => {
    const base = values.find((value) => value !== null && value !== undefined && value !== 0);
    if (!base) return values.map(() => null);
    return values.map((value) => (value === null || value === undefined ? null : (value / base) * 100));
  };
  const indexed = state.companyTrendIndexed;
  const primarySeries = {
    label: selected.label,
    color: dashboardData.chart_colors.TOTAL,
    values: indexed ? indexValues(series.map((point) => point.units)) : series.map((point) => point.units),
  };
  const peerSeries = peerCompanies.map((peer, idx) => {
    const aligned = buildAlignedValues(peer.series);
    return {
      label: peer.label,
      color: peerPalette[idx % peerPalette.length],
      values: indexed ? indexValues(aligned) : aligned,
    };
  });
  const chartSeries = [primarySeries, ...peerSeries];
  const valueFormatter = indexed
    ? (v) => v == null ? "" : `${Number(v).toFixed(0)}`
    : axisFormat;
  const tooltipFormatter = indexed
    ? (v) => v == null ? "" : `${Number(v).toFixed(1)} (idx)`
    : formatUnits;

  // Legend pulls double duty as a compare picker: the primary chip shows the
  // active selection (greyed; not togglable), peer chips are clickable.
  const peerChips = visibleTrends
    .filter((item) => item.company !== selected.company)
    .map((item, idx) => {
      const active = state.companyTrendCompare.includes(item.company);
      const colorIdx = state.companyTrendCompare.indexOf(item.company);
      const color = active ? peerPalette[colorIdx % peerPalette.length] : "transparent";
      return `
        <button
          type="button"
          class="spotlight-peer-chip${active ? " is-active" : ""}"
          data-company-trend-peer="${item.company}"
          style="--peer-color:${color};"
        >
          <span class="spotlight-peer-swatch" aria-hidden="true"></span>
          ${item.label}
        </button>
      `;
    })
    .join("");

  return `
    <div class="oem-spotlight">
      <div class="oem-spotlight-head">
        <div>
          <p class="small-label">Listed-company spotlight</p>
          <h3>${selected.label}${peerCompanies.length ? ` <span class="spotlight-vs">vs ${peerCompanies.length} peer${peerCompanies.length === 1 ? "" : "s"}</span>` : ""}</h3>
          <p class="table-note">${selected.concept}</p>
        </div>
        <div class="oem-spotlight-controls">
          <select class="filter-select" data-company-trend>
            ${visibleTrends.map((item) => `
              <option value="${item.company}" ${item.company === selected.company ? "selected" : ""}>${item.label}</option>
            `).join("")}
          </select>
          <button
            type="button"
            class="spotlight-index-toggle${indexed ? " is-active" : ""}"
            data-action="toggle-company-trend-indexed"
            title="Rebase every line to 100 at its first visible month — useful when peers have very different scales."
          >Index = 100</button>
          ${latestPoint?.source_url ? renderSourceAction(latestPoint.source_url, "Latest filing") : ""}
        </div>
      </div>
      <div class="spotlight-compare-row">
        <span class="spotlight-compare-label">Compare with peers:</span>
        ${peerChips || '<span class="spotlight-compare-empty">No peers reporting in this segment.</span>'}
      </div>
      <div class="chart-frame compact">
        ${lineChart(
          series.map((point) => point.label),
          chartSeries,
          valueFormatter,
          tooltipFormatter,
          buildChartEvents({ company: selected.company }),
        )}
      </div>
    </div>
  `;
}

function renderOemSection() {
  const segments = oemSegmentCatalog();
  if (!segments.length) {
    return "";
  }
  if (!segments.some((segment) => segment.id === state.oemSegment)) {
    state.oemSegment = segments[0].id;
  }
  const active = activeOemSegment(segments);
  const sourceUrl = active.kind === "fada"
    ? (active.table?.source_meta?.url || dashboardData.modules.retail?.source_meta?.url)
    : active.dataset?.source_url;
  const sourceName = active.kind === "fada"
    ? (active.table?.source_meta?.name || dashboardData.modules.retail?.source_meta?.name || "FADA")
    : (active.dataset?.source_name || "Source");
  const downloadKey = active.kind === "fada"
    ? (active.table?.mode === "vahan_live" || active.table?.mode === "periodized"
        ? `unified-oem-${slugify(active.id)}-${(state.liveOemPeriods[active.id] || active.table.default_period || "M").toLowerCase()}`
        : `unified-oem-${slugify(active.id)}`)
    : `unified-oem-${slugify(active.id)}`;

  return `
    <div id="section-oem-tracker" class="oem-section section-anchor">
      <div class="oem-section-head">
        <div>
          <p class="section-kicker">OEM Tracker</p>
          <h2>One leaderboard for every retail segment</h2>
          <p class="section-subtitle">FADA's monthly OEM annexure for ICE-led categories, plus the most recent EV trade tracker for electric segments. Pick a chip to switch view.</p>
        </div>
        <div class="oem-section-actions">
          ${sourceUrl ? `<a class="oem-source-pill" href="${sourceUrl}" target="_blank" rel="noopener">${sourceName} · view source</a>` : ""}
          ${renderDownloadIcon(`${downloadKey}`)}
        </div>
      </div>
      ${renderOemSegmentChips(segments, active.id)}
      <div class="oem-section-body">
        ${renderUnifiedOemTable(active)}
        ${renderUnifiedCompanySpotlight()}
      </div>
    </div>
  `;
}

function setupOemSection() {
  document.querySelectorAll("[data-oem-segment]").forEach((node) => {
    node.addEventListener("click", () => {
      const value = node.getAttribute("data-oem-segment");
      if (!value || value === state.oemSegment) {
        return;
      }
      state.oemSegment = value;
      render();
    });
  });
}

// Names appearing in FADA / Vahan OEM tables that don't exactly match the
// listed-company name in dashboardData.company_map. Add a row here to make
// the OEM drill-down (click row → jump to company card) resolve correctly.
const OEM_TO_COMPANY_ALIASES = {
  "Mahindra Group": "Mahindra & Mahindra",
  "Mahindra Tractors": "Mahindra & Mahindra",
  "Swaraj": "Mahindra & Mahindra",
  "Ashok Leyland Group": "Ashok Leyland",
  "Royal Enfield": "Eicher Motors",
  "VE Commercial Vehicles": "Eicher Motors",
  "Eicher Tractors": "Eicher Motors",
  "Escorts Kubota CE": "Escorts Kubota",
  "Mahindra Electric Automobile": "Mahindra & Mahindra",
};

function oemToCompanyMap(oemName) {
  if (!oemName) return null;
  const trimmed = `${oemName}`.trim();
  const companies = asArray(dashboardData.company_map).map((item) => item.company);
  if (companies.includes(trimmed)) return trimmed;
  const alias = OEM_TO_COMPANY_ALIASES[trimmed];
  if (alias && companies.includes(alias)) return alias;
  return null;
}

// After the OEM tables render, walk each row and — for any OEM that maps
// to a listed-company card — make the row clickable. Click switches to the
// Companies tab and scrolls to that company's drill-down so investors can
// pivot from "who's gaining share" → "what's the public-market read" in one
// click. Rows without a public-market name stay inert.
function setupOemDrilldown() {
  document.querySelectorAll(".oem-unified-table tbody tr").forEach((row) => {
    const firstCell = row.querySelector("td");
    if (!firstCell) return;
    const oemName = firstCell.textContent.trim();
    const mapped = oemToCompanyMap(oemName);
    if (!mapped) return;
    row.classList.add("is-linkable");
    row.setAttribute("data-company-link", mapped);
    firstCell.innerHTML = `<span class="oem-link"><span class="oem-link-text">${escapeHtml(oemName)}</span><span class="oem-link-arrow" aria-hidden="true">↗</span></span>`;
    row.addEventListener("click", () => {
      state.companyMapFocus = mapped;
      pendingScrollTarget = "company-drilldown";
      render();
    });
  });
}

// Snapshot a rendered SVG line chart to a PNG file at 2× scale and trigger
// a browser download. Buy-side analysts paste these into IC memos / pitch
// books constantly — the existing CSV download stays useful for modelling,
// PNG covers the screenshot use case.
function exportSvgAsPng(svg, filenameBase) {
  if (!svg) return;
  const viewBox = svg.viewBox?.baseVal;
  const width = viewBox?.width || svg.clientWidth || 820;
  const height = viewBox?.height || svg.clientHeight || 320;
  const cloned = svg.cloneNode(true);
  cloned.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  cloned.setAttribute("width", `${width}`);
  cloned.setAttribute("height", `${height}`);
  // Inline a white background so the PNG isn't transparent — ICs paste these
  // straight into Word / PowerPoint where transparent background looks broken.
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", `${width}`);
  bg.setAttribute("height", `${height}`);
  bg.setAttribute("fill", "#ffffff");
  cloned.insertBefore(bg, cloned.firstChild);

  const xml = new XMLSerializer().serializeToString(cloned);
  const svgBlob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      URL.revokeObjectURL(url);
      return;
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      const safeName = `${filenameBase || "chart"}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80) || "chart";
      link.download = `${safeName}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 1500);
    }, "image/png");
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

// Inject PNG download icons next to every existing Excel download icon in
// chart cards so investors can grab a screenshot-grade copy of any chart.
// Idempotent: re-running on subsequent renders skips already-decorated nodes.
function setupPngExports() {
  document.querySelectorAll(".download-icon[data-download-key]").forEach((excelBtn) => {
    if (excelBtn.parentElement?.querySelector("[data-action='download-png']")) return;
    const card = excelBtn.closest(".chart-card, .oem-spotlight, .channel-card");
    const svg = card?.querySelector("svg.line-chart");
    if (!svg) return;
    const wrap = document.createElement("span");
    wrap.innerHTML = PNG_ICON_HTML;
    const btn = wrap.firstElementChild;
    if (!btn) return;
    excelBtn.insertAdjacentElement("afterend", btn);
    const titleText = card?.querySelector("h3")?.textContent?.trim() || "chart";
    btn.addEventListener("click", () => exportSvgAsPng(svg, titleText));
  });
}

// Wire stock-mover rows in "What's moved today" to the same drill-down as the
// OEM table — single source of truth for "company name → company card".
function setupChangedMovers() {
  document.querySelectorAll(".changed-mover.is-linkable").forEach((node) => {
    node.addEventListener("click", () => {
      const company = node.getAttribute("data-company-link");
      if (!company) return;
      state.companyMapFocus = company;
      pendingScrollTarget = "company-drilldown";
      render();
    });
  });
}

function renderOemTables() {
  const tables = dashboardData.modules.retail.latest_oem_tables;
  const categories = state.category === "TOTAL"
    ? ["PV", "2W", "CV", "TRACTOR", "3W", "CE"].filter((category) => allowedCategories().includes(category))
    : [state.category].filter((category) => tables[category]);

  return `
    <div id="section-oem-tracker" class="section-anchor">
      <div class="panel-header compact">
        <div>
          <p class="section-kicker">OEM Tracker</p>
          <h2>Brand share, rank and unit movement</h2>
        </div>
        <div class="button-row">
          <p class="section-subtitle">Company selections jump here first because this is where listed OEM changes show up most clearly.</p>
          ${renderSourceAction(dashboardData.modules.retail?.source_meta?.url)}
        </div>
      </div>
      <div class="panel-grid one">
      ${categories.map((category) => renderOemTable(category, tables[category])).join("")}
      </div>
      ${renderCompanyUnitTrend()}
    </div>
  `;
}

function renderStockSparkline(closes) {
  // Inline SVG sparkline. Returns "" when there aren't enough data points
  // to draw a meaningful line (typically pre-cron-run state).
  if (!Array.isArray(closes) || closes.length < 4) return "";
  const W = 200;
  const H = 36;
  const PAD = 2;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = (max - min) || 1;
  const innerW = W - PAD * 2;
  const innerH = H - PAD * 2;
  const points = closes.map((v, i) => {
    const x = PAD + (i / (closes.length - 1)) * innerW;
    const y = PAD + innerH - ((v - min) / range) * innerH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const trendPositive = closes[closes.length - 1] >= closes[0];
  const stroke = trendPositive ? "#1d5a4f" : "#8a2727";
  const fill = trendPositive ? "rgba(47,137,125,0.16)" : "rgba(204,67,67,0.12)";
  // Build a closed polygon for the area fill (sparkline + bottom edge).
  const lastX = PAD + innerW;
  const baselineY = H - PAD;
  const areaPath = `M ${PAD},${baselineY} L ${points.join(" ")} L ${lastX.toFixed(1)},${baselineY} Z`;
  const linePath = `M ${points.join(" L ")}`;
  return `
    <svg class="stock-chip-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <path d="${areaPath}" fill="${fill}" stroke="none" />
      <path d="${linePath}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  `;
}

function renderStockChip(companyName) {
  const stocks = dashboardData.oem_stocks;
  if (!stocks?.available) return "";
  const stock = stocks.stocks?.[companyName];
  if (!stock) return "";
  const fmtPct = (v) => {
    if (v === null || v === undefined) return "—";
    const sign = v >= 0 ? "+" : "";
    return `${sign}${v.toFixed(2)}%`;
  };
  const tone = (v) => (v === null || v === undefined ? "neutral" : (v >= 0 ? "positive" : "negative"));
  const fmtPrice = (v) => v == null ? "—" : v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const exchange = stocks.exchange || "NSE";
  const sparkline = renderStockSparkline(stock.closes_30d);
  return `
    <div class="stock-chip">
      <div class="stock-chip-head">
        <span class="stock-chip-ticker">${exchange}: ${stock.ticker || "—"}</span>
        <a class="stock-chip-link" href="${stock.yahoo_url || "#"}" target="_blank" rel="noopener" title="View on Yahoo Finance">↗</a>
      </div>
      <p class="stock-chip-price">₹${fmtPrice(stock.price)}</p>
      ${sparkline ? `<div class="stock-chip-spark-wrap" title="Last 30 trading days">${sparkline}</div>` : ""}
      <div class="stock-chip-changes">
        <span class="stock-chip-pill stock-tone-${tone(stock.change_1d_pct)}">
          <span class="stock-chip-pill-label">1D</span>
          <span class="stock-chip-pill-value">${fmtPct(stock.change_1d_pct)}</span>
        </span>
        <span class="stock-chip-pill stock-tone-${tone(stock.change_1w_pct)}">
          <span class="stock-chip-pill-label">1W</span>
          <span class="stock-chip-pill-value">${fmtPct(stock.change_1w_pct)}</span>
        </span>
        <span class="stock-chip-pill stock-tone-${tone(stock.change_1m_pct)}">
          <span class="stock-chip-pill-label">1M</span>
          <span class="stock-chip-pill-value">${fmtPct(stock.change_1m_pct)}</span>
        </span>
      </div>
    </div>
  `;
}

function renderCompanyUnitTrend() {
  const trends = asArray(dashboardData.modules.retail?.company_unit_trends);
  if (!trends.length) {
    return "";
  }

  const visibleTrends = state.company === "all"
    ? trends
    : trends.filter((item) => item.company === state.company);
  if (!visibleTrends.length) {
    return "";
  }

  const selected = visibleTrends.find((item) => item.company === state.companyTrend) || visibleTrends[0];
  const series = asArray(selected.series).slice(-6);
  const latestPoint = series.at(-1);

  registerDownload(
    "company-unit-trend",
    `${selected.company.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_company_units.csv`,
    ["month", "label", "units", "source_url"],
    series.map((point) => ({
      month: point.month,
      label: point.label,
      units: point.units,
      source_url: point.source_url,
    })),
  );

  return `
    <div class="panel-grid one company-trend-block">
      <article class="chart-card company-trend-card">
        <div class="chart-title-row">
          <div>
            <p class="small-label">Company unit trend</p>
            <h3>Last ${series.length} reported periods of company units</h3>
          </div>
          <div class="button-row">
            ${latestPoint?.source_url ? renderSourceAction(latestPoint.source_url, "Latest source") : ""}
            ${renderDownloadIcon("company-unit-trend")}
          </div>
        </div>
        <div class="company-trend-toolbar">
          <div class="filter-field compact">
            <label class="filter-label" for="company-trend-select">Company</label>
            <select id="company-trend-select" class="filter-select" data-company-trend>
              ${visibleTrends.map((item) => `
                <option value="${item.company}" ${item.company === selected.company ? "selected" : ""}>${item.label}</option>
              `).join("")}
            </select>
          </div>
          <div class="company-trend-meta">
            <strong>${selected.label}</strong>
            <p class="table-note">${selected.concept}</p>
          </div>
          ${renderStockChip(selected.label)}
        </div>
        <div class="chart-frame compact">
          ${lineChart(
            series.map((point) => point.label),
            [{ label: selected.label, color: dashboardData.chart_colors.TOTAL, values: series.map((point) => point.units) }],
            axisFormat,
            formatUnits,
          )}
        </div>
        <p class="legend-note">This chart uses company-reported unit series from official company disclosures. Some companies report monthly while others disclose quarterly periods. It is intentionally kept separate from FADA retail OEM tables.</p>
      </article>
    </div>
  `;
}

function renderOemTable(category, table) {
  if (table.mode === "vahan_live" || table.mode === "periodized") {
    return renderLiveOemTable(category, table);
  }

  const rows = table.rows.filter((row) => {
    if (state.company === "all") {
      return true;
    }
    return row.listed_companies.includes(state.company) || row.oem === state.company;
  });
  if (!rows.length) {
    return "";
  }

  const key = `oem-${category}`;
  registerDownload(
    key,
    `fada_${category.toLowerCase()}_oem_table.csv`,
    ["oem", "units", "prior_units", "share_pct", "share_change_pp", "unit_growth_pct", "listed_companies"],
    rows.map((row) => ({
      oem: row.oem,
      units: row.units,
      prior_units: row.prior_units,
      share_pct: row.share_pct,
      share_change_pp: row.share_change_pp,
      unit_growth_pct: row.unit_growth_pct,
      listed_companies: row.listed_companies.join(" | "),
    })),
  );

  return `
    <article class="table-card">
      <div class="table-toolbar">
        <div>
          <p class="small-label">OEM tracker</p>
          <h3>${table.label}</h3>
        </div>
        <div class="button-row">
          ${renderSourceAction(dashboardData.modules.retail?.source_meta?.url)}
          ${renderDownloadIcon(`${key}`)}
        </div>
      </div>
      ${renderTable(
        key,
        [
          { key: "oem", label: "OEM" },
          { key: "units", label: "Current units", type: "int" },
          { key: "prior_units", label: "1Y back units", type: "int" },
          { key: "share_pct", label: "Share", type: "pct" },
          { key: "share_change_pp", label: "Share chg", type: "pp" },
          { key: "unit_growth_pct", label: "YoY growth", type: "pct" },
        ],
        rows,
      )}
      <p class="table-note">Source: FADA Feb 2026 YoY market share annexure. Current units and share are shown against Feb 2025 comparables.</p>
    </article>
  `;
}

function renderLiveOemTable(category, table) {
  const periods = asObject(table.periods);
  const selectedPeriodId = state.liveOemPeriods[category] || table.default_period || Object.keys(periods)[0] || "M";
  const selectedPeriod = asObject(periods[selectedPeriodId] || periods[table.default_period] || periods.M || Object.values(periods)[0]);
  const periodId = selectedPeriod.id || selectedPeriodId || "M";
  const sourceName = table.source_meta?.name || "Source";
  const sourceDescriptor = table.mode === "periodized"
    ? `${selectedPeriod.period_label} view from ${sourceName}-led OEM tracking. Latest validated month in this build: ${table.source_meta?.latest_label || selectedPeriod.period_label}.`
    : `${selectedPeriod.period_label} view from official Parivahan maker-wise registrations. Latest live month in this build: ${table.source_meta?.latest_label || selectedPeriod.period_label}.`;
  const periodRows = asArray(selectedPeriod.rows).filter((row) => {
    if (state.company === "all") {
      return true;
    }
    return asArray(row.listed_companies).includes(state.company) || row.oem === state.company;
  });
  if (!periodRows.length) {
    return "";
  }

  const key = `live-${slugify(category)}-oem-${periodId.toLowerCase()}`;
  const columns = asArray(selectedPeriod.columns);
  const downloadPrefix = table.mode === "periodized" ? slugify(sourceName || "oem") : "parivahan";
  registerDownload(
    key,
    `${downloadPrefix}_${slugify(category)}_oem_${periodId.toLowerCase()}.csv`,
    columns.map((column) => column.key),
    periodRows,
  );

  const availablePeriods = ["M", "Q", "Y"].filter((period) => periods[period] && asArray(periods[period].rows).length > 0);

  return `
    <article class="table-card">
      <div class="table-toolbar">
        <div>
          <p class="small-label">OEM tracker</p>
          <h3>${table.label}</h3>
        </div>
        <div class="button-row">
          ${renderSourceActions([
            { url: table.source_meta?.url, label: "Primary source" },
            { url: table.source_meta?.validation_url, label: "Validation export" },
          ])}
          ${renderDownloadIcon(`${key}`)}
        </div>
      </div>
      <div class="table-toolbar cv-oem-toolbar">
        <p class="table-note">${sourceDescriptor}</p>
        <div class="button-row">
          ${availablePeriods.length > 1 ? availablePeriods.map((period) => `
            <button
              class="button ${state.liveOemPeriods[category] === period ? "button-primary" : ""}"
              data-live-oem-category="${category}"
              data-live-oem-period="${period}"
            >${period}</button>
          `).join("") : ""}
        </div>
      </div>
      ${renderTable(key, columns, periodRows, "cv-vahan-table", { key: "current_units", dir: "desc" })}
      <p class="table-note">${selectedPeriod.note}</p>
    </article>
  `;
}

function renderRegistrationSection() {
  const registration = dashboardData.modules.registration;
  const months = sliceMonths(registration.months);
  registerDownload(
    "vahan-registration",
    "vahan_registration_trend.csv",
    ["month", "total_units"],
    months.map((item) => ({
      month: item.month,
      total_units: item.total_units,
    })),
  );

  return `
    <section id="section-registration" class="section panel section-anchor">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Registration Lens</p>
          <h2>Vahan imports are live and kept separate from retail</h2>
        </div>
        <p class="section-subtitle">${registration.source_meta.note}</p>
      </div>
      <div class="panel-grid one">
        <div class="chart-card">
          <div class="chart-title-row">
            <div>
              <p class="small-label">Monthly registrations</p>
              <h3>Imported Vahan trend</h3>
            </div>
            <div class="button-row">
              ${renderSourceAction(registration.source_meta.url)}
              ${renderDownloadIcon("vahan-registration")}
            </div>
          </div>
          <div class="chart-frame">
            ${lineChart(
              months.map((item) => item.label),
              [{ label: "Registrations", color: dashboardData.chart_colors.TOTAL, values: months.map((item) => item.total_units) }],
              axisFormat,
              formatUnits,
            )}
          </div>
        </div>
        <div class="chart-card">
          <div class="chart-title-row">
            <div>
              <p class="small-label">Latest makers</p>
              <h3>Top imported makers</h3>
            </div>
            <div class="button-row">
              ${renderSourceAction(registration.source_meta.url)}
            </div>
          </div>
          <div class="subsegment-list">
            ${registration.top_makers.map((item) => `
              <div class="subsegment-row">
                <span>${item.maker}</span>
                <strong>${formatUnits(item.units)}</strong>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderWholesaleSection() {
  const wholesale = dashboardData.modules.wholesale;
  const months = sliceMonths(wholesale.months);

  registerDownload(
    "siam-wholesale",
    "siam_wholesale_trend.csv",
    ["month", "production_total", "PV_units", "2W_units", "3W_units"],
    months.map((item) => ({
      month: item.month,
      production_total: item.production_total,
      PV_units: item.domestic_sales.find((entry) => entry.category === "PV")?.units || 0,
      "2W_units": item.domestic_sales.find((entry) => entry.category === "2W")?.units || 0,
      "3W_units": item.domestic_sales.find((entry) => entry.category === "3W")?.units || 0,
    })),
  );

  const series = [
    { label: "Production total", color: dashboardData.chart_colors.TOTAL, values: months.map((item) => item.production_total) },
    { label: "2W wholesale", color: dashboardData.chart_colors["2W"], values: months.map((item) => item.domestic_sales.find((entry) => entry.category === "2W")?.units || 0) },
    { label: "PV wholesale", color: dashboardData.chart_colors.PV, values: months.map((item) => item.domestic_sales.find((entry) => entry.category === "PV")?.units || 0) },
    { label: "3W wholesale", color: dashboardData.chart_colors["3W"], values: months.map((item) => item.domestic_sales.find((entry) => entry.category === "3W")?.units || 0) },
  ];

  return `
    <section id="section-wholesale" class="section panel section-anchor">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Wholesale Lens</p>
          <h2>SIAM shows the factory-to-channel side of the market</h2>
        </div>
        <p class="section-subtitle">${wholesale.source_meta.note}</p>
      </div>
      <div class="panel-grid one">
        <div class="chart-card">
          <div class="chart-title-row">
            <div>
              <p class="small-label">Domestic sales and production</p>
              <h3>Wholesale cadence</h3>
            </div>
            <div class="button-row">
              ${renderSourceAction(wholesale.source_meta.url)}
              ${renderDownloadIcon("siam-wholesale")}
            </div>
          </div>
          <div class="chart-frame">
            ${lineChart(months.map((item) => item.label), series, axisFormat, formatUnits, buildChartEvents())}
          </div>
          <div class="chart-legend">
            ${series.map((item) => legendItem(item.label, item.color)).join("")}
          </div>
        </div>
        <div class="chart-card">
          <div class="chart-title-row">
            <div>
              <p class="small-label">Latest divergence</p>
              <h3>Retail vs wholesale, with concepts kept separate</h3>
            </div>
            <div class="button-row">
              ${renderSourceAction(wholesale.source_meta.url)}
            </div>
          </div>
          <div class="stack-list">
            ${wholesale.retail_vs_wholesale.map((item) => stackRow(
              item.label,
              item.ratio_pct,
              item.ratio_pct,
              item.category === "PV" ? dashboardData.chart_colors.PV : dashboardData.chart_colors["2W"],
              `${formatUnits(item.retail_units)} retail vs ${formatUnits(item.wholesale_units)} wholesale`
            )).join("")}
          </div>
          <p class="legend-note">This is a directional read, not a reconciliation exercise. Timing and reporting scope differ.</p>
        </div>
      </div>
    </section>
  `;
}

function renderQuarterSummary() {
  const summary = dashboardData.modules.wholesale.quarter_summary;
  return `
    <article class="info-card">
      <div class="info-card-head">
        <div>
          <p class="small-label">Q3 FY26</p>
          <h3>Official quarterly context</h3>
        </div>
        ${renderSourceAction(summary.source_url)}
      </div>
      <div class="subsegment-list">
        ${Object.entries(summary.domestic_sales).map(([key, value]) => `
          <div class="subsegment-row">
            <div>
              <strong>${labelForCategory(key)}</strong>
              <p class="table-note">${formatSigned(value.yoy_pct, 1)} YoY</p>
            </div>
            <strong>${formatLakh(value.units)}</strong>
          </div>
        `).join("")}
      </div>
    </article>
  `;
}

function renderCalendarSummary() {
  const summary = dashboardData.modules.wholesale.calendar_year_summary;
  return `
    <article class="info-card">
      <div class="info-card-head">
        <div>
          <p class="small-label">CY 2025</p>
          <h3>Calendar-year wholesale base</h3>
        </div>
        ${renderSourceAction(summary.source_url)}
      </div>
      <div class="subsegment-list">
        ${Object.entries(summary.domestic_sales).map(([key, value]) => `
          <div class="subsegment-row">
            <div>
              <strong>${labelForCategory(key)}</strong>
              <p class="table-note">${formatSigned(value.yoy_pct, 1)} YoY</p>
            </div>
            <strong>${formatLakh(value.units)}</strong>
          </div>
        `).join("")}
      </div>
    </article>
  `;
}

function renderLatestWholesaleTable() {
  const latest = dashboardData.modules.wholesale.latest_snapshot.domestic_sales;
  return `
    <article class="info-card">
      <div class="info-card-head">
        <div>
          <p class="small-label">Latest month</p>
          <h3>SIAM domestic sales snapshot</h3>
        </div>
        ${renderSourceAction(dashboardData.modules.wholesale?.source_meta?.url)}
      </div>
      <div class="subsegment-list">
        ${latest.map((item) => `
          <div class="subsegment-row">
            <div>
              <strong>${item.label}</strong>
              <p class="table-note">${item.yoy_pct === null ? "No official YoY in monthly note" : `${formatSigned(item.yoy_pct, 1)} YoY`}</p>
            </div>
            <strong>${formatUnits(item.units)}</strong>
          </div>
        `).join("")}
      </div>
    </article>
  `;
}

function segmentShareColor(index) {
  const palette = [
    dashboardData.chart_colors["2W"],
    dashboardData.chart_colors["3W"],
    dashboardData.chart_colors.PV,
    dashboardData.chart_colors.CV,
    dashboardData.chart_colors.TRACTOR,
    dashboardData.chart_colors.CE,
    dashboardData.chart_colors.TOTAL,
  ];
  return palette[index % palette.length];
}

function renderSegmentShareExplorer() {
  const module = dashboardData.modules.segment_share;
  const selectedOption = asArray(module.options).find((item) => item.id === state.segmentShareView) || module.options[0];
  const trendYears = asArray(selectedOption?.trend_years).length ? asArray(selectedOption?.trend_years) : asArray(module.trend_years);
  const trendLabels = trendYears.map((item) => item.label);
  const tableYears = asArray(selectedOption?.table_years).length ? asArray(selectedOption?.table_years) : asArray(module.table_years);
  const latestFullYearLabel = selectedOption?.latest_full_year_label || module.latest_full_year_label;
  const cagrLabel = selectedOption?.cagr_label || module.cagr_label || "CAGR";
  const sourceUrl = selectedOption?.source_url || module.source_meta.url;
  const sourceName = selectedOption?.source_name || module.source_meta.name;
  const sourceNote = selectedOption?.note || module.source_meta.note;
  const releaseDate = selectedOption?.latest_release_date || module.source_meta.latest_release_date;

  registerDownload(
    "segment-share-explorer",
    `segment_share_${slugify(selectedOption?.label || "market")}.csv`,
    [
      "subsegment",
      ...tableYears.map((item) => item.label),
      "share_pct",
      "cagr_pct",
    ],
    asArray(selectedOption?.rows).map((row) => ({
      subsegment: row.label,
      ...Object.fromEntries(tableYears.map((item) => [item.label, row[`units_${item.id}`] || 0])),
      share_pct: row.share_pct,
      cagr_pct: row.cagr_pct,
    })),
  );

  const columns = [
    { key: "label", label: "Subsegment" },
    ...tableYears.map((item) => ({ key: `units_${item.id}`, label: item.label, type: "int" })),
    { key: "share_display", label: "% share" },
    { key: "cagr_pct", label: cagrLabel, type: "pct" },
  ];

  const rows = asArray(selectedOption?.rows).map((row) => ({
    ...row,
    share_display: formatPct(row.share_pct, 2),
  }));

  const chartRows = [...asArray(selectedOption?.rows)]
    .sort((left, right) => Number(right.share_pct || 0) - Number(left.share_pct || 0))
    .slice(0, 4);

  const chartSeries = chartRows.map((row, index) => ({
    label: row.label,
    color: segmentShareColor(index),
    values: asArray(row.trend).map((point) => point.units),
  }));

  return `
    <div id="section-segment-share" class="state-explorer">
      <div class="chart-title-row state-explorer-head">
        <div>
          <p class="small-label">Segment-wise market share</p>
          <h3>Pick a category to see which subsegments are gaining share</h3>
        </div>
        <div class="button-row">
          ${renderSourceAction(sourceUrl)}
          ${renderDownloadIcon("segment-share-explorer")}
        </div>
      </div>
        <div class="state-explorer-controls">
          <label class="filter-field compact">
            <span class="small-label">Category</span>
            <select data-segment-share>
              ${module.options.map((item) => `
              <option value="${item.id}" ${item.id === selectedOption?.id ? "selected" : ""}>${item.label}</option>
            `).join("")}
          </select>
          </label>
          <div class="stat-inline state-explorer-stats">
            <div class="stat-block">
              <span class="small-label">Latest full FY</span>
              <strong>${latestFullYearLabel}</strong>
            </div>
            <div class="stat-block">
              <span class="small-label">Source lens</span>
              <strong>${sourceName}</strong>
            </div>
            <div class="stat-block">
              <span class="small-label">Latest source update</span>
              <strong>${releaseDate || "-"}</strong>
            </div>
        </div>
        </div>
        ${renderTable(`segment-share-${selectedOption?.id || "default"}`, columns, rows, "segment-share-table")}
        <div class="chart-frame compact">
          ${lineChart(trendLabels, chartSeries, axisFormat, formatUnits)}
        </div>
        <div class="chart-legend">
          ${chartSeries.map((item) => legendItem(item.label, item.color)).join("")}
        </div>
        <p class="table-note">Chart shows the top ${chartSeries.length} subsegments by ${latestFullYearLabel} share, to keep the trend view readable.</p>
        <p class="legend-note">${sourceNote}</p>
      </div>
    `;
  }

function renderRawMaterialExplorer() {
  const module = asObject(dashboardData.modules.components?.raw_material_prices);
  const companies = asArray(module.companies);
  if (!module.available || !companies.length) {
    return "";
  }

  const selected = selectedRawMaterialCompany() || companies[0];
  const materials = asArray(selected.materials);
  const labels = asArray(materials[0]?.series).map((item) => item.label);
  const series = materials.map((material, index) => ({
    label: material.label,
    values: asArray(material.series).map((item) => {
      const baseValue = Number(material.series?.[0]?.value || 0);
      const currentValue = Number(item.value || 0);
      return baseValue ? Number(((currentValue / baseValue) * 100).toFixed(1)) : null;
    }),
    color: ["#7ca4ff", "#f28b61", "#54d3a1", "#cab0ff", "#d7c46f", "#8ad8c7"][index % 6],
  }));
  const strongestMove = materials
    .map((material) => ({
      label: material.label,
      change_pct: Number(material.change_since_base_pct),
    }))
    .sort((left, right) => Math.abs(Number(right.change_pct || 0)) - Math.abs(Number(left.change_pct || 0)))[0];

  registerDownload(
    `raw-material-${slugify(selected.company)}`,
    `${slugify(selected.company)}_raw_material_basket.csv`,
    ["Company", "Material", "Period", "Price", "Unit"],
    materials.flatMap((material) =>
      asArray(material.series).map((item) => ({
        Company: selected.company,
        Material: material.label,
        Period: item.label,
        Price: item.value,
        Unit: material.unit_label,
      })),
    ),
  );

  return `
    <div class="chart-card inset-card">
      <div class="chart-title-row">
        <div>
          <p class="small-label">Raw-material price history</p>
          <h3>Track the indexed commodity basket linked to a selected company</h3>
        </div>
        <div class="button-row">
          ${renderSourceAction(module.source_meta.url)}
          ${renderDownloadIcon(`raw-material-${slugify(selected.company)}`)}
        </div>
      </div>
      <div class="state-explorer-controls explorer-controls">
        <label class="filter-field compact">
          <span class="small-label">Company</span>
          <select data-raw-material-company>
            ${companies.map((item) => `<option value="${item.company}" ${item.company === selected.company ? "selected" : ""}>${item.label}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="stat-inline-compact">
        <div class="stat-block">
          <span class="small-label">Materials tracked</span>
          <strong>${materials.length}</strong>
        </div>
        <div class="stat-block">
          <span class="small-label">Latest visible point</span>
          <strong>${materials[0]?.latest_period || "-"}</strong>
        </div>
        <div class="stat-block">
          <span class="small-label">Biggest move vs 2022</span>
          <strong class="${Number(strongestMove?.change_pct) >= 0 ? "positive" : "negative"}">${strongestMove ? `${strongestMove.label} ${formatSigned(strongestMove.change_pct)}` : "-"}</strong>
        </div>
      </div>
      <div class="chart-frame compact">
        ${lineChart(
          labels,
          series,
          (value) => `${Number(value || 0).toFixed(0)}`,
          (value) => `${Number(value || 0).toFixed(1)} index`,
        )}
      </div>
      <div class="chart-legend">
        ${series.map((item) => legendItem(item.label, item.color)).join("")}
      </div>
      <p class="table-note">${asArray(selected.category_labels).join(" / ")}</p>
      <p class="table-note">${selected.note}</p>
      <p class="legend-note">Chart is rebased to 2022 = 100 so different commodity units can be compared on one view. CSV download keeps the raw benchmark prices. ${module.source_meta.note}</p>
    </div>
  `;
}

function renderCompanyExposureTrendExplorer() {
  const module = asObject(dashboardData.modules.components?.company_segment_trends);
  const companies = asArray(module.companies);
  if (!module.available || !companies.length) {
    return "";
  }

  const selected = selectedComponentTrendCompany() || companies[0];
  const labels = asArray(selected.segments[0]?.series).map((item) => item.label);
  const chartSeries = asArray(selected.segments).map((segment) => ({
    label: segment.label,
    values: asArray(segment.series).map((item) => item.units),
    color: dashboardData.chart_colors?.[segment.category] || "#1b3454",
  }));

  registerDownload(
    `company-segment-${slugify(selected.company)}`,
    `${slugify(selected.company)}_segment_volume_trend.csv`,
    ["Company", "Segment", "Period", "Units", "Source"],
    asArray(selected.segments).flatMap((segment) =>
      asArray(segment.series).map((item) => ({
        Company: selected.company,
        Segment: segment.label,
        Period: item.label,
        Units: item.units,
        Source: segment.source_name,
      })),
    ),
  );

  return `
    <div class="chart-card inset-card">
      <div class="chart-title-row">
        <div>
          <p class="small-label">Company-linked end-market volumes</p>
          <h3>See how the segments behind a company have moved over the last 4 fiscal years</h3>
        </div>
        <div class="button-row">
          ${renderSourceActions(selected.sources)}
          ${renderDownloadIcon(`company-segment-${slugify(selected.company)}`)}
        </div>
      </div>
      <div class="state-explorer-controls explorer-controls">
        <label class="filter-field compact">
          <span class="small-label">Company</span>
          <select data-component-company>
            ${companies.map((item) => `<option value="${item.company}" ${item.company === selected.company ? "selected" : ""}>${item.label}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="stat-inline-compact">
        <div class="stat-block">
          <span class="small-label">Segments tracked</span>
          <strong>${asArray(selected.segments).length}</strong>
        </div>
        <div class="stat-block">
          <span class="small-label">Latest fiscal year</span>
          <strong>${selected.latest_period || module.latest_period || "-"}</strong>
        </div>
        <div class="stat-block">
          <span class="small-label">Source lens</span>
          <strong>${asArray(selected.sources).map((item) => item.label).join(" + ")}</strong>
        </div>
      </div>
      <div class="chart-frame compact">
        ${lineChart(labels, chartSeries, axisFormat, formatUnits)}
      </div>
      <div class="chart-legend">
        ${chartSeries.map((item) => legendItem(item.label, item.color)).join("")}
      </div>
      <p class="legend-note">${selected.note} ${module.source_meta.note}</p>
    </div>
  `;
}

function renderComponentsSection() {
  const components = dashboardData.modules.components;
  const segmentShare = dashboardData.modules.segment_share;

  return `
    <section id="section-components" class="section panel section-anchor">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Components</p>
          <h2>${components.headline}</h2>
        </div>
        <p class="section-subtitle">${components.source_meta.note}</p>
      </div>
      <div class="panel-grid three components-metric-grid">
        ${components.metrics.map((metric) => {
          const slug = String(metric.label).toLowerCase();
          let key = null;
          if (slug.includes("turnover")) key = "components.industry_turnover";
          else if (slug.includes("oem")) key = "components.oem_supplies";
          else if (slug.includes("export")) key = "components.exports";
          else if (slug.includes("aftermarket")) key = "components.aftermarket";
          const explainAttr = key ? `data-explain="${key}" tabindex="0"` : "";
          return `
            <article class="info-card" ${explainAttr}>
              <div class="info-card-head">
                <p class="small-label">${metric.label}</p>
                ${renderSourceAction(components.source_meta.url)}
              </div>
              <h3 class="summary-value">${metric.value}</h3>
              <p class="metric-detail">${metric.delta}</p>
            </article>
          `;
        }).join("")}
      </div>
      <div class="section-divider"></div>
      ${segmentShare.available ? `
        <div class="chart-card">
          ${renderSegmentShareExplorer()}
        </div>
        <div class="section-divider"></div>
      ` : ""}
      <div class="panel-grid one">
        <div class="chart-stack">
          ${renderRawMaterialExplorer()}
          ${renderCompanyExposureTrendExplorer()}
          <div class="chart-card inset-card">
            <div class="chart-title-row">
              <div>
                <p class="small-label">ACMA read-through</p>
                <h3>Why the ancillary backdrop still matters</h3>
              </div>
              <div class="button-row">
                ${renderSourceAction(components.source_meta.url)}
              </div>
            </div>
            <div class="tag-list">
              ${components.insights.map((item) => `<div class="empty-note">${item}</div>`).join("")}
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderInsightsSection() {
  const insights = dashboardData.insights.filter((item) => {
    if (state.lens === "all") {
      return true;
    }
    if (state.lens === "ev") {
      return item.tags.includes("ev") || item.tags.includes("components");
    }
    return item.tags.includes(state.lens);
  });

  return `
    <section id="section-insights" class="section panel section-anchor">
      <div class="panel-header">
        <div>
          <p class="section-kicker">What Matters</p>
          <h2>Plain-English investor takeaways</h2>
        </div>
        <p class="section-subtitle">Generated only from validated data already on the page.</p>
      </div>
      <div class="insight-grid takeaway-grid">
        ${insights.map((item) => `
          <article class="insight-card">
            <div class="insight-head">
              <div>
                <p class="small-label">${item.tags.join(" / ")}</p>
                <h3>${item.title}</h3>
              </div>
            </div>
            <p class="insight-body">${item.body}</p>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderStockSnapshotPanel() {
  const stocks = dashboardData.oem_stocks;
  if (!stocks?.available) return "";
  const entries = Object.entries(stocks.stocks || {});
  if (!entries.length) return "";
  const exchange = stocks.exchange || "NSE";
  const asOf = stocks.as_of_date
    ? new Date(stocks.as_of_date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    : "";

  const fmtPct = (v) => {
    if (v === null || v === undefined) return "—";
    return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  };
  const tone = (v) => (v === null || v === undefined ? "neutral" : (v >= 0 ? "positive" : "negative"));
  const fmtPrice = (v) => v == null || !v ? "—" : v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const renderCard = ([company, stock]) => {
    const sparkline = renderStockSparkline(stock.closes_30d);
    return `
      <article class="stock-snapshot-card">
        <header class="stock-snapshot-head">
          <div>
            <p class="stock-snapshot-company">${company}</p>
            <p class="stock-snapshot-ticker">${exchange}: ${stock.ticker || "—"}</p>
          </div>
          <a class="stock-chip-link" href="${stock.yahoo_url || "#"}" target="_blank" rel="noopener" title="View on Yahoo Finance">↗</a>
        </header>
        <p class="stock-snapshot-price">₹${fmtPrice(stock.price)}</p>
        ${sparkline ? `<div class="stock-snapshot-spark-wrap">${sparkline}</div>` : '<div class="stock-snapshot-spark-empty">Sparkline lands after next live refresh</div>'}
        <div class="stock-chip-changes">
          <span class="stock-chip-pill stock-tone-${tone(stock.change_1d_pct)}">
            <span class="stock-chip-pill-label">1D</span>
            <span class="stock-chip-pill-value">${fmtPct(stock.change_1d_pct)}</span>
          </span>
          <span class="stock-chip-pill stock-tone-${tone(stock.change_1w_pct)}">
            <span class="stock-chip-pill-label">1W</span>
            <span class="stock-chip-pill-value">${fmtPct(stock.change_1w_pct)}</span>
          </span>
          <span class="stock-chip-pill stock-tone-${tone(stock.change_1m_pct)}">
            <span class="stock-chip-pill-label">1M</span>
            <span class="stock-chip-pill-value">${fmtPct(stock.change_1m_pct)}</span>
          </span>
        </div>
        ${stock.note ? `<p class="stock-snapshot-note">${stock.note}</p>` : ""}
      </article>
    `;
  };

  return `
    <section id="section-stock-snapshot" class="section panel section-anchor">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Listed-OEM Stock Snapshot</p>
          <h2>Live NSE prices for every company tracked on this dashboard</h2>
        </div>
        <p class="section-subtitle">${stocks.source_note || ""}${asOf ? ` · As of ${asOf}` : ""}</p>
      </div>
      <div class="stock-snapshot-grid">
        ${entries.map(renderCard).join("")}
      </div>
    </section>
  `;
}

function renderEarningsCalendarPanel() {
  const ec = dashboardData.earnings_calendar;
  if (!ec?.available) return "";
  const next14 = ec.next_14_days || [];
  const upcoming = ec.upcoming_all || [];
  const recentPast = ec.recent_past || [];
  const today = new Date();
  const fmtDate = (iso) => {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
  };
  const daysFromToday = (iso) => {
    const d = new Date(iso + "T00:00:00");
    return Math.round((d - today) / 86400000);
  };
  const renderEvent = (ev, options = {}) => {
    const { isPast = false } = options;
    const days = daysFromToday(ev.date);
    const dayBadge = isPast
      ? `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`
      : days === 0 ? "Today"
        : days === 1 ? "Tomorrow"
          : `in ${days} day${days === 1 ? "" : "s"}`;
    return `
      <a class="earnings-row ${isPast ? "is-past" : days <= 3 ? "is-imminent" : ""}"
         href="${ev.source_url || "#"}" target="_blank" rel="noopener">
        <div class="earnings-date-cell">
          <span class="earnings-day">${fmtDate(ev.date)}</span>
          <span class="earnings-day-badge">${dayBadge}</span>
        </div>
        <div class="earnings-company-cell">
          <span class="earnings-company-name">${ev.company}</span>
          <span class="earnings-period">${ev.period_label}</span>
        </div>
        <span class="earnings-ticker">${ev.ticker || ""}</span>
        <span class="earnings-arrow" aria-hidden="true">↗</span>
      </a>
    `;
  };
  const block = next14.length
    ? `<p class="small-label" style="margin-top:0;">Next 14 days · ${next14.length} announcement${next14.length === 1 ? "" : "s"}</p>
       ${next14.map((ev) => renderEvent(ev)).join("")}`
    : `<p class="empty-note">No earnings calls scheduled in the next 14 days.</p>`;
  const moreUpcoming = upcoming.filter((ev) => !next14.find((n) => n.company === ev.company && n.date === ev.date));
  return `
    <section id="section-earnings-calendar" class="section panel section-anchor">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Earnings Calendar</p>
          <h2>Listed-OEM result dates · ${ec.upcoming_count || 0} upcoming</h2>
        </div>
        <p class="section-subtitle">${ec.source_note || ""}</p>
      </div>
      <div class="earnings-list">${block}</div>
      ${moreUpcoming.length ? `
        <details class="earnings-more">
          <summary>Show ${moreUpcoming.length} more upcoming announcement${moreUpcoming.length === 1 ? "" : "s"}</summary>
          <div class="earnings-list" style="margin-top:10px;">
            ${moreUpcoming.map((ev) => renderEvent(ev)).join("")}
          </div>
        </details>
      ` : ""}
      ${recentPast.length ? `
        <details class="earnings-more">
          <summary>Show ${recentPast.length} recent announcement${recentPast.length === 1 ? "" : "s"}</summary>
          <div class="earnings-list" style="margin-top:10px;">
            ${recentPast.map((ev) => renderEvent(ev, { isPast: true })).join("")}
          </div>
        </details>
      ` : ""}
    </section>
  `;
}

function renderCompanySection() {
  const cards = state.company === "all"
    ? dashboardData.company_map
    : dashboardData.company_map.filter((item) => item.company === state.company);
  const activeCompany = cards.find((item) => item.company === state.companyMapFocus) || cards[0];
  const shownCount = state.companyMapShownCount || 3;
  const visible = cards.slice(0, shownCount);
  const remaining = Math.max(0, cards.length - visible.length);

  return `
    ${renderStockSnapshotPanel()}
    ${renderEarningsCalendarPanel()}
    <section id="section-company-map" class="section panel section-anchor">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Listed Company Mapping</p>
          <h2>How the demand data maps back to public-market names</h2>
        </div>
        <p class="section-subtitle">Mappings stay directional and only appear where the linkage is meaningful. Showing ${visible.length} of ${cards.length} companies.</p>
      </div>
      <div class="company-grid">
        ${visible.map((item) => `
          <article class="insight-card company-map-card ${item.company === activeCompany?.company ? "active" : ""}" data-company-map-card="${item.company}">
            <div class="insight-head">
              <div>
                <p class="small-label">${item.category_labels.join(" / ")}</p>
                <h3>${item.company}</h3>
              </div>
              ${item.summary_source_url ? renderSourceAction(item.summary_source_url, "Source") : ""}
            </div>
            <p class="insight-body">${item.summary}</p>
            ${item.is_management_commentary ? `<p class="table-note">Recent management commentary</p>` : ""}
          </article>
        `).join("")}
      </div>
      ${remaining > 0 ? `
        <div class="company-map-toolbar">
          <button class="button button-primary" data-action="company-map-more">
            Show ${Math.min(3, remaining)} more <span aria-hidden="true">+</span>
          </button>
          ${remaining > 3 ? `<button class="button" data-action="company-map-show-all">Show all (${cards.length})</button>` : ""}
        </div>
      ` : (cards.length > 3 ? `
        <div class="company-map-toolbar">
          <button class="button" data-action="company-map-collapse">Collapse to 3</button>
        </div>
      ` : "")}
      ${activeCompany ? renderCompanyDrilldown(activeCompany) : ""}
    </section>
  `;
}

function setupRecentLaunchesFilter() {
  document.querySelectorAll("[data-launch-filter]").forEach((node) => {
    node.addEventListener("click", () => {
      const value = node.getAttribute("data-launch-filter");
      state.launchFilterCompany = value;
      render();
    });
  });
}

function setupCompanyMapPagination() {
  document.querySelectorAll("[data-action='company-map-more']").forEach((node) => {
    node.addEventListener("click", () => {
      state.companyMapShownCount = (state.companyMapShownCount || 3) + 3;
      render();
    });
  });
  document.querySelectorAll("[data-action='company-map-show-all']").forEach((node) => {
    node.addEventListener("click", () => {
      state.companyMapShownCount = 9999;
      render();
    });
  });
  document.querySelectorAll("[data-action='company-map-collapse']").forEach((node) => {
    node.addEventListener("click", () => {
      state.companyMapShownCount = 3;
      render();
    });
  });
}

function companyMarketShareRows(company) {
  const retailTables = asObject(dashboardData.modules.retail?.latest_oem_tables);
  return asArray(company.categories)
    .map((category) => {
      const table = asObject(retailTables[category]);
      const activeRows = table.mode === "vahan_live" || table.mode === "periodized"
        ? asArray(asObject(asObject(table.periods)[state.liveOemPeriods[category] || table.default_period] || Object.values(asObject(table.periods))[0]).rows)
        : asArray(table.rows);
      const row = activeRows.find((item) => item.oem === company.company || asArray(item.listed_companies).includes(company.company));
      if (!row) {
        return null;
      }
      return {
        category_key: category,
        category: labelForCategory(category),
        oem: row.oem,
        units: row.current_units ?? row.units,
        share_pct: row.share_pct,
        share_change_pp: row.share_change_pp,
      };
    })
    .filter(Boolean);
}

function companyRecentUnitRows(company) {
  const trend = asArray(dashboardData.modules.retail?.company_unit_trends).find((item) => item.company === company.company);
  if (!trend) {
    return { concept: "", rows: [] };
  }
  return {
    concept: trend.concept,
    rows: asArray(trend.series).slice(-3).map((item, index) => ({
      period: item.label || monthLabel(item.month),
      period_order: index,
      units: item.units,
    })),
  };
}

function companyRevenueRows(company) {
  const table = asObject(company.revenue_table);
  const marketRows = companyMarketShareRows(company);
  const rows = asArray(table.rows).map((row) => {
    const normalizedRow = asObject(row);
    const categoryKeys = asArray(normalizedRow.market_categories);
    const matches = marketRows.filter((item) => categoryKeys.includes(item.category_key));
    return {
      ...normalizedRow,
      latest_market_share: matches.length
        ? matches.map((item) => `${shortCategoryLabel(item.category_key)} ${formatPctText(item.share_pct)}`).join(" | ")
        : "n.m.",
    };
  });
  return {
    years: asArray(table.years),
    rows,
    note: table.note || "",
    source_url: table.source_url,
    source_label: table.source_label || "Source",
  };
}

function renderCompanyDrilldown(company) {
  const revenueTable = companyRevenueRows(company);
  const hasPanels = revenueTable.rows.length;
  const revenueColumns = [
    { key: "segment", label: "Revenue segment" },
    { key: "year_0", label: revenueTable.years[0] || "FY23", type: "int" },
    { key: "year_1", label: revenueTable.years[1] || "FY24", type: "int" },
    { key: "year_2", label: revenueTable.years[2] || "FY25", type: "int" },
    { key: "share_pct", label: "% share", type: "pct" },
    { key: "latest_market_share", label: "Latest mkt share" },
    { key: "cagr_5y_pct", label: "5Y CAGR", type: "pct" },
  ];

  return `
      <div id="company-drilldown" class="chart-card company-map-detail section-anchor">
        <div class="chart-title-row">
          <div>
            <p class="small-label">Company drilldown</p>
            <h3>${company.company}</h3>
        </div>
        <div class="button-row">
          ${company.summary_source_url ? renderSourceAction(company.summary_source_url, company.summary_source_label || "Source") : ""}
          </div>
        </div>
        <p class="insight-body">${company.summary}</p>
        ${hasPanels ? `<div class="panel-grid one">
            <div class="chart-card">
              <div class="chart-title-row">
                <div>
                  <p class="small-label">Revenue breakdown</p>
                  <p class="table-note">${revenueTable.note} Latest market-share uses the latest validated retail share where the row maps cleanly to an OEM segment.</p>
                </div>
                <div class="button-row">
                  ${revenueTable.source_url ? renderSourceAction(revenueTable.source_url, revenueTable.source_label) : ""}
                </div>
              </div>
              ${renderTable(`company-revenue-${slugify(company.company)}`, revenueColumns, revenueTable.rows, "compact-table")}
            </div>
        </div>` : ""}
      </div>
    `;
}

function renderTable(id, columns, rows) {
  const sort = state.sorts[id] || { key: columns[1]?.key || columns[0].key, dir: columns[1] ? "desc" : "asc" };
  const sorted = [...rows].sort((left, right) => compareValues(left[sort.key], right[sort.key], sort.dir));
  const head = columns.map((column) => `
    <th data-table="${id}" data-key="${column.key}">
      ${column.label}${sort.key === column.key ? ` ${sort.dir === "asc" ? "↑" : "↓"}` : ""}
    </th>
  `).join("");
  const body = sorted.map((row) => `
    <tr>
      ${columns.map((column) => `<td>${formatCell(row[column.key], column.type)}</td>`).join("")}
    </tr>
  `).join("");
  return `
    <div class="table-scroll">
      <table>
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function compareValues(left, right, direction) {
  const factor = direction === "asc" ? 1 : -1;
  const leftNumber = typeof left === "number" ? left : Number(left);
  const rightNumber = typeof right === "number" ? right : Number(right);
  if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) {
    return (leftNumber - rightNumber) * factor;
  }
  return `${left}`.localeCompare(`${right}`) * factor;
}

function formatCell(value, type) {
    if (type === "int") {
      if (value === null || value === undefined || Number.isNaN(Number(value))) {
        return '<span class="neutral">—</span>';
      }
      return formatUnits(value);
    }
    if (type === "pct") {
      if (value === null || value === undefined || Number.isNaN(Number(value))) {
        return '<span class="neutral">n.m.</span>';
      }
      return `<span class="${Number(value) >= 0 ? "positive" : "negative"}">${formatSigned(value)}</span>`;
    }
  if (type === "pp") {
    return `<span class="${Number(value) >= 0 ? "positive" : "negative"}">${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)} pp</span>`;
  }
  return value;
}

function renderTable(id, columns, rows, extraClass = "", defaultSort = null) {
  const sort = state.sorts[id] || defaultSort || { key: columns[1]?.key || columns[0].key, dir: columns[1] ? "desc" : "asc" };
  const sorted = [...rows].sort((left, right) => compareValues(left[sort.key], right[sort.key], sort.dir));
  const compactClass = columns.length >= 6 ? " compact-table" : "";
  const customClass = extraClass ? ` ${extraClass}` : "";
  const head = columns.map((column) => {
    const sortable = column.sortable !== false;
    const arrow = sortable && sort.key === column.key ? (sort.dir === "asc" ? " &uarr;" : " &darr;") : "";
    const sortAttrs = sortable ? `data-table="${id}" data-key="${column.key}"` : 'class="th-static"';
    return `<th ${sortAttrs}>${column.label}${arrow}</th>`;
  }).join("");
  const body = sorted.map((row) => `
    <tr>
      ${columns.map((column) => `<td>${formatCell(row[column.key], column.type)}</td>`).join("")}
    </tr>
  `).join("");
  return `
    <div class="table-scroll${compactClass}${customClass}">
      <table>
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function formatCell(value, type) {
  if (type === "html") {
    return value ?? "";
  }
  if (type === "int") {
    return formatUnits(value);
  }
  if (type === "pct") {
    return `<span class="${Number(value) >= 0 ? "positive" : "negative"}">${formatSigned(value)}</span>`;
  }
  if (type === "pp") {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
      return '<span class="neutral">n.m.</span>';
    }
    return `<span class="${Number(value) >= 0 ? "positive" : "negative"}">${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)} pp</span>`;
    }
    return value ?? "";
  }

function shortCategoryLabel(category) {
  const mapping = {
    PV: "PV",
    "2W": "2W",
    "3W": "3W",
    CV: "CV",
    TRACTOR: "Tractor",
    CE: "CE",
  };
  return mapping[category] || category;
}

function formatPctText(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "n.m.";
  }
  return `${Number(value).toFixed(2)}%`;
}

function registerDownload(key, filename, columns, rows) {
  downloadRegistry.set(key, { filename, columns, rows });
}

function labelForCategory(category) {
  return dashboardData.filters.categories.find((item) => item.id === category)?.label || category;
}

function selectedRawMaterialCompany() {
  return asArray(dashboardData.modules.components?.raw_material_prices?.companies).find((item) => item.company === state.rawMaterialCompany);
}

function selectedComponentTrendCompany() {
  return asArray(dashboardData.modules.components?.company_segment_trends?.companies).find((item) => item.company === state.componentTrendCompany);
}

function formatRawMaterialValue(value, suffix = "") {
  const number = Number(value || 0);
  const digits = number >= 100 ? 0 : number >= 10 ? 1 : 2;
  return `USD ${number.toLocaleString("en-US", { minimumFractionDigits: digits === 2 ? 2 : 0, maximumFractionDigits: digits })}${suffix ? ` ${suffix}` : ""}`;
}

function legendItem(label, color) {
  return `
    <span class="legend-item">
      <span class="legend-dot" style="background:${color}"></span>
      ${label}
    </span>
  `;
}

function stackRow(label, widthPct, value, color, detail = "") {
  const tooltip = `${label}: ${formatPct(value, 2)}${detail ? ` | ${detail}` : ""}`;
  return `
    <div class="stack-row" data-tooltip="${escapeHtml(tooltip)}" tabindex="0">
      <span>${label}</span>
      <div class="stack-bar">
        <div class="stack-fill" style="width:${Math.max(3, Math.min(widthPct, 100))}%; background:${color}"></div>
      </div>
      <strong title="${detail}">${formatPct(value, 2)}</strong>
    </div>
  `;
}

function renderFestiveCountdown(festival) {
  if (!festival || !festival.date) return "";
  const target = new Date(festival.date + "T00:00:00");
  const now = new Date();
  const msPerDay = 86400000;
  const daysUntil = Math.max(0, Math.ceil((target - now) / msPerDay));
  const datePretty = target.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const isImminent = daysUntil <= 30;
  const tone = isImminent ? "is-imminent" : "is-future";
  return `
    <div class="festive-countdown ${tone}">
      <div class="festive-countdown-icon" aria-hidden="true">🪔</div>
      <div class="festive-countdown-body">
        <p class="small-label">Next major festival</p>
        <h3 class="festive-countdown-name">${festival.name}</h3>
        <p class="festive-countdown-date">${datePretty} · ${festival.region}</p>
      </div>
      <div class="festive-countdown-counter">
        <p class="festive-countdown-number">${daysUntil}</p>
        <p class="festive-countdown-unit">${daysUntil === 1 ? "day to go" : "days to go"}</p>
      </div>
    </div>
  `;
}

function renderFestiveOemLeaderboard(lb) {
  if (!lb || !lb.available || !lb.categories?.length) return "";
  const renderCategory = (cat) => {
    const winners = (cat.winners || []).map((r) => `
      <tr>
        <td>${r.oem}</td>
        <td class="num">${formatUnits(r.units)}</td>
        <td class="num"><strong class="leader-yoy-pos">+${r.yoy_pct.toFixed(1)}%</strong></td>
      </tr>
    `).join("");
    const laggards = (cat.laggards || []).map((r) => `
      <tr>
        <td>${r.oem}</td>
        <td class="num">${formatUnits(r.units)}</td>
        <td class="num"><strong class="${r.yoy_pct >= 0 ? "leader-yoy-pos" : "leader-yoy-neg"}">${r.yoy_pct >= 0 ? "+" : ""}${r.yoy_pct.toFixed(1)}%</strong></td>
      </tr>
    `).join("");
    return `
      <div class="leaderboard-cat">
        <p class="leaderboard-cat-head"><strong>${cat.label}</strong> · Sep–Nov ${cat.year} vs ${cat.prior_year}</p>
        <p class="leaderboard-sub">🏆 Winners</p>
        <table class="leaderboard-table">
          <thead><tr><th>OEM</th><th class="num">Festive units</th><th class="num">YoY</th></tr></thead>
          <tbody>${winners || `<tr><td colspan="3" class="empty">No winners with comparable history.</td></tr>`}</tbody>
        </table>
        ${laggards ? `
          <p class="leaderboard-sub">⚠️ Laggards</p>
          <table class="leaderboard-table">
            <thead><tr><th>OEM</th><th class="num">Festive units</th><th class="num">YoY</th></tr></thead>
            <tbody>${laggards}</tbody>
          </table>
        ` : ""}
      </div>
    `;
  };
  return `
    <div class="chart-card">
      <p class="small-label">OEM festive leaderboard</p>
      <h3 style="margin:6px 0 12px;">Who won (and lost) the festive demand cycle</h3>
      <p class="metric-detail" style="margin-bottom:14px;">${lb.note || ""}</p>
      <div class="leaderboard-grid">
        ${lb.categories.map(renderCategory).join("")}
      </div>
    </div>
  `;
}

function _festivePeriodReturn(daily, year) {
  // Compute Sep 1 → Nov 30 return for the given year from a daily series.
  // Returns null when either bookend is missing.
  if (!Array.isArray(daily) || !daily.length) return null;
  const sepStart = `${year}-09-01`;
  const novEnd = `${year}-11-30`;
  // First close on/after sepStart
  const startEntry = daily.find((d) => d.date >= sepStart);
  // Last close on/before novEnd
  let endEntry = null;
  for (let i = daily.length - 1; i >= 0; i--) {
    if (daily[i].date <= novEnd && daily[i].date >= sepStart) {
      endEntry = daily[i];
      break;
    }
  }
  if (!startEntry || !endEntry || !startEntry.close || endEntry.date <= startEntry.date) return null;
  return {
    start_date: startEntry.date,
    end_date: endEntry.date,
    start_close: startEntry.close,
    end_close: endEntry.close,
    return_pct: ((endEntry.close - startEntry.close) / startEntry.close) * 100,
  };
}

function _nonFestiveReturn(daily, year) {
  // Total return outside the Sep–Nov festive window for the given year.
  // Computed as full-year return minus the festive component.
  if (!Array.isArray(daily) || !daily.length) return null;
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const startEntry = daily.find((d) => d.date >= yearStart);
  let endEntry = null;
  for (let i = daily.length - 1; i >= 0; i--) {
    if (daily[i].date <= yearEnd && daily[i].date >= yearStart) {
      endEntry = daily[i];
      break;
    }
  }
  if (!startEntry || !endEntry || endEntry.date <= startEntry.date) return null;
  // Non-festive proxy: Jan-Aug return + Dec return (Sep-Nov stripped out).
  // Approximate via year-return minus festive-return when both are available.
  const fest = _festivePeriodReturn(daily, year);
  if (!fest) return null;
  const yearReturnPct = ((endEntry.close - startEntry.close) / startEntry.close) * 100;
  // Compounded subtraction
  const yearMul = 1 + yearReturnPct / 100;
  const festMul = 1 + fest.return_pct / 100;
  if (festMul <= 0) return null;
  const nonFestMul = yearMul / festMul;
  return {
    return_pct: (nonFestMul - 1) * 100,
  };
}

function renderFestiveStockPerf() {
  const stocks = dashboardData.oem_stocks;
  if (!stocks?.available) return "";
  const entries = Object.entries(stocks.stocks || {}).filter(([_, s]) => Array.isArray(s.daily_closes) && s.daily_closes.length > 60);
  if (!entries.length) {
    return `
      <div class="chart-card">
        <p class="small-label">Listed-OEM stock performance during festive</p>
        <h3 style="margin:6px 0 8px;">Did the market price in festive demand?</h3>
        <p class="metric-detail">Daily-close history not yet populated. The cron-driven Yahoo Finance scraper saves a 2-year daily series on its next successful run, after which festive-window returns appear here automatically.</p>
      </div>
    `;
  }
  // Compute for the most recent completed festive year covered by the data.
  const today = new Date();
  const festiveYear = today.getMonth() >= 11 || today.getMonth() === 0 ? today.getFullYear() : today.getFullYear() - 1;
  const rows = entries.map(([company, stock]) => {
    const fest = _festivePeriodReturn(stock.daily_closes, festiveYear);
    const nonFest = _nonFestiveReturn(stock.daily_closes, festiveYear);
    return { company, ticker: stock.ticker, fest, nonFest };
  }).filter((r) => r.fest);
  if (!rows.length) {
    return `
      <div class="chart-card">
        <p class="small-label">Listed-OEM stock performance during festive ${festiveYear}</p>
        <p class="metric-detail">Daily history doesn't yet cover the Sep–Nov ${festiveYear} window. Will populate after the next cron run.</p>
      </div>
    `;
  }
  rows.sort((a, b) => (b.fest?.return_pct || 0) - (a.fest?.return_pct || 0));
  const fmtPct = (v) => v === null || v === undefined ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  const tone = (v) => (v === null || v === undefined ? "" : (v >= 0 ? "leader-yoy-pos" : "leader-yoy-neg"));
  return `
    <div class="chart-card">
      <p class="small-label">Listed-OEM stock performance · Festive ${festiveYear} (Sep–Nov)</p>
      <h3 style="margin:6px 0 8px;">Did the market price in festive demand?</h3>
      <p class="metric-detail" style="margin-bottom:12px;">Stock return during the Sep–Nov festive window vs the rest of the calendar year. Pulled from Yahoo Finance — refreshes every cron run.</p>
      <table class="leaderboard-table">
        <thead>
          <tr>
            <th>Company</th>
            <th>Ticker</th>
            <th class="num">Festive return</th>
            <th class="num">Non-festive return</th>
            <th class="num">Outperformance</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => {
            const fest = r.fest?.return_pct;
            const nonFest = r.nonFest?.return_pct;
            const outper = (fest !== null && fest !== undefined && nonFest !== null && nonFest !== undefined) ? fest - nonFest : null;
            return `
              <tr>
                <td><strong>${r.company}</strong></td>
                <td>${r.ticker}</td>
                <td class="num"><strong class="${tone(fest)}">${fmtPct(fest)}</strong></td>
                <td class="num">${fmtPct(nonFest)}</td>
                <td class="num"><strong class="${tone(outper)}">${fmtPct(outper)}</strong></td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderRecentLaunchesSection() {
  const mod = dashboardData.modules.recent_launches;
  if (!mod?.available) return "";
  const items = mod.items || [];
  const companies = mod.companies || [];
  if (!items.length) {
    return `
      <section id="section-recent-launches" class="section panel section-anchor">
        <div class="panel-header">
          <div>
            <p class="section-kicker">Recent Launches</p>
            <h2>No model launches in the last ${mod.window_days || 30} days</h2>
          </div>
        </div>
        <p class="empty-note">The trade-media RSS feeds (RushLane, ET Auto, Autocar Pro, EVReporter) didn't surface any launch articles for tracked OEMs in the rolling window. The next scheduled refresh will retry.</p>
      </section>
    `;
  }

  const today = new Date();
  const fmtRelative = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const days = Math.round((today - d) / 86400000);
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days} days ago`;
    if (days < 14) return "Last week";
    if (days < 30) return `${Math.round(days / 7)} weeks ago`;
    return `${Math.round(days / 30)} months ago`;
  };
  const fmtDateLong = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  };

  const escapeHtml = (s) =>
    String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const stripTags = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

  const trimSummary = (s, limit = 220) => {
    const cleaned = stripTags(s);
    if (cleaned.length <= limit) return cleaned;
    return cleaned.slice(0, limit).replace(/\s+\S*$/, "") + "…";
  };

  const filterCompany = state.launchFilterCompany || "all";
  const visibleItems = filterCompany === "all"
    ? items
    : items.filter((it) => it.company === filterCompany);

  const totalCount = items.length;
  const filterPills = `
    <button type="button"
            class="launch-filter-pill ${filterCompany === "all" ? "is-active" : ""}"
            data-launch-filter="all">
      All <span class="launch-filter-count">${totalCount}</span>
    </button>
    ${companies.map((c) => `
      <button type="button"
              class="launch-filter-pill launch-tone-${c.tone} ${filterCompany === c.company ? "is-active" : ""}"
              data-launch-filter="${escapeHtml(c.company)}">
        ${escapeHtml(c.company)}
        <span class="launch-filter-count">${c.count}</span>
      </button>
    `).join("")}
  `;

  const cards = visibleItems.map((it) => {
    const tone = it.tone || "pv";
    const segmentChips = (it.segment_tags || [])
      .filter((t) => t && t !== "General")
      .slice(0, 2)
      .map((t) => `<span class="launch-segment-chip">${escapeHtml(t)}</span>`)
      .join("");
    return `
      <a class="launch-card launch-tone-${tone}" href="${escapeHtml(it.url)}" target="_blank" rel="noopener">
        <div class="launch-card-header">
          <span class="launch-company">${escapeHtml(it.company)}</span>
          <span class="launch-when" title="${escapeHtml(fmtDateLong(it.published_at))}">${escapeHtml(fmtRelative(it.published_at))}</span>
        </div>
        <h3 class="launch-title">${escapeHtml(stripTags(it.title))}</h3>
        ${it.summary ? `<p class="launch-summary">${escapeHtml(trimSummary(it.summary))}</p>` : ""}
        <div class="launch-card-footer">
          <span class="launch-source">${escapeHtml(it.source)}</span>
          ${segmentChips ? `<span class="launch-segment-chip-row">${segmentChips}</span>` : ""}
          <span class="launch-arrow" aria-hidden="true">↗</span>
        </div>
      </a>
    `;
  }).join("");

  const generatedDisplay = mod.source_meta?.latest_release_date
    ? `Latest launch dated ${fmtDateLong(mod.source_meta.latest_release_date)}`
    : "";

  return `
    <section id="section-recent-launches" class="section panel section-anchor">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Recent Launches</p>
          <h2>New model launches · last ${mod.window_days || 30} days</h2>
        </div>
        <p class="section-subtitle">
          Trade-media coverage from RushLane, ET Auto, Autocar Professional and EVReporter,
          filtered to launch / unveil / debut articles for tracked listed OEMs. Refreshed three times daily.
          ${generatedDisplay ? ` · <strong>${escapeHtml(generatedDisplay)}</strong>` : ""}
        </p>
      </div>
      <div class="launch-filter-row" role="tablist" aria-label="Filter launches by company">
        ${filterPills}
      </div>
      ${visibleItems.length
        ? `<div class="launch-grid">${cards}</div>`
        : `<p class="empty-note">No launches surfaced for ${escapeHtml(filterCompany)} in the last ${mod.window_days || 30} days.</p>`}
    </section>
  `;
}

function renderFestivePulseSection() {
  const fp = dashboardData.modules.festive_pulse;
  if (!fp?.available) return "";
  const latestYear = fp.latest_year;
  const calendar = fp.festival_calendar || {};
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);

  const festivalToneClass = {
    peak: "festival-tone-peak",
    national: "festival-tone-national",
    regional: "festival-tone-regional",
  };

  const renderFestivalRow = (festival) => {
    const isPast = festival.date < todayIso;
    const isUpcoming = festival.date >= todayIso;
    const tone = festivalToneClass[festival.tone] || "festival-tone-national";
    const dateObj = new Date(festival.date);
    const datePretty = dateObj.toLocaleDateString("en-IN", { month: "short", day: "numeric", year: "numeric" });
    const status = isPast ? "Past" : "Upcoming";
    return `
      <tr class="festival-row ${isUpcoming ? "is-upcoming" : "is-past"}">
        <td><span class="festival-pip ${tone}"></span>${festival.name}</td>
        <td><strong>${datePretty}</strong></td>
        <td>${festival.region}</td>
        <td><span class="festival-status">${status}</span></td>
      </tr>
    `;
  };

  const renderCalendarYearTable = (year) => {
    const festivals = (calendar[year] || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    if (!festivals.length) return "";
    return `
      <div class="festival-year-block">
        <h4>${year} festive calendar</h4>
        <table class="festival-table">
          <thead>
            <tr>
              <th>Festival</th>
              <th>Date</th>
              <th>Region</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${festivals.map(renderFestivalRow).join("")}
          </tbody>
        </table>
      </div>
    `;
  };

  // Bar chart of festive-window totals per year
  const yearChart = (() => {
    if (!fp.years || fp.years.length < 1) return "";
    const max = Math.max(...fp.years.map((y) => y.total_units || 0));
    return `
      <div class="festive-year-chart">
        ${fp.years.map((y) => {
          const pct = max ? (y.total_units / max) * 100 : 0;
          const isLatest = y.year === (latestYear?.year || "");
          return `
            <div class="festive-year-bar">
              <div class="festive-year-bar-label">${y.year}</div>
              <div class="festive-year-bar-track">
                <div class="festive-year-bar-fill ${isLatest ? "is-latest" : ""}" style="width:${pct}%;"></div>
                <span class="festive-year-bar-value">${formatUnits(y.total_units)} units</span>
              </div>
              <div class="festive-year-bar-meta">${y.month_count} mo${y.month_count > 1 ? "s" : ""} covered</div>
            </div>
          `;
        }).join("")}
      </div>
    `;
  })();

  // Per-category festive YoY
  const catYoy = fp.category_yoy || [];
  const catYoyBlock = catYoy.length
    ? `
      <div class="chart-card" data-explain-block>
        <p class="small-label">Category breakdown — ${latestYear?.year || ""} vs prior year</p>
        <table class="festive-cat-table">
          <thead>
            <tr><th>Category</th><th>Festive units</th><th>YoY</th></tr>
          </thead>
          <tbody>
            ${catYoy.map((c) => {
              const tone = c.yoy_pct === null ? "" : (c.yoy_pct >= 0 ? "is-pos" : "is-neg");
              const yoyText = c.yoy_pct === null ? "n.m." : `${c.yoy_pct >= 0 ? "+" : ""}${c.yoy_pct.toFixed(1)}%`;
              return `<tr class="${tone}"><td>${c.label}</td><td>${formatUnits(c.units)}</td><td><strong>${yoyText}</strong></td></tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    `
    : "";

  // Latest year monthly breakdown
  const monthlyRows = (latestYear?.monthly_rows || []).map((r) => {
    const yoy = r.total_yoy_pct;
    const tone = yoy === null || yoy === undefined ? "" : (yoy >= 0 ? "is-pos" : "is-neg");
    const yoyText = yoy === null || yoy === undefined ? "—" : `${yoy >= 0 ? "+" : ""}${yoy.toFixed(1)}%`;
    return `<tr class="${tone}"><td>${r.label}</td><td>${formatUnits(r.total_units)}</td><td><strong>${yoyText}</strong></td></tr>`;
  }).join("");

  const peakYoy = latestYear?.peak_month_yoy_pct;
  const peakTone = peakYoy === null || peakYoy === undefined ? "neutral" : (peakYoy >= 0 ? "positive" : "negative");
  const peakClass = `kpi-${peakTone}`;

  return `
    <section id="section-festive-pulse" class="section panel section-anchor">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Macro / Festive Pulse</p>
          <h2>Indian auto demand during the festive window</h2>
        </div>
        <p class="section-subtitle">${fp.window_label || ""} — captures Onam, Navratri, Dussehra, Dhanteras and Diwali driven retail.</p>
      </div>

      ${renderFestiveCountdown(fp.next_festival)}

      <div class="festive-hero-grid">
        <article class="festive-hero-card" data-explain="festive.window_total" tabindex="0">
          <p class="small-label">Festive window total — ${latestYear?.year || ""}</p>
          <p class="festive-hero-value">${formatUnits(latestYear?.total_units || 0)}</p>
          <p class="metric-detail">vehicles registered across India over ${latestYear?.month_count || 0} festive month${(latestYear?.month_count || 0) > 1 ? "s" : ""} (${(latestYear?.month_labels || []).join(", ")})</p>
        </article>
        <article class="festive-hero-card ${peakClass}" data-explain="festive.peak_yoy" tabindex="0">
          <p class="small-label">Peak festive month YoY — ${latestYear?.peak_month_label || ""}</p>
          <p class="festive-hero-value">${peakYoy === null || peakYoy === undefined ? "—" : (peakYoy >= 0 ? "+" : "") + peakYoy.toFixed(1) + "%"}</p>
          <p class="metric-detail">FADA-reported retail change vs same month one year ago</p>
        </article>
        <article class="festive-hero-card">
          <p class="small-label">Festivals tracked</p>
          <p class="festive-hero-value">${(calendar[String(today.getFullYear())] || []).length}</p>
          <p class="metric-detail">major retail-driving festivals on the ${today.getFullYear()} calendar</p>
        </article>
      </div>

      ${fp.narrative ? `<p class="festive-narrative">${fp.narrative}</p>` : ""}

      <div class="panel-grid one">
        ${monthlyRows ? `
          <div class="chart-card">
            <p class="small-label">Per-month retail in ${latestYear?.year || ""} festive window</p>
            <table class="festive-month-table">
              <thead>
                <tr><th>Month</th><th>Total retail</th><th>YoY %</th></tr>
              </thead>
              <tbody>
                ${monthlyRows}
              </tbody>
            </table>
          </div>
        ` : ""}

        ${yearChart ? `
          <div class="chart-card">
            <p class="small-label">Year-on-year festive window totals</p>
            ${yearChart}
            <p class="metric-detail" style="margin-top:10px;">Bars compare the Sep–Nov retail window each year. Snapshots earlier than ${(latestYear?.year || "")} carry partial-month coverage; the chart will deepen as cron picks up older releases.</p>
          </div>
        ` : ""}

        ${catYoyBlock}

        ${renderFestiveOemLeaderboard(fp.oem_leaderboard)}

        ${renderFestiveStockPerf()}

        <div class="chart-card">
          <p class="small-label">Festival calendar</p>
          <p class="metric-detail">Hindu calendar-based festivals shift ~10–15 days year over year. <strong>Dhanteras and Diwali</strong> are the single biggest car &amp; 2W buying days each year. <span class="festival-pip festival-tone-peak"></span> = retail peak day, <span class="festival-pip festival-tone-national"></span> = pan-India, <span class="festival-pip festival-tone-regional"></span> = regional.</p>
          <div class="festival-year-grid">
            ${[String(today.getFullYear()), String(today.getFullYear() + 1), String(today.getFullYear() - 1)]
              .filter((y) => calendar[y])
              .map(renderCalendarYearTable)
              .join("")}
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderPremiumDataSection() {
  const module_ = dashboardData.modules.premium_data;
  if (!module_?.available) {
    return "";
  }
  const summary = module_.summary || {};
  const sources = module_.sources || [];

  const statusToTone = {
    blocked: { label: "Blocked from cloud runners", tone: "premium-tone-red" },
    partial: { label: "Partially live", tone: "premium-tone-amber" },
    absent: { label: "Not yet integrated", tone: "premium-tone-blue" },
  };

  const renderCard = (src) => {
    const toneClass = `premium-tone-${src.color || "blue"}`;
    const status = statusToTone[src.status] || { label: src.status_label || "—", tone: toneClass };
    return `
      <article class="premium-card ${toneClass}">
        <header class="premium-card-head">
          <div class="premium-card-tier">${src.tier || ""}</div>
          <div class="premium-card-status ${status.tone}">${src.status_label || status.label}</div>
        </header>
        <h3 class="premium-card-title">${src.name}</h3>
        <p class="premium-card-tagline">${src.tagline || ""}</p>

        ${(src.currently_unlocks && src.currently_unlocks.length) ? `
          <div class="premium-card-section">
            <p class="small-label">Unlocks on this dashboard</p>
            <div class="premium-chip-row">
              ${src.currently_unlocks.map((item) => `<span class="premium-chip">${item}</span>`).join("")}
            </div>
          </div>
        ` : ""}

        ${(src.what_you_get && src.what_you_get.length) ? `
          <div class="premium-card-section">
            <p class="small-label">What you get</p>
            <ul class="premium-bullets">
              ${src.what_you_get.map((item) => `<li>${item}</li>`).join("")}
            </ul>
          </div>
        ` : ""}

        <footer class="premium-card-foot">
          <div class="premium-cost">
            <p class="small-label">Indicative cost</p>
            <p class="premium-cost-value">${src.cost || "—"}</p>
            ${src.cost_note ? `<p class="premium-cost-note">${src.cost_note}</p>` : ""}
          </div>
          ${src.cta_url ? `
            <a class="button button-primary premium-cta" href="${src.cta_url}" target="_blank" rel="noopener">
              ${src.cta_label || "Get access"} ↗
            </a>
          ` : ""}
        </footer>
      </article>
    `;
  };

  return `
    <section id="section-premium-data" class="section panel section-anchor">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Premium / Paid Data</p>
          <h2>Sources we don't yet feed live</h2>
        </div>
        <p class="section-subtitle">
          What's locked behind a paid subscription, and what each one would unlock on this dashboard
          if it were funded. Costs are indicative ranges, not quotes.
        </p>
      </div>

      <div class="premium-summary-row">
        <div class="premium-summary-tile premium-tone-red">
          <p class="kpi-label">Tabs blocked today</p>
          <p class="kpi-value">${summary.blocked || 0}</p>
          <p class="kpi-detail">Disabled due to source paywall / runner block</p>
        </div>
        <div class="premium-summary-tile premium-tone-amber">
          <p class="kpi-label">Partially live</p>
          <p class="kpi-value">${summary.partial || 0}</p>
          <p class="kpi-detail">Hardcoded snapshot, not auto-refreshing</p>
        </div>
        <div class="premium-summary-tile premium-tone-blue">
          <p class="kpi-label">Future enhancements</p>
          <p class="kpi-value">${summary.not_integrated || 0}</p>
          <p class="kpi-detail">Sources we'd add with a paid subscription</p>
        </div>
        <div class="premium-summary-tile">
          <p class="kpi-label">Total sources catalogued</p>
          <p class="kpi-value">${summary.total || sources.length}</p>
          <p class="kpi-detail">India auto demand + macro context coverage</p>
        </div>
      </div>

      <div class="premium-grid">
        ${sources.map(renderCard).join("")}
      </div>

      <p class="explainer-footer" style="margin-top:18px;">
        Want to activate one of these? Send the corresponding source URL on the right and I'll wire the
        scraper / SDK into the daily refresh workflow within one PR.
      </p>
    </section>
  `;
}

function renderCreditPulseSection() {
  const credit = dashboardData.modules.credit_pulse;
  if (!credit?.available) {
    return "";
  }
  const months = credit.months || [];
  const latest = credit.latest || {};
  const yoyChange = latest.yoy_change_pp;
  const yoyChangeNote = (yoyChange === null || yoyChange === undefined)
    ? ""
    : `${yoyChange >= 0 ? "+" : ""}${yoyChange.toFixed(1)} pp vs prior month`;
  const formatCrore = (value) => `₹${formatUnits(value)} cr`;
  const formatLakhCr = (value) => `₹${(value / 100000).toFixed(2)} lakh crore`;
  const trendSeries = [
    {
      label: "Vehicle Loans outstanding (₹ crore)",
      color: dashboardData.chart_colors?.primary || "#4c8bf5",
      values: months.map((point) => point.outstanding_cr),
    },
  ];
  const yoyComparisonSeries = [
    {
      label: "Vehicle loans YoY %",
      color: dashboardData.chart_colors?.primary || "#4c8bf5",
      values: months.map((point) => point.yoy_pct),
    },
    {
      label: "Total bank lending YoY %",
      color: dashboardData.chart_colors?.accent || "#f59e0b",
      values: months.map((point) => point.non_food_yoy_pct),
    },
  ];
  // The first ~12 months of the RBI series have null YoY values because
  // they predate the start of the year-over-year baseline. Drop them from
  // the YoY chart only so the line starts at the first month with real
  // data — keeps the outstanding-rupee chart unchanged.
  const yoyMonths = months.filter(
    (point) => point.yoy_pct !== null && point.yoy_pct !== undefined &&
               point.non_food_yoy_pct !== null && point.non_food_yoy_pct !== undefined,
  );
  const yoyComparisonChartSeries = [
    {
      label: "Vehicle loans YoY %",
      color: dashboardData.chart_colors?.primary || "#4c8bf5",
      values: yoyMonths.map((point) => point.yoy_pct),
    },
    {
      label: "Total bank lending YoY %",
      color: dashboardData.chart_colors?.accent || "#f59e0b",
      values: yoyMonths.map((point) => point.non_food_yoy_pct),
    },
  ];
  const seedNote = credit.source_meta?.is_seed
    ? `<div class="empty-note">Showing seed values from RBI Sectoral Deployment of Bank Credit press releases. The cron-driven RBI scraper will overwrite these with verified live readings on its next successful run.</div>`
    : "";

  const sharePct = latest.share_pct;
  const spreadPp = latest.spread_pp;
  const spreadColor = (spreadPp ?? 0) >= 0 ? "#10b981" : "#ef4444";

  const renderShareGauge = () => {
    if (sharePct === null || sharePct === undefined) {
      return "";
    }
    const fillPct = Math.max(0, Math.min(100, sharePct * 10));  // 0-10% maps to 0-100% bar width
    const ticks = [0, 2, 4, 6, 8, 10];
    return `
      <div class="chart-card">
        <div class="chart-title-row">
          <div data-explain="credit.share" tabindex="0">
            <p class="small-label">Auto's share of total bank lending &mdash; ${latest.label || ""}</p>
            <h3>${sharePct.toFixed(2)}%</h3>
            <p class="metric-detail">
              ₹${sharePct.toFixed(2)} of every ₹100 banks have lent across India goes to vehicle finance.
              Total bank lending: ${formatLakhCr(latest.non_food_total_cr || 0)}.
            </p>
          </div>
        </div>
        <div class="share-gauge">
          <div class="share-gauge-track">
            <div class="share-gauge-fill" style="width:${fillPct}%;"></div>
            <div class="share-gauge-marker" style="left:${fillPct}%;" title="${sharePct.toFixed(2)}%"></div>
          </div>
          <div class="share-gauge-ticks">
            ${ticks.map((t) => `<span class="share-gauge-tick">${t}%</span>`).join("")}
          </div>
        </div>
        <p class="metric-detail" style="margin-top:10px;">
          Healthy range historically sits between 3% and 4%.
          A drift higher = banks getting more "auto-heavy"; a drift lower = auto losing share to other lending.
        </p>
      </div>
    `;
  };

  const renderSpreadCard = () => {
    if (spreadPp === null || spreadPp === undefined) {
      return "";
    }
    const direction = spreadPp >= 0 ? "above" : "below";
    return `
      <div class="chart-card">
        <div class="chart-title-row">
          <div data-explain="credit.spread" tabindex="0">
            <p class="small-label">Vehicle vs total bank lending growth</p>
            <h3 style="color:${spreadColor};">${spreadPp >= 0 ? "+" : ""}${spreadPp.toFixed(1)} pp</h3>
            <p class="metric-detail">
              Vehicle loans growing ${formatSigned(latest.yoy_pct, 1)} YoY,
              ${direction} the ${formatSigned(latest.non_food_yoy_pct, 1)} pace of total bank lending.
            </p>
          </div>
        </div>
      </div>
    `;
  };

  return `
    <section id="section-credit-pulse" class="section panel section-anchor">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Macro / Credit Pulse</p>
          <h2>Bank vehicle-loan book growth from RBI</h2>
        </div>
        <div class="button-row">
          <button class="button button-explain" data-action="open-credit-explainer">Explain this tab</button>
        </div>
      </div>
      <p class="section-subtitle">${credit.source_meta?.note || ""}</p>
      <div class="panel-grid one">
        <div class="chart-card">
          <div class="chart-title-row">
            <div data-explain="credit.outstanding" tabindex="0">
              <p class="small-label">Latest reading &mdash; ${latest.label || ""}</p>
              <h3>${formatCrore(latest.outstanding_cr || 0)}</h3>
              <p class="metric-detail">
                ${latest.yoy_pct !== null && latest.yoy_pct !== undefined ? `${formatSigned(latest.yoy_pct, 1)} YoY` : "n.m."}
                ${yoyChangeNote ? ` &middot; ${yoyChangeNote}` : ""}
              </p>
            </div>
            <div class="button-row">
              ${renderSourceAction(latest.source_url || credit.source_meta?.url)}
            </div>
          </div>
          ${seedNote}
          <div class="chart-frame">
            ${lineChart(months.map((point) => point.label), trendSeries, formatUnits, formatCrore, buildChartEvents())}
          </div>
          <div class="chart-legend">
            ${trendSeries.map((s) => legendItem(s.label, s.color)).join("")}
          </div>
        </div>
        ${renderSpreadCard()}
        <div class="chart-card">
          <div class="chart-title-row">
            <div>
              <p class="small-label">YoY growth: vehicle loans vs total bank lending</p>
              <h3>Is auto credit running hotter or cooler than the broader lending market?</h3>
            </div>
          </div>
          <div class="chart-frame">
            ${lineChart(
              yoyMonths.map((point) => point.label),
              yoyComparisonChartSeries,
              (value) => `${Number(value || 0).toFixed(1)}%`,
              (value) => `${Number(value || 0).toFixed(1)}%`,
            )}
          </div>
          <div class="chart-legend">
            ${yoyComparisonSeries.map((s) => legendItem(s.label, s.color)).join("")}
          </div>
        </div>
        ${renderShareGauge()}
      </div>
    </section>
  `;
}

function renderCreditPulseExplainerModal() {
  if (!state.creditPulseExplainerOpen) {
    return "";
  }
  const credit = dashboardData.modules.credit_pulse;
  if (!credit?.available) {
    return "";
  }
  const latest = credit.latest || {};
  const months = credit.months || [];

  const formatLakhCr = (value) => `₹${(value / 100000).toFixed(2)} L cr`;
  const yoyText = (value) => (value === null || value === undefined ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`);

  const spreadPp = latest.spread_pp;
  const sharePct = latest.share_pct;
  const isPos = spreadPp >= 0;
  const spreadAbs = spreadPp === null || spreadPp === undefined
    ? "—"
    : `${isPos ? "+" : ""}${spreadPp.toFixed(1)} pp`;

  const olderWithSpread = months
    .filter((p) => p.yoy_pct !== null && p.yoy_pct !== undefined && p.non_food_yoy_pct !== null && p.non_food_yoy_pct !== undefined)
    .map((p) => ({ label: p.label, spread: p.yoy_pct - p.non_food_yoy_pct }));
  const oldest = olderWithSpread[0];

  // Position markers on the spread bar. Bar maps -5pp -> 0%, +5pp -> 100%.
  const spreadToPct = (pp) => Math.max(2, Math.min(98, 50 + (pp / 5) * 50));
  const oldPct = oldest ? spreadToPct(oldest.spread) : null;
  const newPct = spreadPp !== null && spreadPp !== undefined ? spreadToPct(spreadPp) : null;

  const takeawayClass = spreadPp >= 1 ? "takeaway-pos" : (spreadPp <= -1 ? "takeaway-neg" : "");
  const takeawayHeadline = spreadPp >= 1
    ? "Auto credit is running HOT"
    : (spreadPp <= -1 ? "Auto credit is running COOL" : "Auto credit tracking the broader cycle");
  const takeawayBody = spreadPp >= 1
    ? `Banks are lending to vehicle buyers <strong>${spreadAbs} faster</strong> than to everyone else combined. That's a bullish demand signal — consumers are choosing to buy, not just window-shop.`
    : (spreadPp <= -1
      ? `Banks are lending to vehicle buyers <strong>${spreadAbs}</strong> versus the rest of the economy. Consumers are pulling back on auto even when broader credit is healthy — caution flag for near-term sales.`
      : "Vehicle credit is moving in line with overall bank credit. No bullish or bearish edge from this signal right now.");

  const inflectionNarrative = oldest && Math.sign(oldest.spread) !== Math.sign(spreadPp || 0)
    ? `<strong>Big shift:</strong> spread flipped from ${oldest.spread >= 0 ? "+" : ""}${oldest.spread.toFixed(1)} pp to ${spreadAbs} in 12 months — that's the inflection your client wants to see.`
    : `Spread has held in the same direction over the last 12 months.`;

  return `
    <div class="explainer-overlay" data-action="close-credit-explainer">
      <div class="explainer-modal" role="dialog" aria-modal="true" aria-labelledby="credit-explainer-title">
        <button class="explainer-close" data-action="close-credit-explainer" aria-label="Close">×</button>
        <p class="small-label">Credit Pulse · Quick read</p>
        <h2 id="credit-explainer-title">${latest.label || "Latest"} — ${takeawayHeadline}</h2>

        <div class="explainer-kpi-row">
          <div class="explainer-kpi">
            <p class="kpi-label">Vehicle loans</p>
            <p class="kpi-value">${formatLakhCr(latest.outstanding_cr || 0)}</p>
            <p class="kpi-detail">Total outstanding</p>
          </div>
          <div class="explainer-kpi ${isPos ? "kpi-pos" : "kpi-neg"}">
            <p class="kpi-label">Vehicle YoY</p>
            <p class="kpi-value">${yoyText(latest.yoy_pct)}</p>
            <p class="kpi-detail">vs ${yoyText(latest.non_food_yoy_pct)} for total credit</p>
          </div>
          <div class="explainer-kpi ${isPos ? "kpi-pos" : "kpi-neg"}">
            <p class="kpi-label">Spread</p>
            <p class="kpi-value">${spreadAbs}</p>
            <p class="kpi-detail">${isPos ? "Auto leading" : "Auto lagging"}</p>
          </div>
        </div>

        ${oldPct !== null && newPct !== null ? `
        <div class="spread-bar-block">
          <p class="small-label">How the spread moved over 12 months</p>
          <div class="spread-bar">
            <div class="center-line"></div>
            <div class="marker marker-old" style="left:${oldPct}%;" title="${oldest.label}: ${oldest.spread >= 0 ? "+" : ""}${oldest.spread.toFixed(1)} pp"></div>
            <div class="marker marker-new" style="left:${newPct}%;" title="${latest.label}: ${spreadAbs}"></div>
          </div>
          <div class="spread-bar-labels">
            <span class="end-neg">−5 pp · auto lagging</span>
            <span>0 pp · in-line</span>
            <span class="end-pos">+5 pp · auto leading</span>
          </div>
          <div class="spread-bar-narrative">
            <span class="anchor">
              <strong style="color:#8a2727;">${oldest.spread >= 0 ? "+" : ""}${oldest.spread.toFixed(1)} pp</strong>
              <span class="kpi-detail" style="margin:0;">${oldest.label}</span>
            </span>
            <span class="arrow">→</span>
            <span class="anchor">
              <strong style="color:#1d5a4f;">${spreadAbs}</strong>
              <span class="kpi-detail" style="margin:0;">${latest.label}</span>
            </span>
          </div>
          <p class="kpi-detail" style="margin-top:10px;">${inflectionNarrative}</p>
        </div>
        ` : ""}

        <div class="takeaway-box ${takeawayClass}">
          <h3>What this means in plain English</h3>
          <p>${takeawayBody}</p>
        </div>

        <p class="small-label" style="margin-top:18px;">Why we even track this on an auto dashboard</p>
        <ul class="checklist">
          <li><strong>Real demand check.</strong> Banks won't lend if buyers don't show up. Loan growth ${isPos ? "above" : "below"} the rest of the economy ${isPos ? "confirms" : "undercuts"} the demand story.</li>
          <li><strong>Reality check on dealer reports.</strong> FADA / SIAM numbers can wobble on month-end push. Bank credit is harder to fake — useful triangulation.</li>
          <li><strong>Sector exposure.</strong> Vehicle loans = <strong>${sharePct === null || sharePct === undefined ? "—" : sharePct.toFixed(2) + "%"}</strong> of total bank lending. Watch this drift to spot when the system gets auto-heavy.</li>
        </ul>

        <p class="explainer-footer">
          Source: <a href="${credit.source_meta?.url || "#"}" target="_blank" rel="noopener">RBI — Sectoral Deployment of Bank Credit</a>
          · Data through ${latest.label || ""}
          · Total bank lending: ${formatLakhCr(latest.non_food_total_cr || 0)}
        </p>
      </div>
    </div>
  `;
}

function renderMarketInsightsRibbon() {
  const cards = dashboardData.market_insights || [];
  if (!cards.length) {
    return "";
  }
  const ribbonExplainKey = {
    "Demand winner": "ribbon.demand_winner",
    "Demand laggard": "ribbon.demand_laggard",
    "EV penetration": "ribbon.ev_penetration",
    "Auto-credit pulse": "ribbon.credit_pulse",
    "Dealer inventory": "ribbon.dealer_inventory",
    "Channel balance (PV)": "ribbon.channel_balance",
  };
  const renderCard = (card) => {
    const tone = card.tone || "neutral";
    const tabAttr = card.tab_id ? `data-target-tab="${card.tab_id}"` : "";
    const anchorAttr = card.section_anchor ? `data-target-anchor="${card.section_anchor}"` : "";
    const explainKey = ribbonExplainKey[card.kicker];
    const explainAttr = explainKey ? `data-explain="${explainKey}"` : "";
    return `
      <button class="insight-ribbon-card insight-tone-${tone}" ${tabAttr} ${anchorAttr} ${explainAttr}>
        <span class="insight-ribbon-icon" aria-hidden="true">${card.icon || ""}</span>
        <span class="insight-ribbon-body">
          <span class="insight-ribbon-kicker">${card.kicker || ""}</span>
          <span class="insight-ribbon-value">${card.value || ""}</span>
          <span class="insight-ribbon-narrative">${card.narrative || ""}</span>
        </span>
      </button>
    `;
  };
  return `
    <section class="insight-ribbon" aria-label="Market insights summary">
      <p class="insight-ribbon-title">
        <span class="insight-ribbon-pulse" aria-hidden="true"></span>
        Live market signals — auto-generated from this month's data
      </p>
      <div class="insight-ribbon-grid">
        ${cards.map(renderCard).join("")}
      </div>
    </section>
  `;
}

function setupMarketInsightsRibbon() {
  document.querySelectorAll(".insight-ribbon-card").forEach((node) => {
    node.addEventListener("click", () => {
      const tabId = node.getAttribute("data-target-tab");
      const anchor = node.getAttribute("data-target-anchor");
      if (anchor) {
        pendingScrollTarget = anchor;
      }
      if (tabId && tabId !== state.activeTab) {
        state.activeTab = tabId;
        render();
      } else if (anchor) {
        scrollToPendingSection();
      }
    });
  });
}

// Singleton tooltip used by setupExplainerTooltips. Wires hover/focus on
// any element with `data-explain="<key>"` (key looked up in
// METRIC_EXPLAINERS) and shows a styled popover with the explanation.
function _ensureExplainerTooltipNode() {
  let node = document.getElementById("explainer-tooltip");
  if (node) return node;
  node = document.createElement("div");
  node.id = "explainer-tooltip";
  node.className = "metric-tooltip";
  node.setAttribute("role", "tooltip");
  node.style.display = "none";
  document.body.appendChild(node);
  return node;
}

function _showExplainerTooltip(target, explainer) {
  const node = _ensureExplainerTooltipNode();
  node.innerHTML = `
    <p class="metric-tooltip-title">${explainer.title || ""}</p>
    <p class="metric-tooltip-body">${explainer.body || ""}</p>
  `;
  node.style.display = "block";
  // Position: prefer above the target, but flip below if too close to top.
  const rect = target.getBoundingClientRect();
  const tipRect = node.getBoundingClientRect();
  const margin = 10;
  let top = rect.top + window.scrollY - tipRect.height - margin;
  if (top < window.scrollY + 16) {
    top = rect.bottom + window.scrollY + margin;
  }
  let left = rect.left + window.scrollX + rect.width / 2 - tipRect.width / 2;
  const maxLeft = window.scrollX + window.innerWidth - tipRect.width - 16;
  const minLeft = window.scrollX + 16;
  if (left < minLeft) left = minLeft;
  if (left > maxLeft) left = maxLeft;
  node.style.top = `${top}px`;
  node.style.left = `${left}px`;
}

function _hideExplainerTooltip() {
  const node = document.getElementById("explainer-tooltip");
  if (node) node.style.display = "none";
}

function setupExplainerTooltips() {
  document.querySelectorAll("[data-explain]").forEach((target) => {
    const key = target.getAttribute("data-explain");
    const explainer = METRIC_EXPLAINERS[key];
    if (!explainer) return;
    target.classList.add("has-explainer");
    let showTimer = null;
    const onEnter = () => {
      clearTimeout(showTimer);
      showTimer = setTimeout(() => _showExplainerTooltip(target, explainer), 250);
    };
    const onLeave = () => {
      clearTimeout(showTimer);
      _hideExplainerTooltip();
    };
    target.addEventListener("mouseenter", onEnter);
    target.addEventListener("mouseleave", onLeave);
    target.addEventListener("focus", onEnter);
    target.addEventListener("blur", onLeave);
  });
}

function setupCreditPulseExplainer() {
  document.querySelectorAll("[data-action=\"open-credit-explainer\"]").forEach((node) => {
    node.addEventListener("click", () => {
      state.creditPulseExplainerOpen = true;
      render();
    });
  });
  document.querySelectorAll("[data-action=\"close-credit-explainer\"]").forEach((node) => {
    node.addEventListener("click", (event) => {
      if (event.target === node) {
        state.creditPulseExplainerOpen = false;
        render();
      }
    });
  });
  if (state.creditPulseExplainerOpen && !window.__creditExplainerEscBound) {
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.creditPulseExplainerOpen) {
        state.creditPulseExplainerOpen = false;
        render();
      }
    });
    window.__creditExplainerEscBound = true;
  }
}

function lineChart(labels, series, formatter, tooltipFormatter = formatter, events = []) {
  const activeSeries = series.filter((item) => item.values.some((value) => value !== null && value !== undefined));
  const width = 820;
  const height = 320;
  // Padding budget: room for ~5-char Y values on the left, half-label on the
  // right so the rightmost x-tick can extend without clipping.
  const pad = { top: 18, right: 28, bottom: 40, left: 56 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const allValues = activeSeries.flatMap((item) => item.values).filter((value) => value !== null && value !== undefined);
  const rawMax = allValues.length ? Math.max(...allValues) : 1;
  const rawMin = allValues.length ? Math.min(...allValues) : 0;
  // When all values sit in a narrow band well above zero (e.g. monthly OEM sales
  // ~150-240k), zooming in on the band makes month-to-month volatility visible.
  // When the data spans most of [0, max] or crosses zero, keep the axis anchored
  // at zero so absolute scale stays honest.
  let yMin;
  let yMax;
  const span = rawMax - rawMin;
  const tightenable = rawMin > 0 && span > 0 && span / rawMax < 0.5;
  if (tightenable) {
    const padding = span * 0.18;
    yMin = Math.max(0, rawMin - padding);
    yMax = rawMax + padding;
  } else {
    yMin = Math.min(0, rawMin);
    yMax = Math.max(rawMax, 1);
  }
  const yRange = yMax - yMin || 1;
  // 3 horizontal gridlines (top, middle, bottom) is the readable minimum for
  // a quant chart — denser grids fight the data line.
  const steps = 3;
  // Cap visible x-labels to ~6 so they breathe instead of overlapping.
  const xLabelStep = labels.length > 10 ? Math.ceil(labels.length / 6) : 1;

  const gridLines = Array.from({ length: steps + 1 }, (_, index) => {
    const y = pad.top + (innerHeight / steps) * index;
    const value = yMax - (yRange / steps) * index;
    const isBaseline = index === steps;
    return `
      <g>
        <line x1="${pad.left}" x2="${width - pad.right}" y1="${y}" y2="${y}"
              stroke="${isBaseline ? "rgba(20,39,62,0.22)" : "rgba(20,39,62,0.07)"}"
              stroke-width="${isBaseline ? 1 : 1}" />
        <text x="${pad.left - 10}" y="${y + 4}" text-anchor="end"
              font-size="11" font-weight="500" fill="#667687"
              font-family="inherit">${formatter(value)}</text>
      </g>
    `;
  }).join("");

  // X-axis labels: anchor the first label "start" and the last "end" so they
  // never extend past the plot area into the panel padding (the original
  // "middle"-anchored extremes were the visible "axis going out of the tab"
  // problem).
  const xLabels = labels.map((label, index) => {
    if (index % xLabelStep !== 0 && index !== labels.length - 1) {
      return "";
    }
    const x = pad.left + (innerWidth / Math.max(labels.length - 1, 1)) * index;
    let anchor = "middle";
    let dx = 0;
    if (index === 0) {
      anchor = "start";
      dx = -2;
    } else if (index === labels.length - 1) {
      anchor = "end";
      dx = 2;
    }
    return `<text x="${x + dx}" y="${height - 14}" text-anchor="${anchor}"
                  font-size="11" font-weight="500" fill="#667687"
                  font-family="inherit">${label}</text>`;
  }).join("");

  // Auto-detect anomalous monthly prints using a simple z-score against the
  // trailing 4-month window. Tight thresholds (|z| >= 2.5 AND |deviation|
  // >= 20% of trailing mean) so smooth-trending series like RBI credit
  // growth don't pick up nuisance markers — only genuine surprise months
  // get flagged. Direction (positive vs negative deviation) is preserved
  // so the halo can render in green or red instead of always alarming red.
  const detectAnomalies = (values) => {
    const flagged = new Map();
    const annotations = [];
    if (!Array.isArray(values) || values.length < 5) return { flagged, annotations };
    for (let i = 3; i < values.length; i += 1) {
      const v = values[i];
      if (v === null || v === undefined || Number.isNaN(Number(v))) continue;
      const window = values.slice(Math.max(0, i - 4), i)
        .filter((x) => x !== null && x !== undefined && !Number.isNaN(Number(x)))
        .map((x) => Number(x));
      if (window.length < 3) continue;
      const mean = window.reduce((a, b) => a + b, 0) / window.length;
      const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length;
      const stddev = Math.sqrt(variance);
      if (stddev <= 0 || mean === 0) continue;
      const z = (v - mean) / stddev;
      const pctDeviation = Math.abs((v - mean) / mean);
      if (Math.abs(z) >= 2.5 && pctDeviation >= 0.2) {
        const direction = z > 0 ? "up" : "down";
        flagged.set(i, { direction, z, pct: pctDeviation, mean });
        annotations.push({ index: i, direction, z, pct: pctDeviation, mean });
      }
    }
    return { flagged, annotations };
  };

  const seriesAnomalyData = activeSeries.map((item) => (
    item.dashed === true ? { flagged: new Set(), annotations: [] } : detectAnomalies(item.values)
  ));

  const lines = activeSeries.map((item, seriesIdx) => {
    const anomalyFlags = seriesAnomalyData[seriesIdx].flagged;
    const points = item.values.map((value, index) => {
      if (value === null || value === undefined) return null;
      const x = pad.left + (innerWidth / Math.max(item.values.length - 1, 1)) * index;
      const numericValue = Number(value);
      const y = pad.top + innerHeight - ((numericValue - yMin) / yRange) * innerHeight;
      const flag = anomalyFlags.get(index);
      return { x, y, value, label: labels[index], anomaly: flag || null };
    }).filter(Boolean);
    if (!points.length) return "";
    const d = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
    // Series with `dashed: true` are prior-year overlays for WOW 10's
    // "Compare to prior year" toggle. Render thinner + dashed + lower
    // opacity, and skip the data dots so they don't crowd the current line.
    const isDashed = item.dashed === true;
    const strokeAttrs = isDashed
      ? `stroke="${item.color}" stroke-width="2.2" stroke-dasharray="6 4" opacity="0.7"`
      : `stroke="${item.color}" stroke-width="2.6"`;
    return `
      <g>
        <path d="${d}" fill="none" ${strokeAttrs} stroke-linecap="round" stroke-linejoin="round"></path>
        ${isDashed ? "" : points.map((point) => {
          const anomalyHalo = point.anomaly ? (() => {
            // Directional halo: teal-green for upside surprise, red for
            // downside. Smaller radius (5 → 6) and lower opacity than the
            // first cut so the data line stays the hero, the halo just
            // catches the eye.
            const isUp = point.anomaly.direction === "up";
            const haloFill = isUp ? "rgba(47,137,125,0.16)" : "rgba(204,67,67,0.16)";
            const haloStroke = isUp ? "rgba(47,137,125,0.5)" : "rgba(204,67,67,0.5)";
            return `<circle cx="${point.x}" cy="${point.y}" r="6.5" fill="${haloFill}" stroke="${haloStroke}" stroke-width="1.2" pointer-events="none"></circle>`;
          })() : "";
          // Tooltip payload as JSON — showTooltip parses it and renders a
          // structured multi-line layout (label / period / value / note).
          const noteParts = [];
          if (point.anomaly) {
            const direction = point.anomaly.direction === "up" ? "Upside" : "Downside";
            const pctText = `${(point.anomaly.pct * 100).toFixed(1)}%`;
            noteParts.push(`${direction} surprise — ${pctText} vs trailing 4-mo avg`);
          }
          const tooltipPayload = JSON.stringify({
            label: item.label,
            period: point.label,
            value: tooltipFormatter(point.value),
            note: noteParts.length ? noteParts.join(" · ") : "",
          });
          return `
            ${anomalyHalo}
            <circle cx="${point.x}" cy="${point.y}" r="3.5" fill="#fff" stroke="${item.color}" stroke-width="2" pointer-events="none"></circle>
            <circle
              class="chart-hover-target"
              cx="${point.x}"
              cy="${point.y}"
              r="14"
              fill="transparent"
              data-tooltip="${escapeHtml(tooltipPayload)}"
            ></circle>
          `;
        }).join("")}
      </g>
    `;
  }).join("");

  // Auto-anomalies feed the events caption strip too, so investors see a
  // textual readout below the chart explaining which months tripped the flag.
  const anomalyEvents = [];
  activeSeries.forEach((item, seriesIdx) => {
    seriesAnomalyData[seriesIdx].annotations.forEach((anno) => {
      const monthRaw = labels[anno.index];
      if (!monthRaw) return;
      const direction = anno.direction === "up" ? "spike" : "drop";
      const label = activeSeries.length > 1
        ? `${item.label}: ${direction} (z=${anno.z >= 0 ? "+" : ""}${anno.z.toFixed(1)})`
        : `Outlier ${direction} (z=${anno.z >= 0 ? "+" : ""}${anno.z.toFixed(1)})`;
      anomalyEvents.push({ rawLabel: monthRaw, label, tone: "anomaly" });
    });
  });

  // Events list — render BELOW the chart as a small caption strip rather
  // than as floating dots inside the chart itself. The on-chart markers
  // looked disconnected from the data line; the caption is cleaner. The
  // strip combines static calendar events (from the `events` arg) and the
  // auto-detected anomaly markers we just generated, so investors see one
  // unified "what's notable about this window" readout.
  const matchedStaticEvents = (events || [])
    .filter((event) => {
      if (!event?.month) return false;
      const matchLabel = monthLabel(event.month);
      return matchLabel && labels.indexOf(matchLabel) >= 0;
    })
    .map((event) => ({ resolvedLabel: monthLabel(event.month), label: event.label, tone: event.tone || "policy" }));
  const matchedAnomalyEvents = anomalyEvents.map((event) => ({
    resolvedLabel: event.rawLabel,
    label: event.label,
    tone: event.tone || "anomaly",
  }));
  const matchedEvents = [...matchedStaticEvents, ...matchedAnomalyEvents];
  const palette = {
    policy: "#4c74c7",
    festive: "#c26c3a",
    milestone: "#7a4cc7",
    macro: "#2f897d",
    earnings: "#a66325",
    anomaly: "#cc4343",
  };
  const eventCaption = matchedEvents.length
    ? `<div class="chart-events-caption">
         <span class="chart-events-caption-label">Notable events in this window:</span>
         ${matchedEvents.map((event) => {
           const color = palette[event.tone] || palette.policy;
           return `<span class="chart-event-chip" style="--chip-color:${color};">
             <span class="chart-event-chip-month">${event.resolvedLabel}</span>
             ${event.label}
           </span>`;
         }).join("")}
       </div>`
    : "";

  return `
    <svg class="line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Line chart">
      ${gridLines}
      ${lines}
      ${xLabels}
    </svg>
    ${eventCaption}
  `;
}

function slugify(value) {
  return `${value || ""}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function monthLabel(value) {
  if (!value) {
    return "-";
  }
  const [year, month] = `${value}`.split("-").map((item) => Number(item));
  const date = new Date(Date.UTC(year, (month || 1) - 1, 1));
  return date.toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}

function escapeHtml(value) {
  return `${value ?? ""}`
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// State keys that survive across reloads via the URL hash. Defaults match
// the initial values in `state` so we only serialize what the user has
// actually deviated from — keeps shared URLs short and human-readable.
const URL_STATE_DEFAULTS = {
  activeTab: "overview",
  window: "5m",
  lens: "all",
  category: "TOTAL",
  fuel: "all",
  company: "all",
  companyMapFocus: null,
  newsGroup: "all",
  density: "comfortable",
  companyTrend: "all",
  companyTrendCompare: [],
  companyTrendIndexed: false,
  registrationState: "all",
  registrationSegment: "PV",
  segmentShareView: "TOTAL",
  rawMaterialCompany: "Tata Motors",
  componentTrendCompany: "Maruti Suzuki",
  evCategory: "TOTAL",
  evPeriod: "M",
  evOemSegment: "E2W",
  oemSegment: "PV",
  liveOemPeriods: { PV: "M", CV: "M", "2W": "Q" },
  compareToPriorCycle: false,
  launchFilterCompany: "all",
};

function isDefaultStateValue(key, value) {
  const def = URL_STATE_DEFAULTS[key];
  if (Array.isArray(def)) return JSON.stringify(value) === JSON.stringify(def);
  if (def && typeof def === "object") return JSON.stringify(value) === JSON.stringify(def);
  return value === def;
}

function serializeStateToUrl() {
  const params = new URLSearchParams();
  Object.keys(URL_STATE_DEFAULTS).forEach((key) => {
    const cur = state[key];
    if (cur === undefined || cur === null) return;
    if (isDefaultStateValue(key, cur)) return;
    if (Array.isArray(cur)) {
      params.set(key, cur.join("|"));
    } else if (typeof cur === "object") {
      params.set(key, JSON.stringify(cur));
    } else if (typeof cur === "boolean") {
      params.set(key, cur ? "1" : "0");
    } else {
      params.set(key, String(cur));
    }
  });
  const hash = params.toString();
  const path = window.location.pathname + window.location.search;
  // replaceState keeps the back/forward stack from filling up with every
  // filter click; the URL still updates so Copy-Link works at any moment.
  if (hash) {
    window.history.replaceState(null, "", `${path}#${hash}`);
  } else if (window.location.hash) {
    window.history.replaceState(null, "", path);
  }
}

function restoreStateFromUrl() {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return;
  let params;
  try {
    params = new URLSearchParams(hash);
  } catch {
    return;
  }
  Object.keys(URL_STATE_DEFAULTS).forEach((key) => {
    if (!params.has(key)) return;
    const raw = params.get(key);
    const def = URL_STATE_DEFAULTS[key];
    try {
      if (Array.isArray(def)) {
        state[key] = raw ? raw.split("|").filter(Boolean) : [];
      } else if (def && typeof def === "object") {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") state[key] = parsed;
      } else if (typeof def === "boolean") {
        state[key] = raw === "1" || raw === "true";
      } else {
        state[key] = raw;
      }
    } catch {
      // Ignore malformed URL params — fall back to default.
    }
  });
}

function main() {
  loadDashboard()
    .then((data) => {
      dashboardData = data;
      restoreStateFromUrl();
      render();
    })
    .catch((error) => {
      document.getElementById("app").innerHTML = `
        <section class="loading-panel">
          <p class="eyebrow">Dashboard failed to load</p>
          <h1>${error.message}</h1>
          <p>The app expects <code>data/investor_dashboard.json</code>. I can regenerate it if needed.</p>
        </section>
      `;
    });
}

main();
