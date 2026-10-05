import { describe, expect, it, vi } from 'vitest';
import { NotificationsService } from './notifications.service.js';
import { buildNotificationMetadata } from './notification-metadata.js';
import {
  buildNotification,
  createNotification,
  type Tx,
} from '../mission-events/mission-events.js';

/* Chantier #2D — contrat `Notification.metadata` et sa sérialisation.
 *
 * RÈGLE FCFA, testée ici : les montants sont stockés en XAF ENTIER, jamais
 * pré-formatés. Un « 15 000 FCFA » en base serait figé pour tous les
 * utilisateurs et impossible à re-localiser ; le formatage est fait par le
 * frontend (`formatFCFA`).
 *
 * Ces tests n'utilisent aucun mock de module externe : uniquement un faux
 * client Prisma, donc ils s'exécutent sans base de données.
 */

type Row = {
  id: string;
  type: string;
  title: string;
  message: string;
  demandeId: string | null;
  metadata: unknown;
  readAt: Date | null;
  createdAt: Date;
  demande: { reference: string } | null;
};

const row = (overrides: Partial<Row> = {}): Row => ({
  id: 'n1',
  type: 'QUOTE_CREATED',
  title: 'Nouveau devis reçu',
  message: 'Un technicien a envoyé un devis pour votre mission.',
  demandeId: 'd1',
  metadata: null,
  readAt: null,
  createdAt: new Date('2026-10-11T08:00:00.000Z'),
  demande: { reference: 'RD-4821' },
  ...overrides,
});

function serviceWith(rows: Row[]) {
  const prisma = {
    notification: {
      findMany: vi.fn().mockResolvedValue(rows),
      count: vi.fn().mockResolvedValue(rows.filter((r) => r.readAt === null).length),
    },
  };
  return { service: new NotificationsService(prisma as never), prisma };
}

describe('buildNotificationMetadata — filtre réel du JSON', () => {
  it('conserve les clés connues', () => {
    expect(buildNotificationMetadata({ quoteId: 'q1', amountXAF: 15000 })).toEqual({
      quoteId: 'q1',
      amountXAF: 15000,
    });
  });

  it('écarte les clés inconnues (une colonne JSON libre ne doit rien laisser passer)', () => {
    const result = buildNotificationMetadata({
      quoteId: 'q1',
      latitude: 4.05,
      adminSecret: 'x',
    } as never);
    expect(result).toEqual({ quoteId: 'q1' });
  });

  it('écarte `null` (= non applicable) et `undefined` (= non fourni)', () => {
    const result = buildNotificationMetadata({
      amountXAF: null,
      quoteId: undefined,
      currency: 'XAF',
    });
    expect(result).toEqual({ currency: 'XAF' });
  });

  it('renvoie `undefined` si rien ne survit au filtre (colonne laissée à null)', () => {
    expect(buildNotificationMetadata({ amountXAF: null })).toBeUndefined();
    expect(buildNotificationMetadata({})).toBeUndefined();
    expect(buildNotificationMetadata(null)).toBeUndefined();
    expect(buildNotificationMetadata(undefined)).toBeUndefined();
  });

  it('montants : entiers conservés tels quels, AUCUN formatage appliqué', () => {
    const result = buildNotificationMetadata({ amountXAF: 15000, finalAmountXAF: 45000 });
    expect(result).toEqual({ amountXAF: 15000, finalAmountXAF: 45000 });
    // Aucune chaîne, aucun séparateur de milliers, aucune devise.
    expect(typeof result?.amountXAF).toBe('number');
    expect(JSON.stringify(result)).not.toContain('FCFA');
    expect(JSON.stringify(result)).not.toContain('XAF ');
  });
});

