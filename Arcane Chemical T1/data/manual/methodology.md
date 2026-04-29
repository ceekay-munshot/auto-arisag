# Archean dashboard methodology

## Reported vs derived vs modelled

- `Reported`: directly disclosed by Archean or another named source.
- `Derived`: mathematically derived from reported values, with the formula exposed.
- `Modelled`: forecast or sensitivity output built from the assumption file.

## Core formulas

- Bromine realization per ton = bromine revenue / bromine volume
- Salt realization per ton = industrial salt revenue / industrial salt volume
- Q2 FY26 segment rows = H1 FY26 reported segment totals less Q1 FY26 reported segment values
- Q4 FY25 company quarterly financials = FY25 full-year reported values less 9M FY25 reported values
- India bromine trade unit value proxy = WITS trade value / WITS trade quantity
- India salt trade unit value proxy = WITS trade value / WITS trade quantity

## Utilization handling

- Do not treat dispatch as production unless the source clearly says production.
- Bromine and salt utilization shown in the dashboard is labelled as a `dispatch proxy` when the numerator comes from sales volumes rather than disclosed production.
- Acume utilization is shown as management commentary because the transcript explicitly stated the operating range.

## Forecast framework

- Start from latest reported quarter mix and realization levels.
- Project bromine, salt, and derivatives separately.
- Apply scenario-specific volume and realization trajectories from `forecast_assumptions.json`.
- Convert segment revenue to EBITDA using transparent segment contribution margins.
- Deduct corporate costs and apply tax to generate PAT.

## Price and market context

- Archean realization is company-specific and contract-lagged.
- External bromine context uses trade unit values and labelled external commentary, not an unverified spot feed.
- Freight, FX, power, and monsoon inputs are handled as scenario stresses unless a source-backed time series is present.

## Data quality rules

- If a source does not provide a number cleanly, omit the number.
- If a chart would rely on weak or fabricated data, hide the chart.
- All major numbers in the dashboard carry a source id and a source note.

