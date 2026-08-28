const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');

// ── Chargement du fichier .env (Node 22+). Ignoré en production (env Railway).
try { process.loadEnvFile(); } catch (_) {}

const app = express();
const PORT = process.env.PORT || 3000;

// ── Client Supabase (requis — pas de repli fichier) ──
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

if (!SUPABASE_URL.startsWith('http') || !SUPABASE_ANON_KEY) {
  console.error('MISSING SUPABASE_ENV: définissez SUPABASE_URL et SUPABASE_ANON_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
console.log('Supabase connecté ✓ — mode base de données.');

// ── Middleware ──
/**
 * CORS : autorise les origines du frontend (Vercel) à appeler directement
 * l'API. Listé via la variable d'environnement CORS_ORIGINS (séparée par des
 * virgules), avec repli sur les origines par défaut (production + dev local).
 */
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const allowedOrigins = CORS_ORIGINS.length
  ? CORS_ORIGINS
  : ['https://repairdom-frontend.vercel.app', 'http://localhost:3000'];

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use(express.json());

/* ═══════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════ */

/** SALT_ROUNDS pour bcrypt (10 = bon compromis sécurité/perf). */
const SALT_ROUNDS = 10;

/** Compare un mot de passe fourni avec le hash stocké (bcrypt). */
function verifyPassword(stored, provided) {
  if (!stored || provided === undefined) return false;
  if (!/^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$/.test(stored)) return stored === provided;
  try {
    return bcrypt.compareSync(provided, stored);
  } catch {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════
   MAPPING SUPABASE (colonnes FR) ⇄ API (format RepairDom)
   Les generateurs d'ID sont laissés à la base (uuid auto).
   ═══════════════════════════════════════════════════════════ */

// Techniciens considérés comme vérifiés (jusqu'à ce que la colonne
// `verifie` soit renseignée en base). Permet d'afficher le badge "Vérifié".
const VERIFIED_TECHNICIANS = ['Moussa', 'Ibrahima', 'Fatou', 'Ousmane'];

function mapTechnician(row) {
  // La base (Supabase, colonnes FR) peut fournir `row.verifie` (booléen).
  let verified = row.verifie === true || row.verifie === 'true' || row.verified === true || row.verified === 'true';
  if (!verified && row.nom) {
    verified = VERIFIED_TECHNICIANS.some(function (n) {
      return String(row.nom).toLowerCase().includes(n.toLowerCase());
    });
  }
  return {
    id: row.id,
    email: row.email,
    telephone: row.telephone,
    name: row.nom,
    specialty: row.specialite,
    rate: row.tarif,
    location: row.localisation,
    available: row.disponible,
    verified: !!verified,
    avatar: row.avatar,
    languages: row.languages,
    rating: row.rating,
    reviews: row.avis,
    bio: row.bio,
    motDePasse: row.password_hash,
    createdAt: row.created_at
  };
}

function mapMission(row) {
  const c = embed(row, 'clients');
  const t = embed(row, 'technicians');
  return {
    id: row.id,
    clientId: row.client_id || (c && c.id) || null,
    clientName: row.client_name || (c && c.nom) || 'Client',
    clientPhone: (c && c.telephone) || '',
    address: row.address,
    device: row.device,
    issue: row.issue,
    audioFile: null,
    technicianId: row.technician_id || (t && t.id) || null,
    technicianName: (t && t.nom) || null,
    panneId: row.panne_id,
    status: row.status,
    price: row.price,
    dateSouhaitee: row.date_souhaitee,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapMessage(row) {
  return {
    id: row.id,
    missionId: row.mission_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderRole: row.sender_role,
    content: row.content,
    timestamp: row.timestamp
  };
}

/** Gère les embeds PostgREST (objet unique ou tableau). */
function embed(row, key) {
  const v = row[key];
  return Array.isArray(v) ? (v[0] || null) : (v || null);
}

/** Sélecteur standard des missions (avec jointures client/technicien). */
const MISSION_SELECT = '*, clients(*), technicians(*)';

/* ─────────────────────────────────────────────────────────────
   INSCRIPTION / CONNEXION — construction des lignes d'insertion
   ───────────────────────────────────────────────────────────── */

function clientRow(b) {
  return {
    nom: (b.nom || '').trim(),
    email: (b.email || '').trim().toLowerCase(),
    telephone: (b.telephone || '').trim(),
    adresse: (b.adresse || '').trim(),
    password_hash: bcrypt.hashSync(b.motDePasse, SALT_ROUNDS),
    created_at: new Date().toISOString()
  };
}

function technicianRow(b) {
  return {
    nom: (b.nom || '').trim(),
    email: (b.email || '').trim().toLowerCase(),
    telephone: (b.telephone || '').trim(),
    specialite: b.specialite,
    tarif: Number(b.tarifHoraire),
    localisation: (b.localisation || '').trim(),
    disponible: true,
    password_hash: bcrypt.hashSync(b.motDePasse, SALT_ROUNDS),
    rating: 0,
    avis: 0,
    avatar: '🔧',
    languages: ['Français'],
    created_at: new Date().toISOString()
  };
}

function missionRow(b) {
  const now = new Date().toISOString();
  return {
    client_id: b.clientId || null,
    client_name: b.clientName || 'Client',
    address: b.address || '',
    device: b.device,
    issue: b.issue,
    panne_id: b.panneId || b.panne_id || null,
    technician_id: b.technicianId || null,
    status: 'pending',
    price: null,
    date_souhaitee: b.dateSouhaitee || null,
    created_at: now,
    updated_at: now
  };
}

function messageRow(b) {
  return {
    mission_id: b.missionId,
    sender_id: b.senderId || null,
    sender_name: b.senderName || 'Client',
    sender_role: b.senderRole || 'client',
    content: b.content,
    timestamp: new Date().toISOString()
  };
}

/** Vérifie (via Supabase) qu'un email est déjà pris. */
async function emailTaken(table, email) {
  const { data, error } = await supabase.from(table).select('id').eq('email', email).maybeSingle();
  if (error) throw error;
  return !!data;
}

/* ═══════════════════════════════════════════════════════════
   ROUTES API — Supabase uniquement
   ═══════════════════════════════════════════════════════════ */

// ── Catalogue ──
app.get('/api/catalogue', async (_req, res) => {
  try {
    const { data, error } = await supabase.from('catalogue').select('*');
    if (error) return res.status(500).json({ error: 'Catalogue : ' + error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Impossible de charger le catalogue.', details: err.message });
  }
});

// ── Techniciens ──
app.get('/api/technicians', async (req, res) => {
  const { specialty, location, available } = req.query;

  let b = supabase.from('technicians').select('*');
  if (specialty) b = b.ilike('specialite', '%' + specialty + '%');
  if (location) b = b.ilike('localisation', '%' + location + '%');
  if (available !== undefined) b = b.eq('disponible', available === 'true');
  const { data, error } = await b;
  if (error) return res.status(500).json({ error: 'Techniciens : ' + error.message });
  res.json((data || []).map(mapTechnician));
});

app.get('/api/technicians/:id', async (req, res) => {
  const { data, error } = await supabase.from('technicians').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Technicien : ' + error.message });
  data ? res.json(mapTechnician(data)) : res.status(404).json({ error: 'Technicien introuvable.' });
});

// PATCH /api/technicians/:id → mise à jour partielle (disponibilité, tarif, etc.)
app.patch('/api/technicians/:id', async (req, res) => {
  const columns = { available: 'disponible', rate: 'tarif', location: 'localisation', specialty: 'specialite' };
  const updates = {};
  Object.keys(columns).forEach(k => { if (req.body[k] !== undefined) updates[columns[k]] = req.body[k]; });

  let result;
  if (Object.keys(updates).length) {
    const { data, error } = await supabase
      .from('technicians').update(updates).eq('id', req.params.id).select().single();
    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ error: 'Technicien introuvable.' });
      return res.status(500).json({ error: 'Technicien : ' + error.message });
    }
    result = data;
  } else {
    const { data, error } = await supabase.from('technicians').select('*').eq('id', req.params.id).maybeSingle();
    if (error) return res.status(500).json({ error: 'Technicien : ' + error.message });
    if (!data) return res.status(404).json({ error: 'Technicien introuvable.' });
    result = data;
  }
  res.json(mapTechnician(result));
});

// ── Missions ──
app.get('/api/missions', async (req, res) => {
  const { clientId, status, technicianId } = req.query;

  let b = supabase.from('missions').select(MISSION_SELECT);
  if (clientId) b = b.eq('client_id', clientId);
  if (status) b = b.eq('status', status);
  if (technicianId) b = b.eq('technician_id', technicianId);
  const { data, error } = await b;
  if (error) return res.status(500).json({ error: 'Missions : ' + error.message });
  res.json((data || []).map(mapMission));
});

app.post('/api/missions', async (req, res) => {
  const b = req.body;
  if (!b.device || !b.issue) {
    return res.status(400).json({ error: 'Champs manquants (device, issue).' });
  }

  const { data, error } = await supabase.from('missions').insert(missionRow(b)).select(MISSION_SELECT).single();
  if (error) return res.status(500).json({ error: 'Mission : ' + error.message });
  res.status(201).json(mapMission(data));
});

app.get('/api/missions/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('missions').select(MISSION_SELECT).eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Mission : ' + error.message });
  data ? res.json(mapMission(data)) : res.status(404).json({ error: 'Mission introuvable.' });
});

app.patch('/api/missions/:id', async (req, res) => {
  const b = req.body;
  const columns = { status: 'status', price: 'price', technicianId: 'technician_id', address: 'address' };
  const updates = {
    updated_at: new Date().toISOString()
  };
  Object.keys(columns).forEach(k => {
    if (b[k] === undefined) return;
    updates[columns[k]] = (k === 'status' && b[k] === 'in_progress') ? 'in-progress' : b[k];
  });

  const { data, error } = await supabase
    .from('missions').update(updates).eq('id', req.params.id).select(MISSION_SELECT).single();
  if (error) {
    if (error.code === 'PGRST116') return res.status(404).json({ error: 'Mission introuvable.' });
    return res.status(500).json({ error: 'Mission : ' + error.message });
  }
  res.json(mapMission(data));
});

// ── Messages (chat) ──
app.get('/api/messages/:missionId', async (req, res) => {
  const { data, error } = await supabase
    .from('messages').select('*').eq('mission_id', req.params.missionId).order('timestamp');
  if (error) return res.status(500).json({ error: 'Messages : ' + error.message });
  res.json((data || []).map(mapMessage));
});

app.post('/api/messages', async (req, res) => {
  const b = req.body;
  if (!b.missionId || !b.content) {
    return res.status(400).json({ error: 'Champs manquants (missionId, content).' });
  }

  const { data, error } = await supabase.from('messages').insert(messageRow(b)).select().single();
  if (error) return res.status(500).json({ error: 'Message : ' + error.message });
  res.status(201).json(mapMessage(data));
});

// ── Informations client (démo) ──
app.get('/api/client', (_req, res) => {
  res.json({ id: 'client-demo', name: 'Client', email: 'client@email.com' });
});

/* ─────────────────────────────────────────────────────────────
   INSCRIPTION / CONNEXION
   ───────────────────────────────────────────────────────────── */

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function requireAuthFields(res, b, extra) {
  if (!b || !(b.nom || '').trim() || !(b.email || '').trim() || !b.motDePasse) {
    res.status(400).json({ error: 'Champs manquants (nom, email, motDePasse).' });
    return false;
  }
  if (!validateEmail((b.email || '').trim().toLowerCase())) {
    res.status(400).json({ error: 'Adresse email invalide.' });
    return false;
  }
  if ((b.motDePasse || '').length < 6) {
    res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
    return false;
  }
  if (extra && !extra(b)) {
    res.status(400).json({ error: 'Champs manquants (specialite, tarifHoraire, localisation).' });
    return false;
  }
  return true;
}

// POST /api/register-client
app.post('/api/register-client', async (req, res) => {
  const b = req.body || {};
  const email = (b.email || '').trim().toLowerCase();

  if (!requireAuthFields(res, b)) return;
  if (await emailTaken('clients', email)) {
    return res.status(409).json({ error: 'Cet email est déjà utilisé.' });
  }

  const { data, error } = await supabase.from('clients').insert(clientRow(b)).select().single();
  if (error) return res.status(500).json({ error: 'Inscription : ' + error.message });
  res.status(201).json({ success: true, message: 'Inscription réussie !', client: { id: data.id, nom: data.nom, email: data.email } });
});

// POST /api/register-technician
app.post('/api/register-technician', async (req, res) => {
  const b = req.body || {};
  const email = (b.email || '').trim().toLowerCase();

  if (!requireAuthFields(res, b, x => x.specialite && x.localisation && x.tarifHoraire !== undefined)) return;
  if (await emailTaken('technicians', email)) {
    return res.status(409).json({ error: 'Cet email est déjà utilisé.' });
  }

  const { data, error } = await supabase.from('technicians').insert(technicianRow(b)).select().single();
  if (error) return res.status(500).json({ error: 'Inscription : ' + error.message });
  res.status(201).json({ success: true, message: 'Inscription réussie !', technicien: { id: data.id, name: data.nom, email: data.email } });
});

// POST /api/register → inscription unifiée (role: "client" | "technicien")
app.post('/api/register', async (req, res) => {
  const b = req.body || {};
  const email = (b.email || '').trim().toLowerCase();
  const role = b.role === 'technicien' ? 'technicien' : 'client';

  if (role === 'client') {
    if (!requireAuthFields(res, b)) return;
    if (await emailTaken('clients', email)) {
      return res.status(409).json({ error: 'Cet email est déjà utilisé.' });
    }
    const { data, error } = await supabase.from('clients').insert(clientRow(b)).select().single();
    if (error) return res.status(500).json({ error: 'Inscription : ' + error.message });
    return res.status(201).json({ success: true, message: 'Inscription réussie !', role: 'client', client: { id: data.id, nom: data.nom, email: data.email } });
  }

  if (!requireAuthFields(res, b, x => x.specialite && x.localisation && x.tarifHoraire !== undefined)) return;
  if (await emailTaken('technicians', email)) {
    return res.status(409).json({ error: 'Cet email est déjà utilisé.' });
  }
  const { data, error } = await supabase.from('technicians').insert(technicianRow(b)).select().single();
  if (error) return res.status(500).json({ error: 'Inscription : ' + error.message });
  res.status(201).json({ success: true, message: 'Inscription réussie !', role: 'technicien', technicien: { id: data.id, name: data.nom, email: data.email } });
});

// POST /api/login
app.post('/api/login', async (req, res) => {
  const b = req.body || {};
  const email = (b.email || '').trim().toLowerCase();
  const mdp = b.motDePasse || '';

  if (!email || !mdp) {
    return res.status(400).json({ error: 'Champs manquants (email, motDePasse).' });
  }

  const clientQ = await supabase.from('clients').select('*').eq('email', email).maybeSingle();
  if (clientQ.error) return res.status(500).json({ error: 'Connexion : ' + clientQ.error.message });
  if (clientQ.data) {
    if (!verifyPassword(clientQ.data.password_hash, mdp)) {
      return res.status(401).json({ error: 'Identifiants incorrects.' });
    }
    return res.status(200).json({ success: true, message: 'Connexion réussie !', role: 'client', user: { id: clientQ.data.id, nom: clientQ.data.nom } });
  }

  const techQ = await supabase.from('technicians').select('*').eq('email', email).maybeSingle();
  if (techQ.error) return res.status(500).json({ error: 'Connexion : ' + techQ.error.message });
  if (techQ.data) {
    if (!verifyPassword(techQ.data.password_hash, mdp)) {
      return res.status(401).json({ error: 'Identifiants incorrects.' });
    }
    return res.status(200).json({ success: true, message: 'Connexion réussie !', role: 'technicien', user: { id: techQ.data.id, nom: techQ.data.nom } });
  }

  res.status(404).json({ error: 'Aucun compte associé à cet email.' });
});

// POST /api/logout — déconnexion (stateless, aucun token à vérifier).
// Le frontend gère la suppression du token/session côté client.
app.post('/api/logout', (req, res) => {
  res.json({ message: 'Déconnexion réussie' });
});

/* ═══════════════════════════════════════════════════════════
   GESTIONNAIRE D'ERREURS GLOBAL
   ═══════════════════════════════════════════════════════════ */
app.use((err, req, res, next) => {
  console.error('Erreur serveur sur', req.method, req.originalUrl, '\n', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Erreur interne du serveur.', details: err.message });
});

/* ═══════════════════════════════════════════════════════════
   DÉMARRAGE
   ═══════════════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`RepairDom server running → http://localhost:${PORT}`);
});