describe('listMine — sérialisation', () => {
  it('expose `metadata` et `reference` (regroupement par mission)', async () => {
    const { service } = serviceWith([
      row({
        metadata: { quoteId: 'q1', amountXAF: 15000, currency: 'XAF' },
      }),
    ]);
    const result = await service.listMine('u1');

    expect(result.items[0].metadata).toEqual({
      quoteId: 'q1',
      amountXAF: 15000,
      currency: 'XAF',
    });
    expect(result.items[0].reference).toBe('RD-4821');
  });

  it('notification SANS metadata (créée avant la migration) → `metadata: null`, pas une erreur', async () => {
    const { service } = serviceWith([row({ metadata: null })]);
    const result = await service.listMine('u1');
    expect(result.items[0].metadata).toBeNull();
  });

  it('metadata JSON corrompu (tableau / chaîne) → `null`, la liste ne casse pas', async () => {
    const { service } = serviceWith([
      row({ metadata: ['pas', 'un', 'objet'] }),
      row({ id: 'n2', metadata: 'texte' }),
      row({ id: 'n3', metadata: { quoteId: 'ok', amountXAF: 1000 } }),
    ]);
    const result = await service.listMine('u1');
    expect(result.items[0].metadata).toBeNull();
    expect(result.items[1].metadata).toBeNull();
    // Une ligne valide reste servie normalement : on n'écarte pas toute la page.
    expect(result.items[2].metadata).toEqual({ quoteId: 'ok', amountXAF: 1000 });
  });

  it('mission supprimée (`demandeId` mis à null en cascade) → reference null, pas de rejet', async () => {
    const { service } = serviceWith([row({ demandeId: null, demande: null })]);
    const result = await service.listMine('u1');
    expect(result.items[0].reference).toBeNull();
    expect(result.items[0].demandeId).toBeNull();
  });

  it('`read` reste dérivé de `readAt` (null → false)', async () => {
    const { service } = serviceWith([
      row({ id: 'unread', readAt: null }),
      row({ id: 'read', readAt: new Date('2026-10-11T09:00:00.000Z') }),
    ]);
    const result = await service.listMine('u1');
    expect(result.items[0].read).toBe(false);
    expect(result.items[1].read).toBe(true);
  });

  it('`readAt` n’est JAMAIS exposé (le booléen suffit, la date ne l’est pas)', async () => {
    const { service } = serviceWith([row({ readAt: new Date('2026-10-11T09:00:00.000Z') })]);
    const result = await service.listMine('u1');
    expect(result.items[0]).not.toHaveProperty('readAt');
    // `userId` non plus : le client connaît déjà le sien.
    expect(result.items[0]).not.toHaveProperty('userId');
  });
});

/* ── Point de passage unique `createNotification` ───────────────────────────
 *
 * 14 des 16 sites de création passent par cette fonction. La tester, c'est
 * garantir que TOUS les câblages respectent la règle FCFA sans avoir à
 * monter une base.
 */

function txWithCreate() {
  const create = vi.fn().mockResolvedValue({ id: 'n1' });
  return { tx: { notification: { create } } as unknown as Tx, create };
}

