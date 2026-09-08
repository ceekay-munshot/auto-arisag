# India Auto Demand Monitor

Client-facing dashboard for buy-side and public-market investors tracking listed Indian auto and auto-component companies.

## What it shows

- `FADA` retail demand as the primary live lens
- `SIAM` wholesale / production context as a separate lens
- `ACMA` auto-component industry backdrop
- `Vahan` registrations only when a validated local import is present

The build deliberately hides weak modules. If a source is missing or not robust enough, that section does not render.

## Current source boundary

- `FADA`: latest structured retail snapshot is wired through `Mar 2026`
- `SIAM`: latest structured wholesale snapshot is wired through `Feb 2026`
- `ACMA`: latest structured component snapshot is `FY2024-25`
- `Vahan`: auto-hidden unless you place validated CSV files in `data/vahan/`

## Run it

1. `python build_dashboard.py`
2. `python serve_dashboard.py`
3. Open `http://127.0.0.1:8000/`

(The static Python server does not run the chat endpoint — see
[Chat with this dashboard](#chat-with-this-dashboard) for how to run that locally.)

## Chat with this dashboard

Every dashboard view carries a small floating **chat launcher** (bottom-right,
like an Intercom bubble). Clicking it opens a compact popup that answers plain-
English questions about the **currently-open dashboard**, built **only** from
that dashboard's own data, with clickable **source links**. A **"Search the
web"** toggle (off by default) blends in a few live results as a *supplement*
— the dashboard data still leads.

It is **generic**: it works for any `data/<slug>.json` in this repo, nothing is
hard-coded to the auto dashboard.

### Pieces

- `functions/api/chat.js` — a Cloudflare **Pages Function** serving
  `POST /api/chat`. Deploys with the site (no separate server).
- `functions/api/_chat_lib.mjs` — the pure, testable logic (slug safety,
  grounded-context builder, never-invent source filter, history shaping, reply
  parsing).
- `static/chat_widget.js` + widget styles in `static/styles.css` — the floating
  launcher icon and popup.
- `test/chat.test.mjs` — dependency-free unit tests.

### How grounding works

The endpoint sanitises the slug, loads that dashboard's JSON (the same file the
UI renders from), walks every section into a compact **grounded context** with
each fact's **source URL inline**, and builds an **allow-list** of every source
URL in the data. The model is told to answer *only* from that context and cite
verbatim URLs; anything it returns whose URL is **not** in the allow-list is
**stripped** before responding. Out-of-scope questions get an honest "the
dashboard data doesn't cover that." Every error path returns a friendly message
with HTTP 200 — never a 500.

### Environment variables / secrets

| Name | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Yes (for real answers) | Calls Claude. **Without it, chat degrades to a friendly "try again" message and the rest of the dashboard keeps working.** |
| `CHAT_MODEL` | No | Claude model id. Default `claude-opus-5`. Set e.g. `claude-sonnet-5` or `claude-haiku-4-5` for cheaper/faster. |
| `FIRECRAWL_API_KEY` | No | Enables the "Search the web" toggle (Firecrawl search). Missing/any error → web is silently skipped and answers come from the dashboard only. |

Secrets are read from the environment and **never committed**.

### Run the chat locally

The chat needs the Pages Function, so run it through Wrangler (which serves
`dist/` **and** compiles `/functions`):

```bash
cp .dev.vars.example .dev.vars   # then paste your real keys into .dev.vars
npx wrangler pages dev dist
```

Open the printed URL and the chat bubble will talk to the local
`POST /api/chat`.

### Tests

```bash
npm test        # or: node --test 'test/**/*.test.mjs'
```

### Deploy (one-time setup, then automatic forever)

The site already deploys to **Cloudflare Pages** from `dist/`. Because the
`/functions` folder lives in the repo, the chat endpoint deploys **with** the
site — no separate service. To make every push auto-deploy:

1. In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to
   Git**, pick this repo, and set:
   - **Production branch:** `main`
   - **Build command:** *(leave empty — this is a static site)*
   - **Build output directory:** `dist`
2. In the Pages project: **Settings → Environment variables** → add
   `ANTHROPIC_API_KEY` (and optionally `CHAT_MODEL`, `FIRECRAWL_API_KEY`) as
   **secrets** for Production (and Preview if you use it).

That's the only manual step. After that, **every push to `main` auto-deploys**
the dashboard and the `/api/chat` function — no manual deploy, ever.

## Files

- `build_dashboard.py`: writes `data/dashboard.json`
- `dashboard/build.py`: snapshot loader + payload builder
- `dashboard/analyze.py`: validation, derived metrics, investor insight layer
- `dashboard/collectors.py`: local Vahan import loader
- `data/source_snapshot.json`: validated official source snapshot used by the dashboard
- `data/vahan/sample_vahan_template.csv`: template for optional Vahan imports
- `static/`: frontend rendering and styling (`app.js`, `styles.css`, and the chat widget `chat_widget.js`)
- `functions/api/chat.js`: the `POST /api/chat` Cloudflare Pages Function (see [Chat with this dashboard](#chat-with-this-dashboard))
- `functions/api/_chat_lib.mjs`: pure chat logic (shared by the function and the tests)
- `test/chat.test.mjs`: dependency-free tests (`npm test`)

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
