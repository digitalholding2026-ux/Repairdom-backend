const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
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
   AUTHENTIFICATION JWT
   ═══════════════════════════════════════════════════════════ */

const JWT_SECRET = process.env.JWT_SECRET || '';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

/** Signe un JWT pour un utilisateur (rôle: 'client' | 'technician'). */
function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, nom: user.nom },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * Middleware : protège une route réservée à un technicien connecté.
 * Vérifie le JWT (header Authorization: Bearer <token>), que le rôle est
 * bien technicien, et que le technicianId de l'URL correspond à l'utilisateur
 * connecté (le token doit appartenir à ce technicien).
 */
function requireTechnician(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');

  if (!JWT_SECRET) {
    return res.status(500).json({ error: 'JWT_SECRET non configuré sur le serveur.' });
  }
  if (!token) {
    return res.status(401).json({ error: 'Authentification requise : token manquant.' });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Token invalide ou expiré.' });
  }

  if (payload.role !== 'technician') {
    return res.status(403).json({ error: 'Accès réservé aux techniciens.' });
  }

  const technicianId = req.params.technicianId;
  if (!technicianId || technicianId !== payload.sub) {
    return res.status(403).json({ error: 'Vous ne pouvez pas accéder aux données d’un autre technicien.' });
  }

  req.user = payload;
  next();
}

/* ═══════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════ */

/** SALT_ROUNDS pour bcrypt (10 = bon compromis sécurité/perf). */
const SALT_ROUNDS = 10;

/** Commission RetailDom sur chaque mission (0.10 = 10%). Configurable via env. */
const COMMISSION_RATE = Number(process.env.COMMISSION_RATE || 0.10);

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
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    available: row.disponible,
    verified: !!verified,
    avatar: row.avatar,
    languages: row.languages,
    rating: row.rating,
    reviews: row.avis,
    bio: row.bio,
    motDePasse: row.password_hash,
    createdAt: row.created_at,
    lastSeen: row.last_seen || null
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
    technicianStatus: row.technician_status || 'pending',
    cancellationReason: row.cancellation_reason || null,
    rescheduleDate: row.reschedule_date || null,
    price: row.price,
    negotiationStatus: row.negotiation_status || 'pending',
    systemPrice: row.system_price || null,
    travelFee: row.travel_fee || 2000,
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
    timestamp: row.timestamp,
    readByClient: row.read_by_client === true || row.read_by_client === 'true',
    readByTechnician: row.read_by_technician === true || row.read_by_technician === 'true'
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
  const role = b.senderRole || 'client';
  return {
    mission_id: b.missionId,
    sender_id: b.senderId || null,
    sender_name: b.senderName || 'Client',
    sender_role: role,
    content: b.content,
    timestamp: new Date().toISOString(),
    // Le message est « lu » par son expéditeur dès l'insertion.
    read_by_client: role === 'client',
    read_by_technician: role === 'technician'
  };
}

// Seuil de présence : un utilisateur dont `last_seen` remonte à plus de
// PRESENCE_TIMEOUT_MS est considéré hors ligne.
const PRESENCE_TIMEOUT_MS = Number(process.env.PRESENCE_TIMEOUT_MS || 40000);

function isOnline(lastSeen) {
  if (!lastSeen) return false;
  const t = new Date(lastSeen).getTime();
  if (isNaN(t)) return false;
  return (Date.now() - t) < PRESENCE_TIMEOUT_MS;
}

