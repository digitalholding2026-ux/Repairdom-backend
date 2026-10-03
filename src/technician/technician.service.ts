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
import { toApiDemande, toApiDemandePublic, toApiTravelTechnician, isMatchingStatus, compareDemandePriority } from '../demandes/demande-helpers.js';
import { assertTransition } from '../demandes/demandes-lifecycle.js';
import {
  buildNotification,
  createNotification,
  eventTypeForStatus,
  recordEvent,
  type Tx as TravelTx,
} from '../mission-events/mission-events.js';
import type { UpdateTechnicianProfileDto } from './dto/update-technician-profile.dto.js';
import type { TechnicianUpdateStatusDto } from './dto/update-status.dto.js';
import { resolveCityId } from '../geo/city-reference.js';
import { filterActiveCoverageZoneIdsForCity } from '../geo/geo-matching.js';
import {
  GPS_FRESHNESS_MS,
  demandeTechnicianDistanceMeters,
  isLocationFresh,
  isUsableTravelAccuracy,
  isValidLatitude,
  isValidLongitude,
  GPS_TRAVEL_REFRESH_THROTTLE_MS,
} from '../geo/geo-distance.js';
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
import { RealtimeService } from '../realtime/realtime.service.js';
import {
  TECHNICIAN_AVAILABLE_CHANNEL,
  missionChannel,
} from '../realtime/realtime.types.js';
import { PushService } from '../push/push.service.js';

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

/* GPS V3 — états mission compatibles avec le déplacement temporaire :
 * mission planifiée ou intervention démarrée. Les états clos refusent
 * toute action GPS ; les autres états la refusent proprement. */
const TRAVEL_COMPATIBLE_STATUSES = ['SCHEDULED', 'IN_PROGRESS'];
const TRAVEL_CLOSED_STATUSES = ['COMPLETED', 'CONFIRMED', 'CANCELED'];

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
  // GPS V1 — dernière position transmise (nullable, jamais d'historique).
  lastLatitude: number | null;
  lastLongitude: number | null;
  locationUpdatedAt: Date | null;
  createdAt: Date;
  user: { firstName: string; lastName: string | null; phone: string | null; email: string; role: string };
}

