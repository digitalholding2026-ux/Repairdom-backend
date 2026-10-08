import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RealtimeService } from '../realtime/realtime.service.js';
import type { PushService } from '../push/push.service.js';
import type { EmailService } from '../auth/email.service.js';
import { AdminService } from './admin.service.js';

/* Chantier 4-FONDATIONS-A — endpoint admin de notification du nouveau barème.
 *
 * Ce que ces tests verrouillent :
 *  1. SÉLECTION — seuls les techniciens ACTIFS sont visés (le `where` du double
 *     applique réellement role + isActive, pas seulement sa forme) ;
 *  2. CANAUX — in-app persistée + SSE + push + e-mail, comme la décision KYC ;
 *  3. ISOLATION — un échec (e-mail, SSE, push ou écriture in-app) n'empêche NI
 *     les autres canaux NI les techniciens suivants ;
 *  4. PAS D'AUTOMATISME — la méthode ne fait QUE notifier : elle ne modifie
 *     aucun tarif, aucun devis, aucun Pricing.
 *
 * Prisma / Resend / web-push entièrement mockés : aucune infrastructure.
 */

type Row = Record<string, any>;

/* `role` / `isActive` sont présents dès les fixtures : le double `findMany`
 * filtre POUR DE VRAI, donc une fixture sans ces champs serait simplement
 * ignorée (et le test passerait à vide). */
const TECH_1: Row = { id: 't-1', firstName: 'Awa', email: 'awa@example.cm', role: 'TECHNICIAN', isActive: true };
const TECH_2: Row = { id: 't-2', firstName: 'Bertrand', email: 'bertrand@example.cm', role: 'TECHNICIAN', isActive: true };

/** Double fidèle : `findMany` filtre pour de vrai sur role + isActive. */
function prismaMock(technicians: Row[]) {
  const notifications: Row[] = [];
  const prisma = {
    user: {
      findMany: vi.fn(async ({ where }: any) =>
        technicians
          .filter(
            (t) =>
              (where.role === undefined || t.role === where.role) &&
              (where.isActive === undefined || t.isActive === where.isActive),
          )
          .map((t) => ({ ...t })),
      ),
    },
    notification: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `n-${notifications.length + 1}`, readAt: null, ...data };
        notifications.push(row);
        return row;
      }),
    },
  };
  return { prisma, notifications };
}

function harness(options: {
  technicians?: Row[];
  prisma?: ReturnType<typeof prismaMock>;
  email?: Partial<EmailService>;
  push?: Partial<PushService>;
  realtime?: Partial<RealtimeService>;
  notificationCreateFails?: boolean;
} = {}) {
  const mock = options.prisma ?? prismaMock(options.technicians ?? [TECH_1, TECH_2]);
  if (options.notificationCreateFails) {
    mock.prisma.notification.create = vi.fn(async () => {
      throw new Error('in-app indisponible');
    }) as never;
  }
  const realtime = {
    publishToUser: vi.fn(),
    ...options.realtime,
  } as unknown as RealtimeService;
  const push = {
    sendToUser: vi.fn(async () => ({ sent: 1, skipped: null, failed: 0 })),
    ...options.push,
  } as unknown as PushService;
  const email = {
    sendFeeChangeEmail: vi.fn(async () => undefined),
    ...options.email,
  } as unknown as EmailService;
  const config = {
    get: vi.fn((key: string) => (key === 'FRONTEND_URL' ? 'https://app.relioo.space' : undefined)),
  } as unknown as ConfigService;

  const service = new AdminService(
    mock.prisma as unknown as PrismaService,
    {} as never,
    realtime,
    push,
    email,
    config,
  );
  return { service, prisma: mock.prisma, notifications: mock.notifications, realtime, push, email };
}

