import { describe, expect, it, vi } from 'vitest';
import { AdminService } from './admin.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RealtimeService } from '../realtime/realtime.service.js';
import type { PushService } from '../push/push.service.js';
import type { EmailService } from '../auth/email.service.js';
import type { ConfigService } from '@nestjs/config';

/* Chantier #5A — la décision KYC notifie le technicien sur 4 canaux.
 *
 * Ces tests verrouillent deux garanties qui n'ont rien à voir l'une de l'autre :
 *
 *  1. COMPLETUDE — une décision produit exactement une notification in-app,
 *     deux publications SSE, un push et un e-mail, avec les bonnes données
 *     (type, motif, lien de redirection) ;
 *  2. ISOLATION — AUCUN canal ne peut faire échouer la décision déjà
 *     enregistrée. C'est la propriété critique : si le push ou l'e-mail lève,
 *     l'admin doit TOUJOURS recevoir son 200 et le dossier à jour.
 *
 * Prisma est entièrement mocké (aucune base requise). Le `admin.service` est
 * instancié à la main, comme dans `admin-super-powers.spec.ts` : c'est ce qui
 * permet d'injecter un canal qui échoue et de vérifier l'isolation.
 */

const TECHNICIAN_ID = 'tech-1';
const REVIEWER_ID = 'admin-1';

/** Dossier KYC en attente, prêt à être tranché. */
function pendingProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile-1',
    userId: TECHNICIAN_ID,
    kycStatus: 'PENDING',
    kycRejectionReason: null,
    birthDate: null,
    avatarUrl: null,
    city: 'Douala',
    categories: [],
    specialties: [],
    experience: null,
    serviceDescription: null,
    bio: null,
    nationality: null,
    kycIdentityDocType: null,
    activityType: null,
    experienceYears: null,
    familyCodes: [],
    isAvailable: true,
    ...overrides,
  };
}

/**
 * Prisma mocké pour le chemin complet `updateKycStatus` → `getKycFolder`.
 * `notification.create` est piloté par `onNotificationCreate` pour Allows
 * tester l'échec du canal in-app.
 */
function prismaMock(options: { onNotificationCreate?: () => Promise<unknown> } = {}) {
  const created: Array<Record<string, unknown>> = [];
  return {
    created,
    technicianProfile: {
      findUnique: vi.fn(async () => ({
        ...pendingProfile(),
        user: { email: 'tech@relioo.space', firstName: 'Awa' },
      })),
      update: vi.fn(async () => pendingProfile({ kycStatus: 'VERIFIED' })),
    },
    kycReview: { create: vi.fn(async () => ({ id: 'review-1' })) },
    notification: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        if (options.onNotificationCreate) await options.onNotificationCreate();
        return { id: 'notif-1' };
      }),
    },
    /* `getKycFolder` relit le dossier après la décision. */
    user: {
      findUnique: vi.fn(async () => ({
        id: TECHNICIAN_ID,
        role: 'TECHNICIAN',
        firstName: 'Awa',
        lastName: 'Ndo',
        phone: null,
        whatsapp: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        technicianProfile: pendingProfile({ kycStatus: 'VERIFIED' }),
        kycDocuments: [],
        kycReviews: [],
      })),
    },
    demande: { count: vi.fn(async () => 0) },
    $transaction: vi.fn(async () => undefined),
  };
}

function harness(options: {
  prisma?: ReturnType<typeof prismaMock>;
  realtime?: Partial<RealtimeService>;
  push?: Partial<PushService>;
  email?: Partial<EmailService>;
} = {}) {
  const prisma = options.prisma ?? prismaMock();
  const realtime = {
    publishToUser: vi.fn(),
    ...options.realtime,
  } as unknown as RealtimeService;
  const push = {
    sendToUser: vi.fn(async () => ({ sent: 1, skipped: null, failed: 0 })),
    ...options.push,
  } as unknown as PushService;
  const email = {
    sendKycVerifiedEmail: vi.fn(async () => undefined),
    sendKycRejectedEmail: vi.fn(async () => undefined),
    ...options.email,
  } as unknown as EmailService;
  const config = {
    get: vi.fn((key: string) => (key === 'FRONTEND_URL' ? 'https://app.relioo.space' : undefined)),
  } as unknown as ConfigService;

  const service = new AdminService(
    prisma as unknown as PrismaService,
    {} as never,
    realtime,
    push,
    email,
    config,
  );
  return { service, prisma, realtime, push, email };
}

