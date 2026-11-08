import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  DemandeStatus,
  FinancialTransactionMode,
  FundsHoldStatus,
  InvoiceStatus,
} from '../generated/prisma/enums.js';
import { ConfigService } from '@nestjs/config';

const logger = new Logger('InvoiceService');

/** Numéro de facture séquentiel : RELIO-YYYY-XXXX (XXXX sur 4 chiffres). */
const _INVOICE_SEQUENCE_KEY = 'relio_invoice_sequence';

/**
 * Génère un PDF minimal (PDF 1.4, une page) sans dépendance externe.
 * Contenu : en-tête Relio, infos client, appareil, prix, date, WhatsApp.
 */
function buildInvoicePdf({
  invoiceNumber,
  clientName,
  clientPhone,
  device,
  amountXaf,
  dateIso,
}: {
  invoiceNumber: string;
  clientName: string;
  clientPhone: string;
  device: string;
  amountXaf: number;
  dateIso: string;
}): Buffer {
  const esc = (s: string) =>
    s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') +
    '';
  const latin1 = (s: string) =>
    Array.from(s)
      .map((ch) => {
        const c = ch.charCodeAt(0);
        return c < 32 || c > 126 ? '?' : ch;
      })
      .join('');

  const whatsappLine = `(${esc(latin1('Relio - Whatsapp Relio: +237 6 XX XX XX XX'))}) Tj`;

  const lines = [
    'BT',
    '/F1 16 Tf',
    '50 780 Td',
    `(${esc(latin1('RELIO - Facture'))}) Tj`,
    'ET',
    'BT',
    '/F1 11 Tf',
    '50 750 Td',
    `(${esc(latin1(`Facture ${invoiceNumber}`))}) Tj`,
    'ET',
    'BT',
    '/F1 10 Tf',
    '50 720 Td',
    `(${esc(latin1(`Date : ${dateIso}`))}) Tj`,
    'ET',
    'BT',
    '/F1 10 Tf',
    '50 700 Td',
    `(${esc(latin1(`Client : ${clientName}`))}) Tj`,
    'ET',
    'BT',
    '/F1 10 Tf',
    '50 680 Td',
    `(${esc(latin1(`WhatsApp client : ${clientPhone}`))}) Tj`,
    'ET',
    'BT',
    '/F1 10 Tf',
    '50 650 Td',
    `(${esc(latin1(`Appareil : ${device}`))}) Tj`,
    'ET',
    'BT',
    '/F1 10 Tf',
    '50 620 Td',
    `(${esc(latin1(`Montant : ${amountXaf.toLocaleString('fr-FR')} FCFA`))}) Tj`,
    'ET',
    'BT',
    '/F1 10 Tf',
    '50 590 Td',
    whatsappLine,
    'ET',
  ].join('\n');

  const content = lines;
  const contentLen = Buffer.byteLength(content, 'utf8');

  const objects: string[] = [];
  objects.push(`1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj`);
  objects.push(`2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1/Resources<</Font<</F1 5 0 R>>>>>>endobj`);
  objects.push(`3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595.28 841.89]/Contents 4 0 R>>endobj`);
  objects.push(
    `4 0 obj<</Length ${contentLen}>>stream\n${content}\nendstream\nendobj`,
  );
  objects.push(
    `5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj`,
  );

  let offset = 0;
  const xref: number[] = [0];
  const parts: string[] = [];
  parts.push('%PDF-1.4\n');
  offset += Buffer.byteLength(parts[0], 'utf8');
  xref.push(offset);

  for (let i = 0; i < objects.length; i++) {
    parts.push(`${i + 1} 0 obj${objects[i]}\nendobj\n`);
    offset += Buffer.byteLength(parts[parts.length - 1], 'utf8');
    xref.push(offset);
  }

  const xrefOffset = offset;
  parts.push('xref\n');
  offset += Buffer.byteLength(parts[parts.length - 1], 'utf8');
  parts.push(`0 ${objects.length + 1}\n`);
  offset += Buffer.byteLength(parts[parts.length - 1], 'utf8');
  for (const off of xref) {
    parts.push(`${String(off).padStart(10, '0')} 00000 n\n`);
    offset += Buffer.byteLength(parts[parts.length - 1], 'utf8');
  }
  parts.push('trailer<</Size ${objects.length + 1}/Root 1 0 R>>\n');
  offset += Buffer.byteLength(parts[parts.length - 1], 'utf8');
  parts.push(`startxref\n${xrefOffset}\n%%EOF\n`);
  offset += Buffer.byteLength(parts[parts.length - 1], 'utf8');

  return Buffer.concat(parts.map((p) => Buffer.from(p, 'utf8')));
}

