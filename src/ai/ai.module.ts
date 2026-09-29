import { Module } from '@nestjs/common';
import { AiConfig } from './ai.config.js';
import { AiGatewayService } from './ai-gateway.service.js';
import { AiClassificationService } from './ai-classification.service.js';
import { AiDiagnosisMatchService } from './ai-diagnosis-match.service.js';

/* IA-1 — socle AI Gateway (infrastructure uniquement).
 * IA-4 — classification des demandes « Autre » (aide au dispatch,
 * jamais de décision métier : signal enrichissant, fallback total).
 * AUCUN contrôleur (aucune route publique `/ai/...`) : injection par les
 * services backend autorisés uniquement. */
@Module({
  providers: [AiConfig, AiGatewayService, AiClassificationService, AiDiagnosisMatchService],
  exports: [AiConfig, AiGatewayService, AiClassificationService, AiDiagnosisMatchService],
})
export class AiModule {}
