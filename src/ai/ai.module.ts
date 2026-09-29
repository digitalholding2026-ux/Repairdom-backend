import { Module } from '@nestjs/common';
import { AiConfig } from './ai.config.js';
import { AiGatewayService } from './ai-gateway.service.js';

/* IA-1 — socle AI Gateway (infrastructure uniquement).
 * AUCUN contrôleur (aucune route publique `/ai/...`) : le gateway est
 * injecté par les futurs services backend autorisés. Exporté pour eux. */
@Module({
  providers: [AiConfig, AiGatewayService],
  exports: [AiConfig, AiGatewayService],
})
export class AiModule {}
