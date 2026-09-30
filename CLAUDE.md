# CLAUDE.md

Personal website: static HTML/CSS/JS (no build step) on Cloudflare Pages, plus a Cloudflare Worker + D1 in `location-worker/`. See [README.md](README.md) for structure and details.

## Rules

- **Keep README.md up to date.** Any change that affects what the README describes (new/removed pages, features, files or folders, API endpoints, Firestore collections, setup/deploy steps, config) must update README.md in the same task. Before finishing, check whether README.md still matches the code.
- Escape user-supplied data (`escapeHtml`) before putting it into `innerHTML` or HTML attributes, including `src` values. When fixing one such bug, sweep the codebase for siblings.
- Don't touch `tools/` or `node_modules/` — they are not part of the deployed site.
