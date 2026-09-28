import {
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { HttpExceptionFilter } from './http-exception.filter.js';

/* CHANTIER ERREURS P1 — le filtre expose { statusCode, error, message,
 * code? } exploitable par le frontend, jamais de stack ni de détail
 * interne. Réponses JSON factices, aucun réseau. */

function run(exception: unknown, url = '/api/test') {
  let status = 0;
  let payload: Record<string, unknown> = {};
  const response = {
    status: (code: number) => {
      status = code;
      return { json: (body: Record<string, unknown>) => void (payload = body) };
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: 'GET', url }),
    }),
  };
  new HttpExceptionFilter().catch(exception, host as never);
  return { status, payload };
}

describe('format exploitable', () => {
  it('404 métier (code conservé) pour détection sans substring', () => {
    const { status, payload } = run(new NotFoundException({ code: 'DEMANDE_NOT_FOUND', message: 'Mission introuvable.' }));
    expect(status).toBe(404);
    expect(payload.code).toBe('DEMANDE_NOT_FOUND');
    expect(payload.statusCode).toBe(404);
    expect(payload.path).toBe('/api/test');
    expect(payload.timestamp).toBeTypeOf('string');
    expect(payload).not.toHaveProperty('stack');
  });

  it('400 métier 422/409 : statut + message préservés', () => {
    const conflict = run(new HttpException({ code: 'CONFLICT', message: 'Doublon.' }, 409));
    expect(conflict.status).toBe(409);
    expect(conflict.payload.code).toBe('CONFLICT');
  });

  it('erreur inattendue → 500 générique, sans stack ni détail', () => {
    const { status, payload } = run(new Error('prisma P2002 boom'));
    expect(status).toBe(500);
    expect(payload.message).toBe('Une erreur interne est survenue.');
    expect(JSON.stringify(payload)).not.toContain('P2002');
    expect(payload).not.toHaveProperty('stack');
  });

  it('fichier trop lourd → 413 FR', () => {
    const err = Object.assign(new Error('File too large'), { name: 'MulterError', code: 'LIMIT_FILE_SIZE' });
    const { status, payload } = run(err);
    expect(status).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(payload.message).toBe('Le fichier dépasse la taille maximale autorisée.');
  });
});

describe('ValidationPipe cohérente', () => {
  it.each([
    ['champ manquant', ['property email should not be empty']],
    ['valeur invalide', ['latitude must be a number']],
    ['hors limite', ['amount must not be greater than 10000000']],
    ['propriété non autorisée', ['property accuracy should not exist']],
  ])('%s → message[] + code VALIDATION_ERROR', (_label, messages) => {
    const { status, payload } = run(new BadRequestException(messages));
    expect(status).toBe(400);
    expect(payload.message).toEqual(messages);
    expect(payload.code).toBe('VALIDATION_ERROR');
  });

  it('400 métier avec code explicite : code conservé (pas écrasé)', () => {
    const { payload } = run(new BadRequestException({ code: 'KYC_REQUIRED', message: 'Vérification requise.' }));
    expect(payload.code).toBe('KYC_REQUIRED');
  });
});
