# Conventions

## Shortcuts
- **m2m** = "merge to main". When the user types this on its own (or as part of a sentence like "cool m2m"), treat it as a request to squash-merge the open PR for the current feature branch into `main`, then surface the standing before/after summary.

## Standing instructions
- After any merge to main, give a **before / after** summary covering data, UI, and file-level changes — the user has asked for this on every merge.
- Develop on branch `claude/main-branch-work-TLZ1S`. Push there, open PRs against `main`. Force-push-with-lease is acceptable on the feature branch when reusing it after a squash merge.
- Cache busters: bump `app.js` and `styles.css` `?v=` in `index.html` and `dist/index.html` whenever those assets change so users see the fresh build immediately.
- When regenerating `data/investor_dashboard.json` mid-task, also update `dist/data/investor_dashboard.json` (the served copy) so the live dashboard reflects the change without waiting on the cron.
