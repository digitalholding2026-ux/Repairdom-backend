import { IsIn } from 'class-validator';

/* Statuts V2 du workflow admin — mappés vers l'enum Prisma DemandeStatus :
 * RECEIVED → SUBMITTED, IN_PROGRESS → IN_PROGRESS,
 * COMPLETED → COMPLETED, CANCELLED → CANCELED. */
export const ADMIN_DEMANDE_STATUSES = [
  'RECEIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;

export type AdminDemandeStatus = (typeof ADMIN_DEMANDE_STATUSES)[number];

/* Mapping V2 → Prisma enum pour la persistance. */
export const V2_TO_DEMANDE_STATUS: Record<AdminDemandeStatus, string> = {
  RECEIVED: 'SUBMITTED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELED',
};

/* Mapping inverse pour la lecture frontend. */
export const DEMANDE_STATUS_TO_V2: Record<string, AdminDemandeStatus | null> = {
  SUBMITTED: 'RECEIVED',
  PENDING: 'RECEIVED',
  ACCEPTED: 'RECEIVED',
  SCHEDULED: 'RECEIVED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CONFIRMED: 'COMPLETED',
  CANCELED: 'CANCELLED',
};

/* Mapping V2 → DemandeEventType pour l'historique. */
export const V2_TO_EVENT_TYPE: Record<AdminDemandeStatus, string> = {
  RECEIVED: 'CREATED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELED',
};

export class UpdateAdminDemandeStatusDto {
  @IsIn(ADMIN_DEMANDE_STATUSES)
  status: AdminDemandeStatus;
}
