import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BackofficeAgentConfig } from './backoffice-agent.config.js';
import { GroqClient } from './groq.client.js';
import { BackofficeAgentService } from './backoffice-agent.service.js';
import { BackofficeAgentController } from './backoffice-agent.controller.js';

/* Module isolé : aucune dépendance métier en écriture, aucune table dédiée.
 * Supprimable sans toucher au reste de Relio (retirer l'entrée AppModule). */

@Module({
  imports: [AuthModule],
  controllers: [BackofficeAgentController],
  providers: [BackofficeAgentConfig, GroqClient, BackofficeAgentService],
})
export class BackofficeAgentModule {}
