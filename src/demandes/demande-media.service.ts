import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  SupabaseStorageService,
} from '../technician/supabase-storage.service.js';

/* Dépôt de panne multimédia — pièces jointes réelles (photos, vidéos,
 * vocaux). Fourni + exporté par `TechnicianModule` (à côté de
 * `SupabaseStorageService`) pour éviter tout cycle : `DemandesModule`
 * (client) et `TechnicianController` l'injectent sans dépendance croisée.
 *
 * Flux garantissant la visibilité immédiate (§10) :
 *   1. le client uploade chaque fichier AVANT création (`uploadMedia` →
 *      objet privé `demandes/{userId}/{uuid}-nom`, rien en base) ;
 *   2. `POST /demandes` lie les chemins en TRANSACTION avec la Demande
 *      (`stored: true`) : à la création, tout est déjà là ;
 *   3. lecture via URLs signées éphémères (15 min, jamais publiques),
 *      réservées au client propriétaire et au technicien assigné
 *      (`getMediaFileUrl`, 404 sinon — sans fuite d'existence).
 *
 * Aucune logique métier modifiée (dispatch, GPS, finances, KYC intacts).
 * Les octets ne transitent jamais par les logs (seuls tailles/mimes). */

export const DEMANDE_MEDIA_MAX_FILES = 5;
export const DEMANDE_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
/** Durée vocale maximale côté client (3 min) : le backend borne les octets
 *  (25 Mo), le frontend coupe l'enregistrement et l'affiche explicitement. */
export const DEMANDE_AUDIO_MAX_SECONDS = 180;

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_MIMES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const AUDIO_MIMES = new Set([
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/x-m4a',
]);

export type DemandeMediaKind = 'IMAGE' | 'VIDEO' | 'AUDIO';

export function kindForMimeType(mimeType: string): DemandeMediaKind | null {
  if (IMAGE_MIMES.has(mimeType)) return 'IMAGE';
  if (VIDEO_MIMES.has(mimeType)) return 'VIDEO';
  if (AUDIO_MIMES.has(mimeType)) return 'AUDIO';
  return null;
}

/** Formats acceptés affichés côté client (jamais inventés ailleurs). */
export function acceptedMimesDescription(): string {
  return 'JPG, PNG, WEBP, MP4, WEBM, MOV, WEBM/MP4/MP3/OGG/WAV audio';
}

function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'fichier';
  const clean = base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-');
  return clean.slice(0, 80) || 'fichier';
}

