// Cloudflare Turnstile verification. Fails closed: with no secret configured nothing passes,
// unless TURNSTILE_DISABLED=1 is set (local development only, via .dev.vars).

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(token, env, ip, fetchImpl = fetch) {
  if (env.TURNSTILE_DISABLED === '1') return true;
  if (!env.TURNSTILE_SECRET || typeof token !== 'string' || !token) return false;

  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);

  try {
    const res = await fetchImpl(VERIFY_URL, { method: 'POST', body: form });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}
