import { Body, Controller, Headers, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { SasPayWebhookService } from './saspay-webhook.service.js';

/** Webhooks SasPay (fondations SASPAY-01). Route PUBLIQUE (pas de JWT) mais
 *  sécurisée par signature HMAC (X-Webhook-Signature + X-Webhook-Timestamp
 *  + X-Webhook-Event). Réponse 200 rapide ; tout le traitement est
 *  idempotent (rejouabilité sans double écriture ledger).
 *
 *  NOTE raw body : la signature est calculée sur le corps brut exact envoyé
 *  par SasPay. Le contrôleur utilise `req.rawBody` quand l'hôte le fournit,
 *  sinon le JSON re-sérialisé (acceptable en fondation ; le câblage brut
 *  exact sera figé avec les premiers appels réels). */
@Controller('webhooks/saspay')
export class SasPayWebhookController {
  constructor(private readonly webhooks: SasPayWebhookService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-webhook-signature') signature: string | undefined,
    @Headers('x-webhook-timestamp') timestamp: string | undefined,
    @Headers('x-webhook-event') eventHeader: string | undefined,
    @Body() body: Record<string, unknown> | unknown[],
  ) {
    const record = (Array.isArray(body) ? {} : (body ?? {})) as Record<string, unknown>;
    const raw: string | Buffer =
      req.rawBody ?? Buffer.from(JSON.stringify(Array.isArray(body) ? body : record));
    this.webhooks.verifySignature(raw, timestamp, signature);
    const event =
      (eventHeader ?? '').trim() ||
      (typeof record.event === 'string' ? record.event : '') ||
      (typeof record.type === 'string' ? record.type : '');
    const data =
      record.data && typeof record.data === 'object' && !Array.isArray(record.data)
        ? (record.data as Record<string, unknown>)
        : record;
    const result = await this.webhooks.handleEvent(event || 'unknown', data);
    return { received: true, ...result };
  }
}
