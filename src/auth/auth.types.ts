export type UserRole = 'CLIENT' | 'TECHNICIAN' | 'ADMIN';

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
}

export interface RequestUser {
  id: string;
  email: string;
  role: UserRole;
}

export const COOKIE_NAME = 'repairdom_token';
export const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;