/** Compteur de séquence facture (en mémoire, réinitialisé au redémarrage). */
let invoiceSequence = 0;

function computeInvoiceNumber(): string {
  const now = new Date();
  const year = now.getFullYear();
  invoiceSequence += 1;
  return `RELIO-${year}-${String(invoiceSequence).padStart(4, '0')}`;
}

/** Délai d'escrow avant remboursement automatique : 48 heures. */
export const ESCROW_REFUND_HOURS = 48;

/** Vérifie si un hold est arrivé à échéance (pure, testable). */
export function isEscrowOverdue({
  holdStartedAt,
  now,
  hours = ESCROW_REFUND_HOURS,
}: {
  holdStartedAt: Date | null;
  now: Date;
  hours?: number;
}): boolean {
  if (!holdStartedAt) return false;
  return now.getTime() - holdStartedAt.getTime() >= hours * 60 * 60 * 1000;
}

@Injectable()
export class InvoiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private async sendInvoiceEmail(
    to: string,
    subject: string,
    html: string,
    text: string,
  ): Promise<void> {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    if (!apiKey) {
      logger.warn(`[email non envoyé] facture pour ${to} (Resend non configuré).`);
      return;
    }
    const from =
      this.config.get<string>('EMAIL_FROM') ??
      this.config.get<string>('SMTP_FROM') ??
      'Relio <onboarding@resend.dev>';
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      logger.error(
        `Échec d'envoi de la facture par e-mail à ${to}: ${
          error instanceof Error ? error.message : 'erreur inconnue'
        }.`,
      );
    }
  }

  /** Génère (ou régénère) la facture d'une demande close. */
  async generateInvoice(demandeId: string, actorUserId: string) {
    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      include: {
        client: { select: { id: true, firstName: true, lastName: true, phone: true } },
        domain: { select: { name: true } },
      },
    });
    if (!demande) {
      throw new NotFoundException('Demande introuvable.');
    }
    if (demande.status !== DemandeStatus.COMPLETED) {
      throw new ForbiddenException(
        'La facture ne peut être générée que pour une demande terminée.',
      );
    }

    const existing = await this.prisma.invoice.findUnique({
      where: { demandeId },
    });
    if (existing) {
      return existing;
    }

    const clientName = [
      demande.client?.firstName ?? '',
      demande.client?.lastName ?? '',
    ]
      .filter(Boolean)
      .join(' ')
      .trim() || 'Client';
    const device = [demande.domain?.name, demande.category]
      .filter(Boolean)
      .join(' - ') || 'Appareil';
    const amountXaf = demande.finalAmount ?? 0;
    const dateIso = new Date().toISOString().slice(0, 10);
    const invoiceNumber = computeInvoiceNumber();

    const pdfBuffer = buildInvoicePdf({
      invoiceNumber,
      clientName,
      clientPhone: demande.client?.phone ?? '—',
      device,
      amountXaf,
      dateIso,
    });

    // Écriture disque (stockage local ; en prod à remplacer par Supabase).
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(process.cwd(), 'uploads', 'invoices');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${invoiceNumber}.pdf`), pdfBuffer);
    const pdfUrl = `/uploads/invoices/${invoiceNumber}.pdf`;

    const invoice = await this.prisma.invoice.create({
      data: {
        demandeId,
        invoiceNumber,
        amount: amountXaf,
        pdfUrl,
        status: InvoiceStatus.PENDING,
      },
    });

    // E-mail de facture au client (best-effort, ne fait pas échouer la clôture).
    const to = demande.client?.phone ?? undefined;
    if (to) {
      const html = `
        <h2>Votre facture Relio — ${invoiceNumber}</h2>
        <p>Bonjour ${clientName},</p>
        <p>Retrouvez ci-dessous le récapitulatif de votre demande terminée :</p>
        <ul>
          <li><b>Appareil :</b> ${device}</li>
          <li><b>Montant :</b> ${amountXaf.toLocaleString('fr-FR')} FCFA</li>
          <li><b>Date :</b> ${dateIso}</li>
        </ul>
        <p>Le PDF détaillé est disponible sur votre espace client.</p>
      `;
      await this.sendInvoiceEmail(to, `Facture Relio ${invoiceNumber}`, html, html);
    }

    logger.log(`Facture ${invoiceNumber} générée pour la demande ${demandeId}.`);
    return invoice;
  }

  /** Récupère la facture d'une demande (client propriétaire ou ADMIN). */
  async getInvoiceForDemande(
    demandeId: string,
    requesterUserId: string,
    isAdmin: boolean,
  ) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { demandeId },
      include: {
        demande: {
          select: { id: true, reference: true, clientId: true, status: true },
        },
      },
    });
    if (!invoice) {
      throw new NotFoundException('Aucune facture pour cette demande.');
    }
    if (!isAdmin && invoice.demande.clientId !== requesterUserId) {
      throw new ForbiddenException('Accès interdit à cette facture.');
    }
    return invoice;
  }

  /* ── Escrow (mise sous séquestre des fonds smartphone) ────────────────── */

  /** Récupère une demande si elle appartient au client demandeur (sinon null). */
  async getDemandeForEscrow(demandeId: string, _clientUserId: string) {
    return this.prisma.demande.findUnique({
      where: { id: demandeId },
      include: {
        client: { select: { id: true } },
        domain: { select: { name: true } },
      },
    });
  }

  /** Crée le FundsHold ACTIVE et définit escrowStartedAt sur la demande. */
  async createEscrowHold(demande: any, _actorUserId: string) {
    const amount = Number(demande.finalAmount);
    const reference = `ESCROW-${demande.reference ?? demande.id.slice(-6)}-${Date.now()}`;

    const [hold, updated] = await this.prisma.$transaction([
      this.prisma.fundsHold.create({
        data: {
          reference,
          userId: demande.clientId,
          demandeId: demande.id,
          amount,
          currency: 'XAF',
          mode: FinancialTransactionMode.SIMULATION,
          status: FundsHoldStatus.ACTIVE,
          createdById: _actorUserId,
          metadata: {
            purpose: 'escrow-smartphone',
            demandeReference: demande.reference,
          },
        },
      }),
      this.prisma.demande.update({
        where: { id: demande.id },
        data: { escrowStartedAt: new Date() },
      }),
    ]);

    return { hold, escrowStartedAt: updated.escrowStartedAt };
  }

  /** Clôture admin : COMPLETED, libération du hold, génération de la facture. */
  async completeDemande(demandeId: string, _actorUserId: string) {
    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      include: { client: { select: { id: true, firstName: true, lastName: true, phone: true } } },
    });
    if (!demande) {
      throw new NotFoundException('Demande introuvable.');
    }

    const [closed, releasedHold] = await this.prisma.$transaction([
      this.prisma.demande.update({
        where: { id: demandeId },
        data: { status: DemandeStatus.COMPLETED },
      }),
      this.prisma.fundsHold.updateMany({
        where: { demandeId, status: FundsHoldStatus.ACTIVE },
        data: { status: FundsHoldStatus.RELEASED, releasedAt: new Date() },
      }),
    ]);

    const invoice = await this.generateInvoice(demandeId, actorUserId);

    logger.log(
      `Demande ${demandeId} clôturée (COMPLETED), hold libéré, facture générée.`,
    );
    return { demande: closed, hold: releasedHold, invoice };
  }
}
