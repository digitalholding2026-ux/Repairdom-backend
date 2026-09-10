import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RequestUser } from '../auth/auth.types.js';
import type { CreateReviewDto } from './dto/create-review.dto.js';

export interface ReputationDto {
  averageRating: number | null;
  totalReviews: number;
}

interface ReviewWithParty {
  id: string;
  demandeId: string;
  authorId: string;
  targetId: string;
  rating: number;
  comment: string | null;
  createdAt: Date;
  author: { id: string; firstName: string; lastName: string | null };
  target: { id: string; firstName: string; lastName: string | null };
}

const REVIEW_PARTY_SELECT = {
  select: { id: true, firstName: true, lastName: true },
} as const;

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  private toApiReview(review: ReviewWithParty) {
    return {
      id: review.id,
      demandeId: review.demandeId,
      authorId: review.authorId,
      targetId: review.targetId,
      rating: review.rating,
      comment: review.comment,
      createdAt: review.createdAt.toISOString(),
      author: review.author,
      target: review.target,
    };
  }

  private toReputation(averageRating: number | null, totalReviews: number): ReputationDto {
    if (totalReviews === 0 || averageRating === null) {
      return { averageRating: null, totalReviews: 0 };
    }
    return {
      averageRating: Math.round(averageRating * 10) / 10,
      totalReviews,
    };
  }

  async createReview(user: RequestUser, demandeId: string, dto: CreateReviewDto) {
    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      select: { id: true, status: true, clientId: true, technicianId: true },
    });
    if (!demande) throw new NotFoundException('Demande introuvable.');

    // Réputation basée uniquement sur des interventions réellement confirmées.
    if (demande.status !== 'CONFIRMED') {
      throw new ConflictException(
        'L’intervention doit être confirmée avant de pouvoir publier un avis.',
      );
    }
    if (!demande.technicianId) {
      throw new ConflictException('Aucun technicien n’est associé à cette intervention.');
    }

    // L'auteur vient du JWT (jamais du corps de requête) et la cible est
    // déduite automatiquement comme étant l'autre partie de la demande.
    const isAuthorized =
      (user.role === 'CLIENT' && demande.clientId === user.id) ||
      (user.role === 'TECHNICIAN' && demande.technicianId === user.id);
    if (!isAuthorized) {
      throw new ForbiddenException('Vous ne pouvez pas évaluer cette intervention.');
    }

    const targetId = user.role === 'CLIENT' ? demande.technicianId : demande.clientId;
    if (targetId === user.id) {
      throw new ForbiddenException('Vous ne pouvez pas vous évaluer vous-même.');
    }

    const comment = dto.comment?.trim() || null;

    try {
      const review = await this.prisma.review.create({
        data: {
          demandeId,
          authorId: user.id,
          targetId,
          rating: dto.rating,
          comment,
        },
        include: {
          author: REVIEW_PARTY_SELECT,
          target: REVIEW_PARTY_SELECT,
        },
      });
      return this.toApiReview(review);
    } catch (error) {
      // @@unique([demandeId, authorId]) : deux requêtes simultanées ne peuvent
      // pas créer le doublon — on renvoie une erreur métier claire.
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException('Vous avez déjà évalué cette intervention.');
      }
      throw error;
    }
  }

  async listForDemande(user: RequestUser, demandeId: string) {
    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      select: { id: true, clientId: true, technicianId: true },
    });
    if (!demande) throw new NotFoundException('Demande introuvable.');

    const isAuthorized =
      demande.clientId === user.id ||
      (demande.technicianId !== null && demande.technicianId === user.id);
    if (!isAuthorized) {
      throw new NotFoundException('Demande introuvable.');
    }

    const reviews = await this.prisma.review.findMany({
      where: { demandeId },
      orderBy: { createdAt: 'desc' },
      include: {
        author: REVIEW_PARTY_SELECT,
        target: REVIEW_PARTY_SELECT,
      },
    });

    const mine = reviews.find((review) => review.authorId === user.id) ?? null;
    return {
      reviews: reviews.map((review) => this.toApiReview(review)),
      mine: mine ? this.toApiReview(mine) : null,
    };
  }

  async getReputation(targetId: string): Promise<ReputationDto> {
    const aggregate = await this.prisma.review.aggregate({
      where: { targetId },
      _avg: { rating: true },
      _count: true,
    });
    return this.toReputation(aggregate._avg.rating ?? null, aggregate._count ?? 0);
  }

  /** Réputation d'un technicien : publique dans le contexte authentifié
   *  (profil technicien consulté par les clients et les autres techniciens). */
  async getTechnicianReputation(_user: RequestUser, targetId: string): Promise<ReputationDto> {
    return this.getReputation(targetId);
  }

  /** Réputation d'un client : réservée au client lui-même ou au technicien
   *  ayant réellement travaillé avec lui (mission confirmée non requise).
   *  Empêche l'espionnage de la réputation d'inconnus. */
  async getClientReputation(user: RequestUser, targetId: string): Promise<ReputationDto> {
    const isOwner = user.role === 'CLIENT' && user.id === targetId;
    const isMissionTechnician =
      user.role === 'TECHNICIAN' &&
      (await this.prisma.demande.findFirst({
        where: { clientId: targetId, technicianId: user.id },
        select: { id: true },
      })) !== null;

    if (!isOwner && !isMissionTechnician) {
      throw new ForbiddenException('Vous ne pouvez pas consulter la réputation de ce client.');
    }
    return this.getReputation(targetId);
  }
}