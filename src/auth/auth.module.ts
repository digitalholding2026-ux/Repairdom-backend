import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { EmailService } from './email.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { RolesGuard } from './roles.guard.js';
import { VerificationReminderScheduler } from './verification-reminder.scheduler.js';
import { SupabaseStorageService } from '../technician/supabase-storage.service.js';

@Module({
  controllers: [AuthController],
  /* Chantier D2.5 — scheduler de relances e-mail : il ne dépend que de
   * `PrismaService` (module global) et d'`EmailService` (local), donc AUCUN
   * cycle possible ici, et il reste INTERNE (non exporté) : rien d'autre ne
   * doit pouvoir déclencher un envoi de relance. */
  providers: [
    AuthService,
    EmailService,
    SupabaseStorageService,
    JwtAuthGuard,
    RolesGuard,
    VerificationReminderScheduler,
  ],
  // Sprint DISPATCH-V1 — EmailService exporté pour le DispatchService
  // (e-mails « mission disponible », même transport Resend).
  exports: [AuthService, EmailService, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}