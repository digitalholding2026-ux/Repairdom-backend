import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  KYC_BUCKET,
  SupabaseStorageService,
} from '../technician/supabase-storage.service.js';
import { Role } from '../generated/prisma/enums.js';
import type { KycStatus } from '../generated/prisma/enums.js';
import type { UpdateKycStatusDto } from './dto/update-kyc-status.dto.js';
import { toApiEvent } from '../mission-events/mission-events.js';

const ALLOWED_KYC_STATUSES: KycStatus[] = ['NOT_SUBMITTED', 'PENDING', 'VERIFIED', 'REJECTED'];

/* Nombre max de comptes clients retournés par la recherche admin. */
export const ADMIN_CLIENT_SEARCH_LIMIT = 20;

/** Durée de validité des signed URLs de consultation KYC : 5 minutes. */
export const KYC_SIGNED_URL_TTL_SECONDS = 300;

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
  ) {}

  async listKycFolders(status?: string) {
    const resolvedStatus = status ?? 'PENDING';
    if (!ALLOWED_KYC_STATUSES.includes(resolvedStatus as KycStatus)) {
      throw new BadRequestException('Statut de dossier invalide.');
    }

    const profiles = await this.prisma.technicianProfile.findMany({
      where: { kycStatus: resolvedStatus as KycStatus },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            kycDocuments: { select: { createdAt: true } },
          },
        },
      },
    });

    const items = profiles.map((profile) => {
      const documents = profile.user.kycDocuments;
      let latest: Date | null = null;
      for (const document of documents) {
        if (!latest || document.createdAt.getTime() > latest.getTime()) {
          latest = document.createdAt;
        }
      }
      return {
        technicianId: profile.user.id,
        firstName: profile.user.firstName,
        lastName: profile.user.lastName,
        city: profile.city,
        categories: profile.categories,
        kycStatus: profile.kycStatus,
        submittedAt: latest?.toISOString() ?? null,
        documentCount: documents.length,
      };
    });

    items.sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''));

    return { items };
  }

  async getKycFolder(technicianId: string) {
    const technician = await this.prisma.user.findUnique({
      where: { id: technicianId },
      include: {
        technicianProfile: true,
        kycDocuments: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
        kycReviews: {
          orderBy: { createdAt: 'desc' },
          take: 30,
          include: { reviewer: { select: { firstName: true, lastName: true } } },
        },
      },
    });
    if (!technician || technician.role !== 'TECHNICIAN' || !technician.technicianProfile) {
      throw new NotFoundException('Dossier KYC introuvable.');
    }

    const profile = technician.technicianProfile;
    const completedInterventions = await this.prisma.demande.count({
      where: { technicianId, status: 'CONFIRMED' },
    });

    return {
      technician: {
        id: technician.id,
        firstName: technician.firstName,
        lastName: technician.lastName,
        phone: technician.phone,
        avatarUrl: profile.avatarUrl,
        city: profile.city,
        categories: profile.categories,
        specialties: profile.specialties,
        experience: profile.experience,
        serviceDescription: profile.serviceDescription,
        bio: profile.bio,
        isAvailable: profile.isAvailable,
        kycStatus: profile.kycStatus,
        kycRejectionReason: profile.kycRejectionReason,
        completedInterventions,
        registeredAt: technician.createdAt.toISOString(),
      },
      documents: technician.kycDocuments.map((document) => ({
        id: document.id,
        type: document.type,
        originalName: document.originalName,
        mimeType: document.mimeType,
        size: document.size,
        createdAt: document.createdAt.toISOString(),
      })),
      reviews: technician.kycReviews.map((review) => ({
        reviewerId: review.reviewerId,
        reviewerName: [review.reviewer.firstName, review.reviewer.lastName]
          .filter(Boolean)
          .join(' '),
        previousStatus: review.previousStatus,
        newStatus: review.newStatus,
        reason: review.reason ?? null,
        createdAt: review.createdAt.toISOString(),
      })),
    };
  }

  async getKycDocumentUrl(technicianId: string, documentId: string) {
    const technician = await this.prisma.user.findUnique({
      where: { id: technicianId },
      include: { technicianProfile: true },
    });
    if (!technician || technician.role !== 'TECHNICIAN' || !technician.technicianProfile) {
      throw new NotFoundException('Dossier KYC introuvable.');
    }

    const document = await this.prisma.kycDocument.findFirst({
      where: { id: documentId, technicianId },
    });
    if (!document) throw new NotFoundException('Document introuvable.');

    if (!this.storage.isConfigured) {
      throw new ServiceUnavailableException(
        'La consultation des documents est indisponible pour le moment.',
      );
    }

    const url = await this.storage.createSignedUrl(
      KYC_BUCKET,
      document.storagePath,
      KYC_SIGNED_URL_TTL_SECONDS,
    );

    return {
      url,
      expiresIn: KYC_SIGNED_URL_TTL_SECONDS,
      mimeType: document.mimeType,
      originalName: document.originalName,
    };
  }

  async updateKycStatus(
    technicianId: string,
    reviewerId: string,
    dto: UpdateKycStatusDto,
  ) {
    const profile = await this.prisma.technicianProfile.findUnique({
      where: { userId: technicianId },
    });
    if (!profile) throw new NotFoundException('Dossier KYC introuvable.');
    if (profile.kycStatus !== 'PENDING') {
      throw new ConflictException('Le dossier n’est plus en attente de vérification.');
    }

    const reason = dto.reason?.trim() ?? null;
    if (dto.status === 'REJECTED' && !reason) {
      throw new BadRequestException('Le motif de rejet est requis.');
    }
    if (dto.status === 'VERIFIED' && reason) {
      throw new BadRequestException('Aucun motif n’est attendu lors d’une validation.');
    }

    await this.prisma.$transaction([
      this.prisma.technicianProfile.update({
        where: { userId: technicianId },
        data: {
          kycStatus: dto.status,
          kycRejectionReason: dto.status === 'REJECTED' ? reason : null,
        },
      }),
      this.prisma.kycReview.create({
        data: {
          technicianId,
          reviewerId,
          previousStatus: profile.kycStatus,
          newStatus: dto.status,
          reason: dto.status === 'REJECTED' ? reason : null,
        },
      }),
    ]);

    return this.getKycFolder(technicianId);
  }

  /* ── Supervision des missions (Sprint 8.6.5) ────────────────── */
  /* Recherche d'une mission par sa référence publique « RD-XXXXXX ».
   * Lecture seule, réservée à l'admin : la chronologie réutilise les
   * événements métier existants (toApiEvent) sans système parallèle, et le
   * DTO n'expose aucun secret (pas de storagePath KYC, ni de données
   * sensibles autres que celles déjà visibles des acteurs de la mission). */

  async getDemandeByReference(reference: string) {
    const ref = reference.trim().toUpperCase();
    if (!ref) throw new BadRequestException('Référence de mission invalide.');

    const demande = await this.prisma.demande.findUnique({
      where: { reference: ref },
      include: {
        domain: { select: { id: true, name: true } },
        brand: { select: { id: true, name: true } },
        model: { select: { id: true, name: true } },
        problem: { select: { id: true, name: true } },
        client: { select: { id: true, firstName: true, lastName: true, phone: true } },
        technician: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            technicianProfile: { select: { city: true, kycStatus: true } },
          },
        },
        diagnostics: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            mode: true,
            content: true,
            recommendation: true,
            proposedIntervention: true,
            justification: true,
            notes: true,
            createdAt: true,
            technician: { select: { id: true, firstName: true, lastName: true } },
            catalogDiagnostic: { select: { id: true, name: true } },
            catalogIntervention: { select: { id: true, name: true } },
          },
        },
        quotes: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            amount: true,
            currency: true,
            status: true,
            source: true,
            description: true,
            initialReferencePrice: true,
            initialTravelFee: true,
            initialServiceFee: true,
            createdAt: true,
            technician: { select: { id: true, firstName: true, lastName: true } },
            diagnostic: {
              select: {
                id: true,
                mode: true,
                content: true,
                proposedIntervention: true,
                justification: true,
                notes: true,
              },
            },
            catalogDiagnostic: { select: { id: true, name: true } },
            catalogIntervention: { select: { id: true, name: true } },
          },
        },
        events: {
          orderBy: { createdAt: 'asc' },
          take: 200,
          include: {
            actor: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });

    if (!demande) throw new NotFoundException('Mission introuvable.');

    const technician = demande.technician;
    const profile = technician?.technicianProfile;

    return {
      reference: demande.reference,
      status: demande.status,
      category: demande.category,
      description: demande.description,
      contact: {
        city: demande.city,
        neighborhood: demande.neighborhood,
        address: demande.address,
        landmark: demande.landmark,
        contactPhone: demande.contactPhone,
      },
      device: {
        domain: demande.domain
          ? { id: demande.domain.id, name: demande.domain.name }
          : null,
        brand: demande.brand
          ? { id: demande.brand.id, name: demande.brand.name }
          : null,
        model: demande.model
          ? { id: demande.model.id, name: demande.model.name }
          : null,
        problem: demande.problem
          ? { id: demande.problem.id, name: demande.problem.name }
          : null,
      },
      client: demande.client
        ? {
            id: demande.client.id,
            firstName: demande.client.firstName,
            lastName: demande.client.lastName,
            phone: demande.client.phone,
          }
        : null,
      technician: technician
        ? {
            id: technician.id,
            firstName: technician.firstName,
            lastName: technician.lastName,
            phone: technician.phone,
            city: profile?.city ?? null,
            kycVerified: profile?.kycStatus === 'VERIFIED',
          }
        : null,
      request: {
        requestedMode: demande.requestedMode,
        requestedAt: demande.requestedAt?.toISOString() ?? null,
        scheduledAt: demande.scheduledAt?.toISOString() ?? null,
        negotiationRequestedAt: demande.negotiationRequestedAt?.toISOString() ?? null,
      },
      finalAmount: demande.finalAmount ?? null,
      diagnostics: demande.diagnostics.map((diagnostic) => ({
        id: diagnostic.id,
        mode: diagnostic.mode,
        content: diagnostic.content,
        recommendation: diagnostic.recommendation ?? null,
        proposedIntervention: diagnostic.proposedIntervention ?? null,
        justification: diagnostic.justification ?? null,
        notes: diagnostic.notes ?? null,
        createdAt: diagnostic.createdAt.toISOString(),
        technician: diagnostic.technician
          ? {
              id: diagnostic.technician.id,
              firstName: diagnostic.technician.firstName,
              lastName: diagnostic.technician.lastName,
            }
          : null,
        catalogDiagnostic: diagnostic.catalogDiagnostic
          ? {
              id: diagnostic.catalogDiagnostic.id,
              name: diagnostic.catalogDiagnostic.name,
            }
          : null,
        catalogIntervention: diagnostic.catalogIntervention
          ? {
              id: diagnostic.catalogIntervention.id,
              name: diagnostic.catalogIntervention.name,
            }
          : null,
      })),
      quotes: demande.quotes.map((quote) => ({
        id: quote.id,
        amount: quote.amount,
        currency: quote.currency,
        status: quote.status,
        source: quote.source,
        description: quote.description,
        createdAt: quote.createdAt.toISOString(),
        technician: quote.technician
          ? {
              id: quote.technician.id,
              firstName: quote.technician.firstName,
              lastName: quote.technician.lastName,
            }
          : null,
        diagnostic: quote.diagnostic
          ? {
              id: quote.diagnostic.id,
              mode: quote.diagnostic.mode,
              content: quote.diagnostic.content,
              proposedIntervention: quote.diagnostic.proposedIntervention ?? null,
              justification: quote.diagnostic.justification ?? null,
              notes: quote.diagnostic.notes ?? null,
            }
          : null,
        catalogDiagnostic: quote.catalogDiagnostic
          ? {
              id: quote.catalogDiagnostic.id,
              name: quote.catalogDiagnostic.name,
            }
          : null,
        catalogIntervention: quote.catalogIntervention
          ? {
              id: quote.catalogIntervention.id,
              name: quote.catalogIntervention.name,
            }
          : null,
        breakdown: quote.initialReferencePrice
          ? {
              referencePrice: quote.initialReferencePrice,
              travelFee: quote.initialTravelFee,
              serviceFee: quote.initialServiceFee,
            }
          : null,
      })),
      events: demande.events.map(toApiEvent),
      createdAt: demande.createdAt.toISOString(),
      updatedAt: demande.updatedAt.toISOString(),
    };
  }

  /* ── Rechargement des comptes de test (Sprint 8.7 — simulateur) ─ */
  /* Recherche de comptes CLIENT pour la sélection dans le formulaire
   * admin « Créditer un compte de test ». Lecture seule, réservée ADMIN :
   * n'expose que l'identité minimale nécessaire à la sélection
   * (id / prénom / nom / email) — jamais de données financières, KYC,
   * ni autre donnée sensible. */
  async searchClientUsers(query: string) {
    const q = query.trim();
    if (!q) return { items: [] };

    const users = await this.prisma.user.findMany({
      where: {
        role: Role.CLIENT,
        OR: [
          { firstName: { contains: q, mode: 'insensitive' } },
          { lastName: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
      },
      orderBy: { firstName: 'asc' },
      take: ADMIN_CLIENT_SEARCH_LIMIT,
    });

    return {
      items: users.map((user) => ({
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
      })),
    };
  }
}