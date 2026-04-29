# India Auto Demand Monitor

Client-facing dashboard for buy-side and public-market investors tracking listed Indian auto and auto-component companies.

## What it shows

- `FADA` retail demand as the primary live lens
- `SIAM` wholesale / production context as a separate lens
- `ACMA` auto-component industry backdrop
- `Vahan` registrations only when a validated local import is present

The build deliberately hides weak modules. If a source is missing or not robust enough, that section does not render.

## Current source boundary

- `FADA`: latest structured retail snapshot is wired through `Feb 2026`
- `SIAM`: latest structured wholesale snapshot is wired through `Feb 2026`
- `ACMA`: latest structured component snapshot is `FY2024-25`
- `Vahan`: auto-hidden unless you place validated CSV files in `data/vahan/`

## Run it

1. `python build_dashboard.py`
2. `python serve_dashboard.py`
3. Open `http://127.0.0.1:8000/`

## Files

- `build_dashboard.py`: writes `data/dashboard.json`
- `dashboard/build.py`: snapshot loader + payload builder
- `dashboard/analyze.py`: validation, derived metrics, investor insight layer
- `dashboard/collectors.py`: local Vahan import loader
- `data/source_snapshot.json`: validated official source snapshot used by the dashboard
- `data/vahan/sample_vahan_template.csv`: template for optional Vahan imports
- `static/`: frontend rendering and styling

## Vahan import

Supported columns:

- `month`
- `maker`
- `category`
- `registrations`

Optional columns:

- `state`
- `fuel`

The dashboard only turns the registration lens on when at least two monthly points are available.
# auto-arisag
# auto-arisag
