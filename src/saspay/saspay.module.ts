import { Module } from '@nestjs/common';
import { FinancialModule } from '../financial/financial.module.js';
import { SasPayConfig } from './saspay.config.js';
import { SasPayWebhookService } from './saspay-webhook.service.js';
import { SasPayWebhookController } from './saspay-webhook.controller.js';

/** Sprint SASPAY-01 — SasPay comme rail externe (fondations) :
 *  configuration backend-only + webhooks vérifiés HMAC + dispatch
 *  idempotent vers le ledger UNIQUE (FinancialTransaction). Aucun appel
 *  prestataire réel dans ce sprint. */
@Module({
  imports: [FinancialModule],
  controllers: [SasPayWebhookController],
  providers: [SasPayConfig, SasPayWebhookService],
  exports: [SasPayConfig, SasPayWebhookService],
})
export class SasPayModule {}
