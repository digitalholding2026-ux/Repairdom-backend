import { afterEach, describe, expect, it, vi } from 'vitest';
import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { SupabaseStorageService } from './supabase-storage.service.js';

/* Upload Supabase : en-têtes exigés par la passerelle (`apikey` +
 * `Authorization`), message client générique sans fuite, 503 si non
 * configuré. `fetch` est simulé : aucun appel réseau réel. */

function mockConfig(values: Record<string, string> = {}) {
  return {
    get: vi.fn((key: string) => values[key] ?? ''),
  };
}

const CONFIGURED = mockConfig({
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
});

function mockFetchOnce(response: Partial<Response> & { status: number; ok: boolean }) {
  const fetchMock = vi.fn(async () => response as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SupabaseStorageService — upload', () => {
  it('envoie apikey + Authorization vers la bonne URL', async () => {
    const fetchMock = mockFetchOnce({ status: 200, ok: true } as Response);
    const service = new SupabaseStorageService(CONFIGURED as never);
    await service.uploadObject('clients/u/f.png', Buffer.from([1, 2, 3]), 'image/png');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://project.supabase.co/storage/v1/object/repairdom-profile-images/clients/u/f.png',
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe('service-role-key');
    expect(headers.Authorization).toBe('Bearer service-role-key');
    expect(headers['Content-Type']).toBe('image/png');
  });

  it('réponse Supabase non-ok → 502 générique sans fuite du détail', async () => {
    mockFetchOnce({
      status: 401,
      ok: false,
      text: async () => '{"message":"No API key found in request"}',
    } as unknown as Response);
    const service = new SupabaseStorageService(CONFIGURED as never);
    const error = await service
      .uploadObject('clients/u/f.png', Buffer.from([1]), 'image/png')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadGatewayException);
    expect((error as Error).message).toBe(
      'Impossible d’enregistrer le fichier. Réessayez dans un instant.',
    );
    expect((error as Error).message).not.toContain('No API key');
  });

  it('réseau injoignable → 502 générique', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    const service = new SupabaseStorageService(CONFIGURED as never);
    await expect(
      service.uploadObject('clients/u/f.png', Buffer.from([1]), 'image/png'),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('non configuré → 503 sans appel réseau', async () => {
    const fetchMock = mockFetchOnce({ status: 200, ok: true } as Response);
    const service = new SupabaseStorageService(mockConfig() as never);
    await expect(
      service.uploadObject('clients/u/f.png', Buffer.from([1]), 'image/png'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
