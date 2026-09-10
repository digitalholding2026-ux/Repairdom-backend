import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { RequestUser } from '../auth/auth.types.js';
import type { SendMessageDto } from './dto/send-message.dto.js';
import type { CreateDiagnosticDto } from './dto/create-diagnostic.dto.js';
import type { CreateQuoteDto } from './dto/create-quote.dto.js';
import type { SelectCatalogDiagnosticDto } from './dto/select-catalog-diagnostic.dto.js';

export const DEFAULT_QUOTE_CURRENCY = 'XAF';

interface AccessibleDemande {
  id: string;
  status: string;
  clientId: string;
  technicianId: string | null;
  negotiationRequestedAt: Date | null;
}

@Injectable()
export class CollaborationService {
  constructor(private readonly prisma: PrismaService) {}

  private async requireAccess(user: RequestUser, demandeId: string): Promise<AccessibleDemande> {
    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      select: {
        id: true,
        status: true,
        clientId: true,
        technicianId: true,
        negotiationRequestedAt: true,
      },
    });
    if (!demande) throw new NotFoundException('Demande introuvable.');
    if (user.role === 'CLIENT') {
      if (demande.clientId !== user.id) throw new NotFoundException('Demande introuvable.');
    } else {
      if (demande.technicianId !== user.id) throw new NotFoundException('Demande introuvable.');
    }
    return demande;
  }

  /** Une mission est « issue du catalogue » dès qu'un de ses diagnostics
   *  provient du catalogue (Sprint 8.1). */
  private async isCatalogFlow(demandeId: string) {
    const linked = await this.prisma.diagnostic.count({
      where: { demandeId, catalogDiagnosticId: { not: null } },
    });
    return linked > 0;
  }

  /** Chat verrouillé tant que le client n'a pas accepté le tarif auto ou demandé
   *  une négociation. Les missions « classiques » restent ouvertes. */
  private async assertChatAllowed(user: RequestUser, demandeId: string) {
    const demande = await this.requireAccess(user, demandeId);
    this.assertOpen(demande.status);
    if (!(await this.isCatalogFlow(demandeId))) return demande;
    if (demande.status === 'COMPLETED') return demande;

    const accepted = await this.prisma.quote.findFirst({
      where: { demandeId, status: 'ACCEPTED' },
      select: { id: true },
    });
    if (!demande.negotiationRequestedAt && !accepted) {
      throw new ForbiddenException(
        'La discussion est verrouillée : acceptez le tarif proposé ou demandez une négociation.',
      );
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
    source: string;
    catalogDiagnosticId: string | null;
    catalogInterventionId: string | null;
    initialReferencePrice: number | null;
    initialTravelFee: number | null;
    initialServiceFee: number | null;
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
      source: quote.source,
      catalogDiagnosticId: quote.catalogDiagnosticId,
      catalogInterventionId: quote.catalogInterventionId,
      breakdown: quote.source === 'CATALOG'
        ? {
            referencePrice: quote.initialReferencePrice,
            travelFee: quote.initialTravelFee,
            serviceFee: quote.initialServiceFee,
          }
        : null,
      createdAt: quote.createdAt.toISOString(),
    };
  }

  async listMessages(user: RequestUser, demandeId: string) {
    await this.assertChatAllowed(user, demandeId);
    const messages = await this.prisma.message.findMany({
      where: { demandeId },
      orderBy: { createdAt: 'asc' },
      include: { sender: { select: { id: true, firstName: true, lastName: true } } },
    });
    return messages.map((message) => this.toApiMessage(message));
  }

  async sendMessage(user: RequestUser, demandeId: string, dto: SendMessageDto) {
    await this.assertChatAllowed(user, demandeId);

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

    // Mission issue du catalogue : le tarif auto fait foi tant que le client n'a
    // pas demandé une négociation. Le technicien ne peut intervenir qu'après.
    if ((await this.isCatalogFlow(demandeId)) && !demande.negotiationRequestedAt) {
      throw new ForbiddenException(
        'Cette mission dispose d\'un tarif automatique. Le client doit demander une négociation avant toute modification du prix.',
      );
    }

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
  ) {    if (user.role !== 'CLIENT') {
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

    const updated = await this.prisma.$transaction(async (tx) => {
      const quote = await tx.quote.update({
        where: { id: quoteId },
        data: { status: action === 'accept' ? 'ACCEPTED' : 'REJECTED' },
      });
      if (action === 'accept') {
        // Traçabilité (Sprint 8.1) : le montant final de la mission est le
        // montant accepté du tarif.
        await tx.demande.update({
          where: { id: demandeId },
          data: { finalAmount: quote.amount },
        });
      }
      return quote;
    });
    return this.toApiQuote(updated);
  }

  /* ── Sprint 8.1 : catalogue → mission ─────────────────────────── */

  /** Propositions de diagnostics catalogue pour une mission donnée.
   *  Reçues par le technicien assigné ; hiérarchisées par spécificité
   *  (problème exact > problème générique ; marque puis modèle ancrés). */
  async suggestDiagnostics(user: RequestUser, demandeId: string) {
    if (user.role !== 'TECHNICIAN') {
      throw new ForbiddenException('Seul le technicien assigné peut consulter les propositions.');
    }
    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      select: {
        id: true,
        status: true,
        technicianId: true,
        domainId: true,
        brandId: true,
        modelId: true,
        problemId: true,
      },
    });
    if (!demande) throw new NotFoundException('Demande introuvable.');
    if (demande.technicianId !== user.id) throw new NotFoundException('Demande introuvable.');
    this.assertOpen(demande.status);

    // Le problème est retenu quand il correspond au domaine ET (générique
    // « marque/modèle vides » OU ancré sur la marque/le modèle de la demande).
    // NB : Prisma n'accepte pas null comme membre d'un filtre `in` — le cas
    // « générique » doit être exprimé explicitement via un OR (sinon
    // PrismaClientValidationError -> 500 sur cette route).
    const problemWhere: Prisma.ProblemWhereInput = { isActive: true, AND: [] };
    if (demande.domainId) problemWhere.domainId = demande.domainId;
    if (demande.brandId !== null) {
      problemWhere.AND!.push({ OR: [{ brandId: null }, { brandId: demande.brandId }] });
    }
    if (demande.modelId !== null) {
      problemWhere.AND!.push({ OR: [{ modelId: null }, { modelId: demande.modelId }] });
    }

    const candidates = await this.prisma.catalogDiagnostic.findMany({
      where: { isActive: true, problem: problemWhere },
      include: {
        problem: {
          include: {
            brand: { select: { id: true, name: true } },
            model: { select: { id: true, name: true } },
          },
        },
        interventions: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            name: true,
            slug: true,
            description: true,
            difficulty: true,
            estimatedTime: true,
            needsParts: true,
            partsNote: true,
          },
        },
      },
    });

    const ranked = candidates
      .map((d) => {
        let score = 0;
        if (demande.problemId && d.problemId === demande.problemId) score += 3;
        if (demande.brandId && d.problem.brandId === demande.brandId) score += 2;
        if (demande.modelId && d.problem.modelId === demande.modelId) score += 1;
        return { d, score };
      })
      .sort((a, b) => b.score - a.score);

    return {
      suggestions: ranked.map(({ d, score }) => ({
        id: d.id,
        name: d.name,
        slug: d.slug,
        description: d.description,
        confidence: d.confidence,
        difficulty: d.difficulty,
        estimatedTime: d.estimatedTime,
        problem: {
          id: d.problem.id,
          name: d.problem.name,
          slug: d.problem.slug,
          brand: d.problem.brand,
          model: d.problem.model,
        },
        interventions: d.interventions.map((i) => ({
          id: i.id,
          name: i.name,
          slug: i.slug,
          description: i.description,
          difficulty: i.difficulty,
          estimatedTime: i.estimatedTime,
          needsParts: i.needsParts,
          partsNote: i.partsNote,
        })),
        score,
      })),
      total: ranked.length,
      demand: {
        domainId: demande.domainId,
        brandId: demande.brandId,
        modelId: demande.modelId,
        problemId: demande.problemId,
      },
    };
  }

  /** Sélection du diagnostic de mission (mode CATALOG ou MANUAL).
   *  Mode CATALOG : transaction Diagnostic mission + tarif auto (snapshot).
   *  Mode MANUAL  : anomalie libre, aucun tarif automatique. */
  async selectCatalogDiagnostic(
    user: RequestUser,
    demandeId: string,
    dto: SelectCatalogDiagnosticDto,
  ) {
    if (user.role !== 'TECHNICIAN') {
      throw new ForbiddenException('Seul le technicien assigné peut enregistrer le diagnostic.');
    }
    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      select: {
        id: true,
        status: true,
        technicianId: true,
        domainId: true,
        brandId: true,
        modelId: true,
        negotiationRequestedAt: true,
      },
    });
    if (!demande) throw new NotFoundException('Demande introuvable.');
    if (demande.technicianId !== user.id) throw new NotFoundException('Demande introuvable.');
    this.assertOpen(demande.status);

    // Barrière KYC : le catalogue (prix auto + négociation) n'est accessible
    // qu'aux techniciens au profil validé.
    const profile = await this.prisma.technicianProfile.findUnique({
      where: { userId: user.id },
      select: { kycStatus: true },
    });
    if (!profile || profile.kycStatus !== 'VERIFIED') {
      throw new ForbiddenException('Votre dossier KYC doit être validé pour utiliser le catalogue.');
    }

    if (dto.mode === 'CATALOG') {
      if (!dto.catalogDiagnosticId || !dto.catalogInterventionId) {
        throw new BadRequestException(
          'Le mode catalogue exige un diagnostic et une intervention du catalogue.',
        );
      }
      const diag = await this.prisma.catalogDiagnostic.findUnique({
        where: { id: dto.catalogDiagnosticId },
        include: {
          problem: true,
          interventions: { where: { id: dto.catalogInterventionId } },
        },
      });
      if (!diag || !diag.isActive) {
        throw new BadRequestException('Diagnostic catalogue introuvable ou inactif.');
      }
      const intervention = diag.interventions[0];
      if (!intervention || !intervention.isActive) {
        throw new BadRequestException('Intervention catalogue introuvable ou inactif.');
      }
      if (demande.domainId && diag.problem.domainId !== demande.domainId) {
        throw new BadRequestException('Ce diagnostic n\'appartient pas au domaine de la demande.');
      }
      if (demande.modelId && diag.problem.modelId && diag.problem.modelId !== demande.modelId) {
        throw new BadRequestException('Ce diagnostic ne correspond pas au modèle de l\'appareil.');
      }
      if (demande.brandId && diag.problem.modelId === null && diag.problem.brandId && diag.problem.brandId !== demande.brandId) {
        throw new BadRequestException('Ce diagnostic ne correspond pas à la marque de l\'appareil.');
      }

      const pricing = await this.prisma.pricing.findUnique({
        where: { interventionId: intervention.id },
      });
      if (!pricing || !pricing.isActive) {
        throw new BadRequestException('Ce diagnostic n\'a pas de tarif actif dans le catalogue.');
      }

      const content =
        (dto.content?.trim() ??
          `Diagnostic catalogue : ${diag.name}. Intervention : ${intervention.name}.`) ||
        `Diagnostic catalogue : ${diag.name}.`;
      const recommendation = dto.recommendation?.trim() ?? null;

      return this.prisma.$transaction(async (tx) => {
        const pendingAutos = await tx.quote.findFirst({
          where: { demandeId, status: 'PENDING' },
          select: { id: true },
        });
        if (pendingAutos) {
          throw new ConflictException(
            'Un tarif est déjà en attente pour cette demande. Répondez-y avant tout nouveau diagnostic.',
          );
        }

        await tx.quote.updateMany({
          where: { demandeId, status: 'PENDING' },
          data: { status: 'REJECTED' },
        });

        const diagnostic = await tx.diagnostic.create({
          data: {
            demandeId,
            technicianId: user.id,
            content,
            recommendation,
            catalogDiagnosticId: diag.id,
            catalogInterventionId: intervention.id,
          },
          include: { technician: { select: { id: true, firstName: true, lastName: true } } },
        });

        const amount =
          (pricing.referencePrice ?? 0) +
          (pricing.travelFee ?? 0);
        const quote = await tx.quote.create({
          data: {
            demandeId,
            technicianId: user.id,
            amount,
            currency: pricing.currency || DEFAULT_QUOTE_CURRENCY,
            description: `Tarif RepairDom — ${intervention.name} (${diag.name})`,
            source: 'CATALOG',
            catalogDiagnosticId: diag.id,
            catalogInterventionId: intervention.id,
            initialReferencePrice: pricing.referencePrice,
            initialTravelFee: pricing.travelFee,
            initialServiceFee: pricing.serviceFee,
          },
        });

        return {
          mode: 'CATALOG',
          diagnostic: this.toApiDiagnostic(diagnostic),
          quote: this.toApiQuote(quote),
        };
      });
    }

    // Mode MANUAL (« Autre anomalie ») : diagnostic libre sans tarif auto.
    const content = dto.content?.trim();
    if (!content || content.length < 10) {
      throw new BadRequestException('Décrivez l\'anomalie constatée (10 caractères minimum).');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.quote.updateMany({
        where: { demandeId, status: 'PENDING' },
        data: { status: 'REJECTED' },
      });
      const diagnostic = await tx.diagnostic.create({
        data: {
          demandeId,
          technicianId: user.id,
          content,
          recommendation: dto.recommendation?.trim() || null,
          catalogDiagnosticId: null,
          catalogInterventionId: null,
        },
        include: { technician: { select: { id: true, firstName: true, lastName: true } } },
      });
      return { mode: 'MANUAL', diagnostic: this.toApiDiagnostic(diagnostic), quote: null };
    });
  }

  /** Le client déclenche la négociation du tarif automatique → ouverture du chat. */
  async requestNegotiation(user: RequestUser, demandeId: string, quoteId: string) {
    if (user.role !== 'CLIENT') {
      throw new ForbiddenException('Seul le client peut demander la négociation de son tarif.');
    }
    const demande = await this.requireAccess(user, demandeId);
    this.assertOpen(demande.status);

    const quote = await this.prisma.quote.findFirst({
      where: { id: quoteId, demandeId, source: 'CATALOG' },
    });
    if (!quote) {
      throw new NotFoundException('Tarif automatique introuvable pour cette demande.');
    }
    if (quote.status !== 'PENDING') {
      throw new ConflictException('Ce tarif a déjà été traité.');
    }

    const updated = await this.prisma.demande.update({
      where: { id: demandeId },
      data: { negotiationRequestedAt: new Date() },
    });
    return {
      demandeId: updated.id,
      negotiationRequestedAt: updated.negotiationRequestedAt!.toISOString(),
    };
  }

  async summary(user: RequestUser, demandeId: string) {
    await this.requireAccess(user, demandeId);

    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      include: {
        client: {
          select: { id: true, firstName: true, lastName: true, phone: true },
        },
        domain: { select: { id: true, name: true, slug: true } },
        brand: { select: { id: true, name: true, slug: true } },
        model: { select: { id: true, name: true, slug: true } },
        problem: { select: { id: true, name: true, slug: true } },
        technician: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            technicianProfile: { select: { city: true } },
          },
        },
      },
    });
    if (!demande) throw new NotFoundException('Demande introuvable.');

    const diagnostics = await this.prisma.diagnostic.findMany({
      where: { demandeId },
      orderBy: { createdAt: 'desc' },
      take: 1,
      include: { technician: { select: { id: true, firstName: true, lastName: true } } },
    });
    const latestDiagnostic = diagnostics[0] ?? null;

    const quotes = await this.prisma.quote.findMany({
      where: { demandeId },
      orderBy: { createdAt: 'desc' },
    });
    const acceptedQuote =
      quotes.find((q) => q.status === 'ACCEPTED') ?? quotes[0] ?? null;

    const technician = demande.technician
      ? {
          id: demande.technician.id,
          firstName: demande.technician.firstName,
          lastName: demande.technician.lastName,
          phone: demande.technician.phone,
          city: demande.technician.technicianProfile?.city ?? null,
        }
      : null;

    return {
      demandeId: demande.id,
      reference: demande.reference,
      status: demande.status,
      category: demande.category,
      description: demande.description,
      device: {
        domain: demande.domain
          ? { id: demande.domain.id, name: demande.domain.name, slug: demande.domain.slug }
          : null,
        brand: demande.brand
          ? { id: demande.brand.id, name: demande.brand.name, slug: demande.brand.slug }
          : null,
        model: demande.model
          ? { id: demande.model.id, name: demande.model.name, slug: demande.model.slug }
          : null,
        problem: demande.problem
          ? { id: demande.problem.id, name: demande.problem.name, slug: demande.problem.slug }
          : null,
      },
      negotiationRequestedAt: demande.negotiationRequestedAt
        ? demande.negotiationRequestedAt.toISOString()
        : null,
      finalAmount: demande.finalAmount,
      technician,
      scheduledAt: demande.scheduledAt ? demande.scheduledAt.toISOString() : null,
      requestedMode: demande.requestedMode,
      requestedAt: demande.requestedAt ? demande.requestedAt.toISOString() : null,
      createdAt: demande.createdAt.toISOString(),
      diagnostic: latestDiagnostic
        ? {
            id: latestDiagnostic.id,
            content: latestDiagnostic.content,
            recommendation: latestDiagnostic.recommendation,
            technician: latestDiagnostic.technician,
            createdAt: latestDiagnostic.createdAt.toISOString(),
          }
        : null,
      quote: acceptedQuote
        ? {
            id: acceptedQuote.id,
            amount: acceptedQuote.amount,
            currency: acceptedQuote.currency,
            description: acceptedQuote.description,
            status: acceptedQuote.status,
            source: acceptedQuote.source,
            breakdown:
              acceptedQuote.source === 'CATALOG'
                ? {
                    referencePrice: acceptedQuote.initialReferencePrice,
                    travelFee: acceptedQuote.initialTravelFee,
                    serviceFee: acceptedQuote.initialServiceFee,
                  }
                : null,
          }
        : null,
      location: {
        city: demande.city,
        neighborhood: demande.neighborhood,
        address: demande.address,
        landmark: demande.landmark,
        contactPhone: demande.contactPhone,
      },
    };
  }
}