export interface UploadedDemandeMedia {
  storagePath: string;
  kind: DemandeMediaKind;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

@Injectable()
export class DemandeMediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
  ) {}

  /** Upload d'un fichier AVANT création de la Demande (aucune ligne créée ;
   * le chemin est lié en transaction à la création). */
  async uploadMedia(
    userId: string,
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number } | undefined,
    kind: string | undefined,
  ): Promise<UploadedDemandeMedia> {
    if (!file || file.size < 1) {
      throw new BadRequestException('Aucun fichier reçu.');
    }
    if (file.size > DEMANDE_MEDIA_MAX_BYTES) {
      throw new BadRequestException('Fichier trop volumineux (25 Mo maximum).');
    }
    const kindForMime = kindForMimeType(file.mimetype);
    if (!kindForMime) {
      throw new BadRequestException(
        `Format non supporté (${file.mimetype || 'inconnu'}). Formats acceptés : ${acceptedMimesDescription()}.`,
      );
    }
    if (kind !== undefined && kind !== kindForMime) {
      throw new BadRequestException('Le type déclaré ne correspond pas au fichier.');
    }
    const name = sanitizeFileName(file.originalname);
    const storagePath = `demandes/${userId}/${randomUUID()}-${name}`;
    await this.storage.uploadDemandeObject(storagePath, file.buffer, file.mimetype);
    return { storagePath, kind: kindForMime, name, mimeType: file.mimetype, sizeBytes: file.size };
  }

  /** Suppression best-effort d'un upload abandonné (le stockage tolère
   *  déjà l'absence ; préfixe propriétaire exigé). */
  async deleteUploadedMedia(userId: string, storagePath: string): Promise<void> {
    if (typeof storagePath !== 'string' || !storagePath.startsWith(`demandes/${userId}/`)) {
      throw new BadRequestException('Chemin de fichier invalide.');
    }
    await this.storage.deleteDemandeObject(storagePath);
  }

  /* Note vocale du diagnostic libre : même bucket privé, mêmes
   * garanties (upload AVANT création, URLs signées, aucun accès tiers).
   * Préfixe `diagnostics/{userId}/…` (jamais de stockage parallèle). */

  /** Upload d'une note vocale AVANT création du diagnostic (aucune ligne). */
  async uploadDiagnosticAudio(
    userId: string,
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number } | undefined,
  ): Promise<UploadedDemandeMedia> {
    if (!file || file.size < 1) {
      throw new BadRequestException('Aucun fichier reçu.');
    }
    if (file.size > DEMANDE_MEDIA_MAX_BYTES) {
      throw new BadRequestException('Fichier trop volumineux (25 Mo maximum).');
    }
    if (!kindForMimeType(file.mimetype) || kindForMimeType(file.mimetype) !== 'AUDIO') {
      throw new BadRequestException(
        `Format audio non supporté (${file.mimetype || 'inconnu'}). Formats acceptés : WEBM, MP4, MP3, OGG, WAV.`,
      );
    }
    const name = sanitizeFileName(file.originalname).replace(/\.[a-zA-Z0-9]{1,5}$/, '') || 'note-vocale';
    const ext = file.mimetype.includes('mp4') || file.mimetype.includes('m4a') ? 'm4a' : 'webm';
    const storagePath = `diagnostics/${userId}/${randomUUID()}-${name}.${ext}`;
    await this.storage.uploadDemandeObject(storagePath, file.buffer, file.mimetype);
    return { storagePath, kind: 'AUDIO', name: `${name}.${ext}`, mimeType: file.mimetype, sizeBytes: file.size };
  }

  /** Suppression best-effort d'une note vocale abandonnée. */
  async deleteDiagnosticAudio(userId: string, storagePath: string): Promise<void> {
    if (typeof storagePath !== 'string' || !storagePath.startsWith(`diagnostics/${userId}/`)) {
      throw new BadRequestException('Chemin de fichier invalide.');
    }
    await this.storage.deleteDemandeObject(storagePath);
  }

  /** URL signée éphémère d'écoute (technicien assigné ou client
   *  propriétaire, 404 sinon — sans révéler l'existence). */
  async getDiagnosticAudioUrl(actor: { userId: string; role: string }, demandeId: string, diagnosticId: string): Promise<string> {
    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      select: { id: true, clientId: true, technicianId: true },
    });
    if (!demande) throw new NotFoundException('Fichier introuvable.');
    const allowed =
      (actor.role === 'CLIENT' && demande.clientId === actor.userId) ||
      (actor.role === 'TECHNICIAN' && demande.technicianId === actor.userId);
    if (!allowed) throw new NotFoundException('Fichier introuvable.');
    const diagnostic = await this.prisma.diagnostic.findFirst({
      where: { id: diagnosticId, demandeId: demande.id },
    });
    if (!diagnostic || !diagnostic.audioStoragePath) throw new NotFoundException('Fichier introuvable.');
    return this.storage.createDemandeSignedUrl(diagnostic.audioStoragePath);
  }

  /** URL signée éphémère de lecture (client propriétaire ou technicien
   *  assigné uniquement, 404 sinon — sans révéler l'existence). */
  async getMediaFileUrl(actor: { userId: string; role: string }, demandeId: string, mediaId: string): Promise<string> {
    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      select: { id: true, status: true, clientId: true, technicianId: true },
    });
    if (!demande) throw new NotFoundException('Fichier introuvable.');
    const allowed =
      (actor.role === 'CLIENT' && demande.clientId === actor.userId) ||
      (actor.role === 'TECHNICIAN' && demande.technicianId === actor.userId) ||
      // Mission ouverte non assignée : le technicien peut écouter/voir les
      // médias AVANT d'accepter (détail d'opportunité éligible). Les IDs
      // étant des UUID imprévisibles, aucune énumération n'est possible ;
      // adresse/téléphone/GPS restent masqués par la vue publique.
      (actor.role === 'TECHNICIAN' &&
        demande.technicianId === null &&
        (demande.status === 'SUBMITTED' || demande.status === 'PENDING'));
    if (!allowed) throw new NotFoundException('Fichier introuvable.');
    const media = await this.prisma.demandeMedia.findFirst({
      where: { id: mediaId, demandeId: demande.id },
    });
    if (!media || !media.storagePath) throw new NotFoundException('Fichier introuvable.');
    return this.storage.createDemandeSignedUrl(media.storagePath);
  }
}