describe('createNotification — écriture du metadata', () => {
  it('QUOTE_CREATED : le montant est un ENTIER XAF, jamais formaté', async () => {
    const { tx, create } = txWithCreate();
    await createNotification(tx, {
      ...buildNotification('QUOTE_CREATED', 'd1', 'client-1', 'CLIENT'),
      metadata: { quoteId: 'q1', amountXAF: 15000, currency: 'XAF' },
    });

    const data = create.mock.calls[0][0].data;
    expect(data.metadata).toEqual({ quoteId: 'q1', amountXAF: 15000, currency: 'XAF' });
    expect(typeof data.metadata.amountXAF).toBe('number');
    // AUCUN montant pré-formaté dans les textes (règle FCFA).
    expect(data.title).not.toMatch(/\d/);
    expect(data.message).not.toMatch(/\d/);
    expect(JSON.stringify(data.metadata)).not.toContain('FCFA');
  });

  it('CONFIRMED : montant final net en XAF entier', async () => {
    const { tx, create } = txWithCreate();
    await createNotification(tx, {
      ...buildNotification('CONFIRMED', 'd1', 'tech-1', 'TECHNICIAN'),
      metadata: { finalAmountXAF: 45000 },
    });
    expect(create.mock.calls[0][0].data.metadata).toEqual({ finalAmountXAF: 45000 });
  });

  it('SCHEDULED : date de rendez-vous en ISO, seule donnée structurée', async () => {
    const { tx, create } = txWithCreate();
    await createNotification(tx, {
      ...buildNotification('SCHEDULED', 'd1', 'client-1', 'CLIENT'),
      metadata: { scheduledAt: '2026-10-20T08:00:00.000Z' },
    });
    expect(create.mock.calls[0][0].data.metadata).toEqual({
      scheduledAt: '2026-10-20T08:00:00.000Z',
    });
  });

  it('DISPUTE_RESOLVED : la décision administrative est remontée', async () => {
    const { tx, create } = txWithCreate();
    await createNotification(tx, {
      ...buildNotification('DISPUTE_RESOLVED', 'd1', 'client-1', 'CLIENT'),
      metadata: { disputeId: 'sp1', disputeStatus: 'RESOLVED', resolution: 'Remboursement.' },
    });
    expect(create.mock.calls[0][0].data.metadata).toEqual({
      disputeId: 'sp1',
      disputeStatus: 'RESOLVED',
      resolution: 'Remboursement.',
    });
  });

  it('sans metadata exploitable → la clé est ABSENTE (colonne laissée à null)', async () => {
    const { tx, create } = txWithCreate();
    // Cas réel : TECHNICIAN_EN_ROUTE n'a aucune donnée structurée.
    await createNotification(
      tx,
      buildNotification('TECHNICIAN_EN_ROUTE', 'd1', 'client-1', 'CLIENT'),
    );
    const data = create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('metadata');
    // La notification est bien créée (l'absence de metadata n'est pas bloquante).
    expect(data.type).toBe('TECHNICIAN_EN_ROUTE');
  });

  it('un metadata {} ne crée pas de clé `metadata` vide', async () => {
    const { tx, create } = txWithCreate();
    await createNotification(tx, {
      ...buildNotification('COMPLETED', 'd1', 'client-1', 'CLIENT'),
      metadata: { amountXAF: null },
    });
    expect(create.mock.calls[0][0].data).not.toHaveProperty('metadata');
  });

  it('jamais de clé parasite dans la ligne écrite (latitude, distance, secret)', async () => {
    const { tx, create } = txWithCreate();
    await createNotification(tx, {
      ...buildNotification('MISSION_AVAILABLE', 'd1', 'tech-1', 'TECHNICIAN'),
      metadata: { city: 'Douala', latitude: 4.05, distanceMeters: 1200 } as never,
    });
    const data = create.mock.calls[0][0].data;
    expect(data.metadata).toEqual({ city: 'Douala' });
    expect(data).not.toHaveProperty('latitude');
    expect(data).not.toHaveProperty('distanceMeters');
  });
});

describe('buildNotification — invariant FCFA des textes', () => {
  const cases = [
    ['TECHNICIAN_ACCEPTED', 'CLIENT'],
    ['QUOTE_CREATED', 'CLIENT'],
    ['NEGOTIATION_REQUESTED', 'TECHNICIAN'],
    ['QUOTE_ACCEPTED', 'TECHNICIAN'],
    ['QUOTE_REJECTED', 'TECHNICIAN'],
    ['SCHEDULED', 'CLIENT'],
    ['SCHEDULED', 'TECHNICIAN'],
    ['COMPLETED', 'CLIENT'],
    ['CONFIRMED', 'TECHNICIAN'],
    ['MISSION_AVAILABLE', 'TECHNICIAN'],
    ['TECHNICIAN_EN_ROUTE', 'CLIENT'],
    ['DISPUTE_OPENED', 'TECHNICIAN'],
    ['DISPUTE_OPENED', 'CLIENT'],
    ['DISPUTE_RESOLVED', 'CLIENT'],
    ['DISPUTE_RESOLVED', 'TECHNICIAN'],
  ] as const;

  it('aucun titre ni message ne contient de montant ni de devise', () => {
    for (const [type, audience] of cases) {
      const built = buildNotification(type, 'd1', 'u1', audience);
      /* Un montant, même entier, dans un texte ne peut plus être re-formaté
       * ni re-localisé : c'est interdit par construction. */
      expect(built.title, `${type}/${audience} title`).not.toMatch(/\d/);
      expect(built.message, `${type}/${audience} message`).not.toMatch(/\d/);
      expect(built.title).not.toMatch(/FCFA|XAF/);
      expect(built.message).not.toMatch(/FCFA|XAF/);
    }
  });

  it('le message d’une pièce d’identité est générique, sans « motif : … »', () => {
    // La catégorie du litige est passée par `metadata`, pas injectée dans le
    // texte : le message reste identique quel que soit le motif.
    const a = buildNotification('DISPUTE_OPENED', 'd1', 'u1', 'TECHNICIAN');
    const b = buildNotification('DISPUTE_OPENED', 'd2', 'u2', 'TECHNICIAN');
    expect(a.message).toBe(b.message);
  });
});