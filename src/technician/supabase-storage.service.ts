import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Bucket public dédié aux photos de profil. Les documents KYC utiliseront un
 * bucket séparé et privé (repairdom-kyc-documents) dans un sprint ultérieur. */
export const AVATAR_BUCKET = 'repairdom-profile-images';

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
    this.assertConfigured();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/storage/v1/object/${AVATAR_BUCKET}/${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.serviceRoleKey}`,
          'Content-Type': contentType,
          'x-upsert': 'false',
        },
        body: data as unknown as BodyInit,
      });
    } catch {
      throw new BadGatewayException('Impossible d’enregistrer la photo. Réessayez dans un instant.');
    }
    if (!response.ok) {
      throw new BadGatewayException('Impossible d’enregistrer la photo. Réessayez dans un instant.');
    }
  }

  async deleteObject(path: string): Promise<void> {
    this.assertConfigured();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/storage/v1/object/${AVATAR_BUCKET}/${path}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.serviceRoleKey}`,
        },
      });
    } catch {
      throw new BadGatewayException('Impossible de supprimer l’ancienne photo.');
    }
    if (!response.ok && response.status !== 404) {
      throw new BadGatewayException('Impossible de supprimer l’ancienne photo.');
    }
  }

  publicUrl(path: string): string {
    return `${this.baseUrl}/storage/v1/object/public/${AVATAR_BUCKET}/${path}`;
  }

  private assertConfigured(): void {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException('L’upload de photo n’est pas configuré pour le moment.');
    }
  }
}