describe('notifyTechniciansFeeChange — sélection des destinataires', () => {
  it('interroge les techniciens actifs et notifie chacun sur 4 canaux', async () => {
    const { service, prisma, notifications, realtime, push, email } = harness();

    const result = await service.notifyTechniciansFeeChange();

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { role: 'TECHNICIAN', isActive: true } }),
    );
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(2);

    // Canal 1 : une notification in-app persistée par technicien, type
    // ADMIN_MESSAGE (déjà supporté, aucune migration).
    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toMatchObject({
      userId: 't-1',
      type: 'ADMIN_MESSAGE',
      demandeId: null,
    });
    // Règle FCFA : le barème est en toutes lettres, aucun montant formaté.
    expect(String(notifications[0].message)).toContain('500 FCFA + 4 %');
    expect(String(notifications[0].message)).toContain('5 000 FCFA');
    expect(notifications[0].metadata ?? null).toBeNull();

    // Canal 2 : SSE (notification.created + technician.fee_changed).
    expect(realtime.publishToUser).toHaveBeenCalledTimes(4);
    expect(realtime.publishToUser).toHaveBeenCalledWith('t-1', 'notification.created', {
      notificationId: expect.any(String),
      kind: 'ADMIN_MESSAGE',
    });
    expect(realtime.publishToUser).toHaveBeenCalledWith('t-2', 'technician.fee_changed', {
      technicianId: 't-2',
    });

    // Canal 3 : push, URL vers les missions.
    expect(push.sendToUser).toHaveBeenCalledTimes(2);
    expect(push.sendToUser).toHaveBeenCalledWith(
      't-1',
      expect.objectContaining({ url: '/technicien/demandes', type: 'fee_change' }),
    );

    // Canal 4 : e-mail, avec le lien applicatif et le prénom.
    expect(email.sendFeeChangeEmail).toHaveBeenCalledTimes(2);
    expect(email.sendFeeChangeEmail).toHaveBeenCalledWith(
      'awa@example.cm',
      'Awa',
      'https://app.relioo.space/technicien/demandes',
    );
  });

  it('un technicien désactivé n\'est jamais notifié', async () => {
    const { service, notifications, email } = harness({
      technicians: [
        TECH_1,
        { id: 't-3', firstName: 'Dormant', email: 'dormant@example.cm', role: 'TECHNICIAN', isActive: false },
      ],
    });

    const result = await service.notifyTechniciansFeeChange();

    expect(result.total).toBe(1);
    expect(result.sent).toBe(1);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].userId).toBe('t-1');
    expect(email.sendFeeChangeEmail).toHaveBeenCalledTimes(1);
  });

  it('aucun technicien actif → total 0, aucun appel sortant', async () => {
    const { service, notifications, realtime, push, email } = harness({ technicians: [] });

    const result = await service.notifyTechniciansFeeChange();

    expect(result).toMatchObject({ sent: 0, failed: 0, total: 0 });
    expect(notifications).toHaveLength(0);
    expect(realtime.publishToUser).not.toHaveBeenCalled();
    expect(push.sendToUser).not.toHaveBeenCalled();
    expect(email.sendFeeChangeEmail).not.toHaveBeenCalled();
  });

  it('la route est une action manuelle : aucun tarif ni devis n\'est modifié', async () => {
    const { service, prisma } = harness();

    await service.notifyTechniciansFeeChange();

    // Le double n'expose QUE `user.findMany` et `notification.create` : si la
    // méthode écrivait ailleurs (pricing, quote, compte), le test échouerait.
    expect(Object.keys(prisma).sort()).toEqual(['notification', 'user']);
  });

  it('le compte rendu expose le barème annoncé', async () => {
    const { service } = harness({ technicians: [TECH_1] });
    const result = await service.notifyTechniciansFeeChange();
    expect(result.rule).toEqual({
      commission: '500 FCFA + 4 % du montant du devis',
      minimumQuote: '5 000 FCFA',
    });
  });
});

describe('notifyTechniciansFeeChange — isolation des échecs', () => {
  it('un e-mail en échec ne bloque ni l\'in-app ni les autres techniciens', async () => {
    const { service, notifications, push, email } = harness({
      email: {
        sendFeeChangeEmail: vi.fn(async (to: string) => {
          if (to === 'awa@example.cm') throw new Error('Resend 500');
          return undefined;
        }),
      } as never,
    });

    const result = await service.notifyTechniciansFeeChange();

    // Les deux notifications in-app existent : l'échec e-mail n'a rien annulé.
    expect(notifications).toHaveLength(2);
    // Le push est parti pour les DEUX (canal indépendant).
    expect(push.sendToUser).toHaveBeenCalledTimes(2);
    // L'e-mail a été tenté pour les deux : l'échec du premier n'a pas court-
    // circuité le second.
    expect(email.sendFeeChangeEmail).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ sent: 1, failed: 1, total: 2 });
    expect(result.failedChannels).toEqual({ email: 1 });
  });

  it('une écriture in-app en échec est isolée (SSE + push + e-mail restent)', async () => {
    const { service, realtime, push, email } = harness({ notificationCreateFails: true });

    const result = await service.notifyTechniciansFeeChange();

    // Sans identifiant de notification, on ne publie PAS de `notification.created`.
    const types = (realtime.publishToUser as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[1],
    );
    expect(types).not.toContain('notification.created');
    expect(types.filter((t: string) => t === 'technician.fee_changed')).toHaveLength(2);
    expect(push.sendToUser).toHaveBeenCalledTimes(2);
    expect(email.sendFeeChangeEmail).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ sent: 0, failed: 2, total: 2 });
    expect(result.failedChannels).toEqual({ notification: 2 });
  });

  it('un push en échec ne bloque pas l\'e-mail', async () => {
    const { service, email } = harness({
      push: {
        sendToUser: vi.fn(async () => {
          throw new Error('push indisponible');
        }),
      } as never,
    });

    const result = await service.notifyTechniciansFeeChange();

    expect(email.sendFeeChangeEmail).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ sent: 0, failed: 2 });
    expect(result.failedChannels).toEqual({ push: 2 });
  });

  it('le compte rendu distingue « partially sent » d\'« échec total »', async () => {
    const { service } = harness({
      technicians: [TECH_1, TECH_2],
      email: {
        sendFeeChangeEmail: vi.fn(async () => {
          throw new Error('Resend 500');
        }),
      } as never,
    });

    const result = await service.notifyTechniciansFeeChange();

    // 2 envoyés sur les 3 canaux, 0 « entièrement » réussi → `sent` compte les
    // techniciens dont AUCUN canal n'a échoué.
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.failedChannels).toEqual({ email: 2 });
  });
});

/* Le contrôleur est protégé par `@UseGuards(JwtAuthGuard, RolesGuard)` +
 * `@Roles('ADMIN')` au niveau de la CLASSE `AdminController` : la route
 * `/admin/notify-technicians/fee-change` en hérite. Ce test verrouille qu'elle
 * reste déclarée dans ce contrôleur (et pas ailleurs, hors du mur de rôles). */
describe('AdminController — la route est bien sous le mur ADMIN', () => {
  it('POST notify-technicians/fee-change est déclaré dans AdminController', async () => {
    const { AdminController: Controller } = await import('./admin.controller.js');
    const handlerNames = Object.getOwnPropertyNames(
      Controller.prototype as unknown as object,
    ).filter((name) => name !== 'constructor');
    expect(handlerNames).toContain('notifyTechniciansFeeChange');
  });
});