# Project rules

- Always keep README.md up to date. Whenever a change affects pages, features, structure, or setup, update README.md in the same task and mention it in the summary.
- Consider emoji reactions whenever adding a new element to bookclub/index.html. Decide whether it should be reactable; if so, give it a `data-react-id="kind:id"` attribute (bookclub/reactions.js does the rest) and add the new kind to the target ID table in README.md. Put the attribute on a wrapper element, not on a `<button>` or `<img>`, which can't hold the reaction bar. If unsure whether something should be reactable, ask. A new kind needs no rule changes; a new reaction emoji needs `reactions.js` and `firestore.rules` updated together.
