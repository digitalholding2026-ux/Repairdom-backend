import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { toApiDemande, toApiDemandePublic, isMatchingStatus, compareDemandePriority } from '../demandes/demande-helpers.js';
import { assertTransition } from '../demandes/demandes-lifecycle.js';
import {
  buildNotification,
  createNotification,
  eventTypeForStatus,
  recordEvent,
} from '../mission-events/mission-events.js';
import type { UpdateTechnicianProfileDto } from './dto/update-technician-profile.dto.js';
import type { TechnicianUpdateStatusDto } from './dto/update-status.dto.js';
import { resolveCityId } from '../geo/city-reference.js';
import { filterActiveCoverageZoneIdsForCity } from '../geo/geo-matching.js';
import { SupabaseStorageService, AVATAR_BUCKET } from './supabase-storage.service.js';
import {
  AVATAR_EXTENSION_BY_MIME,
  MAX_AVATAR_SIZE,
  isAllowedAvatarMimetype,
  isImageBuffer,
  type UploadedAvatarFile,
} from './avatar-file.js';
import {
  KYC_EXTENSION_BY_MIME,
  MAX_KYC_DOCUMENT_SIZE,
  isAllowedKycDocumentType,
  isAllowedKycMimetype,
  isKycDocumentBuffer,
  type UploadedKycFile,
} from './kyc-file.js';
import type { KycDocumentType } from '../generated/prisma/enums.js';
import { ReviewsService } from '../reviews/reviews.service.js';

// Correctif boucle circulaire DISPATCH-V1 : les prédicats géographiques
// partagés vivent dans le module feuille `../geo/geo-eligibility.js` (aucune
// dépendance de service). Ré-exportés ici pour compatibilité des imports
// existants (`geo-eligibility.spec.ts`, `dispatch.service.ts` historique).
export {
  isCityMatch,
  isGeoEligible,
  normalizeValue,
} from '../geo/geo-eligibility.js';
export type { GeoEligibilityInput } from '../geo/geo-eligibility.js';
import { isGeoEligible, normalizeValue } from '../geo/geo-eligibility.js';

function normalizeCategory(value: string): string {
  return normalizeValue(value);
}

export interface PublicTechnicianProfile {
  id: string;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  avatarUrl: string | null;
  city: string;
  // Sprint 8.8.2 — la couverture reste une donnée personnelle (GET
  // /technician/coverage) : le profil public n'expose ni `cityId` ni zones.
  categories: string[];
  specialties: string[];
  bio: string | null;
  experience: string | null;
  serviceDescription: string | null;
  isAvailable: boolean;
  kycStatus: string;
  completedInterventions: number;
  registeredAt: string;
}

interface PrivateProfileRow {
  id: string;
  userId: string;
  city: string;
  cityId: string | null;
  categories: string[];
  isAvailable: boolean;
  avatarUrl: string | null;
  bio: string | null;
  experience: string | null;
  serviceDescription: string | null;
  specialties: string[];
  kycStatus: string;
  kycRejectionReason: string | null;
  createdAt: Date;
  user: { firstName: string; lastName: string | null; phone: string | null; email: string; role: string };
}

