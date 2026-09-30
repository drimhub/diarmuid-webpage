# CLAUDE.md

Personal website: static HTML/CSS/JS (no build step) on Cloudflare Pages, plus a Cloudflare Worker + D1 in `location-worker/`. See [README.md](README.md) for structure and details.

## Project rules

- Always keep README.md up to date. Whenever a change affects pages, features, structure, Firestore collections, setup/deploy steps or config, update README.md in the same task and mention it in the summary. Before finishing, check that README.md still matches the code.
- Consider emoji reactions whenever adding a new element to bookclub/index.html. Decide whether it should be reactable; if so, give it a `data-react-id="kind:id"` attribute (bookclub/reactions.js does the rest) and add the new kind to the target ID table in README.md. Put the attribute on a wrapper element, not on a `<button>` or `<img>`, which can't hold the reaction bar. If unsure whether something should be reactable, ask. A new kind needs no rule changes; a new reaction emoji needs `reactions.js` and `firestore.rules` updated together.
- Any new Firestore collection must be added to `firestore.rules` (unlisted collections are denied) and deployed.
- Escape user-supplied data (`escapeHtml`) before putting it into `innerHTML` or HTML attributes, including `src` values. When fixing one such bug, sweep the codebase for siblings.
- Don't touch `tools/` or `node_modules/` — they are not part of the deployed site.
