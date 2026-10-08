import { Prisma } from '../generated/prisma/client.js';
import {
  buildNotificationMetadata,
  type NotificationMetadataInput,
} from '../notifications/notification-metadata.js';

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
  | 'MANUAL_DIAGNOSTIC_DECLARED'
  | 'QUOTE_CREATED'
  | 'NEGOTIATION_REQUESTED'
  | 'QUOTE_ACCEPTED'
  | 'QUOTE_REJECTED'
  | 'SCHEDULED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CONFIRMED'
  | 'CANCELED'
  // Sprint DISPATCH-V1 : vague de dispatch notifiée.
  | 'DISPATCH_WAVE'
  // GPS V3 : déplacement temporaire (aucun changement de statut).
  | 'TECHNICIAN_EN_ROUTE'
  | 'TECHNICIAN_ARRIVED'
  // Litige : ouverture / clôture administrative (sans changement de statut).
  | 'DISPUTE_OPENED'
  | 'DISPUTE_RESOLVED';

export type NotificationType =
  | 'TECHNICIAN_ACCEPTED'
  | 'QUOTE_CREATED'
  | 'NEGOTIATION_REQUESTED'
  | 'QUOTE_ACCEPTED'
  | 'QUOTE_REJECTED'
  | 'SCHEDULED'
  | 'COMPLETED'
  | 'CONFIRMED'
  | 'MISSION_AVAILABLE'
  // GPS V3 : notifiée au client de la mission uniquement.
  | 'TECHNICIAN_EN_ROUTE'
  // Litige : ouverture (admin + technicien) / décision (client + technicien).
  | 'DISPUTE_OPENED'
  | 'DISPUTE_RESOLVED'
  // Chantier #5A : décision KYC — notifiée au technicien concerné uniquement.
  | 'KYC_VERIFIED'
  | 'KYC_REJECTED'
  // Chantier #4A : récompenses client — palier franchi (client) et mission
  // écartée après décision anti-fraude (client).
  | 'REWARD_TIER_REACHED'
  | 'REWARD_MISSION_NOT_COUNTED'
  // Chantier 4-FONDATIONS-C : refonte LTV. Ces deux valeurs MANQUAIENT à ce
  // type local alors qu'elles existent dans l'enum Prisma — la dérive signalée
  // à l'audit du 08/10 est ici corrigée : sans elles, le backend ne pouvait pas
  // créer ces notifications (erreur de compilation, pas un bug silencieux).
  | 'REWARD_CREDIT_EARNED'
  | 'REWARD_NATURE_REACHED';

export interface EventInput {
  demandeId: string;
  type: DemandeEventType;
  actorUserId?: string | null;
  fromStatus?: DemandeStatusLite | null;
  toStatus?: DemandeStatusLite | null;
  metadata?: Prisma.InputJsonObject | null;
}

/** Métadonnées structurées d'une notification (montants XAF entiers, ids).
 *  Voir `notifications/notification-metadata.ts` pour le contrat complet. */
