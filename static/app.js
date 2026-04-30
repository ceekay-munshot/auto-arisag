let dashboardData = null;
const state = {
  window: "5m",
  lens: "all",
  category: "TOTAL",
  fuel: "all",
  company: "all",
  companyMapFocus: null,
  newsGroup: "all",
  companyTrend: "all",
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
};

const SECTION_TO_TAB = {
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
};
const refreshState = {
  loading: false,
  message: "Reload the latest validated dashboard dataset.",
  tone: "neutral",
};
let pendingScrollTarget = null;
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
  return `<a class="button button-link source-button" href="${url}" target="_blank" rel="noreferrer">${label}</a>`;
}

function renderSourceActions(items = []) {
  return asArray(items)
    .filter((item) => item?.url)
    .map((item) => renderSourceAction(item.url, item.label || "Source"))
    .join("");
}

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
    node.addEventListener("click", () => {
      const record = downloadRegistry.get(node.dataset.downloadKey);
      if (!record) {
        return;
      }
      const header = record.columns.join(",");
      const rows = record.rows.map((row) =>
        record.columns
          .map((column) => csvEscape(row[column]))
          .join(",")
      );
      const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = record.filename;
      link.click();
      URL.revokeObjectURL(url);
    });
  });
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
    render();
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
  node.textContent = text;
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
  return [
    {
      id: "overview",
      label: "Overview",
      group: "Top",
      render: () => [
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
  ];
}

function visibleTabs() {
  return tabDefinitions().filter((tab) => !tab.hidden);
}

function activeTabDefinition() {
  const tabs = visibleTabs();
  return tabs.find((tab) => tab.id === state.activeTab) || tabs[0];
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
          ${group.tabs.map((tab) => `
            <button
              class="side-nav-item${tab.id === activeId ? " is-active" : ""}"
              data-tab="${tab.id}"
              type="button"
            >${tab.label}</button>
          `).join("")}
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
    renderFilters(),
    `<div class="dashboard-body">
       ${renderSideNav(activeTab.id)}
       <main class="dashboard-content">${activeTab.render()}</main>
     </div>`,
  ].join("");

  setupFilters();
  setupTabBar();
  setupNewsPicker();
  setupCompanyTrendPicker();
  setupRefreshAction();
  setupStateRegistrationExplorer();
  setupSegmentShareExplorer();
  setupRawMaterialExplorer();
  setupCompanySegmentTrendExplorer();
  setupEvTrendExplorer();
  setupEvOemTracker();
  setupLiveOemTrackers();
  setupOemSection();
  setupSorts();
  setupCompanyMapCards();
  setupDownloads();
  setupChartTooltips();
  requestAnimationFrame(() => {
    scrollToPendingSection();
  });
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
  return `
    <article class="summary-card ${tone}">
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
          <h2>FADA retail momentum and category mix</h2>
        </div>
        <p class="section-subtitle">${retail.source_meta.note}</p>
      </div>
      <div class="panel-grid two">
        <div class="chart-card">
          <div class="chart-title-row">
            <div>
              <p class="small-label">Monthly trend</p>
              <h3>${companyFocused ? "Retail momentum in company-linked categories" : "Retail momentum by category"}</h3>
            </div>
            <div class="button-row">
              ${renderSourceAction(retail.source_meta.url)}
              <button class="button" data-download-key="retail-trend">Download CSV</button>
            </div>
          </div>
          <div class="chart-frame">
            ${lineChart(months.map((item) => item.label), trendSeries, axisFormat, formatUnits)}
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
      <div class="panel-grid two">
        <div class="chart-card">
          <div class="chart-title-row">
            <div>
              <p class="small-label">Monthly trend</p>
              <h3>${companyFocused ? "Retail momentum in company-linked categories" : "Retail momentum by category"}</h3>
            </div>
            <div class="button-row">
              ${renderSourceAction(retail.source_meta.url)}
              <button class="button" data-download-key="retail-trend">Download CSV</button>
            </div>
          </div>
          <div class="chart-frame">
            ${lineChart(months.map((item) => item.label), trendSeries, axisFormat, formatUnits)}
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

function renderCategoryCard(item) {
  return `
    <article class="chip-card">
      <div class="chip-card-head">
        <div>
          <p class="small-label">${item.label}</p>
          <h3>${formatLakh(item.units)}</h3>
        </div>
        ${chip(`${item.share_pct.toFixed(1)}% mix`, "active")}
      </div>
      <div class="stat-inline">
        <div class="stat-block">
          <span class="small-label">YoY</span>
          <strong class="${item.yoy_pct >= 0 ? "positive" : "negative"}">${formatSigned(item.yoy_pct)}</strong>
        </div>
        <div class="stat-block">
          <span class="small-label">MoM</span>
          <strong class="${item.mom_pct >= 0 ? "positive" : "negative"}">${formatSigned(item.mom_pct)}</strong>
        </div>
      </div>
      <p class="table-note">Mapped listed names: ${item.listed_companies.join(", ") || "No direct listed mapping"}</p>
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
    <div id="section-ev" class="panel-grid two section-anchor">
      <div class="panel-grid one">
        <div class="chart-card">
          <div class="chart-title-row">
            <div>
              <p class="small-label">EV dashboard</p>
              <h3>Derived EV penetration from official retail fuel mix</h3>
            </div>
            <div class="button-row">
              <button class="button" data-download-key="ev-trend">Download CSV</button>
            </div>
          </div>
          <div class="chart-frame">
            ${lineChart(months.map((item) => item.label), evSeries, (value) => `${value.toFixed(1)}%`, (value) => formatPct(value, 2))}
          </div>
          <div class="chart-legend">
            ${evSeries.map((series) => legendItem(series.label, series.color)).join("")}
          </div>
          <p class="legend-note">Caveat: this is a retail fuel-mix derivation from FADA, not a Vahan registration series.</p>
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
      <div class="panel-grid one">
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
  return [
    {
      id: "E2W",
      label: "EV 2W",
      latest_month: "Feb 2026",
      total_units: 111709,
      compare_label: "Feb 2025 units",
      growth_label: "YoY growth",
      source_name: "RushLane",
      source_url: "https://www.rushlane.com/category/electric-vehicles",
      note: "Article-derived high-speed e-2W retail tracker built on recent public FADA/Vahan-based reporting. Low-speed e-2W data is excluded.",
      rows: [
        { oem: "TVS Motor", units: 31614, prior_units: 18955 },
        { oem: "Bajaj Auto", units: 25328, prior_units: 21571 },
        { oem: "Ather Energy", units: 20584, prior_units: 11978 },
        { oem: "Hero Vida", units: 12514, prior_units: 2696 },
        { oem: "Greaves Ampere", units: 4725, prior_units: 3730 },
        { oem: "Ola Electric", units: 3968, prior_units: 8675 },
      ],
    },
    {
      id: "E4W",
      label: "EV 4W",
      latest_month: "Feb 2026",
      total_units: 13733,
      compare_label: "Feb 2025 units",
      growth_label: "YoY growth",
      source_name: "RushLane",
      source_url: "https://www.rushlane.com/category/electric-vehicles",
      note: "Article-derived electric car retail tracker from recent public market reporting. Shares are computed on the latest visible segment total from the same summary.",
      rows: [
        { oem: "Tata Motors", units: 5568, prior_units: 4020 },
        { oem: "JSW MG Motor", units: 3312, prior_units: 3490 },
        { oem: "Mahindra & Mahindra", units: 2913, prior_units: 508 },
        { oem: "BYD", units: 306, prior_units: 278 },
        { oem: "Hyundai", units: 304, prior_units: 93 },
        { oem: "BMW", units: 245, prior_units: 239 },
      ],
    },
    {
      id: "E3WG",
      label: "E-3W Goods",
      latest_month: "Feb 2026",
      total_units: 3196,
      compare_label: "Feb 2025 units",
      growth_label: "YoY growth",
      source_name: "CMV360",
      source_url: "https://www.cmv360.com/news/e-3w-goods-l5-sales-report-february-2026?amp=1",
      note: "OEM-wise electric cargo 3W table from CMV360's February 2026 summary. Shares are computed against the public EVReporter category total for E-3W goods.",
      rows: [
        { oem: "Mahindra Last Mile Mobility", units: 571, prior_units: 592 },
        { oem: "Bajaj Auto", units: 453, prior_units: 430 },
        { oem: "Omega Seiki", units: 377, prior_units: 534 },
        { oem: "Atul Auto", units: 287, prior_units: 74 },
        { oem: "Euler Motors", units: 201, prior_units: 199 },
        { oem: "Green Evolve", units: 151, prior_units: 68 },
      ],
    },
    {
      id: "EBUS",
      label: "E-Bus",
      latest_month: "Feb 2026",
      total_units: 578,
      compare_label: "Jan 2026 units",
      growth_label: "MoM growth",
      source_name: "CMV360",
      source_url: "https://www.cmv360.com/news/india-s-electric-bus-sales-decline-in-january-2026-oem-wise-performance-and-market-share",
      note: "Electric bus OEM table uses the latest recent public CMV360 market-share summary available in this environment. Growth here is sequential against the prior visible month.",
      rows: [
        { oem: "Switch Mobility", units: 280, prior_units: 100 },
        { oem: "JBM Electric", units: 87, prior_units: 110 },
        { oem: "PMI Electro Mobility", units: 63, prior_units: 50 },
        { oem: "Olectra Greentech", units: 46, prior_units: 46 },
        { oem: "Tata Motors", units: 35, prior_units: 26 },
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
          <button class="button" data-download-key="ev-oem-tracker">Download CSV</button>
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
          <button class="button" data-download-key="ev-category-trend">Download CSV</button>
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
          ${["M", "Q", "Y"].map((period) => `
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
          <button class="button" data-download-key="state-registration-trend">Download CSV</button>
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
    <div class="panel-grid two channel-grid">
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
  const ev = evOemTrackerDatasets().map((dataset) => ({
    id: dataset.id,
    group: "ev",
    kind: "ev",
    label: dataset.label,
    dataset,
  }));
  return [...fada, ...ev];
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
  const evChips = segments.filter((segment) => segment.group === "ev").map(renderChip).join("");
  return `
    <div class="oem-chip-row">
      <div class="oem-chip-group">
        <span class="oem-chip-group-label">FADA retail</span>
        <div class="oem-chip-group-items">${fadaChips}</div>
      </div>
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

function findCompanyTrendForRow(row) {
  const trends = asArray(dashboardData.modules.retail?.company_unit_trends);
  if (!trends.length) {
    return null;
  }
  const candidates = asArray(row.listed_companies);
  if (!candidates.length) {
    return null;
  }
  for (const candidate of candidates) {
    const match = trends.find((trend) => trend.company === candidate);
    if (match) {
      return match;
    }
  }
  return null;
}

function inlineSparkline(values, color = "#c26c3a") {
  const numeric = values.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (numeric.length < 2) {
    return '<span class="oem-sparkline-empty">–</span>';
  }
  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  const range = max - min || 1;
  const width = 96;
  const height = 28;
  const stepX = numeric.length > 1 ? width / (numeric.length - 1) : 0;
  const points = numeric.map((value, index) => {
    const x = index * stepX;
    const y = height - 4 - ((value - min) / range) * (height - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = points[points.length - 1].split(",");
  const first = numeric[0];
  const lastValue = numeric[numeric.length - 1];
  const direction = lastValue >= first ? "up" : "down";
  return `
    <svg class="oem-sparkline" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-direction="${direction}" aria-hidden="true">
      <polyline fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" points="${points.join(" ")}"></polyline>
      <circle cx="${last[0]}" cy="${last[1]}" r="2" fill="${color}"></circle>
    </svg>
  `;
}

function renderUnifiedFadaFlatTable(category, table) {
  const rows = asArray(table.rows);
  const periodLabelText = table.source_meta?.latest_label
    || dashboardData.modules.retail?.source_meta?.latest_month
    || dashboardData.modules.retail?.latest_month
    || "";
  const key = `unified-oem-${slugify(category)}`;
  const enrichedRows = rows.map((row) => {
    const trend = findCompanyTrendForRow(row);
    if (!trend) {
      return { ...row, trend_sparkline: '<span class="oem-sparkline-empty" title="No listed-company series available">–</span>' };
    }
    const series = asArray(trend.series).slice(-6);
    const values = series.map((point) => Number(point.units));
    const lastLabel = series.at(-1)?.label || "";
    const titleAttr = `${trend.label}: ${series.map((point) => `${point.label} ${formatUnits(point.units)}`).join(" · ")}`;
    return { ...row, trend_sparkline: `<span class="oem-sparkline-cell" title="${titleAttr}">${inlineSparkline(values)}<small>${lastLabel}</small></span>` };
  });
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
        <p class="table-note">FADA YoY market share annexure. Sparkline shows the listed company's last 6 months of company-reported sales when an OEM maps to a tracked listed company.</p>
      </div>
      ${renderTable(
        key,
        [
          { key: "oem", label: "OEM" },
          { key: "units", label: "Current units", type: "int" },
          { key: "trend_sparkline", label: "Trend (6M)", type: "html", sortable: false },
          { key: "prior_units", label: "Prior-year units", type: "int" },
          { key: "share_pct", label: "Share", type: "pct" },
          { key: "share_change_pp", label: "Share Δ", type: "pp" },
          { key: "unit_growth_pct", label: "YoY", type: "pct" },
        ],
        enrichedRows,
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
  const availablePeriods = ["M", "Q", "Y"].filter((period) => periods[period]);
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
  return `
    <div class="oem-spotlight">
      <div class="oem-spotlight-head">
        <div>
          <p class="small-label">Listed-company spotlight</p>
          <h3>${selected.label}</h3>
          <p class="table-note">${selected.concept}</p>
        </div>
        <div class="oem-spotlight-controls">
          <select class="filter-select" data-company-trend>
            ${visibleTrends.map((item) => `
              <option value="${item.company}" ${item.company === selected.company ? "selected" : ""}>${item.label}</option>
            `).join("")}
          </select>
          ${latestPoint?.source_url ? renderSourceAction(latestPoint.source_url, "Latest filing") : ""}
        </div>
      </div>
      <div class="chart-frame compact">
        ${lineChart(
          series.map((point) => point.label),
          [{ label: selected.label, color: dashboardData.chart_colors.TOTAL, values: series.map((point) => point.units) }],
          axisFormat,
          formatUnits,
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
          <button class="button" data-download-key="${downloadKey}">Download CSV</button>
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
            <button class="button" data-download-key="company-unit-trend">Download CSV</button>
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
          <button class="button" data-download-key="${key}">Download CSV</button>
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

  const availablePeriods = ["M", "Q", "Y"].filter((period) => periods[period]);

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
          <button class="button" data-download-key="${key}">Download CSV</button>
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
      <div class="panel-grid two">
        <div class="chart-card">
          <div class="chart-title-row">
            <div>
              <p class="small-label">Monthly registrations</p>
              <h3>Imported Vahan trend</h3>
            </div>
            <div class="button-row">
              ${renderSourceAction(registration.source_meta.url)}
              <button class="button" data-download-key="vahan-registration">Download CSV</button>
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
      <div class="panel-grid two">
        <div class="chart-card">
          <div class="chart-title-row">
            <div>
              <p class="small-label">Domestic sales and production</p>
              <h3>Wholesale cadence</h3>
            </div>
            <div class="button-row">
              ${renderSourceAction(wholesale.source_meta.url)}
              <button class="button" data-download-key="siam-wholesale">Download CSV</button>
            </div>
          </div>
          <div class="chart-frame">
            ${lineChart(months.map((item) => item.label), series, axisFormat, formatUnits)}
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
          <button class="button" data-download-key="segment-share-explorer">Download CSV</button>
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
          <button class="button" data-download-key="raw-material-${slugify(selected.company)}">Download CSV</button>
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
          <button class="button" data-download-key="company-segment-${slugify(selected.company)}">Download CSV</button>
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
        ${components.metrics.map((metric) => `
          <article class="info-card">
            <div class="info-card-head">
              <p class="small-label">${metric.label}</p>
              ${renderSourceAction(components.source_meta.url)}
            </div>
            <h3 class="summary-value">${metric.value}</h3>
            <p class="metric-detail">${metric.delta}</p>
          </article>
        `).join("")}
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

function renderCompanySection() {
  const cards = state.company === "all"
    ? dashboardData.company_map
    : dashboardData.company_map.filter((item) => item.company === state.company);
  const activeCompany = cards.find((item) => item.company === state.companyMapFocus) || cards[0];

  return `
    <section id="section-company-map" class="section panel section-anchor">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Listed Company Mapping</p>
          <h2>How the demand data maps back to public-market names</h2>
        </div>
        <p class="section-subtitle">Mappings stay directional and only appear where the linkage is meaningful.</p>
      </div>
      <div class="company-grid">
        ${cards.map((item) => `
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
      ${activeCompany ? renderCompanyDrilldown(activeCompany) : ""}
    </section>
  `;
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

function lineChart(labels, series, formatter, tooltipFormatter = formatter) {
  const activeSeries = series.filter((item) => item.values.some((value) => value !== null && value !== undefined));
  const width = 820;
  const height = 320;
  const pad = { top: 24, right: 22, bottom: 44, left: 64 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const allValues = activeSeries.flatMap((item) => item.values).filter((value) => value !== null && value !== undefined);
  const max = Math.max(...allValues, 1);
  const steps = 4;
  const xLabelStep = labels.length > 10 ? Math.ceil(labels.length / 6) : 1;

  const gridLines = Array.from({ length: steps + 1 }, (_, index) => {
    const y = pad.top + (innerHeight / steps) * index;
    const value = max - (max / steps) * index;
    return `
      <g>
        <line x1="${pad.left}" x2="${width - pad.right}" y1="${y}" y2="${y}" stroke="rgba(20,39,62,0.10)" />
        <text x="${pad.left - 12}" y="${y + 4}" text-anchor="end" font-size="11" fill="#667687">${formatter(value)}</text>
      </g>
    `;
  }).join("");

  const xLabels = labels.map((label, index) => {
    if (index % xLabelStep !== 0 && index !== labels.length - 1) {
      return "";
    }
    const x = pad.left + (innerWidth / Math.max(labels.length - 1, 1)) * index;
    return `<text x="${x}" y="${height - 12}" text-anchor="middle" font-size="11" fill="#667687">${label}</text>`;
  }).join("");

  const lines = activeSeries.map((item) => {
    const points = item.values.map((value, index) => {
      const x = pad.left + (innerWidth / Math.max(item.values.length - 1, 1)) * index;
      const y = pad.top + innerHeight - (Number(value || 0) / max) * innerHeight;
      return { x, y, value, label: labels[index] };
    });
    const d = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
    return `
      <g>
        <path d="${d}" fill="none" stroke="${item.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>
        ${points.map((point) => `
          <circle cx="${point.x}" cy="${point.y}" r="4.5" fill="${item.color}" pointer-events="none"></circle>
          <circle
            class="chart-hover-target"
            cx="${point.x}"
            cy="${point.y}"
            r="12"
            fill="transparent"
            data-tooltip="${escapeHtml(`${item.label} | ${point.label}: ${tooltipFormatter(point.value)}`)}"
          ></circle>
        `).join("")}
      </g>
    `;
  }).join("");

  return `
    <svg class="line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Line chart">
      ${gridLines}
      ${lines}
      ${xLabels}
    </svg>
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

function main() {
  loadDashboard()
    .then((data) => {
      dashboardData = data;
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
