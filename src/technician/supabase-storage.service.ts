import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Bucket public dédié aux photos de profil. */
export const AVATAR_BUCKET = 'repairdom-profile-images';

/** Bucket PRIVÉ dédié aux documents KYC. Jamais exposé via une URL publique :
 * les documents restent uniquement accessibles côté backend (service role). */
export const KYC_BUCKET = 'repairdom-kyc-documents';

/* Délais d’attente explicites : sans eux, un hang réseau (DNS qui ne répond
 * pas, connexion gelée) pend indéfiniment jusqu’au timeout Railway. Avec eux,
 * l’échec devient un timeout identifiable dans les logs. */
const UPLOAD_TIMEOUT_MS = 30_000;
const DELETE_TIMEOUT_MS = 15_000;
const SIGN_TIMEOUT_MS = 15_000;

@Injectable()
export class SupabaseStorageService {
  private readonly logger = new Logger(SupabaseStorageService.name);
  private readonly baseUrl: string;
  private readonly serviceRoleKey: string;

  constructor(config: ConfigService) {
    // Normalisation défensive : un slash final dans SUPABASE_URL doublait le
    // séparateur (`//storage/v1/...`, toléré mais fragile). Format attendu :
    // `https://<ref>.supabase.co` sans slash final ni chemin.
    this.baseUrl = (config.get<string>('SUPABASE_URL') ?? '').replace(/\/+$/, '');
    this.serviceRoleKey = config.get<string>('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  }

  get isConfigured(): boolean {
    return this.baseUrl.length > 0 && this.serviceRoleKey.length > 0;
  }

  /* En-têtes exigés par la passerelle REST Supabase hébergée : `apikey` pour
   * le routage projet + `Authorization: Bearer` (service role, contourne les
   * RLS). Sans `apikey`, la passerelle répond 401 (« No API key found in
   * request ») même avec un Bearer valide — d’où un 502 générique côté API.
   * La clé n’est utilisée qu’en en-tête sortant, jamais journalisée. */
  private storageHeaders(contentType?: string): Record<string, string> {
    return {
      apikey: this.serviceRoleKey,
      Authorization: `Bearer ${this.serviceRoleKey}`,
      ...(contentType ? { 'Content-Type': contentType } : {}),
    };
  }

  async uploadObject(path: string, data: Buffer, contentType: string): Promise<void> {
    await this.uploadToBucket(AVATAR_BUCKET, path, data, contentType);
  }

  async deleteObject(path: string): Promise<void> {
    await this.deleteFromBucket(AVATAR_BUCKET, path);
  }

  async uploadKycObject(path: string, data: Buffer, contentType: string): Promise<void> {
    await this.uploadToBucket(KYC_BUCKET, path, data, contentType);
  }

  async deleteKycObject(path: string): Promise<void> {
    await this.deleteFromBucket(KYC_BUCKET, path);
  }

  publicUrl(path: string): string {
    return `${this.baseUrl}/storage/v1/object/public/${AVATAR_BUCKET}/${path}`;
  }

  /**
   * Génère une URL temporaire signée pour un objet d'un bucket PRIVÉ.
   * L'URL expire après `expiresInSeconds` et n'est stockée nulle part :
   * elle ne sert qu'à permettre à un admin de consulter un document KYC.
   *
   * Contrat REST officiel Supabase Storage (`storage-api`) :
   *   POST /storage/v1/object/sign/{bucket}/{path}   body { "expiresIn": N }
   *   → 200 { "signedURL": "/object/sign/{bucket}/{path}?token=..." }
   */
  async createSignedUrl(
    bucket: string,
    path: string,
    expiresInSeconds: number,
  ): Promise<string> {
    this.assertConfigured();
    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/storage/v1/object/sign/${bucket}/${path}`,
        {
          method: 'POST',
          headers: {
            ...this.storageHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ expiresIn: expiresInSeconds }),
          signal: AbortSignal.timeout(SIGN_TIMEOUT_MS),
        },
      );
    } catch {
      throw new BadGatewayException(
        'Le service de stockage est injoignable. Réessayez dans un instant.',
      );
    }
    if (!response.ok) {
      const detail = await this.safeErrorDetail(response);
      throw new BadGatewayException(
        `Impossible de générer le lien de consultation du document (Supabase HTTP ${response.status}).${detail}`,
      );
    }
    const data = (await response.json().catch(() => null)) as
      | { signedURL?: string; signedUrl?: string }
      | null;
    const signedPath = data?.signedURL ?? data?.signedUrl;
    if (!signedPath) {
      throw new BadGatewayException(
        'La génération du lien a échoué : réponse Supabase incomplète.',
      );
    }
    if (/^https?:\/\//.test(signedPath)) return encodeURI(signedPath);
    if (signedPath.startsWith('/storage/v1/')) {
      return encodeURI(`${this.baseUrl}${signedPath}`);
    }
    if (signedPath.startsWith('/object/sign/')) {
      return encodeURI(`${this.baseUrl}/storage/v1${signedPath}`);
    }
    return encodeURI(`${this.baseUrl}${signedPath}`);
  }

  private async safeErrorDetail(response: Response): Promise<string> {
    const text = await response.text().catch(() => '');
    const safe = text.replace(/\r?\n/g, ' ').trim().slice(0, 160);
    return safe ? ` Détail : ${safe}` : '';
  }

  /* Chaîne de causes d’une erreur réseau, sans secret : `fetch` (undici)
   * lève toujours `TypeError: fetch failed` ; la vraie raison (DNS
   * `ENOTFOUND`, connexion refusée `ECONNREFUSED`, timeout, TLS…) est nichée
   * dans `cause`, parfois sur plusieurs niveaux. Seuls type/message/code
   * sont conservés (jamais d’en-tête, de clé, de JWT ni de contenu). */
  private describeNetworkError(error: unknown): string {
    const parts: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
      const code = (current as { code?: unknown }).code;
      parts.push(
        `${current.name}: ${current.message}${typeof code === 'string' ? ` [${code}]` : ''}`,
      );
      const next = (current as { cause?: unknown }).cause;
      if (!next || next === current) break;
      current = next;
    }
    return (parts.length > 0 ? parts.join(' ← ') : 'erreur inconnue').slice(0, 400);
  }

  private storageHost(): string {
    try {
      return new URL(this.baseUrl).hostname || 'inconnu';
    } catch {
      return 'URL invalide';
    }
  }

  private async uploadToBucket(
    bucket: string,
    path: string,
    data: Buffer,
    contentType: string,
  ): Promise<void> {
    this.assertConfigured();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/storage/v1/object/${bucket}/${path}`, {
        method: 'POST',
        headers: {
          ...this.storageHeaders(contentType),
          'x-upsert': 'false',
        },
        body: data as unknown as BodyInit,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      // Échec avant toute réponse HTTP (DNS, connexion refusée, TLS,
      // timeout, URL mal formée) : journaliser la cause imbriquée réelle,
      // le hostname visé et la taille — jamais de secret ni de contenu.
      this.logger.error(
        `Upload stockage impossible (réseau) vers le bucket « ${bucket} » ` +
          `(hôte ${this.storageHost()}, ${data.length} octets, ${contentType}) : ${this.describeNetworkError(error)}.`,
      );
      throw new BadGatewayException('Impossible d’enregistrer le fichier. Réessayez dans un instant.');
    }
    if (!response.ok) {
      // Réponse Supabase exploitable (401 clé, 403 politique, 404 bucket,
      // 409 conflit, 5xx) : détail borné en log, message générique au client.
      const detail = await this.safeErrorDetail(response);
      this.logger.error(
        `Upload stockage refusé par Supabase (HTTP ${response.status}) pour le bucket « ${bucket} » ` +
          `(${data.length} octets, ${contentType}).${detail}`,
      );
      throw new BadGatewayException('Impossible d’enregistrer le fichier. Réessayez dans un instant.');
    }
  }

  private async deleteFromBucket(bucket: string, path: string): Promise<void> {
    this.assertConfigured();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/storage/v1/object/${bucket}/${path}`, {
        method: 'DELETE',
        headers: this.storageHeaders(),
        signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error(
        `Suppression stockage impossible (réseau) pour le bucket « ${bucket} » ` +
          `(hôte ${this.storageHost()}) : ${this.describeNetworkError(error)}.`,
      );
      throw new BadGatewayException('Impossible de supprimer le fichier.');
    }
    if (!response.ok && response.status !== 404) {
      const detail = await this.safeErrorDetail(response);
      this.logger.error(
        `Suppression stockage refusée par Supabase (HTTP ${response.status}) pour le bucket « ${bucket} ».${detail}`,
      );
      throw new BadGatewayException('Impossible de supprimer le fichier.');
    }
  }

  private assertConfigured(): void {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException('Le stockage n’est pas configuré pour le moment.');
    }
  }
}