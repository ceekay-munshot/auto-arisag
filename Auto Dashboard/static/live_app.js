const MODULE_META = {
  official_filings: {
    kicker: "Official Filings",
    title: "Validated company disclosures",
    subtitle: "Primary-source filings, presentations, transcripts, and management disclosures that survived the live refresh.",
  },
  industry_sales: {
    kicker: "Industry Sales",
    title: "Monthly sales and channel checks",
    subtitle: "Official SIAM data cross-checked against higher-frequency trade-media demand read-through.",
  },
  policy_watch: {
    kicker: "Policy Watch",
    title: "Policy and regulatory watch",
    subtitle: "Subsidies, schemes, regulation, and policy signals that matter for listed auto names.",
  },
  supplier_watch: {
    kicker: "Supplier Watch",
    title: "Supplier, component, and input chain",
    subtitle: "Component newsflow, supply-chain moves, and input-cost themes relevant for ancillaries and EV exposure.",
  },
  luxury_watch: {
    kicker: "Luxury Watch",
    title: "Luxury watchlist",
    subtitle: "Luxury and premium commentary that can signal mix, pricing, or demand direction early.",
  },
  high_signal_newsflow: {
    kicker: "High-Signal Newsflow",
    title: "Most actionable recent flow",
    subtitle: "Ranked by source quality, signal density, and recency after filtering low-value items.",
  },
};

async function loadDashboard() {
  const response = await fetch("data/dashboard.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load dashboard data: ${response.status}`);
  }
  return response.json();
}

