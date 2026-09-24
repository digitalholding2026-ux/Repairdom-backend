import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { FinancialModule } from '../financial/financial.module.js';
import { SasPayConfig } from './saspay.config.js';
import { SasPayApiClient } from './saspay-api.client.js';
import { SasPayTopupService } from './saspay-topup.service.js';
import { SasPayWebhookService } from './saspay-webhook.service.js';
import { SasPayWebhookController } from './saspay-webhook.controller.js';
import { TopupController } from './topup.controller.js';

/** Sprint SASPAY-01 — SasPay comme rail externe (fondations) : configuration
 *  backend-only + webhooks vérifiés HMAC + dispatch idempotent vers le
 *  ledger UNIQUE (FinancialTransaction).
 *  Sprint SASPAY-03 — pay-in réel : client API softpay/verify + orchestration
 *  TopupIntent (init idempotente, vérification serveur) + surface HTTP
 *  recharge. Aucun payout, aucun Payment Link. */
@Module({
  imports: [FinancialModule, AuthModule],
  controllers: [SasPayWebhookController, TopupController],
  providers: [SasPayConfig, SasPayApiClient, SasPayTopupService, SasPayWebhookService],
  exports: [SasPayConfig, SasPayApiClient, SasPayTopupService, SasPayWebhookService],
})
export class SasPayModule {}
