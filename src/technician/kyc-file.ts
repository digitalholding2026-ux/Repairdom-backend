import { isImageBuffer } from './avatar-file.js';

export const ALLOWED_KYC_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

/** Taille maximale acceptée pour un document KYC : 10 Mo. */
export const MAX_KYC_DOCUMENT_SIZE = 10 * 1024 * 1024;

export const KYC_EXTENSION_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const ALLOWED_KYC_DOCUMENT_TYPES = ['IDENTITY', 'PROFESSIONAL'] as const;

export function isAllowedKycMimetype(value: string): boolean {
  return ALLOWED_KYC_MIME_TYPES.includes(value as (typeof ALLOWED_KYC_MIME_TYPES)[number]);
}

export function isAllowedKycDocumentType(value: string): boolean {
  return ALLOWED_KYC_DOCUMENT_TYPES.includes(
    value as (typeof ALLOWED_KYC_DOCUMENT_TYPES)[number],
  );
}

export function isPdfBuffer(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.toString('latin1', 0, 4) === '%PDF';
}

/** Vérifie que le contenu correspond à un PDF ou à une image JPG/PNG/WEBP. */
export function isKycDocumentBuffer(buffer: Buffer): boolean {
  return isPdfBuffer(buffer) || isImageBuffer(buffer);
}

export interface UploadedKycFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}