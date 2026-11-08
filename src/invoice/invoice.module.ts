import { Module } from '@nestjs/common';
import { InvoiceService } from './invoice.service.js';
import { InvoiceClientController } from './invoice.controller.js';
import { InvoiceAdminController } from './invoice.controller.js';
import { InvoiceDownloadController } from './invoice.controller.js';
import { EscrowCronService } from './escrow-cron.service.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule],
  providers: [InvoiceService, EscrowCronService],
  controllers: [
    InvoiceClientController,
    InvoiceAdminController,
    InvoiceDownloadController,
  ],
  exports: [InvoiceService],
})
export class InvoiceModule {}
