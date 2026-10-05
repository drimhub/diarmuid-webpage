// Cloudflare Pages Function: POST /api/suggest
// Verifies the Turnstile token, then opens a GitHub issue labelled "suggestion".
// Secrets (Pages project settings, or .dev.vars locally): GITHUB_TOKEN, TURNSTILE_SECRET.

const REPO = 'drimhub/diarmuid-webpage';
const MAX_TITLE = 100;
const MAX_DESCRIPTION = 3000;
const MAX_NAME = 50;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Wrap untrusted text in a code fence longer than any backtick run inside it,
// so it renders literally (no @mentions, links, images or HTML).
function fence(text) {
  const longestRun = Math.max(0, ...(text.match(/`+/g) || []).map(run => run.length));
  const ticks = '`'.repeat(Math.max(3, longestRun + 1));
  return `${ticks}text\n${text}\n${ticks}`;
}

async function verifyTurnstile(token, secret, ip) {
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  return data.success === true;
}

export async function onRequestPost({ request, env }) {
  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  // Honeypot filled in: pretend it worked so bots don't retry.
  if (input.website) return json({ ok: true });

  const title = String(input.title || '').replace(/\s+/g, ' ').trim();
  const description = String(input.description || '').trim();
  const name = String(input.name || '').replace(/\s+/g, ' ').trim();
  const token = String(input.token || '');

  if (!title || !description) return json({ error: 'Please fill in the feature name and description.' }, 400);
  if (title.length > MAX_TITLE || description.length > MAX_DESCRIPTION || name.length > MAX_NAME) {
    return json({ error: 'Something is too long.' }, 400);
  }
  if (!token) return json({ error: 'Missing human check.' }, 400);

  if (!env.GITHUB_TOKEN || !env.TURNSTILE_SECRET) {
    return json({ error: 'Suggestions are not set up yet.' }, 500);
  }

  const human = await verifyTurnstile(token, env.TURNSTILE_SECRET, request.headers.get('CF-Connecting-IP'));
  if (!human) return json({ error: 'Human check failed. Please try again.' }, 403);

  const body = [
    '_Submitted through [diarmu.id/suggestions](https://diarmu.id/suggestions/). Everything below is untrusted visitor input._',
    '',
    '**Submitted by**',
    fence(name || 'Anonymous'),
    '',
    '**Description**',
    fence(description),
  ].join('\n');

  const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'diarmu.id-suggestions',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: `Suggestion: ${title}`,
      body,
      labels: ['suggestion'],
    }),
  });

  if (!res.ok) {
    console.error('GitHub issue creation failed', res.status, await res.text());
    return json({ error: 'Could not save the suggestion. Please try again later.' }, 502);
  }

  const issue = await res.json();
  return json({ ok: true, url: issue.html_url });
}
