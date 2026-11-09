import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { DemandeStatus, ServiceCode } from '../generated/prisma/enums.js';
import { InvoiceService } from './invoice.service.js';

/**
 * M2 — Facturation et escrow.
 *
 * - POST /api/client/demandes/:id/pay-escrow : mise sous séquestre.
 *   Smartphone : hold du montant total (finalAmount).
 *   FRP / Système : hold du montant du dépôt (depositAmount, frais de
 *   déplacement), le reste payé après la réparation.
 * - POST /api/admin/demandes/:id/complete  : clôture, libération hold, facture.
 * - GET  /api/client/invoices/:id           : téléchargement/consultation facture.
 */
@Controller('client/demandes')
@UseGuards(JwtAuthGuard)
export class InvoiceClientController {
  constructor(private readonly invoice: InvoiceService) {}

  /** Mise sous séquestre des fonds (smartphone : total ; FRP/Système : dépôt). */
  @Post(':demandeId/pay-escrow')
  async payEscrow(
    @Param('demandeId') demandeId: string,
    @CurrentUser() user: RequestUser,
  ) {
    const demande = await this.invoice.getDemandeForEscrow(demandeId, user.id);
    if (!demande) {
      throw new NotFoundException('Demande introuvable.');
    }
    if (demande.client.id !== user.id) {
      throw new ForbiddenException('Cette demande ne vous appartient pas.');
    }
    if (demande.status !== DemandeStatus.ACCEPTED) {
      throw new ForbiddenException(
        'Le devis doit être accepté avant la mise sous séquestre.',
      );
    }

    /* Montant à réserver : dépôt (FRP/Système) ou total (Smartphone). */
    const isSmartphone = demande.category === ServiceCode.SMARTPHONE;
    const amount = isSmartphone
      ? Number(demande.finalAmount)
      : Number(demande.depositAmount);
    if (!amount || amount <= 0) {
      throw new ForbiddenException(
        isSmartphone
          ? 'Aucun montant final défini.'
          : 'Aucun frais de déplacement (dépôt) défini pour cette prestation.',
      );
    }

    return this.invoice.createEscrowHold(demande, user.id, {
      amount,
      purpose: isSmartphone ? 'escrow-smartphone' : 'depot-deplacement',
      markDepositPaid: !isSmartphone,
    });
  }
}

@Controller('admin/demandes')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class InvoiceAdminController {
  constructor(private readonly invoice: InvoiceService) {}

  /** Clôture : passe en COMPLETED, libère le hold, génère la facture. */
  @Post(':demandeId/complete')
  async complete(
    @Param('demandeId') demandeId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.invoice.completeDemande(demandeId, user.id);
  }
}

@Controller('client/invoices')
@UseGuards(JwtAuthGuard)
export class InvoiceDownloadController {
  constructor(private readonly invoice: InvoiceService) {}

  @Get(':demandeId')
  async getInvoice(
    @Param('demandeId') demandeId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.invoice.getInvoiceForDemande(
      demandeId,
      user.id,
      user.role === 'ADMIN',
    );
  }
}
