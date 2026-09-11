import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { FinancialService } from './financial.service.js';
import { CreateTestCreditDto } from './dto/create-test-credit.dto.js';
import { DEFAULT_TEST_CREDIT_AMOUNT } from './financial-fees.js';

/** Outils de simulation financière — réservés ADMIN.
 *  Sprint 8.7-FIN : aucun endpoint utilisateur de création/modification/
 *  suppression de transaction : le ledger est serveur et immuable. */
@Controller('admin/dev')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class FinancialAdminController {
  constructor(private readonly financial: FinancialService) {}

  /** Crédit initial SIMULATION (50 000 XAF par défaut) pour un compte client.
   *  Idempotent : un seul crédit par utilisateur. Jamais automatique. */
  @Post('test-credit')
  @HttpCode(HttpStatus.CREATED)
  testCredit(@CurrentUser() user: RequestUser, @Body() dto: CreateTestCreditDto) {
    return this.financial.createTestCredit(
      user.id,
      dto.userId,
      dto.amount ?? DEFAULT_TEST_CREDIT_AMOUNT,
    );
  }
}