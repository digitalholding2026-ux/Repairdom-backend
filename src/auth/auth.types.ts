export type UserRole = 'CLIENT' | 'ADMIN';

/** M1 — nature commerciale du compte (tarif public vs tarif professionnel). */
export type UserClientType = 'CLIENT' | 'B2B';

export interface AuthUser {
  id: string;
  role: UserRole;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  email: string;
  emailVerified: boolean;
  avatarUrl: string | null;
  city: string | null;
  address: string | null;
  whatsapp: string | null;
  createdAt: Date;
  /** Version de session (reset password) : comparée au payload JWT. */
  tokenVersion: number;
}

export interface RequestUser {
  id: string;
  email: string;
  role: UserRole;
  /** M1 — tarif applicable (lu en base à chaque requête, jamais depuis le payload). */
  clientType: UserClientType;
  /** Version de session portée par le JWT vérifié. */
  tokenVersion: number;
}

export const COOKIE_NAME = 'repairdom_token';
export const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;