export interface NotificationInput {
  userId: string;
  demandeId?: string | null;
  type: NotificationType;
  title: string;
  message: string;
  /* `NotificationMetadataInput` (et non `NotificationMetadata`) : une clé
   * présente mais inapplicable s'écrit `null`, pas `undefined`. */
  metadata?: NotificationMetadataInput | null;
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
  /* POINT DE PASSAGE UNIQUE des métadonnées (chantier #2D).
   *
   * 14 des 16 sites de création passent par cette fonction : le `metadata` y
   * est donc garanti conforme au contrat, quel que soit le site appelant.
   * Les deux sites restants (fan-out admin des litiges, ADMIN_MESSAGE) écrivent
   * en direct et appellent `buildNotificationMetadata` explicitement.
   *
   * La notification créée est RETOURNÉE (chantier #4A) : les diffuseurs qui
   * doivent ensuite émettre un SSE `notification.created` ont besoin de son id.
   * Aucun appelant antérieur n'utilisait la valeur de retour (il n'y en avait
   * pas) : le changement est rétro-compatible. */
  const metadata = buildNotificationMetadata(input.metadata);
  return tx.notification.create({
    data: {
      userId: input.userId,
      demandeId: input.demandeId ?? null,
      type: input.type,
      title: input.title,
      message: input.message,
      ...(metadata ? { metadata } : {}),
    },
    select: { id: true },
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
    MANUAL_DIAGNOSTIC_DECLARED: 'Diagnostic non référencé déclaré',
    QUOTE_CREATED: 'Tarif proposé',
    NEGOTIATION_REQUESTED: 'Négociation demandée',
    QUOTE_ACCEPTED: 'Tarif accepté',
    QUOTE_REJECTED: 'Tarif refusé',
    SCHEDULED: 'Rendez-vous planifié',
    IN_PROGRESS: 'Intervention en cours',
    COMPLETED: 'Intervention terminée',
    CONFIRMED: 'Mission confirmée',
    CANCELED: 'Mission annulée',
    DISPATCH_WAVE: 'Vague de dispatch envoyée',
    TECHNICIAN_EN_ROUTE: 'Technicien en route',
    TECHNICIAN_ARRIVED: 'Technicien arrivé',
    DISPUTE_OPENED: 'Litige ouvert',
    DISPUTE_RESOLVED: 'Litige clôturé par l’administration',
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
    MISSION_AVAILABLE: {
      title: 'Nouvelle mission disponible',
      message:
        audience === 'TECHNICIAN'
          ? 'Une intervention correspondant à votre zone est disponible. Consultez les détails pour accepter la mission.'
          : 'Une nouvelle mission est disponible.',
    },
    TECHNICIAN_EN_ROUTE: {
      title: 'Technicien en route',
      message: 'Le technicien est en route vers votre intervention.',
    },
    DISPUTE_OPENED: {
      title: 'Litige ouvert',
      message:
        audience === 'TECHNICIAN'
          ? 'Le client a ouvert un litige sur une mission terminée. Consultez le dossier.'
          : 'Un litige a été ouvert sur cette mission. L’administration va l’examiner.',
    },
    DISPUTE_RESOLVED: {
      title: 'Litige clôturé',
      message: 'L’administration a tranché le litige. Consultez la décision sur le dossier.',
    },
    // Chantier #5A. Le `message` reste volontairement SANS le motif : celui-ci
    // voyage dans `metadata.kycRejectionReason` (jamais dans un texte figé),
    // ce qui permet à l'app de l'afficher séparément sans dupliquer la donnée.
    KYC_VERIFIED: {
      title: 'Identité vérifiée',
      message: 'Vous pouvez maintenant accepter des missions.',
    },
    KYC_REJECTED: {
      title: 'Vérification à compléter',
      message: 'Votre dossier doit être corrigé pour être validé.',
    },
    // Chantier #4A. `message` reste SANS MONTANT : la valeur de la récompense
    // voyage en `metadata.rewardValueXAF` (XAF entier) et le libellé du
    // palier en `metadata.rewardLabel`, que l'app affiche via `formatFCFA`.
    REWARD_TIER_REACHED: {
      title: 'Palier de récompenses atteint',
      message: 'Vous avez débloqué une nouvelle récompense Relio.',
    },
    REWARD_MISSION_NOT_COUNTED: {
      title: 'Mission non comptabilisée',
      message: 'Cette mission n’a pas été retenue dans votre programme de récompenses.',
    },
    /* Chantier 4-FONDATIONS-C — libellés par défaut. Les titres et messages
     * RÉELS sont fournis par `RewardsNotificationsService` (qui construit la
     * notification directement) ; ces entrées servent aux appels de
     * `buildNotification` générique. AUCUN montant : règle FCFA. */
    REWARD_CREDIT_EARNED: {
      title: 'De nouveaux crédits de fidélité',
      message: 'Des crédits vous attendent sur votre programme de fidélité.',
    },
    REWARD_NATURE_REACHED: {
      title: 'Récompense débloquée',
      message: 'Une nouvelle récompense est disponible dans votre programme de fidélité.',
    },
  };
  const { title, message } = content[type];
  return { userId, demandeId: demandeId ?? null, type, title, message };
}