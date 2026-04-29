# Arcane Chemical T1

Institutional-grade local research dashboard for Archean Chemical Industries Limited.

## What this project contains

- `scripts/fetch_archean_sources.py`
  Downloads and refreshes the local source PDF set used for the dashboard.
- `scripts/extract_pdf_text.py`
  Extracts text from the downloaded PDFs for audit and manual parsing support.
- `scripts/archean_seed.py`
  Curated, source-backed structured seed data for Archean, peers, capacity, trade and optionality modules.
- `scripts/build_dashboard.py`
  Builds the canonical dashboard payload, SQLite cache, CSV exports and static frontend bundle.
- `src/`
  Static frontend shell for the research dashboard.
- `data/manual/`
  Source registry, methodology note, data dictionary and forecast assumptions.
- `dist/`
  Generated deployment bundle. Host this folder as-is for static deployment.

## Build workflow

1. Refresh or review local source files if needed:
   `python scripts\\fetch_archean_sources.py`
2. Extract PDF text if you need to inspect or extend parsing:
   `python scripts\\extract_pdf_text.py`
3. Build the dashboard bundle:
   `python scripts\\build_dashboard.py`
4. Optional live trade refresh:
   `python scripts\\build_dashboard.py --refresh-live`
5. Serve the bundle locally:
   `python serve_local.py`

## Outputs

Running the build writes:

- `dist/index.html`
- `dist/assets/`
- `dist/data/dashboard.json`
- `dist/data/exports/*.csv`
- `data/cache/archean_research.sqlite`

The frontend reads only `dist/data/dashboard.json`, so the UI and builder stay aligned.

## Verification status model

- Local build verification:
  `python -m py_compile scripts\\build_dashboard.py scripts\\fetch_archean_sources.py scripts\\extract_pdf_text.py scripts\\archean_seed.py serve_local.py`
- Local HTTP verification:
  serve `dist/` and confirm `http://127.0.0.1:<port>` returns `200`
- Browser verification:
  should be done separately in a real browser engine before calling the build locally verified end-to-end
- Hosted verification:
  separate from local verification; do not assume static hosting behavior until it is explicitly checked

## Data discipline

- Important numbers should always resolve back to a visible source in `data/manual/source_registry.json`
- Derived metrics must stay labelled as derived or modelled
- Weak source chains should be omitted rather than padded with placeholders
- The dashboard is built for Archean specifically, not as a reusable screener shell
