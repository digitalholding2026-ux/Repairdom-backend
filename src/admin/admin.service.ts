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
import type { KycStatus } from '../generated/prisma/enums.js';
import type { UpdateKycStatusDto } from './dto/update-kyc-status.dto.js';

const ALLOWED_KYC_STATUSES: KycStatus[] = ['NOT_SUBMITTED', 'PENDING', 'VERIFIED', 'REJECTED'];

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
}