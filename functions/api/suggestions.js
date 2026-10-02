// Cloudflare Pages Function: GET /api/suggestions
// Public list of suggestions and their status, for the /suggestions/ page.
// Status: built (listed in suggestions/features.json) > rejected > approved > pending.
// Closed issues that are neither built nor rejected (e.g. spam) are hidden.
// A rejection's reason is the repo owner's latest comment that doesn't mention
// @claude. Nobody else's comments are ever shown.
// Secret: GITHUB_TOKEN (same token as /api/suggest).

const REPO = 'drimhub/diarmuid-webpage';
const OWNER = 'drimhub';
const CACHE_SECONDS = 60;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function github(path, env) {
  return fetch(`https://api.github.com/repos/${REPO}${path}`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'diarmu.id-suggestions',
    },
  });
}

async function rejectionReason(number, env) {
  const res = await github(`/issues/${number}/comments?per_page=100`, env);
  if (!res.ok) return null;
  const comments = await res.json();
  const reasons = comments.filter(c => c.user && c.user.login === OWNER && !/@claude\b/i.test(c.body || ''));
  return reasons.length ? reasons[reasons.length - 1].body : null;
}

export async function onRequestGet({ request, env, waitUntil }) {
  const cache = caches.default;
  const cacheKey = new Request(new URL('/api/suggestions', request.url).toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  if (!env.GITHUB_TOKEN) return json({ error: 'Suggestions are not set up yet.' }, 500);

  const [issuesRes, featuresRes] = await Promise.all([
    github('/issues?labels=suggestion&state=all&sort=created&direction=desc&per_page=100', env),
    env.ASSETS.fetch(new URL('/suggestions/features.json', request.url).toString()),
  ]);
  if (!issuesRes.ok) {
    console.error('GitHub issue list failed', issuesRes.status, await issuesRes.text());
    return json({ error: "Couldn't load suggestions." }, 502);
  }

  const issues = await issuesRes.json();
  let features = [];
  try {
    features = await featuresRes.json();
  } catch {
    // missing or invalid features.json: nothing counts as built
  }
  const builtSlugs = new Map(
    (Array.isArray(features) ? features : [])
      .filter(f => f && Number.isInteger(f.issue) && typeof f.slug === 'string' && /^[a-z0-9-]+$/.test(f.slug))
      .map(f => [f.issue, f.slug])
  );

  const suggestions = [];
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const labels = issue.labels.map(l => (typeof l === 'string' ? l : l.name));
    let status;
    if (builtSlugs.has(issue.number)) status = 'built';
    else if (labels.includes('rejected')) status = 'rejected';
    else if (issue.state !== 'open') continue;
    else if (labels.includes('approved')) status = 'approved';
    else status = 'pending';

    suggestions.push({
      number: issue.number,
      title: issue.title.replace(/^Suggestion:\s*/, ''),
      status,
      createdAt: issue.created_at,
      url: issue.html_url,
      slug: builtSlugs.get(issue.number) || null,
      reason: null,
    });
  }

  await Promise.all(
    suggestions
      .filter(s => s.status === 'rejected')
      .map(async s => { s.reason = await rejectionReason(s.number, env); })
  );

  const response = json(suggestions, 200, { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
  waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
