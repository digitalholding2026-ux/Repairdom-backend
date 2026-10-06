/* SOCLE TEMPS RÉEL (SSE, serveur → client uniquement).
 *
 * Types partagés du hub : channels adressables + événements métier.
 * Les montants restent en XAF entiers côté serveur (le formatage FCFA est
 * une responsabilité frontend). Aucun contenu sensible dans les logs. */

export type RealtimeEventType =
  // Mission — généraux
  | 'mission.status_changed'
  | 'mission.technician_en_route'
  | 'mission.technician_arrived'
  // Mission — chat
  | 'mission.message_created'
  // Mission — GPS
  | 'mission.technician_position'
  // Demandes technicien
  | 'technician.new_mission_available'
  | 'technician.mission_taken'
  // Chantier #5A : décision KYC prise par un admin, émise sur le channel
  // personnel du technicien (`user:<id>`). Permet à l'UI de rafraîchir son
  // statut KYC sans rechargement de page.
  | 'technician.kyc_verified'
  | 'technician.kyc_rejected'
  // Devis
  | 'mission.quote_created'
  | 'mission.quote_accepted'
  | 'mission.quote_rejected'
  | 'mission.negotiation_requested'
  // Notifications
  | 'notification.created'
  // Chantier #4A : la progression du programme de récompenses a changé
  // (palier franchi, mission validée ou écartée par un admin). Permet à
  // `/client/recompenses` de se rafraîchir sans rechargement de page.
  | 'client.rewards_updated';

export interface RealtimeEvent {
  type: RealtimeEventType;
  channel: string;
  payload: Record<string, unknown>;
  /** Horodatage d'émission ISO (le backend garde l'historique : en cas de
   *  reconnexion, le client refait un fetch et ne perd aucun message). */
  emittedAt: string;
}

/** Channel des événements personnels d'un utilisateur (notifications). */
export function userChannel(userId: string): string {
  return `user:${userId}`;
}

/** Channel des événements d'une mission (chat, statuts, GPS technicien). */
export function missionChannel(demandeId: string): string {
  return `mission:${demandeId}`;
}

/** Channel de diffusion des missions disponibles (techniciens uniquement). */
export const TECHNICIAN_AVAILABLE_CHANNEL = 'technician:available';
