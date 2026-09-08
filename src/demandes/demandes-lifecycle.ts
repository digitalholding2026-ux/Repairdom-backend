import { BadRequestException } from '@nestjs/common';

export const DEMANDE_STATUSES = [
  'SUBMITTED',
  'PENDING',
  'ACCEPTED',
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'CONFIRMED',
  'CANCELED',
] as const;

export type DemandeLifecycleStatus = (typeof DEMANDE_STATUSES)[number];

const CLIENT_TRANSITIONS: Record<string, readonly string[]> = {
  SUBMITTED: ['CANCELED'],
  PENDING: ['CANCELED'],
  ACCEPTED: ['CANCELED'],
  SCHEDULED: ['CANCELED'],
  COMPLETED: ['CONFIRMED'],
};

const TECHNICIAN_TRANSITIONS: Record<string, readonly string[]> = {
  ACCEPTED: ['SCHEDULED'],
  SCHEDULED: ['IN_PROGRESS'],
  IN_PROGRESS: ['COMPLETED'],
};

export type LifecycleActor = 'CLIENT' | 'TECHNICIAN';

export function assertTransition(
  actor: LifecycleActor,
  currentStatus: string,
  requestedStatus: string,
  scheduledAt?: string | null,
): Date | null {
  const allowed = (actor === 'CLIENT' ? CLIENT_TRANSITIONS : TECHNICIAN_TRANSITIONS)[currentStatus];

  if (!allowed) {
    throw new BadRequestException(
      `Aucune transition n'est possible depuis le statut « ${currentStatus} ».`,
    );
  }
  if (!allowed.includes(requestedStatus)) {
    throw new BadRequestException(
      `La transition « ${currentStatus} » → « ${requestedStatus} » n'est pas autorisée.`,
    );
  }

  if (requestedStatus === 'SCHEDULED') {
    if (!scheduledAt) {
      throw new BadRequestException(
        'Une date d\'intervention (scheduledAt) est obligatoire pour planifier le rendez-vous.',
      );
    }
    const date = new Date(scheduledAt);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(
        'La date d\'intervention (scheduledAt) est invalide.',
      );
    }
    return date;
  }

  return null;
}