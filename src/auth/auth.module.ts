import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { EmailService } from './email.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { RolesGuard } from './roles.guard.js';
import { SupabaseStorageService } from '../technician/supabase-storage.service.js';

@Module({
  controllers: [AuthController],
  providers: [AuthService, EmailService, SupabaseStorageService, JwtAuthGuard, RolesGuard],
  // Sprint DISPATCH-V1 — EmailService exporté pour le DispatchService
  // (e-mails « mission disponible », même transport Resend).
  exports: [AuthService, EmailService, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}