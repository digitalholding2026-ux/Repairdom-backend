#!/usr/bin/env node
// ============================================================================
// Harnais de test API RepairDom — MISSION #005
// Utilise uniquement Node.js natif (fetch + node:test), aucune dépendance.
//
// Usage :
//   node scripts/test-api.mjs [BASE_URL]
//   API_BASE_URL=<base> node scripts/test-api.mjs
//
// Par défaut, teste le backend déployé sur Railway.
// Les données créées sont des données de test explicites (suffixe "-test").
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE =
  process.env.API_BASE_URL ??
  process.argv[2] ??
  'https://repairdom-backend-production.up.railway.app';
const API = `${BASE}/api`;

const VERCEL_ORIGIN = 'https://repairdom-frontend.vercel.app';

async function api(path, { method = 'GET', body, cookie, origin } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, response, json };
}

function extractCookie(response) {
  const setCookies = response.headers.getSetCookie?.() ?? [];
  const authCookie = setCookies.find((c) => c.startsWith('repairdom_token='));
  return authCookie ? authCookie.split(';')[0] : '';
}

function headersOf(response) {
  const out = {};
  response.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CLIENT_A = { firstName: 'Test A', email: `test-a-${suffix}@repairdom.local`, password: 's3cret-A!' };
const CLIENT_B = { firstName: 'Test B', email: `test-b-${suffix}@repairdom.local`, password: 's3cret-B!' };

const VALID_DEMANDE = {
  categoryId: 'plomberie',
  description: 'Fuite importante sous l évier de la cuisine, le sol est mouillé.',
  city: 'Lyon',
  address: '12 rue des Lilas',
};

let cookieA = '';
let cookieB = '';

test('health — GET /api/health répond ok et base up', async () => {
  const { status, json } = await api('/health');
  assert.equal(status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.database, 'up');
});

test('CORS — l origine Vercel est autorisée avec credentials', async () => {
  const { status, response } = await api('/health', { origin: VERCEL_ORIGIN });
  assert.equal(status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), VERCEL_ORIGIN);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
});

