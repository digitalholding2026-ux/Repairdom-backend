import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { NotificationMetadata } from './notification-metadata.js';

/* Chantier #2D — Notifications applicatives. Les notifications sont créées
 * uniquement par le backend (au cœur des transactions métier) : ce service
 * expose les listes et la lecture à l'utilisateur connecté, jamais d'écriture.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async listMine(userId: string) {
    const [items, unreadCount, total] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        /* `demande.reference` est inclus pour que le frontend puisse
         * regrouper les notifications par mission et afficher « Mission #RD-… »
         * SANS N+1. `demandeId` est `SetNull` à la suppression : la référence
         * devient alors `null` et le repli côté UI s'applique. */
        include: { demande: { select: { reference: true } } },
      }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
      this.prisma.notification.count({ where: { userId } }),
    ]);

    return {
      total,
      unreadCount,
      items: items.map((notification) => ({
        id: notification.id,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        demandeId: notification.demandeId,
        /* Référence de mission (null si la mission a été supprimée, ou si la
         * notification n'est rattachée à aucune mission : ADMIN_MESSAGE).
         * Évite au frontend un N+1 pour le regroupement par mission. */
        reference: notification.demande?.reference ?? null,
        /* Données structurées (montants XAF ENTIERS, ids cibles). `null` =
         * notification sans donnée structurée (créée avant le chantier, ou
         * type sans donnée applicable). Le frontend formate les montants. */
        metadata: toNotificationMetadata(notification.metadata),
        read: notification.readAt !== null,
        createdAt: notification.createdAt.toISOString(),
      })),
    };
  }

  async unreadCount(userId: string) {
    const unreadCount = await this.prisma.notification.count({
      where: { userId, readAt: null },
    });
    return { unreadCount };
  }

  async markRead(userId: string, id: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id, userId },
    });
    if (!notification) throw new NotFoundException('Notification introuvable.');
    if (notification.readAt) return { id, read: true };

    await this.prisma.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });
    return { id, read: true };
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }
}

/**
 * Normalise la colonne JSONB en objet stable.
 *
 * Une notification créée AVANT la migration a `metadata = null`. Une valeur
 * JSON invalide stockée à la main ne doit pas faire exploser la sérialisation
 * de TOUTES les notifications : on retombe sur `null`.
 */
function toNotificationMetadata(
  value: Prisma.JsonValue | null,
): NotificationMetadata | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as NotificationMetadata;
}