describe('AdminService.updateKycStatus — notification de la décision (chantier #5A)', () => {
  it('VERIFIED → notif in-app KYC_VERIFIED + 2 SSE + push + e-mail', async () => {
    const { service, prisma, realtime, push, email } = harness();

    await service.updateKycStatus(TECHNICIAN_ID, REVIEWER_ID, { status: 'VERIFIED' } as never);

    /* ── Canal 1 : notification in-app persistée ── */
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    const notif = prisma.created[0]!;
    expect(notif).toMatchObject({
      userId: TECHNICIAN_ID,
      /* Une décision KYC ne concerne aucune mission : `demandeId` null, donc
       * l'app l'affiche À PLAT (jamais regroupée par mission). */
      demandeId: null,
      type: 'KYC_VERIFIED',
      title: 'Identité vérifiée',
      message: 'Vous pouvez maintenant accepter des missions.',
    });
    expect(notif.metadata).toMatchObject({ kycStatus: 'VERIFIED', kycAction: 'view_missions' });
    /* Un dossier validé n'a pas de motif : la clé ne doit pas exister. */
    expect(notif.metadata).not.toHaveProperty('kycRejectionReason');

    /* ── Canal 2 : SSE, deux événements sur le channel personnel ── */
    const publishes = (realtime.publishToUser as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(publishes).toHaveLength(2);
    expect(publishes[0]).toEqual([
      TECHNICIAN_ID,
      'notification.created',
      { notificationId: 'notif-1', kind: 'KYC_VERIFIED' },
    ]);
    expect(publishes[1]).toEqual([
      TECHNICIAN_ID,
      'technician.kyc_verified',
      { technicianId: TECHNICIAN_ID, kycStatus: 'VERIFIED', reason: null },
    ]);

    /* ── Canal 3 : push web ── */
    expect(push.sendToUser).toHaveBeenCalledTimes(1);
    expect(push.sendToUser).toHaveBeenCalledWith(TECHNICIAN_ID, {
      title: 'Identité vérifiée',
      body: 'Vous pouvez maintenant accepter des missions.',
      tag: `kyc-${TECHNICIAN_ID}`,
      url: '/technicien/demandes',
      type: 'kyc_verified',
    });

    /* ── Canal 4 : e-mail vers les missions ── */
    expect(email.sendKycVerifiedEmail).toHaveBeenCalledWith(
      'tech@relioo.space',
      'Awa',
      'https://app.relioo.space/technicien/demandes',
    );
    expect(email.sendKycRejectedEmail).not.toHaveBeenCalled();
  });

  it('REJECTED → notif KYC_REJECTED avec le motif dans le metadata, lien vers le KYC', async () => {
    const { service, prisma, realtime, push, email } = harness();

    await service.updateKycStatus(TECHNICIAN_ID, REVIEWER_ID, {
      status: 'REJECTED',
      reason: '  Photo floue  ',
    } as never);

    const notif = prisma.created[0]!;
    expect(notif).toMatchObject({
      userId: TECHNICIAN_ID,
      demandeId: null,
      type: 'KYC_REJECTED',
      title: 'Vérification à compléter',
      message: 'Votre dossier doit être corrigé pour être validé.',
    });
    /* Le motif est normalisé (trim) et voyage dans le metadata, PAS dans le
     * texte figé : l'app l'affiche séparément sans dupliquer la donnée. */
    expect(notif.metadata).toMatchObject({
      kycStatus: 'REJECTED',
      kycAction: 'fix_kyc',
      kycRejectionReason: 'Photo floue',
    });
    /* Le message reste générique : le motif ne doit pas y figurer en dur. */
    expect(notif.message).not.toContain('Photo floue');

    const publishes = (realtime.publishToUser as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(publishes).toHaveLength(2);
    expect(publishes[0]![1]).toBe('notification.created');
    expect(publishes[1]).toEqual([
      TECHNICIAN_ID,
      'technician.kyc_rejected',
      { technicianId: TECHNICIAN_ID, kycStatus: 'REJECTED', reason: 'Photo floue' },
    ]);

    expect(push.sendToUser).toHaveBeenCalledWith(
      TECHNICIAN_ID,
      expect.objectContaining({ url: '/technicien/kyc', type: 'kyc_rejected' }),
    );
    expect(email.sendKycRejectedEmail).toHaveBeenCalledWith(
      'tech@relioo.space',
      'Awa',
      'Photo floue',
      'https://app.relioo.space/technicien/kyc',
    );
    expect(email.sendKycVerifiedEmail).not.toHaveBeenCalled();
  });

  /* ── Isolation des canaux (propriété critique) ────────────────────────── */

  it('push en échec → la décision KYC reste enregistrée et l’admin reçoit son dossier', async () => {
    const push = {
      sendToUser: vi.fn(async () => {
        throw new Error('VAPID indisponible');
      }),
    };
    const { service, prisma, realtime, email } = harness({ push });

    const folder = await service.updateKycStatus(TECHNICIAN_ID, REVIEWER_ID, {
      status: 'VERIFIED',
    } as never);

    /* La décision est bien faite… */
    expect(prisma.technicianProfile.update).toHaveBeenCalledTimes(1);
    /* …et l'admin reçoit un dossier exploitable. */
    expect(folder.technician.kycStatus).toBe('VERIFIED');
    /* Les autres canaux ne sont pas affectés par l'échec du push. */
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(realtime.publishToUser).toHaveBeenCalledTimes(2);
    expect(email.sendKycVerifiedEmail).toHaveBeenCalledTimes(1);
  });

  it('e-mail en échec → la décision KYC reste enregistrée, les autres canaux partent', async () => {
    const email = {
      sendKycVerifiedEmail: vi.fn(async () => {
        throw new Error('Resend 500');
      }),
      sendKycRejectedEmail: vi.fn(async () => undefined),
    };
    const { service, prisma, realtime, push } = harness({ email });

    const folder = await service.updateKycStatus(TECHNICIAN_ID, REVIEWER_ID, {
      status: 'VERIFIED',
    } as never);

    expect(folder.technician.kycStatus).toBe('VERIFIED');
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(realtime.publishToUser).toHaveBeenCalledTimes(2);
    expect(push.sendToUser).toHaveBeenCalledTimes(1);
  });

  it('notification in-app en échec → SSE et push partent quand même', async () => {
    const prisma = prismaMock({
      onNotificationCreate: async () => {
        throw new Error('contrainte base');
      },
    });
    const { service, realtime, push, email } = harness({ prisma });

    await service.updateKycStatus(TECHNICIAN_ID, REVIEWER_ID, { status: 'VERIFIED' } as never);

    /* Sans identifiant de notification, on ne publie PAS de `notification.created`
     * (le frontend ne pourrait pas l'aliaser), mais le signal métier
     * `technician.kyc_verified` part bien. */
    const publishes = (realtime.publishToUser as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(publishes).toHaveLength(1);
    expect(publishes[0]![1]).toBe('technician.kyc_verified');
    expect(push.sendToUser).toHaveBeenCalledTimes(1);
    expect(email.sendKycVerifiedEmail).toHaveBeenCalledTimes(1);
  });

  it('SSE en échec → la décision et les autres canaux sont préservés', async () => {
    const realtime = {
      publishToUser: vi.fn(() => {
        throw new Error('hub indisponible');
      }),
    };
    const { service, prisma, push, email } = harness({ realtime });

    const folder = await service.updateKycStatus(TECHNICIAN_ID, REVIEWER_ID, {
      status: 'VERIFIED',
    } as never);

    expect(folder.technician.kycStatus).toBe('VERIFIED');
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(push.sendToUser).toHaveBeenCalledTimes(1);
    expect(email.sendKycVerifiedEmail).toHaveBeenCalledTimes(1);
  });

  /* ── Pas de doublon d'e-mail (A.6) ────────────────────────────────────── */

  it('un dossier déjà tranché est refusé (409) → aucun canal ne repart', async () => {
    const prisma = prismaMock();
    prisma.technicianProfile.findUnique = vi.fn(async () => ({
      ...pendingProfile({ kycStatus: 'VERIFIED' }),
      user: { email: 'tech@relioo.space', firstName: 'Awa' },
    })) as never;
    const { service, realtime, push, email } = harness({ prisma });

    await expect(
      service.updateKycStatus(TECHNICIAN_ID, REVIEWER_ID, { status: 'VERIFIED' } as never),
    ).rejects.toThrow(/plus en attente/i);

    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(realtime.publishToUser).not.toHaveBeenCalled();
    expect(push.sendToUser).not.toHaveBeenCalled();
    expect(email.sendKycVerifiedEmail).not.toHaveBeenCalled();
  });

  it('REJECTED sans motif → 400, aucun canal déclenché', async () => {
    const { service, prisma } = harness();

    await expect(
      service.updateKycStatus(TECHNICIAN_ID, REVIEWER_ID, { status: 'REJECTED' } as never),
    ).rejects.toThrow(/motif de rejet/i);

    expect(prisma.notification.create).not.toHaveBeenCalled();
  });
});