@Injectable()
export class TechnicianService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
    private readonly reviews: ReviewsService,
    // Temps réel (socle SSE) : injection optionnelle (tests sans module).
    private readonly realtime?: RealtimeService,
    // Push web (chantier #2B) : idem, `sendToUser()` ne lève jamais.
    private readonly push?: PushService,
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

  /* GPS V1 — dernière position connue (transmission explicite et
   * ponctuelle du technicien connecté, jamais de tracking ni d'historique).
   * Route strictement personnelle : seul le JWT désigne le profil modifié.
   * `locationUpdatedAt` = horodatage de CETTE transmission. */
  async updateLocation(userId: string, latitude: number, longitude: number) {
    const existing = await this.prisma.technicianProfile.findUnique({ where: { userId } });
    if (!existing) throw new NotFoundException('Profil technicien introuvable.');
    const updated = await this.prisma.technicianProfile.update({
      where: { userId },
      data: {
        lastLatitude: latitude,
        lastLongitude: longitude,
        locationUpdatedAt: new Date(),
      },
      include: { user: { select: { firstName: true, lastName: true, phone: true, email: true, role: true } } },
    });
    const completedInterventions = await this.completedInterventionsCount(userId);
    return this.serializePrivate(updated, completedInterventions);
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
      // GPS V1 — exposé au seul propriétaire (jamais dans le profil public).
      lastLatitude: profile.lastLatitude ?? null,
      lastLongitude: profile.lastLongitude ?? null,
      locationUpdatedAt: profile.locationUpdatedAt
        ? profile.locationUpdatedAt.toISOString()
        : null,
      /* CHANTIER GPS P0/P1 — fraîcheur calculée CÔTÉ SERVEUR (fenêtre V2
       * `GPS_FRESHNESS_MS`) : l'UI ne doit plus déduire « à jour » de
       * l'horloge du téléphone (`Date.now()`), falsifiable. */
      isLocationFresh: isLocationFresh(profile.locationUpdatedAt, new Date(), GPS_FRESHNESS_MS),
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
      // GPS V2 — ordre métier inchangé (ASAP préservé) ; `distanceMeters`
      // additif par opportunité (null sans GPS frais des deux côtés),
      // sans coordonnées brutes.
      .sort((a, b) => compareDemandePriority(a, b))
      .slice(0, 50)
      .map((d) => ({
        ...toApiDemandePublic(d),
        distanceMeters: isLocationFresh(profile.locationUpdatedAt)
          ? demandeTechnicianDistanceMeters(d, profile)
          : null,
      }));
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
        // GPS V1 — distance informative (lecture seule, sans effet sur le
        // matching) ; null si l'une des positions est absente.
        distanceMeters: demandeTechnicianDistanceMeters(demande, profile),
        // GPS V3 — déplacement temporaire (coordonnées visibles par le
        // technicien assigné, propriétaire de ces données).
        travel: toApiTravelTechnician(demande),
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

    // Mission éligible non assignée : le technicien peut consulter les
    // médias du client AVANT d'accepter (métadonnées + lecture via URLs
    // signées). Adresse/téléphone/GPS restent masqués (vue publique) ;
    // les listes d'opportunités n'embarquent toujours aucun média.
    const full = toApiDemande(demande);
    return { ...toApiDemandePublic(demande), medias: full.medias };
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
    // Correctif post-audit — le profil peut aussi changer entre l'affichage
    // et l'acceptation (disponibilité coupée, compte désactivé, KYC révoqué) :
    // ces états sont donc relus DANS la transaction et refusés en 403
    // (rollback), sans contourner les gardes existantes.
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.demande.findUnique({ where: { id: demandeId } });
      if (!current) return null;

      const freshProfile = await tx.technicianProfile.findUnique({
        where: { id: profile.id },
        select: { isAvailable: true, kycStatus: true },
      });
      const account = await tx.user.findUnique({
        where: { id: userId },
        select: { isActive: true },
      });
      if (!account || account.isActive === false) {
        throw new ForbiddenException('Votre compte a été désactivé. Contactez Relio.');
      }
      if (!freshProfile || freshProfile.isAvailable !== true) {
        throw new ForbiddenException(
          'Vous êtes actuellement indisponible : réactivez votre disponibilité pour accepter une mission.',
        );
      }
      if (freshProfile.kycStatus !== 'VERIFIED') {
        throw new ForbiddenException(
          'Votre compte technicien doit être vérifié avant de pouvoir accepter une mission.',
        );
      }

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

    // Temps réel (après commit) : statut mission + retrait des listes.
    this.realtime?.publish(missionChannel(demandeId), 'mission.status_changed', {
      demandeId,
      toStatus: 'ACCEPTED',
      technicianId: userId,
      createdAt: new Date().toISOString(),
    });
    this.realtime?.publish(TECHNICIAN_AVAILABLE_CHANNEL, 'technician.mission_taken', {
      demandeId,
      technicianId: userId,
      createdAt: new Date().toISOString(),
    });
    this.realtime?.publishToUser(result.clientId, 'notification.created', {
      demandeId,
      kind: 'TECHNICIAN_ACCEPTED',
    });

    return toApiDemande(result);
  }

  async updateStatus(userId: string, demandeId: string, dto: TechnicianUpdateStatusDto) {
    // Capturés dans la transaction, diffusés après commit (jamais d'événement
    // fantôme en cas de rollback).
    let fromStatus: string | null = null;
    let scheduledAtIso: string | null = null;
    let notifyClientId: string | null = null;
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
        notifyClientId = current.clientId;
      }
      if (dto.status === 'COMPLETED') {
        await createNotification(
          tx,
          buildNotification('COMPLETED', current.id, current.clientId, 'CLIENT'),
        );
        notifyClientId = current.clientId;
      }
      fromStatus = current.status;
      if (scheduledAt) scheduledAtIso = scheduledAt.toISOString();

      return updated;
    });

    if (!result) {
      const existing = await this.prisma.demande.findUnique({ where: { id: demandeId } });
      if (!existing) throw new NotFoundException('Demande introuvable.');
      throw new ForbiddenException('Vous n\'êtes pas le technicien assigné à cette demande.');
    }

    // Temps réel : diffusion du changement de statut (après commit).
    this.realtime?.publish(missionChannel(demandeId), 'mission.status_changed', {
      demandeId,
      fromStatus,
      toStatus: dto.status,
      scheduledAt: scheduledAtIso,
      createdAt: new Date().toISOString(),
    });
    if (notifyClientId) {
      this.realtime?.publishToUser(notifyClientId, 'notification.created', {
        demandeId,
        kind: dto.status,
      });
      // Push web : validation demandée au client (COMPLETED uniquement).
      if (dto.status === 'COMPLETED') {
        void this.push?.sendToUser(notifyClientId, {
          title: 'Mission terminée, à valider',
          body: 'Votre technicien a terminé. Validez la mission pour clôturer.',
          tag: `completed-${demandeId}`,
          url: `/client/demandes/${demandeId}`,
          type: 'status_completed',
        });
      }
    }

    return toApiDemande(result);
  }

  /* GPS V3 — déplacement temporaire lié à la mission (« technicien en
   * route »). Principes : transmission EXPLICITE et ponctuelle (aucun
   * tracking, aucun WebSocket, aucun historique — chaque position remplace
   * la précédente) ; acteur = technicien JWT assigné (aucun identifiant de
   * tiers) ; mission dans un état compatible (SCHEDULED/IN_PROGRESS) ;
   * le lifecycle existant reste la source de vérité (aucun changement de
   * statut ici) ; aucune coordonnée dans les logs. */

  private assertTravelCoordinates(latitude: unknown, longitude: unknown): void {
    if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
      throw new BadRequestException('Coordonnées GPS invalides.');
    }
  }

  private resolveTravelDenial(existing: {
    technicianId: string | null;
    technicianArrivedAt: Date | null;
    technicianEnRouteAt: Date | null;
    status: string;
  }): Error {
    if (existing.technicianArrivedAt) {
      return new ConflictException(
        'Le déplacement est déjà clôturé (arrivée enregistrée).',
      );
    }
    if (TRAVEL_CLOSED_STATUSES.includes(existing.status)) {
      return new ConflictException(
        'Le déplacement est impossible sur une mission terminée.',
      );
    }
    return new BadRequestException(
      'Le déplacement ne peut démarrer que sur une mission planifiée ou en cours.',
    );
  }

  /* Point d'entrée commun : mission assignée au technicien connecté,
   * sinon 404 (inexistante) ou 403 (autre technicien / autre rôle). */
  private async requireAssignedDemande(
    tx: TravelTx,
    userId: string,
    demandeId: string,
  ) {
    const current = await tx.demande.findFirst({
      where: { id: demandeId, technicianId: userId },
    });
    if (current) return current;
    const existing = await tx.demande.findUnique({ where: { id: demandeId } });
    if (!existing) throw new NotFoundException('Demande introuvable.');
    throw new ForbiddenException("Vous n'êtes pas le technicien assigné à cette demande.");
  }

  /* « Je suis en route » : enregistre le début du déplacement, avec ou
   * SANS coordonnées (CHANTIER GPS P0/P1 : permission refusée, GPS
   * désactivé, timeout ou fix trop imprécis ne bloquent jamais le départ —
   * l'action métier part quand même, sans position inventée).
   * Réémission avant arrivée = simple actualisation (le
   * `technicianEnRouteAt` d'origine est conservé, une seule notification
   * client au premier démarrage). Sans coordonnées exploitables,
   * `travelLocationUpdatedAt` reste inchangé (null au premier départ) :
   * la vue `travel` expose alors `enRoute: true, fresh: false` (fenêtre V3
   * 15 min), le marqueur n'est affiché ni côté technicien ni côté client.
   * Aucun nouveau statut, aucune coordonnée dans les logs. */
  async startTravel(
    userId: string,
    demandeId: string,
    latitude?: number,
    longitude?: number,
    accuracy?: number,
  ) {
    const hasCoords = latitude !== undefined || longitude !== undefined;
    // Corps vide ou partiel sans les deux coordonnées = départ sans GPS.
    // Coordonnées partielles invalides (une seule sur deux) = 400.
    if (hasCoords && (latitude === undefined || longitude === undefined)) {
      throw new BadRequestException('Coordonnées GPS incomplètes.');
    }
    let withPosition = false;
    if (latitude !== undefined && longitude !== undefined) {
      this.assertTravelCoordinates(latitude, longitude);
      // Fix trop imprécis : départ enregistré SANS position exploitable
      // (jamais transformé en position précise artificielle).
      withPosition = isUsableTravelAccuracy(accuracy);
    }
    // Capturé dans la transaction, diffusé après commit.
    let notifyClientId: string | null = null;
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await this.requireAssignedDemande(tx, userId, demandeId);
      if (
        current.technicianArrivedAt ||
        TRAVEL_CLOSED_STATUSES.includes(current.status) ||
        !TRAVEL_COMPATIBLE_STATUSES.includes(current.status)
      ) {
        throw this.resolveTravelDenial(current);
      }

      const now = new Date();
      const firstStart = !current.technicianEnRouteAt;
      const claimed = await tx.demande.updateMany({
        where: {
          id: current.id,
          technicianId: userId,
          status: current.status,
          technicianArrivedAt: null,
        },
        // Sans position exploitable : seul le départ est enregistré (les
        // coordonnées/horodatage précédents sont conservés tels quels, la
        // fraîcheur V3 reste calculée côté serveur).
        data: withPosition
          ? {
              travelLatitude: latitude,
              travelLongitude: longitude,
              travelLocationUpdatedAt: now,
              technicianEnRouteAt: current.technicianEnRouteAt ?? now,
            }
          : {
              technicianEnRouteAt: current.technicianEnRouteAt ?? now,
            },
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

      await recordEvent(tx, {
        demandeId: current.id,
        type: 'TECHNICIAN_EN_ROUTE',
        actorUserId: userId,
        fromStatus: current.status,
      });
      if (firstStart) {
        await createNotification(
          tx,
          buildNotification('TECHNICIAN_EN_ROUTE', current.id, current.clientId, 'CLIENT'),
        );
        notifyClientId = current.clientId;
      }
      return updated;
    });

    // Temps réel (après commit) : départ + position éventuelle + notification.
    this.realtime?.publish(missionChannel(demandeId), 'mission.technician_en_route', {
      demandeId,
      technicianId: userId,
      hasPosition: withPosition,
      createdAt: new Date().toISOString(),
    });
    if (withPosition) {
      this.realtime?.publish(missionChannel(demandeId), 'mission.technician_position', {
        demandeId,
        technicianId: userId,
        latitude,
        longitude,
        createdAt: new Date().toISOString(),
      });
    }
    if (notifyClientId) {
      this.realtime?.publishToUser(notifyClientId, 'notification.created', {
        demandeId,
        kind: 'TECHNICIAN_EN_ROUTE',
      });
      // Push web : le client n'a pas forcément l'app ouverte.
      void this.push?.sendToUser(notifyClientId, {
        title: 'Votre technicien est en route',
        body: 'Suivez son arrivée depuis votre mission.',
        tag: `en-route-${demandeId}`,
        url: `/client/demandes/${demandeId}`,
        type: 'technician_en_route',
      });
    }

    return { ...toApiDemande(result), travel: toApiTravelTechnician(result) };
  }

  /* « Actualiser ma position » : remplace la position précédente (aucun
   * historique, aucun tracking). Exige un déplacement actif (démarré ET non
   * arrivé). CHANTIER GPS P0/P1 :
   * - fix trop imprécis (`accuracy` > `GPS_TRAVEL_MAX_ACCURACY_M`) : refusé
   *   en 400 SANS écrire (jamais présenté comme localisation précise) ;
   * - appels trop rapprochés (< `GPS_TRAVEL_REFRESH_THROTTLE_MS`) : état
   *   courant renvoyé SANS écriture (protège la DB même si le frontend est
   *   contourné ; l'actualisation manuelle reste fonctionnelle au-delà). */
  async refreshTravelLocation(
    userId: string,
    demandeId: string,
    latitude: number,
    longitude: number,
    accuracy?: number,
  ) {
    this.assertTravelCoordinates(latitude, longitude);
    if (!isUsableTravelAccuracy(accuracy)) {
      throw new BadRequestException(
        'Position trop imprécise pour être actualisée. Réessayez dans un endroit à ciel ouvert.',
      );
    }
    // Diffusé après commit uniquement si une écriture a eu lieu (pas sur le
    // chemin throttle qui renvoie l'état courant sans écrire).
    let wrotePosition = false;
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await this.requireAssignedDemande(tx, userId, demandeId);
      if (!current.technicianEnRouteAt || current.technicianArrivedAt) {
        throw new BadRequestException(
          'Aucun déplacement actif : démarrez votre déplacement (« Je suis en route »).',
        );
      }
      if (
        TRAVEL_CLOSED_STATUSES.includes(current.status) ||
        !TRAVEL_COMPATIBLE_STATUSES.includes(current.status)
      ) {
        throw this.resolveTravelDenial(current);
      }
      // Throttle : une position actualisée il y a moins de 30 s ne justifie
      // pas une nouvelle écriture (double-clic, retry agressif, spam).
      const lastUpdate =
        current.travelLocationUpdatedAt instanceof Date
          ? current.travelLocationUpdatedAt.getTime()
          : null;
      if (lastUpdate !== null && Date.now() - lastUpdate < GPS_TRAVEL_REFRESH_THROTTLE_MS) {
        return tx.demande.findFirstOrThrow({
          where: { id: current.id, technicianId: userId },
          include: this.deviceInclude,
        });
      }

      const claimed = await tx.demande.updateMany({
        where: {
          id: current.id,
          technicianId: userId,
          status: current.status,
          technicianArrivedAt: null,
        },
        data: {
          travelLatitude: latitude,
          travelLongitude: longitude,
          travelLocationUpdatedAt: new Date(),
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          'Cette mission a été modifiée entre-temps. Veuillez réactualiser avant de réessayer.',
        );
      }
      wrotePosition = true;
      return tx.demande.findFirstOrThrow({
        where: { id: current.id, technicianId: userId },
        include: this.deviceInclude,
      });
    });

    // Temps réel (après commit) : position actualisée.
    if (wrotePosition) {
      this.realtime?.publish(missionChannel(demandeId), 'mission.technician_position', {
        demandeId,
        technicianId: userId,
        latitude,
        longitude,
        createdAt: new Date().toISOString(),
      });
    }

    return { ...toApiDemande(result), travel: toApiTravelTechnician(result) };
  }

  /* « Je suis arrivé » : clôt le déplacement (la position de déplacement
   * n'est plus exposée comme active). La dernière position n'est mise à
   * jour que si des coordonnées valides ET exploitables sont fournies ; la
   * date d'arrivée est toujours enregistrée (comportement préservé). */
  async markArrived(
    userId: string,
    demandeId: string,
    latitude?: number,
    longitude?: number,
    accuracy?: number,
  ) {
    if (latitude !== undefined || longitude !== undefined) {
      this.assertTravelCoordinates(latitude, longitude);
    }
    // Capturé dans la transaction, diffusé après commit.
    let arrivedClientId: string | null = null;
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await this.requireAssignedDemande(tx, userId, demandeId);
      if (!current.technicianEnRouteAt) {
        throw new BadRequestException(
          'Démarrez d\u2019abord votre déplacement (« Je suis en route »).',
        );
      }
      if (current.technicianArrivedAt) {
        throw new ConflictException("L'arrivée est déjà enregistrée.");
      }
      if (TRAVEL_CLOSED_STATUSES.includes(current.status)) {
        throw new ConflictException(
          'Le déplacement est impossible sur une mission terminée.',
        );
      }

      const now = new Date();
      const claimed = await tx.demande.updateMany({
        where: {
          id: current.id,
          technicianId: userId,
          status: current.status,
          technicianArrivedAt: null,
        },
        data: {
          technicianArrivedAt: now,
          // Fix trop imprécis : arrivée enregistrée SANS stocker la
          // position (jamais de précision artificielle).
          ...(latitude !== undefined && longitude !== undefined && isUsableTravelAccuracy(accuracy)
            ? {
                travelLatitude: latitude,
                travelLongitude: longitude,
                travelLocationUpdatedAt: now,
              }
            : {}),
        },
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

      await recordEvent(tx, {
        demandeId: current.id,
        type: 'TECHNICIAN_ARRIVED',
        actorUserId: userId,
        fromStatus: current.status,
      });
      arrivedClientId = current.clientId;
      return updated;
    });

    // Temps réel (après commit) : arrivée (+ position si fournie).
    this.realtime?.publish(missionChannel(demandeId), 'mission.technician_arrived', {
      demandeId,
      technicianId: userId,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      createdAt: new Date().toISOString(),
    });
    if (arrivedClientId) {
      // Push web : le client n'a pas forcément l'app ouverte.
      void this.push?.sendToUser(arrivedClientId, {
        title: 'Votre technicien est arrivé',
        body: "Le technicien est arrivé sur le lieu de l'intervention.",
        tag: `arrived-${demandeId}`,
        url: `/client/demandes/${demandeId}`,
        type: 'technician_arrived',
      });
    }

    return { ...toApiDemande(result), travel: toApiTravelTechnician(result) };
  }

  private async requireProfile(userId: string) {
    const profile = await this.prisma.technicianProfile.findUnique({ where: { userId } });
    if (!profile) {
      throw new BadRequestException('Profil technicien incomplet. Veuillez compléter votre profil.');
    }
    return profile;
  }
}