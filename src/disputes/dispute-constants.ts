/* Contestation / litige — constantes partagées (jamais de logique ici). */

export const DISPUTE_CATEGORIES = ['QUALITY', 'INCOMPLETE', 'PRICING', 'BEHAVIOR', 'OTHER'] as const;
export type DisputeCategory = (typeof DISPUTE_CATEGORIES)[number];

export const DISPUTE_OPEN_STATUSES = ['OPEN', 'UNDER_REVIEW'] as const;

export const DISPUTE_DESCRIPTION_MIN = 10;
export const DISPUTE_DESCRIPTION_MAX = 2000;
export const DISPUTE_RESOLUTION_MAX = 2000;
