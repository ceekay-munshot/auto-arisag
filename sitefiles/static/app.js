let dashboardData = null;
const state = {
  window: "5m",
  lens: "all",
  category: "TOTAL",
  fuel: "all",
  company: "all",
  sorts: {},
};
const refreshState = {
  loading: false,
  message: "Reload the latest validated dashboard dataset.",
  tone: "neutral",
};
const downloadRegistry = new Map();

async function loadDashboard() {
  const response = await fetch("data/investor_dashboard.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load dashboard data: ${response.status}`);
  }
  const payload = await response.json();
  return normalizePayload(payload);
}

async function triggerRefresh() {
  if (refreshState.loading) {
    return;
  }

  const startedAt = Date.now();
  refreshState.loading = true;
  refreshState.message = "Refreshing validated data and rebuilding the dashboard...";
  refreshState.tone = "neutral";
  render();

  try {
    const response = await fetch("refresh", {
      method: "POST",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const result = await response.json();
    if (!response.ok || !result.ok || !result.payload) {
      throw new Error(result.error || `Refresh failed: ${response.status}`);
    }
    dashboardData = normalizePayload(result.payload);
    refreshState.message = `Refreshed ${formatTimestamp(result.generated_at || result.payload.generated_at)}`;
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

  normalized.company_map = asArray(normalized.company_map);
  normalized.insights = asArray(normalized.insights);

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
  ["PV", "2W", "3W", "CV", "TRACTOR", "CE"].forEach((category) => {
    const table = asObject(retail.latest_oem_tables[category]);
    table.rows = asArray(table.rows);
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

function companyDetails() {
  return asArray(dashboardData.company_map).find((item) => item.company === state.company);
}

function companyCategoryIds(company) {
  const validCategories = new Set(asArray(dashboardData.filters.categories).map((item) => item.id));
  return asArray(company?.categories).filter((item) => validCategories.has(item));
}

function allowedCategories() {
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
  let allowedIds = baseCategories.map((item) => item.id);

  if (state.lens === "wholesale") {
    const wholesaleIds = new Set();
    asArray(dashboardData.modules.wholesale?.months).forEach((month) => {
      asArray(month.domestic_sales).forEach((item) => wholesaleIds.add(item.category));
    });
    allowedIds = allowedIds.filter((item) => wholesaleIds.has(item));
  } else if (state.lens === "ev") {
    const evIds = new Set();
    const firstEvMonth = asArray(dashboardData.modules.retail?.ev_penetration_series)[0];
    asArray(firstEvMonth?.by_category).forEach((item) => evIds.add(item.category));
    allowedIds = allowedIds.filter((item) => evIds.has(item));
  } else if (state.lens === "components") {
    return [];
  }

  if (state.company !== "all") {
    const companyIds = companyCategoryIds(companyDetails());
    if (companyIds.length) {
      allowedIds = allowedIds.filter((item) => companyIds.includes(item));
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

  const categoryIds = new Set(
    availableCategoryOptions()
      .map((item) => item.id)
      .filter((item) => item !== "TOTAL"),
  );

  const visibleCategories = asArray(dashboardData.modules.retail?.fuel_mix_latest).filter((item) => {
    if (!categoryIds.size) {
      return false;
    }
    if (state.category !== "TOTAL") {
      return item.category === state.category;
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

function render() {
  downloadRegistry.clear();
  syncStateToAvailableOptions();
  const app = document.getElementById("app");
  app.innerHTML = [
    renderHero(),
    renderFilters(),
    renderSourceVisibility(),
    visibleModule("retail") ? renderRetailSection() : "",
    dashboardData.modules.registration.available && visibleModule("registration") ? renderRegistrationSection() : "",
    visibleModule("wholesale") ? renderWholesaleSection() : "",
    visibleModule("components") ? renderComponentsSection() : "",
    renderInsightsSection(),
    renderCompanySection(),
  ].join("");

  setupFilters();
  setupRefreshAction();
  setupSorts();
  setupDownloads();
}

function renderHero() {
  const summary = dashboardData.summary;
  const activeSources = asArray(summary.source_badges).filter((item) => item.status === "active").slice(0, 3);
  const qaChecks = asArray(dashboardData.qa).filter((item) => item.status === "ok").slice(0, 3);
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
    </section>
  `;
}

function renderSummaryCard(card) {
  const tone = card?.tone || "neutral";
  return `
    <article class="summary-card ${tone}">
      <p class="small-label">${card?.label || ""}</p>
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
    <section class="section panel">
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
    <section class="section panel">
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
              <button class="button" data-download-key="retail-trend">Download CSV</button>
            </div>
          </div>
          <div class="chart-frame">
            ${lineChart(months.map((item) => item.label), trendSeries, axisFormat)}
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
              .filter((item) => state.category === "TOTAL" || item.category === state.category)
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
          .filter((item) => state.category === "TOTAL" || item.category === state.category)
          .filter((item) => allowed.includes(item.category))
          .map(renderCategoryCard)
          .join("")}
      </div>
      <div class="section-divider"></div>
      ${renderEvSection()}
      <div class="section-divider"></div>
      ${renderChannelPulse()}
      <div class="section-divider"></div>
      ${renderOemTables()}
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
  const months = sliceMonths(retail.ev_penetration_series);
  const selectedFuel = state.fuel === "all" ? null : state.fuel;
  const latestMix = retail.fuel_mix_latest
    .filter((item) => state.category === "TOTAL" || item.category === state.category)
    .filter((item) => allowedCategories().includes(item.category));

  const evSeries = [
    {
      label: "Overall EV penetration",
      color: dashboardData.chart_colors.EV,
      values: months.map((item) => item.overall_ev_pct),
    },
  ];
  if (state.category !== "TOTAL" && ["2W", "3W", "PV", "CV"].includes(state.category)) {
    evSeries.push({
      label: `${labelForCategory(state.category)} EV share`,
      color: dashboardData.chart_colors[state.category],
      values: months.map((item) => item.by_category.find((entry) => entry.category === state.category)?.ev_share_pct || 0),
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
    <div class="panel-grid two">
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
          ${lineChart(months.map((item) => item.label), evSeries, (value) => `${value.toFixed(1)}%`)}
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
    .filter((item) => state.category === "TOTAL" || item.category === state.category)
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

function renderOemTables() {
  const tables = dashboardData.modules.retail.latest_oem_tables;
  const categories = state.category === "TOTAL"
    ? ["PV", "2W", "CV", "TRACTOR", "3W", "CE"].filter((category) => allowedCategories().includes(category))
    : [state.category].filter((category) => tables[category]);

  return `
    <div class="panel-grid two">
      ${categories.map((category) => renderOemTable(category, tables[category])).join("")}
    </div>
  `;
}

function renderOemTable(category, table) {
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
    ["oem", "units", "share_pct", "share_change_pp", "unit_growth_pct", "listed_companies"],
    rows.map((row) => ({
      oem: row.oem,
      units: row.units,
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
          <button class="button" data-download-key="${key}">Download CSV</button>
        </div>
      </div>
      ${renderTable(
        key,
        [
          { key: "oem", label: "OEM" },
          { key: "units", label: "Units", type: "int" },
          { key: "share_pct", label: "Share", type: "pct" },
          { key: "share_change_pp", label: "Share chg", type: "pp" },
          { key: "unit_growth_pct", label: "Unit growth", type: "pct" },
        ],
        rows,
      )}
      <p class="table-note">Source: FADA Feb 2026 YoY market share annexure. Current share is shown against Feb 2025.</p>
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
    <section class="section panel">
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
              <button class="button" data-download-key="vahan-registration">Download CSV</button>
            </div>
          </div>
          <div class="chart-frame">
            ${lineChart(
              months.map((item) => item.label),
              [{ label: "Registrations", color: dashboardData.chart_colors.TOTAL, values: months.map((item) => item.total_units) }],
              axisFormat,
            )}
          </div>
        </div>
        <div class="chart-card">
          <div class="chart-title-row">
            <div>
              <p class="small-label">Latest makers</p>
              <h3>Top imported makers</h3>
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
    <section class="section panel">
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
              <button class="button" data-download-key="siam-wholesale">Download CSV</button>
            </div>
          </div>
          <div class="chart-frame">
            ${lineChart(months.map((item) => item.label), series, axisFormat)}
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
      <div class="section-divider"></div>
      <div class="panel-grid three">
        ${renderQuarterSummary()}
        ${renderCalendarSummary()}
        ${renderLatestWholesaleTable()}
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

function renderComponentsSection() {
  const components = dashboardData.modules.components;
  const details = state.company === "all" ? null : companyDetails();
  const beneficiaries = details
    ? components.listed_beneficiaries.filter((item) => item.company === state.company)
    : components.listed_beneficiaries;

  return `
    <section class="section panel">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Components</p>
          <h2>${components.headline}</h2>
        </div>
        <p class="section-subtitle">${components.source_meta.note}</p>
      </div>
      <div class="panel-grid three">
        ${components.metrics.map((metric) => `
          <article class="info-card">
            <p class="small-label">${metric.label}</p>
            <h3 class="summary-value">${metric.value}</h3>
            <p class="metric-detail">${metric.delta}</p>
          </article>
        `).join("")}
      </div>
      <div class="section-divider"></div>
      <div class="panel-grid two">
        <div class="chart-card">
          <div class="chart-title-row">
            <div>
              <p class="small-label">ACMA read-through</p>
              <h3>Why the ancillary backdrop still matters</h3>
            </div>
          </div>
          <div class="tag-list">
            ${components.insights.map((item) => `<div class="empty-note">${item}</div>`).join("")}
          </div>
        </div>
        <div class="chart-card">
          <div class="chart-title-row">
            <div>
              <p class="small-label">Listed beneficiaries</p>
              <h3>Useful public-market proxies</h3>
            </div>
          </div>
          <div class="company-grid">
            ${beneficiaries.map((item) => `
              <article class="insight-card">
                <div class="insight-head">
                  <div>
                    <p class="small-label">${item.categories.map((entry) => labelForCategory(entry)).join(" / ")}</p>
                    <h3>${item.company}</h3>
                  </div>
                </div>
                <p class="insight-body">${item.summary}</p>
              </article>
            `).join("")}
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
    <section class="section panel">
      <div class="panel-header">
        <div>
          <p class="section-kicker">What Matters</p>
          <h2>Plain-English investor takeaways</h2>
        </div>
        <p class="section-subtitle">Generated only from validated data already on the page.</p>
      </div>
      <div class="insight-grid">
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

  return `
    <section class="section panel">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Listed Company Mapping</p>
          <h2>How the demand data maps back to public-market names</h2>
        </div>
        <p class="section-subtitle">Mappings stay directional and only appear where the linkage is meaningful.</p>
      </div>
      <div class="company-grid">
        ${cards.map((item) => `
          <article class="insight-card">
            <div class="insight-head">
              <div>
                <p class="small-label">${item.category_labels.join(" / ")}</p>
                <h3>${item.company}</h3>
              </div>
            </div>
            <p class="insight-body">${item.summary}</p>
          </article>
        `).join("")}
      </div>
    </section>
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
    return formatUnits(value);
  }
  if (type === "pct") {
    return `<span class="${Number(value) >= 0 ? "positive" : "negative"}">${formatSigned(value)}</span>`;
  }
  if (type === "pp") {
    return `<span class="${Number(value) >= 0 ? "positive" : "negative"}">${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)} pp</span>`;
  }
  return value;
}

function renderTable(id, columns, rows) {
  const sort = state.sorts[id] || { key: columns[1]?.key || columns[0].key, dir: columns[1] ? "desc" : "asc" };
  const sorted = [...rows].sort((left, right) => compareValues(left[sort.key], right[sort.key], sort.dir));
  const head = columns.map((column) => {
    const arrow = sort.key === column.key ? (sort.dir === "asc" ? " &uarr;" : " &darr;") : "";
    return `
      <th data-table="${id}" data-key="${column.key}">
        ${column.label}${arrow}
      </th>
    `;
  }).join("");
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

function formatCell(value, type) {
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

function registerDownload(key, filename, columns, rows) {
  downloadRegistry.set(key, { filename, columns, rows });
}

function labelForCategory(category) {
  return dashboardData.filters.categories.find((item) => item.id === category)?.label || category;
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
  return `
    <div class="stack-row">
      <span>${label}</span>
      <div class="stack-bar">
        <div class="stack-fill" style="width:${Math.max(3, Math.min(widthPct, 100))}%; background:${color}"></div>
      </div>
      <strong title="${detail}">${formatPct(value, 2)}</strong>
    </div>
  `;
}

function lineChart(labels, series, formatter) {
  const activeSeries = series.filter((item) => item.values.some((value) => value !== null && value !== undefined));
  const width = 820;
  const height = 320;
  const pad = { top: 24, right: 22, bottom: 44, left: 64 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const allValues = activeSeries.flatMap((item) => item.values).filter((value) => value !== null && value !== undefined);
  const max = Math.max(...allValues, 1);
  const steps = 4;

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
          <circle cx="${point.x}" cy="${point.y}" r="4.5" fill="${item.color}">
            <title>${item.label} | ${point.label}: ${typeof point.value === "number" && point.value < 100 ? point.value.toFixed(2) : formatUnits(point.value)}</title>
          </circle>
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
