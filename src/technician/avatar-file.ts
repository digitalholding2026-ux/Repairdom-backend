export const ALLOWED_AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Taille maximale acceptée pour une photo de profil : 5 Mo. */
export const MAX_AVATAR_SIZE = 5 * 1024 * 1024;

export const AVATAR_EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function isAllowedAvatarMimetype(value: string): boolean {
  return ALLOWED_AVATAR_MIME_TYPES.includes(value as (typeof ALLOWED_AVATAR_MIME_TYPES)[number]);
}

export function isJpegBuffer(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

export function isPngBuffer(buffer: Buffer): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return buffer.length >= signature.length && signature.every((byte, index) => buffer[index] === byte);
}

export function isWebpBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.toString('latin1', 0, 4) === 'RIFF' &&
    buffer.toString('latin1', 8, 12) === 'WEBP'
  );
}

/** Vérifie que le contenu du fichier correspond bien à une image JPG, PNG ou WEBP. */
export function isImageBuffer(buffer: Buffer): boolean {
  return isJpegBuffer(buffer) || isPngBuffer(buffer) || isWebpBuffer(buffer);
}

export interface UploadedAvatarFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}