/** Distance en km (haversine) — null si une coordonnée est absente. */
function haversineKm(aLat, aLng, bLat, bLng) {
  const A = [Number(aLat), Number(aLng)];
  const B = [Number(bLat), Number(bLng)];
  if (!A.concat(B).every(Number.isFinite)) return null;
  const R = 6371;
  const dLat = (B[0] - A[0]) * Math.PI / 180;
  const dLng = (B[1] - A[1]) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(A[0] * Math.PI / 180) * Math.cos(B[0] * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Frais de déplacement par défaut (FCFA). */
const DEFAULT_TRAVEL_FEE = 2000;

/** Insère une notification système dans le fil de chat d'une mission
 *  (best-effort : n'interrompt pas la route en cas d'échec). */
async function notifyInChat(missionId, content) {
  try {
    await supabase.from('messages').insert({
      mission_id: missionId,
      sender_id: null,
      sender_name: 'Système',
      sender_role: 'system',
      content,
      timestamp: new Date().toISOString(),
      read_by_client: false,
      read_by_technician: false
    });
  } catch (err) {
    console.error('Notification chat ignorée :', err.message || err);
  }
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

/* ─────────────────────────────────────────────────────────────
   ASSIGNATION AUTOMATIQUE D'UN TECHNICIEN
   POST /api/missions/:id/assign-technician
   Sélectionne un technicien disponible (statut = disponible), le
   plus proche de l'adresse du client (lat/lng) et avec la meilleure
   note. Calcule et mémorise le prix système (catalogue + transport).
   ───────────────────────────────────────────────────────────── */
app.post('/api/missions/:id/assign-technician', async (req, res) => {
  const missionId = req.params.id;

  // Charge la mission (avec panne pour le calcul du prix).
  const { data: mission, error: mErr } = await supabase
    .from('missions').select('*, clients(*)').eq('id', missionId).maybeSingle();
  if (mErr) return res.status(500).json({ error: 'Mission : ' + mErr.message });
  if (!mission) return res.status(404).json({ error: 'Mission introuvable.' });

  // Récupère les techniciens disponibles.
  const { data: techs, error: tErr } = await supabase
    .from('technicians').select('*').eq('disponible', true);
  if (tErr) return res.status(500).json({ error: 'Techniciens : ' + tErr.message });

  if (!techs || !techs.length) {
    return res.status(404).json({ error: 'Aucun technicien disponible pour le moment.' });
  }

  // Coordonnées du client (si fournies en mémoire de session).
  const clientLat = Number(req.body && (req.body.latitude != null ? req.body.latitude : mission.latitude));
  const clientLng = Number(req.body && (req.body.longitude != null ? req.body.longitude : mission.longitude));

  // Fonction de distance (haversine) — 0 si coordonnées absentes.
  function haversine(aLat, aLng, bLat, bLng) {
    if (![aLat, aLng, bLat, bLng].every(Number.isFinite)) return null;
    const R = 6371;
    const dLat = (bLat - aLat) * Math.PI / 180;
    const dLng = (bLng - aLng) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  let chosen = null;
  let chosenDistance = null;

  // 1) Priorité : techniciens avec coordonnées + distance calculable.
  const techsWithCoords = [];
  let clientHasCoords = Number.isFinite(clientLat) && Number.isFinite(clientLng);
  techs.forEach(function (t) {
    const tLat = Number(t.latitude);
    const tLng = Number(t.longitude);
    const d = Number.isFinite(tLat) && Number.isFinite(tLng) ? haversine(clientLat, clientLng, tLat, tLng) : null;
    if (d != null) techsWithCoords.push({ t, d });
  });

  if (clientHasCoords && techsWithCoords.length) {
    // Tri : distance croissante, puis note décroissante.
    techsWithCoords.sort(function (a, b) {
      if (a.d !== b.d) return a.d - b.d;
      return (Number(b.t.rating) || 0) - (Number(a.t.rating) || 0);
    });
    chosen = techsWithCoords[0].t;
    chosenDistance = techsWithCoords[0].d;
  }

  // 2) Sinon : meilleure note parmi les disponibles.
  if (!chosen) {
    techs.sort(function (a, b) {
      return (Number(b.rating) || 0) - (Number(a.rating) || 0);
    });
    chosen = techs[0];
  }

  // Calcule le prix système : (min+max)/2 + frais déplacement.
  let systemPrice = null;
  let travelFee = Number(mission.travel_fee);
  if (!Number.isFinite(travelFee) || travelFee <= 0) travelFee = 2000;
  if (mission.panne_id) {
    const { data: panne } = await supabase
      .from('catalogue').select('prix_min, prix_max, nom').eq('id', mission.panne_id).maybeSingle();
    if (panne) {
      systemPrice = Math.round((panne.prix_min + panne.prix_max) / 2) + travelFee;
    }
  }

  const now = new Date().toISOString();
  // Assigne le technicien + mémorise le prix système.
  const { data: updated, error: uErr } = await supabase
    .from('missions')
    .update({
      technician_id: chosen.id,
      system_price: systemPrice,
      travel_fee: travelFee,
      negotiation_status: 'pending',
      updated_at: now
    })
    .eq('id', missionId)
    .select(MISSION_SELECT)
    .single();
  if (uErr) return res.status(500).json({ error: 'Mission : ' + uErr.message });

  res.status(200).json({
    mission: mapMission(updated),
    technician: mapTechnician(chosen),
    distanceKm: chosenDistance != null ? Math.round(chosenDistance * 100) / 100 : null,
    systemPrice,
    travelFee
  });
});

app.get('/api/missions/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('missions').select(MISSION_SELECT).eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Mission : ' + error.message });
  data ? res.json(mapMission(data)) : res.status(404).json({ error: 'Mission introuvable.' });
});

app.patch('/api/missions/:id', async (req, res) => {
  const b = req.body;
  const columns = {
    status: 'status', price: 'price', technicianId: 'technician_id', address: 'address',
    negotiationStatus: 'negotiation_status', systemPrice: 'system_price', travelFee: 'travel_fee',
    technicianStatus: 'technician_status', cancellationReason: 'cancellation_reason',
    rescheduleDate: 'reschedule_date', dateSouhaitee: 'date_souhaitee'
  };
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

// POST /api/missions/:id/cancel — le client annule sa mission.
// - Autorisé si technician_status est 'pending' ou 'on_the_way'.
// - Si 'on_the_way' : application des frais de transport au débit du client.
// - La raison est enregistrée dans cancellation_reason.
app.post('/api/missions/:id/cancel', async (req, res) => {
  const missionId = req.params.id;
  const reason = (req.body && req.body.reason ? String(req.body.reason).trim() : '') ||
                 'Annulation par le client';

  const { data: mission, error: mErr } = await supabase
    .from('missions').select(MISSION_SELECT).eq('id', missionId).maybeSingle();
  if (mErr) return res.status(500).json({ error: 'Mission : ' + mErr.message });
  if (!mission) return res.status(404).json({ error: 'Mission introuvable.' });

  const tStatus = mission.technician_status || 'pending';
  if (tStatus !== 'pending' && tStatus !== 'on_the_way') {
    return res.status(409).json({
      error: 'Annulation impossible : la mission est déjà en cours ou terminée (' + tStatus + ').'
    });
  }

  const onTheWay = tStatus === 'on_the_way';
  const transportFee = onTheWay ? Number(mission.travel_fee) || DEFAULT_TRAVEL_FEE : 0;
  const now = new Date().toISOString();

  // Si on_the_way, on applique les frais de transport au prix facturé au client.
  const updates = {
    technician_status: 'cancelled',
    status: 'cancelled',
    cancellation_reason: reason,
    updated_at: now
  };
  if (onTheWay) {
    const currentPrice = Number(mission.price);
    updates.price = (Number.isFinite(currentPrice) ? currentPrice : 0) + transportFee;
  }

  const { data: updated, error: uErr } = await supabase
    .from('missions').update(updates).eq('id', missionId).select(MISSION_SELECT).single();
  if (uErr) return res.status(500).json({ error: 'Mission : ' + uErr.message });

  // Prévient le technicien dans le chat de la mission.
  await notifyInChat(missionId, 'Mission annulée par le client' +
    (onTheWay ? ' (frais de transport appliqués : ' + transportFee + ' FCFA).' : '.'));

  res.json({
    success: true,
    message: onTheWay
      ? 'Mission annulée. Les frais de transport de ' + transportFee + ' FCFA s\'appliquent.'
      : 'Mission annulée avec succès.',
    technicianStatus: 'cancelled',
    status: 'cancelled',
    cancellationReason: reason,
    transportFee
  });
});

// PATCH /api/missions/:id/reschedule — le client ou le technicien reporte le RDV.
// - Body : { new_date: "2026-09-15T10:00:00Z" }
// - Autorisé si technician_status est 'pending' ou 'on_the_way'.
// - Si 'on_the_way' : ajout de frais de litige calculés selon la distance.
// - Met à jour date_souhaitee et updated_at, et notifie le technicien.
app.patch('/api/missions/:id/reschedule', async (req, res) => {
  const missionId = req.params.id;
  const rawDate = req.body && req.body.new_date;
  if (!rawDate) {
    return res.status(400).json({ error: 'Champ requis : new_date.' });
  }
  const parsedDate = new Date(rawDate);
  if (isNaN(parsedDate.getTime())) {
    return res.status(400).json({ error: 'new_date invalide.' });
  }
  const newDate = parsedDate.toISOString();

  const { data: mission, error: mErr } = await supabase
    .from('missions').select(MISSION_SELECT).eq('id', missionId).maybeSingle();
  if (mErr) return res.status(500).json({ error: 'Mission : ' + mErr.message });
  if (!mission) return res.status(404).json({ error: 'Mission introuvable.' });

  const tStatus = mission.technician_status || 'pending';
  if (tStatus !== 'pending' && tStatus !== 'on_the_way') {
    return res.status(409).json({
      error: 'Report impossible : la mission est déjà en cours ou terminée (' + tStatus + ').'
    });
  }

  // Frais de litige : uniquement si le technicien est déjà en route (on_the_way),
  // calculés selon la distance entre le client et le technicien.
  const technician = mission.technicians ? (Array.isArray(mission.technicians) ? mission.technicians[0] : mission.technicians) : null;
  let disputeFee = 0;
  if (tStatus === 'on_the_way') {
    const client = mission.clients ? (Array.isArray(mission.clients) ? mission.clients[0] : mission.clients) : null;
    const cLat = Number(client && client.latitude);
    const cLng = Number(client && client.longitude);
    const tLat = Number(technician && technician.latitude);
    const tLng = Number(technician && technician.longitude);
    const distKm = haversineKm(cLat, cLng, tLat, tLng);
    if (distKm != null) {
      disputeFee = Math.max(1000, Math.round(distKm * 500));
    } else {
      disputeFee = DEFAULT_TRAVEL_FEE;
    }
  }

  const currentTravelFee = Number(mission.travel_fee) || DEFAULT_TRAVEL_FEE;
  const newTravelFee = currentTravelFee + disputeFee;
  const now = new Date().toISOString();

  const updates = {
    date_souhaitee: newDate,
    travel_fee: newTravelFee,
    updated_at: now
  };
  if (disputeFee > 0) {
    const currentPrice = Number(mission.price);
    updates.price = (Number.isFinite(currentPrice) ? currentPrice : 0) + disputeFee;
  }

  const { data: updated, error: uErr } = await supabase
    .from('missions').update(updates).eq('id', missionId).select(MISSION_SELECT).single();
  if (uErr) return res.status(500).json({ error: 'Mission : ' + uErr.message });

  const techName = (technician && technician.nom) || '';
  await notifyInChat(
    missionId,
    'Rendez-vous reporté au ' + new Date(newDate).toLocaleString('fr-FR') +
    (disputeFee > 0 ? ' — frais de litige de ' + disputeFee + ' FCFA appliqués.' : '.')
  );

  res.json({
    success: true,
    message: 'Rendez-vous reporté avec succès.',
    rescheduleDate: newDate,
    dateSouhaitee: newDate,
    disputeFee,
    travelFee: newTravelFee,
    technicianName: techName,
    notification: { sentTo: 'technician', via: 'chat', content: 'Rendez-vous reporté.' }
  });
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

// POST /api/messages/read — marque les messages d'une mission comme lus par
// une partie donnée ("client" ou "technician").
app.post('/api/messages/read', async (req, res) => {
  const b = req.body || {};
  if (!b.missionId || !(b.readerRole === 'client' || b.readerRole === 'technician')) {
    return res.status(400).json({ error: 'Champs manquants (missionId, readerRole client|technician).' });
  }
  const column = b.readerRole === 'client' ? 'read_by_client' : 'read_by_technician';
  const { error } = await supabase
    .from('messages')
    .update({ [column]: true })
    .eq('mission_id', b.missionId)
    .neq(column, true);
  if (error) return res.status(500).json({ error: 'Messages : ' + error.message });
  res.json({ success: true });
});

/* ─────────────────────────────────────────────────────────────
   PRÉSENCE (statut en ligne / hors ligne)
   Un battement de cœur (heartbeat ~15s) met à jour `last_seen` sur la table
   du compte (clients / technicians). Le statut réel est dérivé de last_seen.
   ───────────────────────────────────────────────────────────── */

// POST /api/presence — marque un utilisateur comme actif (last_seen = now).
app.post('/api/presence', async (req, res) => {
  const b = req.body || {};
  const { userId, role } = b;
  if (!userId || !(role === 'client' || role === 'technician')) {
    return res.status(400).json({ error: 'Champs manquants (userId, role).' });
  }
  const table = role === 'client' ? 'clients' : 'technicians';
  const { error } = await supabase
    .from(table).update({ last_seen: new Date().toISOString() }).eq('id', userId);
  if (error) return res.status(500).json({ error: 'Présence : ' + error.message });
  res.json({ success: true, online: true });
});

// GET /api/presence/status?clientId=&technicianId=
// Renvoie le statut en ligne réel des deux parties.
app.get('/api/presence/status', async (req, res) => {
  const { clientId, technicianId } = req.query;
  const out = { client: { online: false, lastSeen: null }, technician: { online: false, lastSeen: null } };

  if (clientId) {
    const { data, error } = await supabase.from('clients').select('id, last_seen').eq('id', clientId).maybeSingle();
    if (error) return res.status(500).json({ error: 'Présence : ' + error.message });
    if (data) out.client = { online: isOnline(data.last_seen), lastSeen: data.last_seen };
  }
  if (technicianId) {
    const { data, error } = await supabase.from('technicians').select('id, last_seen').eq('id', technicianId).maybeSingle();
    if (error) return res.status(500).json({ error: 'Présence : ' + error.message });
    if (data) out.technician = { online: isOnline(data.last_seen), lastSeen: data.last_seen };
  }
  res.json(out);
});

/* ─────────────────────────────────────────────────────────────
   PROPOSITIONS DE PRIX (négociation avec validation)
   Un prix proposé par une partie n'est appliqué à la mission (price) et au
   reçu qu'après acceptation par l'autre partie.
   ───────────────────────────────────────────────────────────── */

// GET /api/missions/:id/proposals — propositions de prix d'une mission (les plus récentes d'abord).
app.get('/api/missions/:id/proposals', async (req, res) => {
  const { data, error } = await supabase
    .from('price_proposals')
    .select('*')
    .eq('mission_id', req.params.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Propositions : ' + error.message });
  res.json(data || []);
});

// POST /api/missions/:id/proposals
// Body: { proposerRole: 'client'|'technician', amount }
// Crée une proposition "proposed" et remplace toute proposition encore en attente.
app.post('/api/missions/:id/proposals', async (req, res) => {
  const missionId = req.params.id;
  const b = req.body || {};
  const { proposerRole, amount } = b;
  const amountNum = Number(amount);
  if (!(proposerRole === 'client' || proposerRole === 'technician')) {
    return res.status(400).json({ error: 'Champs manquants (proposerRole client|technician).' });
  }
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return res.status(400).json({ error: 'Montant invalide.' });
  }

  const now = new Date().toISOString();
  // Remplace toute proposition encore "proposed" (créée par n'importe quelle partie).
  await supabase.from('price_proposals')
    .update({ status: 'replaced', resolved_at: now })
    .eq('mission_id', missionId)
    .eq('status', 'proposed');

  const { data, error } = await supabase.from('price_proposals')
    .insert({ mission_id: missionId, proposer_role: proposerRole, amount: amountNum, status: 'proposed', created_at: now })
    .select().single();
  if (error) return res.status(500).json({ error: 'Proposition : ' + error.message });

  // Met à jour le negotiation_status
  const newStatus = proposerRole === 'client' ? 'client_proposed' : 'tech_proposed';
  await supabase.from('missions')
    .update({ negotiation_status: newStatus, updated_at: now })
    .eq('id', missionId);

  res.status(201).json({ ...data, negotiationStatus: newStatus });
});

// POST /api/missions/:id/proposals/:proposalId/accept
// Body: { accepterRole: 'client'|'technician' }
// Valide la proposition : applique le prix à la mission (price) → nouveau reçu.
app.post('/api/missions/:id/proposals/:proposalId/accept', async (req, res) => {
  const { proposalId } = req.params;
  const missionId = req.params.id;
  const accepterRole = (req.body || {}).accepterRole;

  if (!(accepterRole === 'client' || accepterRole === 'technician')) {
    return res.status(400).json({ error: 'Champ manquant (accepterRole client|technician).' });
  }

  const { data: proposal, error: pErr } = await supabase
    .from('price_proposals').select('*').eq('id', proposalId).maybeSingle();
  if (pErr) return res.status(500).json({ error: 'Proposition : ' + pErr.message });
  if (!proposal) return res.status(404).json({ error: 'Proposition introuvable.' });
  if (proposal.status !== 'proposed') {
    return res.status(409).json({ error: 'Cette proposition n\u2019est plus en attente.' });
  }
  if (proposal.proposer_role === accepterRole) {
    return res.status(400).json({ error: 'La proposition doit être validée par l\u2019autre partie.' });
  }

  const now = new Date().toISOString();
  const { data: mission, error: mErr } = await supabase
    .from('missions')
    .update({ price: proposal.amount, updated_at: now })
    .eq('id', proposal.mission_id)
    .select().single();
  if (mErr) return res.status(500).json({ error: 'Mission : ' + mErr.message });

  await supabase.from('price_proposals')
    .update({ status: 'accepted', resolved_at: now })
    .eq('id', proposalId);

  // Mise à jour des autres propositions en attente → remplacées.
  await supabase.from('price_proposals')
    .update({ status: 'replaced', resolved_at: now })
    .eq('mission_id', proposal.mission_id)
    .eq('status', 'proposed')
    .neq('id', proposalId);

  // ── Validation mutuelle ──
  // Une proposition est acceptée par l'AUTRE partie → accord des deux côtés.
  // Le prix est appliqué à la mission (missions.price) et la négociation est
  // marquée comme acceptée → le bouton "Valider la mission" est débloqué.
  await supabase.from('missions')
    .update({ negotiation_status: 'accepted', updated_at: now })
    .eq('id', proposal.mission_id);

  res.json({
    success: true,
    price: proposal.amount,
    negotiationStatus: 'accepted',
    mutualAgreement: true,
    priceProposal: { ...proposal, status: 'accepted', resolved_at: now }
  });
});

// POST /api/missions/:id/proposals/:proposalId/reject
// Body: { accepterRole } — refuse la proposition (elle reste "declined").
app.post('/api/missions/:id/proposals/:proposalId/reject', async (req, res) => {
  const { proposalId } = req.params;
  const accepterRole = (req.body || {}).accepterRole;
  if (!(accepterRole === 'client' || accepterRole === 'technician')) {
    return res.status(400).json({ error: 'Champ manquant (accepterRole client|technician).' });
  }

  const { data: proposal, error: pErr } = await supabase
    .from('price_proposals').select('*').eq('id', proposalId).maybeSingle();
  if (pErr) return res.status(500).json({ error: 'Proposition : ' + pErr.message });
  if (!proposal) return res.status(404).json({ error: 'Proposition introuvable.' });
  if (proposal.status !== 'proposed') {
    return res.status(409).json({ error: 'Cette proposition n\u2019est plus en attente.' });
  }
  if (proposal.proposer_role === accepterRole) {
    return res.status(400).json({ error: 'La proposition doit être refusée par l\u2019autre partie.' });
  }

  await supabase.from('price_proposals')
    .update({ status: 'declined', resolved_at: new Date().toISOString() })
    .eq('id', proposalId);
  // Remet le status de négociation à pending (retour au prix système).
  await supabase.from('missions')
    .update({ negotiation_status: 'pending', updated_at: new Date().toISOString() })
    .eq('id', proposal.mission_id);
  res.json({ success: true, priceProposal: { ...proposal, status: 'declined' } });
});

/* ─────────────────────────────────────────────────────────────
   NÉGOCIATION MUTUALISÉE
   POST /api/negotiation/:missionId
   Calcule le prix système (catalogue + frais déplacement) et/ou
   enregistre une proposition de prix avec validation mutuelle.
   Body: { proposedBy: 'client'|'technician', amount? }
   ───────────────────────────────────────────────────────────── */
app.post('/api/negotiation/:missionId', async (req, res) => {
  const missionId = req.params.missionId;
  const b = req.body || {};
  const { proposedBy, amount } = b;

  // Récupère la mission
  const { data: mission, error: mErr } = await supabase
    .from('missions').select('*, clients(*), technicians(*)').eq('id', missionId).maybeSingle();
  if (mErr) return res.status(500).json({ error: 'Mission : ' + mErr.message });
  if (!mission) return res.status(404).json({ error: 'Mission introuvable.' });

  // 1) Calcul du prix système si pas encore calculé
  let systemPrice = mission.system_price;
  let travelFee = mission.travel_fee || 2000;
  if (!systemPrice && mission.panne_id) {
    const { data: panne } = await supabase
      .from('catalogue').select('prix_min, prix_max').eq('id', mission.panne_id).maybeSingle();
    if (panne) {
      systemPrice = Math.round((panne.prix_min + panne.prix_max) / 2) + travelFee;
      await supabase.from('missions')
        .update({ system_price: systemPrice, travel_fee: travelFee, updated_at: new Date().toISOString() })
        .eq('id', missionId);
    }
  }

  // 2) Si pas de proposition de prix → retourne juste le prix système
  if (!proposedBy || amount === undefined) {
    return res.json({
      missionId,
      systemPrice,
      travelFee,
      negotiationStatus: mission.negotiation_status || 'pending',
      price: mission.price
    });
  }

  // 3) Proposition de prix par une partie
  const amountNum = Number(amount);
  const proposerRole = (proposedBy === 'technician') ? 'technician' : 'client';
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return res.status(400).json({ error: 'Montant invalide.' });
  }

  const now = new Date().toISOString();

  // Remplace toute proposition encore "proposed"
  await supabase.from('price_proposals')
    .update({ status: 'replaced', resolved_at: now })
    .eq('mission_id', missionId)
    .eq('status', 'proposed');

  // Insère la nouvelle proposition
  const { data: proposal, error: pErr } = await supabase.from('price_proposals')
    .insert({
      mission_id: missionId,
      proposer_role: proposerRole,
      amount: amountNum,
      status: 'proposed',
      created_at: now
    })
    .select().single();
  if (pErr) return res.status(500).json({ error: 'Proposition : ' + pErr.message });

  // Met à jour le negotiation_status
  const newStatus = proposerRole === 'client' ? 'client_proposed' : 'tech_proposed';
  await supabase.from('missions')
    .update({ negotiation_status: newStatus, updated_at: now })
    .eq('id', missionId);

  res.status(201).json({
    missionId,
    systemPrice,
    travelFee,
    negotiationStatus: newStatus,
    priceProposal: proposal
  });
});

/* ─────────────────────────────────────────────────────────────
   DASHBOARD TECHNICIEN (routes protégées par JWT)
   Toutes ces routes vérifient que le technicianId de l'URL
   correspond au technicien connecté (token Bearer).
   ───────────────────────────────────────────────────────────── */

// GET /api/technician/missions/:technicianId?status=...
// Missions assignées au technicien, avec infos du client (nom, téléphone, adresse).
app.get('/api/technician/missions/:technicianId', requireTechnician, async (req, res) => {
  const { status } = req.query;

  let b = supabase.from('missions').select(MISSION_SELECT).eq('technician_id', req.params.technicianId);
  if (status) b = b.eq('status', status);

  const { data, error } = await b;
  if (error) return res.status(500).json({ error: 'Missions : ' + error.message });

  const missions = (data || []).map(row => {
    const c = embed(row, 'clients');
    return {
      id: row.id,
      clientName: (c && c.nom) || row.client_name || 'Client',
      clientPhone: (c && c.telephone) || '',
      address: row.address || (c && c.adresse) || '',
      device: row.device,
      issue: row.issue,
      technicianId: row.technician_id,
      status: row.status,
      price: row.price,
      dateSouhaitee: row.date_souhaitee || null,
      time: row.time_souhaitee || null,
      createdAt: row.created_at
    };
  });

  res.json(missions);
});

// GET /api/technician/stats/:technicianId
// Statistiques du technicien : total, en cours, terminées, revenus, note moyenne.
app.get('/api/technician/stats/:technicianId', requireTechnician, async (req, res) => {
  const technicianId = req.params.technicianId;

  const missionsQ = await supabase.from('missions').select('status,price').eq('technician_id', technicianId);
  if (missionsQ.error) return res.status(500).json({ error: 'Statistiques : ' + missionsQ.error.message });

  const missions = missionsQ.data || [];
  const terminees = missions.filter(m => m.status === 'completed');
  const enCours = missions.filter(m => m.status === 'in-progress' || m.status === 'pending' || m.status === 'accepted');
  const revenusTotaux = terminees.reduce((sum, m) => sum + (Number(m.price) || 0), 0);

  // Note moyenne : on préfère le rating stocké sur le technicien (déjà agrégé).
  const techQ = await supabase.from('technicians').select('rating').eq('id', technicianId).maybeSingle();
  const noteMoyenne = techQ.data && techQ.data.rating != null ? Number(techQ.data.rating) : null;

  res.json({
    technicianId,
    totalMissions: missions.length,
    missionsEnCours: enCours.length,
    missionsTerminees: terminees.length,
    revenusTotaux,
    noteMoyenne
  });
});

// GET /api/technician/conversations/:technicianId
// Liste des conversations du technicien, une par mission (active ou terminée) :
// nom du client, dernier message, date, nombre de messages non lus.
app.get('/api/technician/conversations/:technicianId', requireTechnician, async (req, res) => {
  const technicianId = req.params.technicianId;

  const { data: missions, error: mErr } = await supabase
    .from('missions')
    .select(MISSION_SELECT)
    .eq('technician_id', technicianId);
  if (mErr) return res.status(500).json({ error: 'Conversations : ' + mErr.message });

  const activeMissions = (missions || []).filter(m =>
    ['pending', 'accepted', 'in-progress', 'in_progress', 'completed'].includes(m.status)
  );

  const missionIds = activeMissions.map(m => m.id);
  if (!missionIds.length) return res.json([]);

  const { data: messages, error: msErr } = await supabase
    .from('messages')
    .select('*')
    .in('mission_id', missionIds)
    .order('timestamp', { ascending: true });
  if (msErr) return res.status(500).json({ error: 'Conversations : ' + msErr.message });

  // Groupe les messages par mission.
  const byMission = {};
  (messages || []).forEach(msg => {
    (byMission[msg.mission_id] = byMission[msg.mission_id] || []).push(msg);
  });

  const conversations = activeMissions.map(row => {
    const c = embed(row, 'clients');
    const msgs = byMission[row.id] || [];
    const last = msgs[msgs.length - 1] || null;
    const unread = msgs.filter(msg => msg.sender_role === 'client' && !(msg.read_by_technician === true)).length;

    return {
      missionId: row.id,
      clientName: (c && c.nom) || row.client_name || 'Client',
      clientId: row.client_id || (c && c.id) || null,
      clientPhone: (c && c.telephone) || '',
      address: row.address || (c && c.adresse) || '',
      device: row.device,
      issue: row.issue,
      status: row.status,
      price: row.price,
      lastMessage: last ? last.content : null,
      lastMessageBy: last ? last.sender_role : null,
      lastMessageAt: last ? last.timestamp : null,
      unread
    };
  });

  // Tri : conversations avec messages non lus d'abord, puis par activité récente.
  conversations.sort((a, b) => {
    if ((b.unread > 0) !== (a.unread > 0)) return (b.unread > 0) ? 1 : -1;
    const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return tb - ta;
  });

  res.json(conversations);
});

// GET /api/technician/reviews/:technicianId
// Liste des avis reçus (nom du client, note, commentaire, date).
app.get('/api/technician/reviews/:technicianId', requireTechnician, async (req, res) => {
  const { data, error } = await supabase
    .from('avis')
    .select('*, clients(nom)')
    .eq('technicien_id', req.params.technicianId)
    .order('created_at', { ascending: false });

  if (error) {
    // La table `avis` peut ne pas exister encore → réponse vide explicite.
    if (error.code === 'PGRST205' || String(error.message).toLowerCase().includes('relation "avis" does not exist')) {
      return res.json([]);
    }
    return res.status(500).json({ error: 'Avis : ' + error.message });
  }

  const reviews = (data || []).map(r => ({
    id: r.id,
    clientName: (r.clients && r.clients.nom) || r.client_name || 'Client',
    note: r.note,
    commentaire: r.commentaire,
    date: r.created_at
  }));
  res.json(reviews);
});

// GET /api/technician/payments/:technicianId
// Historique des paiements : missions terminées, montant perçu (commission
// déduite), client, date de paiement, statut du paiement. Ordonné par date
// décroissante, avec montants totaux en tête.
app.get('/api/technician/payments/:technicianId', requireTechnician, async (req, res) => {
  let b = supabase
    .from('missions')
    .select(MISSION_SELECT)
    .eq('technician_id', req.params.technicianId)
    .eq('status', 'completed');

  const { data, error } = await b;
  if (error) return res.status(500).json({ error: 'Paiements : ' + error.message });

  const payments = (data || []).map(row => {
    const c = embed(row, 'clients');
    const gross = Number(row.price) || 0;
    const net = Math.round(gross * (1 - COMMISSION_RATE));

    // Statut du paiement : utilise la colonne `paye` si elle existe,
    // sinon un paiement est considéré "Payé" quand un montant est fixé.
    let paid;
    if (row.paye === true || row.paye === 'true') paid = true;
    else if (row.paye === false || row.paye === 'false') paid = false;
    else paid = gross > 0;

    const paidAt = row.paid_at || row.updated_at || row.created_at || null;

    return {
      id: row.id,
      missionId: row.id,
      clientName: (c && c.nom) || row.client_name || 'Client',
      gross: gross,
      commission: Math.round(gross * COMMISSION_RATE),
      net: net,
      status: paid ? 'Payé' : 'En attente',
      date: new Date(paidAt).toISOString()
    };
  });

  // Tri par date décroissante (les plus récentes en premier).
  payments.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const totalGross = payments.reduce((s, p) => s + p.gross, 0);
  const totalCommission = payments.reduce((s, p) => s + p.commission, 0);
  const totalNet = payments.reduce((s, p) => s + p.net, 0);

  res.json({
    commissionRate: COMMISSION_RATE,
    totalGross,
    totalCommission,
    totalNet,
    totalPaid: payments.filter(p => p.status === 'Payé').length,
    payments
  });
});

// PATCH /api/technician/status/:technicianId
// Met à jour le champ `disponible` du technicien. Body: { disponible: true/false }.
app.patch('/api/technician/status/:technicianId', requireTechnician, async (req, res) => {
  const disponible = req.body && req.body.disponible;
  if (typeof disponible !== 'boolean') {
    return res.status(400).json({ error: 'Champ manquant (disponible doit être un booléen).' });
  }

  const { data, error } = await supabase
    .from('technicians')
    .update({ disponible })
    .eq('id', req.params.technicianId)
    .select()
    .single();
  if (error) {
    if (error.code === 'PGRST116') return res.status(404).json({ error: 'Technicien introuvable.' });
    return res.status(500).json({ error: 'Technicien : ' + error.message });
  }

  res.json({ success: true, id: data.id, disponible: data.disponible });
});

// PATCH /api/technician/profile/:technicianId
// Met à jour les informations du profil du technicien (nom, téléphone,
// spécialité, tarif, localisation). Le mot de passe n'est pas modifiable ici.
app.patch('/api/technician/profile/:technicianId', requireTechnician, async (req, res) => {
  const b = req.body || {};

  // Validation du téléphone : format +237XXXXXXXXX.
  if (b.telephone !== undefined && (!/^\+237\s?\d{9}$/.test(String(b.telephone).trim()))) {
    return res.status(400).json({ error: 'Le téléphone doit être au format +237XXXXXXXXX.' });
  }

  const updates = {};
  if (b.nom !== undefined) {
    if (!String(b.nom).trim()) return res.status(400).json({ error: 'Le nom ne peut pas être vide.' });
    updates.nom = String(b.nom).trim();
  }
  if (b.telephone !== undefined) updates.telephone = String(b.telephone).trim();
  if (b.specialite !== undefined) updates.specialite = String(b.specialite).trim();
  if (b.localisation !== undefined) updates.localisation = String(b.localisation).trim();
  if (b.tarif !== undefined) {
    const tarif = Number(b.tarif);
    if (!Number.isFinite(tarif) || tarif < 0) {
      return res.status(400).json({ error: 'Le tarif doit être un nombre positif.' });
    }
    updates.tarif = tarif;
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
  }

  const { data, error } = await supabase
    .from('technicians')
    .update(updates)
    .eq('id', req.params.technicianId)
    .select()
    .single();
  if (error) {
    if (error.code === 'PGRST116') return res.status(404).json({ error: 'Technicien introuvable.' });
    return res.status(500).json({ error: 'Technicien : ' + error.message });
  }

  res.json({ success: true, message: 'Profil mis à jour.', technicien: mapTechnician(data) });
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
  const token = signToken({ id: data.id, role: 'client', nom: data.nom });
  res.status(201).json({ success: true, message: 'Inscription réussie !', role: 'client', token, client: { id: data.id, nom: data.nom, email: data.email } });
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
  const token = signToken({ id: data.id, role: 'technician', nom: data.nom });
  res.status(201).json({ success: true, message: 'Inscription réussie !', role: 'technician', token, technicien: { id: data.id, name: data.nom, email: data.email } });
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
    const token = signToken({ id: data.id, role: 'client', nom: data.nom });
    return res.status(201).json({ success: true, message: 'Inscription réussie !', role: 'client', token, client: { id: data.id, nom: data.nom, email: data.email } });
  }

  if (!requireAuthFields(res, b, x => x.specialite && x.localisation && x.tarifHoraire !== undefined)) return;
  if (await emailTaken('technicians', email)) {
    return res.status(409).json({ error: 'Cet email est déjà utilisé.' });
  }
  const { data, error } = await supabase.from('technicians').insert(technicianRow(b)).select().single();
  if (error) return res.status(500).json({ error: 'Inscription : ' + error.message });
  const token = signToken({ id: data.id, role: 'technician', nom: data.nom });
  res.status(201).json({ success: true, message: 'Inscription réussie !', role: 'technician', token, technicien: { id: data.id, name: data.nom, email: data.email } });
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
    const token = signToken({ id: clientQ.data.id, role: 'client', nom: clientQ.data.nom });
    return res.status(200).json({ success: true, message: 'Connexion réussie !', role: 'client', token, user: { id: clientQ.data.id, nom: clientQ.data.nom } });
  }

  const techQ = await supabase.from('technicians').select('*').eq('email', email).maybeSingle();
  if (techQ.error) return res.status(500).json({ error: 'Connexion : ' + techQ.error.message });
  if (techQ.data) {
    if (!verifyPassword(techQ.data.password_hash, mdp)) {
      return res.status(401).json({ error: 'Identifiants incorrects.' });
    }
    const token = signToken({ id: techQ.data.id, role: 'technician', nom: techQ.data.nom });
    return res.status(200).json({ success: true, message: 'Connexion réussie !', role: 'technician', token, user: { id: techQ.data.id, nom: techQ.data.nom } });
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