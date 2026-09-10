import { Prisma } from '../generated/prisma/client.js';

/* Sprint 8.3 — Préparation opérationnelle de la mission.
 * Helpers partagés d'enregistrement des événements métier (DemandeEvent) et
 * des notifications applicatives (Notification). Les événements sont créés
 * UNIQUEMENT côté backend, au cœur des transactions des services métier, et
 * ne sont jamais soumis par le frontend.
 */

export type Tx = Prisma.TransactionClient;

export type DemandeStatusLite =
  | 'SUBMITTED'
  | 'PENDING'
  | 'ACCEPTED'
  | 'SCHEDULED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CONFIRMED'
  | 'CANCELED';

export type DemandeEventType =
  | 'CREATED'
  | 'TECHNICIAN_ASSIGNED'
  | 'TECHNICIAN_ACCEPTED'
  | 'DIAGNOSTIC_SELECTED'
  | 'QUOTE_CREATED'
  | 'NEGOTIATION_REQUESTED'
  | 'QUOTE_ACCEPTED'
  | 'QUOTE_REJECTED'
  | 'SCHEDULED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CONFIRMED'
  | 'CANCELED';

export type NotificationType =
  | 'TECHNICIAN_ACCEPTED'
  | 'QUOTE_CREATED'
  | 'NEGOTIATION_REQUESTED'
  | 'QUOTE_ACCEPTED'
  | 'QUOTE_REJECTED'
  | 'SCHEDULED'
  | 'COMPLETED'
  | 'CONFIRMED';

export interface EventInput {
  demandeId: string;
  type: DemandeEventType;
  actorUserId?: string | null;
  fromStatus?: DemandeStatusLite | null;
  toStatus?: DemandeStatusLite | null;
  metadata?: Prisma.InputJsonObject | null;
}

export interface NotificationInput {
  userId: string;
  demandeId?: string | null;
  type: NotificationType;
  title: string;
  message: string;
}

export async function recordEvent(tx: Tx, input: EventInput) {
  await tx.demandeEvent.create({
    data: {
      demandeId: input.demandeId,
      actorUserId: input.actorUserId ?? null,
      type: input.type,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      metadata: input.metadata ?? Prisma.JsonNull,
    },
  });
}

export async function createNotification(tx: Tx, input: NotificationInput) {
  await tx.notification.create({
    data: {
      userId: input.userId,
      demandeId: input.demandeId ?? null,
      type: input.type,
      title: input.title,
      message: input.message,
    },
  });
}

/* Type d'événement dérivé d'une transition de statut (source de vérité :
 * demandes-lifecycle.assertTransition). Tous les statuts cibles possibles
 * disposent d'un événement dédié ; retourne null pour tout autre cas afin de
 * ne jamais enregistrer d'événement invalide. */
const STATUS_EVENT_TYPES: Record<string, DemandeEventType> = {
  SCHEDULED: 'SCHEDULED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CONFIRMED: 'CONFIRMED',
  CANCELED: 'CANCELED',
};

export function eventTypeForStatus(status: string): DemandeEventType | null {
  return STATUS_EVENT_TYPES[status] ?? null;
}

export function eventLabel(type: string): string {
  const labels: Record<string, string> = {
    CREATED: 'Demande envoyée',
    TECHNICIAN_ASSIGNED: 'Technicien assigné',
    TECHNICIAN_ACCEPTED: 'Mission acceptée par le technicien',
    DIAGNOSTIC_SELECTED: 'Diagnostic enregistré',
    QUOTE_CREATED: 'Tarif proposé',
    NEGOTIATION_REQUESTED: 'Négociation demandée',
    QUOTE_ACCEPTED: 'Tarif accepté',
    QUOTE_REJECTED: 'Tarif refusé',
    SCHEDULED: 'Rendez-vous planifié',
    IN_PROGRESS: 'Intervention en cours',
    COMPLETED: 'Intervention terminée',
    CONFIRMED: 'Mission confirmée',
    CANCELED: 'Mission annulée',
  };
  return labels[type] ?? type;
}

/* Sérialisation privée d'un événement : disponible uniquement aux acteurs
 * autorisés de la mission (client ou technicien assigné). Le nom de l'acteur
 * est exposé sans son identifiant (actorUserId jamais renvoyé). */
export function toApiEvent(event: {
  id: string;
  type: string;
  fromStatus: DemandeStatusLite | null;
  toStatus: DemandeStatusLite | null;
  createdAt: Date;
  actor: { firstName: string; lastName: string | null } | null;
}) {
  return {
    id: event.id,
    type: event.type,
    label: eventLabel(event.type),
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    createdAt: event.createdAt.toISOString(),
    actor: event.actor
      ? { firstName: event.actor.firstName, lastName: event.actor.lastName }
      : null,
  };
}

/* Contenu des notifications, déterminé côté backend uniquement. */
export function buildNotification(
  type: NotificationType,
  demandeId: string | null,
  userId: string,
  audience: 'CLIENT' | 'TECHNICIAN',
): NotificationInput {
  const content: Record<NotificationType, { title: string; message: string }> = {
    TECHNICIAN_ACCEPTED: {
      title: 'Mission acceptée',
      message: 'Un technicien a accepté votre demande de dépannage.',
    },
    QUOTE_CREATED: {
      title: 'Nouveau tarif',
      message: 'Votre technicien a proposé un tarif pour votre intervention.',
    },
    NEGOTIATION_REQUESTED: {
      title: 'Négociation demandée',
      message: 'Le client souhaite négocier le tarif de la mission.',
    },
    QUOTE_ACCEPTED: {
      title: 'Tarif accepté',
      message: 'Le client a accepté votre tarif. Vous pouvez planifier l’intervention.',
    },
    QUOTE_REJECTED: {
      title: 'Tarif refusé',
      message: 'Le client a refusé le tarif proposé. Vous pouvez proposer un nouveau tarif.',
    },
    SCHEDULED: {
      title: 'Rendez-vous planifié',
      message:
        audience === 'TECHNICIAN'
          ? 'Votre intervention est planifiée.'
          : 'L’intervention a été planifiée : consultez la date du rendez-vous.',
    },
    COMPLETED: {
      title: 'Intervention terminée',
      message:
        'Le technicien a terminé l’intervention. Confirmez la réalisation pour clôturer la mission.',
    },
    CONFIRMED: {
      title: 'Mission confirmée',
      message: 'Le client a confirmé la réalisation de la mission.',
    },
  };
  const { title, message } = content[type];
  return { userId, demandeId: demandeId ?? null, type, title, message };
}