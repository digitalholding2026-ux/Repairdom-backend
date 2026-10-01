import { Module } from '@nestjs/common';
import { FinancialModule } from '../financial/financial.module.js';
import { DisputesService } from './disputes.service.js';

/* Litiges post-intervention : un seul service, réutilisé par les
 * contrôleurs client (demandes), technicien (collaboration) et admin.
 * Règlement via FinancialService existant (aucun second rail). */
@Module({
  imports: [FinancialModule],
  providers: [DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}