function formatTimestamp(iso) {
  return new Date(iso).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function pill(text, tone = "active") {
  return `<span class="pill ${tone}">${text}</span>`;
}

function metricCard(label, value, detail, tone = "primary") {
  return `
    <article class="summary-card ${tone}">
      <p class="small-label">${label}</p>
      <p class="summary-value">${value}</p>
      <p class="summary-meta">${detail}</p>
    </article>
  `;
}

function articleCard(article) {
  return `
    <article class="news-card">
      <div class="news-meta">
        ${pill(article.source, "active")}
        ${pill(article.published_display, "hidden")}
        <span class="score-chip">Score ${article.importance_score}</span>
        ${article.attachment_url ? `<a class="button button-link" href="${article.attachment_url}" target="_blank" rel="noreferrer">Attachment</a>` : ""}
      </div>
      <h3><a href="${article.url}" target="_blank" rel="noreferrer">${article.title}</a></h3>
      <p class="muted">${article.summary || "No source summary available."}</p>
      <div class="tag-row">
        ${article.brand_tags.filter((item) => item !== "Unmapped").slice(0, 3).map((item) => pill(item, "active")).join("")}
        ${article.segment_tags.filter((item) => item !== "General").slice(0, 3).map((item) => pill(item, "hidden")).join("")}
        ${article.signal_tags.filter((item) => item !== "General").slice(0, 3).map((item) => pill(item, "default")).join("")}
      </div>
    </article>
  `;
}

function countBars(title, kicker, subtitle, items) {
  if (!items?.length) {
    return "";
  }
  return `
    <article class="chart-card">
      <div class="chart-title-row">
        <div>
          <p class="small-label">${kicker}</p>
          <h3>${title}</h3>
        </div>
      </div>
      <p class="table-note">${subtitle}</p>
      <div class="stack-list">
        ${items.map((item) => `
          <div class="stack-row">
            <span>${item.label}</span>
            <div class="stack-bar">
              <div class="stack-fill" style="width:${Math.max(8, item.count * 12)}%;"></div>
            </div>
            <strong>${item.count}</strong>
          </div>
        `).join("")}
      </div>
    </article>
  `;
}

function matrixSection(matrix) {
  if (!matrix?.values?.length) {
    return "";
  }
  const lookup = new Map(matrix.values.map((item) => [`${item.brand}::${item.segment}`, item.count]));
  const header = ["Brand", ...matrix.segments].map((label) => `<th>${label}</th>`).join("");
  const rows = matrix.brands.map((brand) => {
    const cells = matrix.segments.map((segment) => {
      const count = lookup.get(`${brand}::${segment}`) || 0;
      return `<td>${count ? `<span class="matrix-count">${count}</span>` : ""}</td>`;
    }).join("");
    return `<tr><th>${brand}</th>${cells}</tr>`;
  }).join("");
  return `
    <section class="section panel">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Coverage Matrix</p>
          <h2>Brand x segment concentration</h2>
        </div>
        <p class="section-subtitle">Built only from mapped items that survived the audit and tagging pass.</p>
      </div>
      <div class="table-scroll">
        <table class="matrix-table">
          <thead><tr>${header}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function moduleSection(name, items, sources) {
  if (!items?.length) {
    return "";
  }
  const meta = MODULE_META[name];
  return `
    <section class="section panel">
      <div class="panel-header">
        <div>
          <p class="section-kicker">${meta.kicker}</p>
          <h2>${meta.title}</h2>
        </div>
        <p class="section-subtitle">${meta.subtitle}</p>
      </div>
      <div class="meta-strip">
        ${(sources || []).map((source) => pill(source, "active")).join("")}
      </div>
      <div class="article-list">
        ${items.map(articleCard).join("")}
      </div>
    </section>
  `;
}

function liveSourcesSection(items) {
  if (!items?.length) {
    return "";
  }
  return `
    <section class="section panel">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Live Source Coverage</p>
          <h2>Only populated sources remain visible</h2>
        </div>
        <p class="section-subtitle">Failed or zero-item collectors are hidden from the UI, but still counted in the build audit.</p>
      </div>
      <div class="source-grid">
        ${items.map((item) => `
          <article class="info-card">
            <div class="info-card-head">
              <div>
                <p class="small-label">${item.source_type.replaceAll("_", " ")}</p>
                <h3>${item.source}</h3>
              </div>
              ${pill(`${item.items} items`, "active")}
            </div>
            <p class="source-note">${item.description}</p>
            <p class="muted">${item.message}</p>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderHero(data) {
  return `
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Public-Market Buy Side Dashboard</p>
        <h1>Indian Auto Market Intelligence</h1>
        <p class="hero-lede">Live recent auto, EV, filing, policy, and supplier flow for the Indian listed auto ecosystem, filtered to the last ${data.recent_window_days} days.</p>
        <div class="hero-grid">
          ${metricCard("Retained Items", data.summary.total_articles, "Only validated recent items after dedupe and low-signal filtering.", "primary")}
          ${metricCard("High-Signal", data.summary.high_signal_articles, "Heavier-weight disclosures and investor-relevant developments.", "good")}
          ${metricCard("Official Items", data.summary.official_items, "Primary-source filings and official industry releases currently live.", "warm")}
          ${metricCard("Live Sources", data.summary.live_sources, `${data.audit.sources_attempted - data.audit.sources_live} attempted sources were hidden for zero or unusable output.`, "primary")}
        </div>
      </div>
      <aside class="hero-meta">
        <p class="eyebrow">Build Meta</p>
        <h2>Audit-first refresh</h2>
        <p class="hero-meta-value">${formatTimestamp(data.generated_at)}</p>
        <p class="metric-detail">Tracked brands: ${data.summary.tracked_brands}</p>
        <p class="metric-detail">Duplicates removed: ${data.audit.duplicates_removed}</p>
        <p class="metric-detail">Low-signal items removed: ${data.audit.filtered_low_signal}</p>
      </aside>
    </section>
  `;
}

function renderThesis(data) {
  if (!data.thesis_board?.length) {
    return "";
  }
  return `
    <section class="section panel">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Investor Thesis Board</p>
          <h2>What the current data is really saying</h2>
        </div>
        <p class="section-subtitle">Every statement here is generated only from visible, retained source data.</p>
      </div>
      <div class="insight-grid">
        ${data.thesis_board.map((item) => `
          <article class="insight-card">
            <p class="insight-body">${item}</p>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderOverview(data) {
  const cards = [
    countBars("Brand Heat", "Coverage", "Mapped brand intensity after dedupe and filtering.", data.top_brands),
    countBars("Signal Stack", "Signals", "Signal counts by item, not by raw keyword frequency.", data.top_signals),
    countBars("Source Mix", "Sources", "Live source contribution to the retained dataset.", data.source_breakdown),
  ].filter(Boolean);
  if (!cards.length) {
    return "";
  }
  return `
    <section class="section panel">
      <div class="panel-header">
        <div>
          <p class="section-kicker">Coverage Overview</p>
          <h2>Where the evidence is clustering</h2>
        </div>
        <p class="section-subtitle">Counts are reconciled from the retained article set, not from empty collectors or hidden sections.</p>
      </div>
      <div class="panel-grid three">
        ${cards.join("")}
      </div>
    </section>
  `;
}

function renderDashboard(data) {
  const sections = [
    renderHero(data),
    renderThesis(data),
    renderOverview(data),
    matrixSection(data.brand_segment_matrix),
    moduleSection("official_filings", data.modules.official_filings, data.module_sources.official_filings),
    moduleSection("industry_sales", data.modules.industry_sales, data.module_sources.industry_sales),
    moduleSection("policy_watch", data.modules.policy_watch, data.module_sources.policy_watch),
    moduleSection("supplier_watch", data.modules.supplier_watch, data.module_sources.supplier_watch),
    moduleSection("luxury_watch", data.modules.luxury_watch, data.module_sources.luxury_watch),
    moduleSection("high_signal_newsflow", data.modules.high_signal_newsflow, data.module_sources.high_signal_newsflow),
    liveSourcesSection(data.live_sources),
  ].filter(Boolean);

  document.getElementById("app").innerHTML = sections.join("");
}

async function main() {
  try {
    const data = await loadDashboard();
    renderDashboard(data);
  } catch (error) {
    document.getElementById("app").innerHTML = `
      <section class="loading-panel">
        <p class="eyebrow">Dashboard failed to load</p>
        <h1>${error.message}</h1>
        <p>Run <code>python build_dashboard.py</code> to regenerate <code>data/dashboard.json</code>.</p>
      </section>
    `;
  }
}

main();
