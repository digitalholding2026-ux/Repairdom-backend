import { Controller, Headers, HttpCode, HttpStatus, Post, Req, UnauthorizedException, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { SasPayWebhookService } from './saspay-webhook.service.js';

/** Webhooks SasPay (Sprint SASPAY-01, durci SASPAY-03). Route PUBLIQUE (pas
 *  de JWT) mais sécurisée par signature HMAC (X-Webhook-Signature +
 *  X-Webhook-Timestamp + X-Webhook-Event) calculée sur les OCTETS EXACTS
 *  reçus (`req.rawBody`, conservé via `rawBody: true` dans main.ts).
 *
 *  Règles absolues :
 *  - sans raw body exact → 401 (AUCUN fallback re-sérialisé : une
 *    re-sérialisation casse la comparaison bit à bit) ;
 *  - le JSON n'est parsé qu'APRÈS validation de la signature ;
 *  - réponse 200 rapide ; traitement idempotent (rejouabilité sans double
 *    écriture ledger ; SasPay retente 5 fois sur non-2xx). */
@Controller('webhooks/saspay')
export class SasPayWebhookController {
  constructor(private readonly webhooks: SasPayWebhookService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-webhook-signature') signature: string | undefined,
    @Headers('x-webhook-timestamp') timestamp: string | undefined,
    @Headers('x-webhook-event') eventHeader: string | undefined,
  ) {
    const raw = req.rawBody;
    if (!raw || raw.length === 0) {
      throw new UnauthorizedException('Corps brut manquant : vérification impossible.');
    }
    this.webhooks.verifySignature(raw, timestamp, signature);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new UnauthorizedException('Corps webhook non-JSON.');
    }
    const record =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
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
