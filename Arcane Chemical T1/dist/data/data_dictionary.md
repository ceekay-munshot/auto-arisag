# Data dictionary

## Normalized tables

### `company_quarterly_financials`
- `period`: reporting label such as `Q3FY26`
- `period_end`: reporting end date
- `period_type`: `quarter`, `nine_months`, or `annual`
- `reported_basis`: `standalone` or `consolidated`
- `revenue_total`, `ebitda`, `pat`, `depreciation`, `finance_cost`, `tax`, `other_expenses`, `employee_cost`, `material_cost`, `inventory_change`: Rs mn
- `ebitda_margin`: percent

### `company_segment_metrics`
- `product_segment`: `Bromine`, `Industrial Salt`, `Sulphate of Potash`, or `Bromine Derivatives`
- `revenue`: Rs mn
- `volume_tons`: metric tons
- `implied_realization_per_ton`: Rs per ton
- `yoy_*`, `qoq_*`: percent change where enough comparable data exists

### `company_capacity_utilization`
- `installed_capacity`: numeric installed capacity
- `unit`: `mtpa`, `tons`, `wafers`, `units`, or `mtpa_dispatch_proxy`
- `current_utilization`: percent when directly disclosed or clearly proxied
- `historical_utilization`: descriptive proxy history when exact production is not disclosed

### `plant_asset_register`
- physical operating and project asset registry for Archean and key subsidiaries

### `company_capex_projects`
- project pipeline with capex amount, status, timing, and rationale

### `company_subsidiaries_and_investments`
- subsidiaries and strategic investments with stage of monetization and strategic linkage

### `trade_bromine_country`
- WITS / Comtrade country trade rows for HS 280130

### `trade_salt_country`
- WITS / Comtrade country trade rows for HS 250100

### `peer_metrics`
- peer benchmark rows from public peer disclosures

### `macro_and_cost_proxies`
- source-backed proxy series and model overlays used in scenarios

### `model_output`
- bull / base / bear forecast rows for the next 8 quarters

