import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { FinancialModule } from '../financial/financial.module.js';
import { SasPayConfig } from './saspay.config.js';
import { SasPayApiClient } from './saspay-api.client.js';
import { SasPayTopupService } from './saspay-topup.service.js';
import { SasPayPayoutService } from './saspay-payout.service.js';
import { SasPayWebhookService } from './saspay-webhook.service.js';
import { SasPayWebhookController } from './saspay-webhook.controller.js';
import { TopupController } from './topup.controller.js';
import { WithdrawalController } from './withdrawal.controller.js';

/** Sprint SASPAY-01 — SasPay comme rail externe (fondations) : configuration
 *  backend-only + webhooks vérifiés HMAC + dispatch idempotent vers le
 *  ledger UNIQUE (FinancialTransaction).
 *  Sprint SASPAY-03 — pay-in réel : client API softpay/verify + orchestration
 *  TopupIntent (init idempotente, vérification serveur) + surface HTTP
 *  recharge. Aucun payout, aucun Payment Link.
 *  Sprint PAYOUT — retrait réel : client API payouts + orchestration
 *  WithdrawalRequest (init idempotente, vérification serveur, débit unique
 *  au charged constaté) + surface HTTP retraits. */
@Module({
  imports: [FinancialModule, AuthModule],
  controllers: [SasPayWebhookController, TopupController, WithdrawalController],
  providers: [SasPayConfig, SasPayApiClient, SasPayTopupService, SasPayPayoutService, SasPayWebhookService],
  exports: [SasPayConfig, SasPayApiClient, SasPayTopupService, SasPayPayoutService, SasPayWebhookService],
})
export class SasPayModule {}
