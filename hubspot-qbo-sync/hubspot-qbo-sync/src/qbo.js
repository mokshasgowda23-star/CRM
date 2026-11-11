import { config } from './config.js';
import { db } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { HttpError, PermanentError } from './errors.js';

const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const basic = () => 'Basic ' + Buffer.from(`${config.qbo.clientId}:${config.qbo.clientSecret}`).toString('base64');

export function authorizeUrl(state) {
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({
    client_id: config.qbo.clientId,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: config.qbo.redirectUri,
    state,
  }).toString();
  return u.toString();
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: basic(), Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError('QBO-OAuth', res.status, text, { retryable: !(res.status === 400 || res.status === 401) });
  const j = JSON.parse(text);
  const now = Date.now();
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    accessExpiresAt: now + j.expires_in * 1000,
    refreshExpiresAt: now + (j.x_refresh_token_expires_in ?? 0) * 1000,
  };
}

function saveTokens(realmId, t) {
  db.prepare(
    `INSERT INTO oauth_tokens(realm_id, env, payload, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(realm_id) DO UPDATE SET env=excluded.env, payload=excluded.payload, updated_at=excluded.updated_at`,
  ).run(realmId, config.qbo.env, encrypt(t), Date.now());
}

function loadTokens() {
  const row = db.prepare('SELECT realm_id, payload FROM oauth_tokens WHERE env = ? ORDER BY updated_at DESC LIMIT 1').get(config.qbo.env);
  if (!row) throw new PermanentError('QuickBooks is not connected. Open /auth/qbo/connect');
  return { realmId: row.realm_id, tokens: decrypt(row.payload) };
}

export function connectionStatus() {
  try {
    const { realmId, tokens } = loadTokens();
    return { connected: true, env: config.qbo.env, realmId, refreshExpiresAt: tokens.refreshExpiresAt };
  } catch {
    return { connected: false, env: config.qbo.env };
  }
}

export async function handleCallback(code, realmId) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: config.qbo.redirectUri });
  saveTokens(realmId, t);
}

// Intuit rotates the refresh token: the OLD one dies when a new one is issued, so the new one must be
// persisted before anything else happens. One in-flight refresh at a time prevents the classic race.
// (Running several instances? Move this lock into the database or a Redis lock.)
let inFlight = null;
function refresh() {
  inFlight ??= (async () => {
    const { realmId, tokens } = loadTokens();
    try {
      const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
      saveTokens(realmId, t);
      return { realmId, tokens: t };
    } catch (e) {
      if (e.retryable === false) throw new PermanentError(`QuickBooks token refresh rejected (${e.status}). Reconnect at /auth/qbo/connect`);
      throw e;
    }
  })().finally(() => { inFlight = null; });
  return inFlight;
}

async function currentTokens() {
  const c = loadTokens();
  return c.tokens.accessExpiresAt - Date.now() < 60_000 ? refresh() : c;
}

/** Authenticated QBO call: proactive refresh, one reactive refresh on 401, idempotent writes via requestid. */
export async function qbo(method, path, { body, query, requestId } = {}) {
  let { realmId, tokens } = await currentTokens();
  for (let attempt = 0; ; attempt++) {
    const url = new URL(`${config.qbo.apiBase}/v3/company/${realmId}${path}`);
    url.searchParams.set('minorversion', config.qbo.minorVersion);
    if (requestId) url.searchParams.set('requestid', requestId);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: 'application/json', ...(body && { 'Content-Type': 'application/json' }) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new HttpError('QBO', 503, `network error: ${e.message}`);
    }
    if (res.status === 401 && attempt === 0) { ({ realmId, tokens } = await refresh()); continue; }
    const text = await res.text();
    if (!res.ok) throw new HttpError('QBO', res.status, `${text} [intuit_tid=${res.headers.get('intuit_tid')}]`);
    return JSON.parse(text);
  }
}

export const qboQuery = async (sql) => (await qbo('GET', '/query', { query: { query: sql } })).QueryResponse;
