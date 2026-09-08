import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RequestUser } from '../auth/auth.types.js';
import type { SendMessageDto } from './dto/send-message.dto.js';
import type { CreateDiagnosticDto } from './dto/create-diagnostic.dto.js';
import type { CreateQuoteDto } from './dto/create-quote.dto.js';

export const DEFAULT_QUOTE_CURRENCY = 'XAF';

interface AccessibleDemande {
  id: string;
  status: string;
  clientId: string;
  technicianId: string | null;
}

@Injectable()
export class CollaborationService {
  constructor(private readonly prisma: PrismaService) {}

  private async requireAccess(user: RequestUser, demandeId: string): Promise<AccessibleDemande> {
    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      select: { id: true, status: true, clientId: true, technicianId: true },
    });
    if (!demande) throw new NotFoundException('Demande introuvable.');
    if (user.role === 'CLIENT') {
      if (demande.clientId !== user.id) throw new NotFoundException('Demande introuvable.');
    } else {
      if (demande.technicianId !== user.id) throw new NotFoundException('Demande introuvable.');
    }
    return demande;
  }

  private assertOpen(status: string) {
    if (status === 'CANCELED' || status === 'CONFIRMED') {
      throw new ConflictException('Cette demande est clôturée.');
    }
  }

  private toApiMessage(message: {
    id: string;
    content: string;
    senderId: string;
    createdAt: Date;
    sender: { id: string; firstName: string; lastName: string | null };
  }) {
    return {
      id: message.id,
      content: message.content,
      senderId: message.senderId,
      sender: message.sender,
      createdAt: message.createdAt.toISOString(),
    };
  }

  private toApiDiagnostic(diagnostic: {
    id: string;
    content: string;
    recommendation: string | null;
    technicianId: string;
    createdAt: Date;
    technician: { id: string; firstName: string; lastName: string | null };
  }) {
    return {
      id: diagnostic.id,
      content: diagnostic.content,
      recommendation: diagnostic.recommendation,
      technicianId: diagnostic.technicianId,
      technician: diagnostic.technician,
      createdAt: diagnostic.createdAt.toISOString(),
    };
  }

  private toApiQuote(quote: {
    id: string;
    demandeId: string;
    technicianId: string;
    amount: number;
    currency: string;
    description: string;
    status: string;
    createdAt: Date;
  }) {
    return {
      id: quote.id,
      demandeId: quote.demandeId,
      technicianId: quote.technicianId,
      amount: quote.amount,
      currency: quote.currency,
      description: quote.description,
      status: quote.status,
      createdAt: quote.createdAt.toISOString(),
    };
  }

  async listMessages(user: RequestUser, demandeId: string) {
    await this.requireAccess(user, demandeId);
    const messages = await this.prisma.message.findMany({
      where: { demandeId },
      orderBy: { createdAt: 'asc' },
      include: { sender: { select: { id: true, firstName: true, lastName: true } } },
    });
    return messages.map((message) => this.toApiMessage(message));
  }

  async sendMessage(user: RequestUser, demandeId: string, dto: SendMessageDto) {
    const demande = await this.requireAccess(user, demandeId);
    this.assertOpen(demande.status);

    const content = dto.content.trim();
    if (!content) throw new BadRequestException('Le message ne peut pas être vide.');

    const message = await this.prisma.message.create({
      data: { demandeId, senderId: user.id, content },
      include: { sender: { select: { id: true, firstName: true, lastName: true } } },
    });
    return this.toApiMessage(message);
  }

  async listDiagnostics(user: RequestUser, demandeId: string) {
    await this.requireAccess(user, demandeId);
    const diagnostics = await this.prisma.diagnostic.findMany({
      where: { demandeId },
      orderBy: { createdAt: 'desc' },
      include: { technician: { select: { id: true, firstName: true, lastName: true } } },
    });
    return diagnostics.map((diagnostic) => this.toApiDiagnostic(diagnostic));
  }

  async createDiagnostic(user: RequestUser, demandeId: string, dto: CreateDiagnosticDto) {
    if (user.role !== 'TECHNICIAN') {
      throw new ForbiddenException('Seul le technicien assigné peut ajouter un diagnostic.');
    }
    const demande = await this.requireAccess(user, demandeId);
    this.assertOpen(demande.status);

    const content = dto.content.trim();
    if (!content) throw new BadRequestException('Le diagnostic ne peut pas être vide.');

    const diagnostic = await this.prisma.diagnostic.create({
      data: {
        demandeId,
        technicianId: user.id,
        content,
        recommendation: dto.recommendation?.trim() || null,
      },
      include: { technician: { select: { id: true, firstName: true, lastName: true } } },
    });
    return this.toApiDiagnostic(diagnostic);
  }

  async listQuotes(user: RequestUser, demandeId: string) {
    await this.requireAccess(user, demandeId);
    const quotes = await this.prisma.quote.findMany({
      where: { demandeId },
      orderBy: { createdAt: 'desc' },
    });
    return quotes.map((quote) => this.toApiQuote(quote));
  }

  async createQuote(user: RequestUser, demandeId: string, dto: CreateQuoteDto) {
    if (user.role !== 'TECHNICIAN') {
      throw new ForbiddenException('Seul le technicien assigné peut proposer un tarif.');
    }
    const demande = await this.requireAccess(user, demandeId);
    this.assertOpen(demande.status);

    const description = dto.description.trim();
    if (!description) throw new BadRequestException('La description du tarif ne peut pas être vide.');

    const quote = await this.prisma.$transaction(async (tx) => {
      const accepted = await tx.quote.findFirst({
        where: { demandeId, status: 'ACCEPTED' },
        select: { id: true },
      });
      if (accepted) {
        throw new ConflictException('Un tarif a déjà été accepté pour cette demande.');
      }

      await tx.quote.updateMany({
        where: { demandeId, status: 'PENDING' },
        data: { status: 'REJECTED' },
      });

      return tx.quote.create({
        data: {
          demandeId,
          technicianId: user.id,
          amount: dto.amount,
          currency: dto.currency?.trim().toUpperCase() || DEFAULT_QUOTE_CURRENCY,
          description,
        },
      });
    });

    return this.toApiQuote(quote);
  }

  async respondToQuote(
    user: RequestUser,
    demandeId: string,
    quoteId: string,
    action: 'accept' | 'reject',
  ) {
    if (user.role !== 'CLIENT') {
      throw new ForbiddenException('Seul le client propriétaire peut répondre à une proposition.');
    }
    const demande = await this.requireAccess(user, demandeId);
    this.assertOpen(demande.status);

    const quote = await this.prisma.quote.findFirst({
      where: { id: quoteId, demandeId },
    });
    if (!quote) throw new NotFoundException('Proposition introuvable.');
    if (quote.status !== 'PENDING') {
      throw new ConflictException('Cette proposition a déjà été traitée.');
    }

    const updated = await this.prisma.quote.update({
      where: { id: quote.id },
      data: { status: action === 'accept' ? 'ACCEPTED' : 'REJECTED' },
    });
    return this.toApiQuote(updated);
  }
}