test('CORS — preflight POST depuis l origine Vercel accepté', async () => {
  const response = await fetch(`${API}/auth/login`, {
    method: 'OPTIONS',
    headers: {
      origin: VERCEL_ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), VERCEL_ORIGIN);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
});

test('auth — inscription A (201) avec cookie', async () => {
  const { status, json, response } = await api('/auth/register', {
    method: 'POST',
    body: CLIENT_A,
  });
  assert.equal(status, 201);
  assert.equal(json.user.email, CLIENT_A.email);
  assert.ok(json.user.id);
  assert.ok(json.user.passwordHash === undefined, 'ne doit pas exposer le hash');
  cookieA = extractCookie(response);
  assert.ok(cookieA, 'cookie de session posé');
  assert.match(cookieA, /^repairdom_token=/);
});

test('auth — email dupliqué → 409', async () => {
  const { status } = await api('/auth/register', { method: 'POST', body: CLIENT_A });
  assert.equal(status, 409);
});

test('auth — payload invalide → 400', async () => {
  const { status, json } = await api('/auth/register', {
    method: 'POST',
    body: { firstName: 'X', email: 'pas-un-email', password: '123' },
  });
  assert.equal(status, 400);
  assert.ok(Array.isArray(json.message), 'message de validation détaillé');
});

test('auth — /me sans cookie → 401', async () => {
  const { status } = await api('/auth/me');
  assert.equal(status, 401);
});

test('auth — /me avec cookie → 200 + utilisateur', async () => {
  const { status, json } = await api('/auth/me', { cookie: cookieA });
  assert.equal(status, 200);
  assert.equal(json.email, CLIENT_A.email);
});

test('auth — connexion mauvais mot de passe → 401', async () => {
  const { status } = await api('/auth/login', {
    method: 'POST',
    body: { email: CLIENT_A.email, password: 'wrong-password' },
  });
  assert.equal(status, 401);
});

test('auth — connexion A valide → 200 + cookie', async () => {
  const { status, response } = await api('/auth/login', {
    method: 'POST',
    body: { email: CLIENT_A.email, password: CLIENT_A.password },
  });
  assert.equal(status, 200);
  cookieA = extractCookie(response);
  assert.ok(cookieA);
});

test('demandes — création sans cookie → 401', async () => {
  const { status } = await api('/demandes', { method: 'POST', body: VALID_DEMANDE });
  assert.equal(status, 401);
});

test('demandes — DTO invalide (catégorie inconnue, description courte) → 400', async () => {
  const { status, json } = await api('/demandes', {
    method: 'POST',
    cookie: cookieA,
    body: { categoryId: 'inconnue', description: 'court', city: '' },
  });
  assert.equal(status, 400);
  assert.ok(Array.isArray(json.message));
});

test('demandes — création réelle A → 201 + référence serveur', async () => {
  const { status, json } = await api('/demandes', {
    method: 'POST',
    cookie: cookieA,
    body: VALID_DEMANDE,
  });
  assert.equal(status, 201);
  assert.match(json.reference, /^RD-[A-Z0-9]{6}$/);
  assert.equal(json.status, 'SUBMITTED');
  assert.equal(json.categoryId, VALID_DEMANDE.categoryId);
  assert.equal(json.mediaPersisted, false);
  assert.equal(json.storageStatus, 'metadata-only');
  assert.ok(json.id);
  globalThis.__demandeId = json.id;
  globalThis.__demandeRef = json.reference;
});

test('demandes — création avec métadonnées médias (metadata-only)', async () => {
  const { status, json } = await api('/demandes', {
    method: 'POST',
    cookie: cookieA,
    body: {
      ...VALID_DEMANDE,
      description: 'Bruit anormal à la mise en route du lave-linge.',
      medias: [{ kind: 'IMAGE', name: 'lave-linge.jpg', mimeType: 'image/jpeg', sizeBytes: 204800 }],
    },
  });
  assert.equal(status, 201);
  assert.equal(json.medias.length, 1);
  assert.equal(json.medias[0].kind, 'IMAGE');
  assert.equal(json.medias[0].stored, false);
});

test('demandes — liste des demandes du client', async () => {
  const { status, json } = await api('/demandes', { cookie: cookieA });
  assert.equal(status, 200);
  assert.ok(Array.isArray(json));
  assert.ok(json.some((d) => d.reference === globalThis.__demandeRef));
});

test('demandes — détail par id → référence identique', async () => {
  const { status, json } = await api(`/demandes/${globalThis.__demandeId}`, { cookie: cookieA });
  assert.equal(status, 200);
  assert.equal(json.reference, globalThis.__demandeRef);
});

test('isolation — B ne voit pas les demandes de A et obtient 404 sur son id', async () => {
  const reg = await api('/auth/register', { method: 'POST', body: CLIENT_B });
  assert.equal(reg.status, 201);
  cookieB = extractCookie(reg.response);
  assert.ok(cookieB);

  const list = await api('/demandes', { cookie: cookieB });
  assert.equal(list.status, 200);
  assert.ok(
    !list.json.some((d) => d.reference === globalThis.__demandeRef),
    'le client B ne doit pas voir la demande de A',
  );

  const detail = await api(`/demandes/${globalThis.__demandeId}`, { cookie: cookieB });
  assert.equal(detail.status, 404);
});

test('auth — logout efface le cookie', async () => {
  const { status, response } = await api('/auth/logout', { method: 'POST', cookie: cookieA });
  assert.equal(status, 200);
  const cleared = (response.headers.getSetCookie?.() ?? []).find((c) =>
    c.startsWith('repairdom_token='),
  );
  assert.ok(cleared);
  assert.match(cleared, /Max-Age=0|Expires=Thu, 01 Jan 1970|expires=.*1970/i);
});

test('auth — /me après logout (sans cookie) → 401', async () => {
  const { status } = await api('/auth/me');
  assert.equal(status, 401);
});

test('sécurité — réponse d erreur 401 ne fuit aucun détail interne', async () => {
  const { status, json } = await api('/me-n-existe-pas');
  assert.equal(status, 404);
  const raw = JSON.stringify(json).toLowerCase();
  assert.ok(
    !raw.includes('stack') && !raw.includes('sql') && !raw.includes('databas'),
    'pas de trace interne dans le corps de réponse',
  );
});