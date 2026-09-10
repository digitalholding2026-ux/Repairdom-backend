import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/* Sprint 8.3 — Notifications applicatives. Les notifications sont créées
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