@Injectable()
export class TechnicianService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
    private readonly reviews: ReviewsService,
  ) {}

  /** Contexte appareil (catalogue, Sprint 8.1) sur les demandes techniques :
   *  à rejoindre à tout `include`/`select` de demande côté technicien.
   *  Sprint 8.8.2 : la zone et la ville structurées sont jointes pour le
   *  matching et la sérialisation (sans exposer d'adresse privée). */
  private readonly deviceInclude = {
    medias: true,
    zoneRef: { select: { id: true, name: true, slug: true, cityId: true } },
    cityRef: { select: { id: true, name: true, slug: true } },
    domain: { select: { id: true, name: true, slug: true } },
    brand: { select: { id: true, name: true, slug: true } },
    model: { select: { id: true, name: true, slug: true } },
    problem: { select: { id: true, name: true, slug: true } },
  };

  private async completedInterventionsCount(technicianId: string): Promise<number> {
    return this.prisma.demande.count({
      where: { technicianId, status: 'CONFIRMED' },
    });
  }

  async getProfile(userId: string) {
    const profile = await this.prisma.technicianProfile.findUnique({
      where: { userId },
      include: { user: { select: { firstName: true, lastName: true, phone: true, email: true, role: true } } },
    });
    if (!profile) throw new NotFoundException('Profil technicien introuvable.');
    const completedInterventions = await this.completedInterventionsCount(userId);
    return this.serializePrivate(profile, completedInterventions);
  }

  async updateProfile(userId: string, dto: UpdateTechnicianProfileDto) {
    let profile: PrivateProfileRow;

    const existing = await this.prisma.technicianProfile.findUnique({ where: { userId } });

    if (!existing) {
      if (!dto.city || !dto.categories || dto.categories.length === 0) {
        throw new BadRequestException(
          'Profil technicien incomplet. Veuillez compléter votre profil.',
        );
      }
      // Sprint 8.8.2 (règle D) — résolution non bloquante : correspondance
      // unique active → cityId, sinon null, sans modifier le texte saisi.
      const cityId = await resolveCityId(this.prisma, dto.city.trim());
      profile = await this.prisma.technicianProfile.create({
        data: {
          userId,
          city: dto.city.trim(),
          cityId,
          categories: dto.categories,
          isAvailable: dto.isAvailable ?? false,
          avatarUrl: dto.avatarUrl ?? null,
          bio: dto.bio ?? null,
          experience: dto.experience ?? null,
          serviceDescription: dto.serviceDescription ?? null,
          specialties: dto.specialties ?? [],
        },
        include: { user: { select: { firstName: true, lastName: true, phone: true, email: true, role: true } } },
      });
    } else {
      // Un texte de ville modifié invalide le `cityId` précédent : il est
      // re-résolu (ou remis à null) au lieu d'être conservé tel quel.
      const cityId =
        dto.city !== undefined ? await resolveCityId(this.prisma, dto.city.trim()) : undefined;
      profile = await this.prisma.technicianProfile.update({
        where: { userId },
        data: {
          ...(dto.city !== undefined ? { city: dto.city.trim(), cityId } : {}),
          ...(dto.categories !== undefined ? { categories: dto.categories } : {}),
          ...(dto.isAvailable !== undefined ? { isAvailable: dto.isAvailable } : {}),
          ...(dto.avatarUrl !== undefined ? { avatarUrl: dto.avatarUrl } : {}),
          ...(dto.bio !== undefined ? { bio: dto.bio } : {}),
          ...(dto.experience !== undefined ? { experience: dto.experience } : {}),
          ...(dto.serviceDescription !== undefined ? { serviceDescription: dto.serviceDescription } : {}),
          ...(dto.specialties !== undefined ? { specialties: dto.specialties } : {}),
        },
        include: { user: { select: { firstName: true, lastName: true, phone: true, email: true, role: true } } },
      });
    }

    const completedInterventions = await this.completedInterventionsCount(userId);
    return this.serializePrivate(profile, completedInterventions);
  }

  /* Sprint 8.8.2 — couvertures géographiques du technicien connecté.
   * Lecture strictement personnelle : aucun identifiant de tiers n'est
   * accepté, l'utilisateur ne voit que sa propre couverture. */
  async getCoverage(userId: string) {
    const profile = await this.requireProfile(userId);
    return this.coverageView(profile.id);
  }

  private async coverageView(technicianProfileId: string) {
    const coverages = await this.prisma.technicianZoneCoverage.findMany({
      where: { technicianProfileId },
      include: {
        zone: {
          select: {
            id: true,
            name: true,
            slug: true,
            isActive: true,
            cityId: true,
            city: { select: { id: true, name: true, slug: true } },
          },
        },
      },
      orderBy: [{ zone: { sortOrder: 'asc' } }, { zone: { name: 'asc' } }],
    });
    return coverages.map((coverage) => ({
      zoneId: coverage.zone.id,
      name: coverage.zone.name,
      slug: coverage.zone.slug,
      isActive: coverage.zone.isActive,
      city: coverage.zone.city,
    }));
  }

  /* Sprint 8.8.2 (règles C + F) — remplacement idempotent de la couverture.
   * 1. Le profil doit posséder un `cityId` (sinon aucune couverture
   *    intra-ville ne peut être validée → 400 explicite).
   * 2. Chaque zone doit exister, être active et appartenir au `cityId` du
   *    profil (intra-ville uniquement pour ce sprint).
   * 3. TOUTES les validations réussissent AVANT toute écriture : un échec
   *    laisse les couvertures précédentes intactes.
   * 4. Remplacement transactionnel (deleteMany + createMany) : rejouer la
   *    même charge produit le même état (idempotence). */
  async setCoverage(userId: string, zoneIds: string[]) {
    const profile = await this.requireProfile(userId);

    if (!profile.cityId) {
      throw new BadRequestException(
        'Votre ville de référence n’est pas rattachée au référentiel. Mettez à jour votre ville d’intervention avant de déclarer vos zones couvertes.',
      );
    }

    const uniqueZoneIds = [...new Set(zoneIds)];

    if (uniqueZoneIds.length > 0) {
      const zones = await this.prisma.zone.findMany({
        where: { id: { in: uniqueZoneIds } },
        select: { id: true, isActive: true, cityId: true },
      });
      const foundById = new Map(zones.map((zone) => [zone.id, zone]));
      for (const zoneId of uniqueZoneIds) {
        const zone = foundById.get(zoneId);
        if (!zone) {
          throw new NotFoundException('Zone introuvable.');
        }
        if (!zone.isActive) {
          throw new BadRequestException('Cette zone n’est plus disponible.');
        }
        if (zone.cityId !== profile.cityId) {
          throw new BadRequestException(
            'Cette zone n’appartient pas à votre ville d’intervention.',
          );
        }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.technicianZoneCoverage.deleteMany({
        where: { technicianProfileId: profile.id },
      });
      if (uniqueZoneIds.length > 0) {
        await tx.technicianZoneCoverage.createMany({
          data: uniqueZoneIds.map((zoneId) => ({
            technicianProfileId: profile.id,
            zoneId,
          })),
          skipDuplicates: true,
        });
      }
    });

    return this.getCoverage(userId);
  }

  /** Identifiants des zones couvertes retenues pour le matching (GEO-04 :
   *  actives ET appartenant à la ville de référence courante du profil).
   *  Filtrage défensif sans suppression : un changement de ville neutralise
   *  immédiatement les anciennes couvertures, les lignes restant en base. */
  private async activeCoverageZoneIds(
    technicianProfileId: string,
    technicianCityId: string | null,
  ): Promise<string[]> {
    if (!technicianCityId) return [];
    const coverages = await this.prisma.technicianZoneCoverage.findMany({
      where: {
        technicianProfileId,
        zone: { isActive: true, cityId: technicianCityId },
      },
      select: {
        zoneId: true,
        zone: { select: { isActive: true, cityId: true } },
      },
    });
    return filterActiveCoverageZoneIdsForCity(coverages, technicianCityId);
  }

  async uploadAvatar(userId: string, file: UploadedAvatarFile | undefined) {
    const profile = await this.prisma.technicianProfile.findUnique({
      where: { userId },
      include: { user: { select: { firstName: true, lastName: true, phone: true, email: true, role: true } } },
    });
    if (!profile) throw new NotFoundException('Profil technicien introuvable.');
    if (!file) throw new BadRequestException('Fichier manquant.');
    if (!isAllowedAvatarMimetype(file.mimetype)) {
      throw new BadRequestException('Format non supporté. Formats acceptés : JPG, PNG, WEBP.');
    }
    if (file.size > MAX_AVATAR_SIZE) {
      throw new BadRequestException('Le fichier dépasse 5 Mo.');
    }
    if (!isImageBuffer(file.buffer)) {
      throw new BadRequestException('Le fichier n’est pas une image valide.');
    }
    if (!this.storage.isConfigured) {
      throw new ServiceUnavailableException('L’upload de photo n’est pas disponible pour le moment.');
    }

    const extension = AVATAR_EXTENSION_BY_MIME[file.mimetype];
    const path = `technicians/${userId}/${randomUUID()}.${extension}`;
    await this.storage.uploadObject(path, file.buffer, file.mimetype);
    const avatarUrl = this.storage.publicUrl(path);

    let updated: PrivateProfileRow;
    try {
      updated = await this.prisma.technicianProfile.update({
        where: { userId },
        data: { avatarUrl },
        include: { user: { select: { firstName: true, lastName: true, phone: true, email: true, role: true } } },
      });
    } catch (error) {
      await this.storage.deleteObject(path).catch(() => undefined);
      throw error;
    }

    if (profile.avatarUrl) {
      const previousPath = this.extractObjectPath(profile.avatarUrl);
      if (previousPath && previousPath !== path) {
        await this.storage.deleteObject(previousPath).catch(() => undefined);
      }
    }

    const completedInterventions = await this.completedInterventionsCount(userId);
    return this.serializePrivate(updated, completedInterventions);
  }

  async submitKycDocument(userId: string, file: UploadedKycFile | undefined, type: string) {
    const profile = await this.prisma.technicianProfile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundException('Profil technicien introuvable.');
    if (!file) throw new BadRequestException('Fichier manquant.');
    if (!type || !isAllowedKycDocumentType(type)) {
      throw new BadRequestException('Type de document non autorisé.');
    }
    if (!isAllowedKycMimetype(file.mimetype)) {
      throw new BadRequestException('Format non supporté. Formats acceptés : PDF, JPG, PNG, WEBP.');
    }
    if (file.size > MAX_KYC_DOCUMENT_SIZE) {
      throw new BadRequestException('Le fichier dépasse 10 Mo.');
    }
    if (!isKycDocumentBuffer(file.buffer)) {
      throw new BadRequestException('Le fichier n’est pas un document valide.');
    }
    if (!this.storage.isConfigured) {
      throw new ServiceUnavailableException('Le dépôt de documents n’est pas disponible pour le moment.');
    }
    if (profile.kycStatus === 'VERIFIED') {
      throw new ForbiddenException('Votre identité est déjà vérifiée.');
    }

    const extension = KYC_EXTENSION_BY_MIME[file.mimetype];
    const storagePath = `technicians/${userId}/kyc/${randomUUID()}.${extension}`;
    await this.storage.uploadKycObject(storagePath, file.buffer, file.mimetype);

    try {
      await this.prisma.kycDocument.create({
        data: {
          technicianId: userId,
          type: type as KycDocumentType,
          storagePath,
          originalName: this.sanitizeOriginalName(file.originalname),
          mimeType: file.mimetype,
          size: file.size,
        },
      });
    } catch (error) {
      await this.storage.deleteKycObject(storagePath).catch(() => undefined);
      throw error;
    }

    // Le statut passe à PENDING uniquement (jamais VERIFIED/REJECTED) et reste PENDING
    // si l'utilisateur ajoute un document complémentaire. Une resoumission (REJECTED → PENDING)
    // efface le motif de rejet courant : le précédent reste tracé dans l'historique KycReview.
    if (profile.kycStatus !== 'PENDING') {
      await this.prisma.technicianProfile.update({
        where: { userId },
        data: { kycStatus: 'PENDING', kycRejectionReason: null },
      });
    }

    return this.listKycDocuments(userId);
  }

  async listKycDocuments(userId: string) {
    const [profile, documents] = await Promise.all([
      this.prisma.technicianProfile.findUnique({ where: { userId } }),
      this.prisma.kycDocument.findMany({
        where: { technicianId: userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);
    if (!profile) throw new NotFoundException('Profil technicien introuvable.');
    return {
      status: profile.kycStatus,
      kycRejectionReason: profile.kycRejectionReason ?? null,
      documents: documents.map((document) => ({
        id: document.id,
        type: document.type,
        originalName: document.originalName,
        createdAt: document.createdAt.toISOString(),
      })),
    };
  }

  async deleteKycDocument(userId: string, documentId: string) {
    const profile = await this.prisma.technicianProfile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundException('Profil technicien introuvable.');
    if (profile.kycStatus === 'VERIFIED') {
      throw new ForbiddenException('Votre identité est déjà vérifiée : les documents ne peuvent pas être supprimés.');
    }

    const document = await this.prisma.kycDocument.findFirst({
      where: { id: documentId, technicianId: userId },
    });
    if (!document) throw new NotFoundException('Document introuvable.');

    // Suppression Storage d'abord, puis suppression de la métadonnée en base.
    await this.storage.deleteKycObject(document.storagePath);

    try {
      await this.prisma.kycDocument.delete({ where: { id: document.id } });
    } catch (error) {
      throw error;
    }

    const remaining = await this.prisma.kycDocument.count({ where: { technicianId: userId } });
    if (profile.kycStatus === 'PENDING' && remaining === 0) {
      await this.prisma.technicianProfile.update({
        where: { userId },
        data: { kycStatus: 'NOT_SUBMITTED' },
      });
    }

    return this.listKycDocuments(userId);
  }

  private sanitizeOriginalName(name: string): string {
    const base = name.split(/[\\/]/).pop() ?? name;
    return base.slice(0, 200);
  }

  async getPublicProfile(technicianId: string): Promise<PublicTechnicianProfile> {
    const technician = await this.prisma.user.findUnique({
      where: { id: technicianId },
      include: { technicianProfile: true },
    });
    if (!technician || technician.role !== 'TECHNICIAN' || !technician.technicianProfile) {
      throw new NotFoundException('Profil technicien introuvable.');
    }
    const profile = technician.technicianProfile;
    const completedInterventions = await this.completedInterventionsCount(technicianId);
    return {
      id: technician.id,
      firstName: technician.firstName,
      lastName: technician.lastName,
      phone: technician.phone,
      avatarUrl: profile.avatarUrl,
      city: profile.city,
      categories: profile.categories,
      specialties: profile.specialties,
      bio: profile.bio,
      experience: profile.experience,
      serviceDescription: profile.serviceDescription,
      isAvailable: profile.isAvailable,
      kycStatus: profile.kycStatus,
      completedInterventions,
      registeredAt: technician.createdAt.toISOString(),
    };
  }

  private serializePrivate(
    profile: PrivateProfileRow,
    completedInterventions: number,
  ) {
    return {
      id: profile.userId,
      city: profile.city,
      // Sprint 8.8.2 — `cityId` structuré exposé dans les réponses privées
      // (le profil public n'y a pas accès, voir `PublicTechnicianProfile`).
      cityId: profile.cityId ?? null,
      categories: profile.categories,
      isAvailable: profile.isAvailable,
      avatarUrl: profile.avatarUrl,
      bio: profile.bio,
      experience: profile.experience,
      serviceDescription: profile.serviceDescription,
      specialties: profile.specialties,
      kycStatus: profile.kycStatus,
      kycRejectionReason: profile.kycRejectionReason ?? null,
      completedInterventions,
      createdAt: profile.createdAt.toISOString(),
      user: profile.user,
    };
  }

  private extractObjectPath(publicUrl: string): string | null {
    const marker = `/object/public/${AVATAR_BUCKET}/`;
    const index = publicUrl.indexOf(marker);
    return index >= 0 ? publicUrl.slice(index + marker.length) : null;
  }

  async listAvailable(userId: string) {
    const profile = await this.requireProfile(userId);
    const normalizedCategories = profile.categories.map((c) => normalizeCategory(c));
    // Sprint 8.8.2 — UNE seule lecture des couvertures actives pour tout le
    // filtrage (pas de requête par demande, pas de N+1).
    const coverageZoneIds = await this.activeCoverageZoneIds(profile.id, profile.cityId);
    const demandes = await this.prisma.demande.findMany({
      where: {
        status: { in: ['SUBMITTED', 'PENDING'] },
        technicianId: null,
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: this.deviceInclude,
    });
    return demandes
      .filter(
        (d) =>
          isGeoEligible({
            demandeCityId: d.cityId,
            demandeCity: d.city,
            technicianCityId: profile.cityId,
            technicianCity: profile.city,
            demandeZoneId: d.zoneId,
            technicianActiveZoneIds: coverageZoneIds,
          }) && normalizedCategories.includes(normalizeCategory(d.category)),
      )
      // Les demandes « dès que possible » passent en premier (signal de priorité) ;
      // à besoin équivalent, la plus récente d'abord (voir `compareDemandePriority`).
      .sort((a, b) => compareDemandePriority(a, b))
      .slice(0, 50)
      .map((d) => toApiDemandePublic(d));
  }

  async listMine(userId: string) {
    const demandes = await this.prisma.demande.findMany({
      where: {
        technicianId: userId,
        status: { notIn: ['CONFIRMED', 'CANCELED'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: this.deviceInclude,
    });
    return demandes.map((d) => toApiDemande(d));
  }

  /* Historique : uniquement les demandes terminées (CONFIRMED) ou annulées
   * (CANCELED) pour lesquelles ce technicien est bien l'intervenant assigné. */
  async listMineHistory(userId: string) {
    const demandes = await this.prisma.demande.findMany({
      where: {
        technicianId: userId,
        status: { in: ['CONFIRMED', 'CANCELED'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: this.deviceInclude,
    });
    return Promise.all(
      demandes.map(async (d) => {
        const api = toApiDemande(d);
        const client = await this.prisma.user.findUnique({
          where: { id: d.clientId },
          select: { id: true, firstName: true, lastName: true },
        });
        const clientReputation = client
          ? await this.reviews.getReputation(client.id)
          : { averageRating: null, totalReviews: 0 };
        return { ...api, client: client ?? null, clientReputation };
      }),
    );
  }

  async getDemandeDetail(userId: string, demandeId: string) {
    const profile = await this.requireProfile(userId);
    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      include: this.deviceInclude,
    });
    if (!demande) throw new NotFoundException('Demande introuvable.');

    const isAlreadyMine = demande.technicianId === userId;
    if (isAlreadyMine) {
      const api = toApiDemande(demande);
      const client = await this.prisma.user.findUnique({
        where: { id: demande.clientId },
        select: { id: true, firstName: true, lastName: true },
      });
      const clientReputation = client
        ? await this.reviews.getReputation(client.id)
        : { averageRating: null, totalReviews: 0 };
      return {
        ...api,
        client: client ?? null,
        clientReputation,
      };
    }

    // Sprint 8.8.2 — même éligibilité géographique que recherche/acceptation.
    const coverageZoneIds = await this.activeCoverageZoneIds(profile.id, profile.cityId);
    const isGeoOk = isGeoEligible({
      demandeCityId: demande.cityId,
      demandeCity: demande.city,
      technicianCityId: profile.cityId,
      technicianCity: profile.city,
      demandeZoneId: demande.zoneId,
      technicianActiveZoneIds: coverageZoneIds,
    });
    const isCategoryMatch = profile.categories.some(
      (c) => normalizeCategory(c) === normalizeCategory(demande.category),
    );
    const isAvailable =
      isMatchingStatus(demande.status) && isGeoOk && isCategoryMatch && !demande.technicianId;

    if (!isAvailable) {
      throw new NotFoundException('Demande introuvable.');
    }

    return toApiDemandePublic(demande);
  }

  async acceptDemande(userId: string, demandeId: string) {
    const profile = await this.requireProfile(userId);

    if (profile.kycStatus !== 'VERIFIED') {
      throw new ForbiddenException(
        'Votre compte technicien doit être vérifié avant de pouvoir accepter une mission.',
      );
    }

    // Sprint 8.8.2 (GEO-05) — l'atomicité reste portée par le `updateMany`
    // gardé ci-dessous ; les couvertures sont relues DANS la transaction
    // pour éviter toute lecture obsolète (modification de couverture ou
    // désactivation de zone entre la lecture et l'acceptation).
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.demande.findUnique({ where: { id: demandeId } });
      if (!current) return null;

      const coverages = profile.cityId
        ? await tx.technicianZoneCoverage.findMany({
            where: {
              technicianProfileId: profile.id,
              zone: { isActive: true, cityId: profile.cityId },
            },
            select: {
              zoneId: true,
              zone: { select: { isActive: true, cityId: true } },
            },
          })
        : [];
      const coverageZoneIds = filterActiveCoverageZoneIdsForCity(coverages, profile.cityId);

      const isGeoOk = isGeoEligible({
        demandeCityId: current.cityId,
        demandeCity: current.city,
        technicianCityId: profile.cityId,
        technicianCity: profile.city,
        demandeZoneId: current.zoneId,
        technicianActiveZoneIds: coverageZoneIds,
      });
      const isCategoryMatch = profile.categories.some(
        (c) => normalizeCategory(c) === normalizeCategory(current.category),
      );
      const isEligible =
        isMatchingStatus(current.status) && isGeoOk && isCategoryMatch && !current.technicianId;
      if (!isEligible) return null;

      const updated = await tx.demande.updateMany({
        where: {
          id: demandeId,
          status: { in: ['SUBMITTED', 'PENDING'] },
          technicianId: null,
        },
        data: {
          status: 'ACCEPTED',
          technicianId: userId,
        },
      });

      if (updated.count === 0) {
        return null;
      }

      const assigned = await tx.demande.findUnique({
        where: { id: demandeId },
        include: {
          ...this.deviceInclude,
          client: { select: { id: true, firstName: true, lastName: true } },
        },
      });
      if (!assigned) return null;

      // Sprint 8.3 : journal métier de l'acceptation (assignation puis
      // acceptation) + notification au client, dans la même transaction.
      await recordEvent(tx, {
        demandeId,
        type: 'TECHNICIAN_ASSIGNED',
        actorUserId: userId,
        fromStatus: current.status,
      });
      await recordEvent(tx, {
        demandeId,
        type: 'TECHNICIAN_ACCEPTED',
        actorUserId: userId,
        fromStatus: current.status,
        toStatus: 'ACCEPTED',
      });
      await createNotification(
        tx,
        buildNotification('TECHNICIAN_ACCEPTED', demandeId, current.clientId, 'CLIENT'),
      );

      return assigned;
    });

    if (!result) {
      const existing = await this.prisma.demande.findUnique({ where: { id: demandeId } });
      if (!existing) throw new NotFoundException('Demande introuvable.');
      if (existing.technicianId) throw new ConflictException('Cette demande a déjà été acceptée par un autre technicien.');
      if (existing.status === 'CANCELED') throw new ConflictException('Cette demande a été annulée.');
      throw new ForbiddenException('Cette demande ne correspond pas à votre profil.');
    }

    return toApiDemande(result);
  }

  async updateStatus(userId: string, demandeId: string, dto: TechnicianUpdateStatusDto) {
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.demande.findFirst({
        where: { id: demandeId, technicianId: userId },
      });
      if (!current) return null;

      const scheduledAt = assertTransition('TECHNICIAN', current.status, dto.status, dto.scheduledAt);

      if (dto.status === 'SCHEDULED') {
        const acceptedQuote = await tx.quote.findFirst({
          where: { demandeId, status: 'ACCEPTED' },
          select: { id: true },
        });
        if (!acceptedQuote) {
          throw new BadRequestException(
            'Le tarif doit être accepté par le client avant de planifier l\'intervention.',
          );
        }
      }

      // Sprint SASPAY-01 (durcissement) : mutation conditionnelle atomique
      // sur le statut lu (updateMany gardé). Une transition concurrente
      // (ex. COMPLETED technicien + CANCELED client) ne s'écrase plus
      // silencieusement : la perdante reçoit un 409. assertTransition,
      // journal, notifications et transaction sont préservés.
      const claimed = await tx.demande.updateMany({
        where: { id: current.id, technicianId: userId, status: current.status },
        data: scheduledAt ? { status: dto.status, scheduledAt } : { status: dto.status },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          'Cette mission a été modifiée entre-temps. Veuillez réactualiser avant de réessayer.',
        );
      }
      const updated = await tx.demande.findFirstOrThrow({
        where: { id: current.id, technicianId: userId },
        include: this.deviceInclude,
      });

      // Sprint 8.3 : journal métier de la transition de statut + notifications
      // (planification → client et technicien ; terminaison → client).
      const type = eventTypeForStatus(dto.status);
      if (type) {
        await recordEvent(tx, {
          demandeId: current.id,
          type,
          actorUserId: userId,
          fromStatus: current.status,
          toStatus: dto.status,
          metadata:
            type === 'SCHEDULED' && scheduledAt
              ? { scheduledAt: scheduledAt.toISOString() }
              : null,
        });
      }
      if (dto.status === 'SCHEDULED') {
        await createNotification(
          tx,
          buildNotification('SCHEDULED', current.id, current.clientId, 'CLIENT'),
        );
        await createNotification(
          tx,
          buildNotification('SCHEDULED', current.id, userId, 'TECHNICIAN'),
        );
      }
      if (dto.status === 'COMPLETED') {
        await createNotification(
          tx,
          buildNotification('COMPLETED', current.id, current.clientId, 'CLIENT'),
        );
      }

      return updated;
    });

    if (!result) {
      const existing = await this.prisma.demande.findUnique({ where: { id: demandeId } });
      if (!existing) throw new NotFoundException('Demande introuvable.');
      throw new ForbiddenException('Vous n\'êtes pas le technicien assigné à cette demande.');
    }

    return toApiDemande(result);
  }

  private async requireProfile(userId: string) {
    const profile = await this.prisma.technicianProfile.findUnique({ where: { userId } });
    if (!profile) {
      throw new BadRequestException('Profil technicien incomplet. Veuillez compléter votre profil.');
    }
    return profile;
  }
}