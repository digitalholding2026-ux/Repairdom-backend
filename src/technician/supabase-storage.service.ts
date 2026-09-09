import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Bucket public dédié aux photos de profil. */
export const AVATAR_BUCKET = 'repairdom-profile-images';

/** Bucket PRIVÉ dédié aux documents KYC. Jamais exposé via une URL publique :
 * les documents restent uniquement accessibles côté backend (service role). */
export const KYC_BUCKET = 'repairdom-kyc-documents';

@Injectable()
export class SupabaseStorageService {
  private readonly baseUrl: string;
  private readonly serviceRoleKey: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('SUPABASE_URL') ?? '';
    this.serviceRoleKey = config.get<string>('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  }

  get isConfigured(): boolean {
    return this.baseUrl.length > 0 && this.serviceRoleKey.length > 0;
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
            Authorization: `Bearer ${this.serviceRoleKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ expiresIn: expiresInSeconds }),
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
          Authorization: `Bearer ${this.serviceRoleKey}`,
          'Content-Type': contentType,
          'x-upsert': 'false',
        },
        body: data as unknown as BodyInit,
      });
    } catch {
      throw new BadGatewayException('Impossible d’enregistrer le fichier. Réessayez dans un instant.');
    }
    if (!response.ok) {
      throw new BadGatewayException('Impossible d’enregistrer le fichier. Réessayez dans un instant.');
    }
  }

  private async deleteFromBucket(bucket: string, path: string): Promise<void> {
    this.assertConfigured();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/storage/v1/object/${bucket}/${path}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.serviceRoleKey}`,
        },
      });
    } catch {
      throw new BadGatewayException('Impossible de supprimer le fichier.');
    }
    if (!response.ok && response.status !== 404) {
      throw new BadGatewayException('Impossible de supprimer le fichier.');
    }
  }

  private assertConfigured(): void {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException('Le stockage n’est pas configuré pour le moment.');
    }
  }
}