import {
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { DemandesService } from './demandes.service.js';
import type { CreateDemandeDto, RequestMediaDto } from './dto/create-demande.dto.js';
import type { CreateDemandeDraftDto } from './dto/create-demande-draft.dto.js';
import type { UpdateDemandeDraftDto } from './dto/update-demande-draft.dto.js';
import { REQUEST_TIMINGS } from './dto/base-demande.dto.js';

/* Chantier D1 — brouillon de demande pour visiteur NON authentifié.
 *
 * PRINCIPE VALIDÉ : on ne crée JAMAIS une `Demande` sans client. Le visiteur
 * décrit sa panne ici, la ligne vit 7 jours, et la `Demande` (statut
 * SUBMITTED, `clientId` renseigné, dispatch déclenché) naît au `convert`.
 *
 * LE TOKEN EST UN SECRET : il est l'équivalent d'un lien magique. Il n'est
 * JAMAIS journalisé, ni dans un message d'erreur, ni dans un log de service.
 * Les seuls messages d'erreur ci-dessous ne mentionnent que le motif.
 */

/* Rétention 7 jours (décision D1-4). */
export const DRAFT_RETENTION_DAYS = 7;
export const DRAFT_RETENTION_MS = DRAFT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/* Vue publique d'un brouillon. `id`, `convertedToDemandeId` et
 * `convertedByUserId` sont VOLONTAIREMENT ABSENTS : ce sont des identifiants
 * internes et le client n'en a aucun usage. Exposer `convertedToDemandeId`
 * reviendrait à révéler l'identifiant d'une Demande à quiconque possède le
 * token. */
export interface PublicDemandeDraft {
  token: string;
  categoryId: string;
  domainId: string | null;
  brandId: string | null;
  equipmentFamily: string | null;
  description: string;
  city: string;
  neighborhood: string | null;
  address: string | null;
  landmark: string | null;
  contactPhone: string | null;
  latitude: number | null;
  longitude: number | null;
  requestedMode: string;
  /* ISO 8601 — le brouillon est stocké en `DateTime`, le contrat public du
   * wizard est le même `string` que sur `POST /demandes`. */
  requestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

type DraftRow = {
  id: string;
  token: string;
  categoryId: string;
  domainId: string | null;
  brandId: string | null;
  equipmentFamily: string | null;
  description: string;
  city: string;
  neighborhood: string | null;
  address: string | null;
  landmark: string | null;
  contactPhone: string | null;
  latitude: number | null;
  longitude: number | null;
  requestedMode: string;
  requestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  convertedToDemandeId: string | null;
  convertedAt: Date | null;
  convertedByUserId: string | null;
};

export function toPublicDraft(draft: DraftRow): PublicDemandeDraft {
  return {
    token: draft.token,
    categoryId: draft.categoryId,
    domainId: draft.domainId,
    brandId: draft.brandId,
    equipmentFamily: draft.equipmentFamily,
    description: draft.description,
    city: draft.city,
    neighborhood: draft.neighborhood,
    address: draft.address,
    landmark: draft.landmark,
    contactPhone: draft.contactPhone,
    latitude: draft.latitude,
    longitude: draft.longitude,
    requestedMode: draft.requestedMode,
    requestedAt: draft.requestedAt ? draft.requestedAt.toISOString() : null,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
    expiresAt: draft.expiresAt.toISOString(),
  };
}

/* Champs de date acceptés en entrée : `Date` (tests, appel interne) ou chaîne
 * ISO (contrat HTTP). `null` explicite est autorisé pour `requestedAt` —
 * passer de `SCHEDULED` à `ASAP` doit pouvoir effacer la date. */
function toRequestedAt(value: Date | string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  /* `@IsDateString` a déjà filtré le HTTP ; ce filet reste pour les appels
   * internes et évite d'écrire une `Invalid Date` en base. */
  return Number.isNaN(date.getTime()) ? null : date;
}

/* Type de retour de `convert` : ce que rend `DemandesService.create`, c'est-à-dire
 * la vue API `toApiDemande` (jamais la ligne Prisma brute). */
export type ConvertedDemande = Awaited<ReturnType<DemandesService['create']>>;

@Injectable()
export class DemandeDraftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly demandesService: DemandesService,
  ) {}

  /* ------------------------------------------------------------------ */
  /* B.1 — create                                                       */
  /* ------------------------------------------------------------------ */
  async create(dto: CreateDemandeDraftDto): Promise<{ token: string; expiresAt: Date }> {
    /* Purge paresseuse AVANT l'écriture. `.catch(() => undefined)` : une
     * purge ratée ne doit jamais empêcher un visiteur de créer son brouillon
     * (les brouillons expirés sont inoffensifs — ils seront purgés à la
     * prochaine création réussie).
     *
     * `convertedToDemandeId: null` : un brouillon converti est conservé même
     * au-delà de l'expiration — c'est la trace du rattachement, et la seule
     * preuve qu'un `token` a déjà été utilisé (protection anti-rejeu).
     *
     * Pas de `take` : `deleteMany` ne le supporte pas. Le filtre s'appuie sur
     * `@@index([expiresAt])` ; le volume purgé est borné par le nombre de
     * brouillons créés depuis 7 jours. Le suivi de ce volume est au backlog
     * (`docs/UX-BACKLOG.md`). */
    await this.prisma.demandeDraft
      .deleteMany({
        where: { expiresAt: { lt: new Date() }, convertedToDemandeId: null },
      })
      .catch(() => undefined);

    const created = await this.prisma.demandeDraft.create({
      data: {
        /* `randomUUID()` = UUID v4 (122 bits d'entropie, `crypto`).
         * Jamais séquentiel : le token EST la seule autorisation d'accès au
         * brouillon, énumérable serait fatal. */
        token: randomUUID(),
        categoryId: dto.categoryId,
        domainId: dto.domainId ?? null,
        brandId: dto.brandId ?? null,
        equipmentFamily: dto.equipmentFamily ?? null,
        description: dto.description.trim(),
        city: dto.city.trim(),
        neighborhood: dto.neighborhood ?? null,
        address: dto.address ?? null,
        landmark: dto.landmark ?? null,
        contactPhone: dto.contactPhone ?? null,
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
        requestedMode: dto.requestedMode ?? 'ASAP',
        requestedAt: toRequestedAt(dto.requestedAt) ?? null,
        expiresAt: new Date(Date.now() + DRAFT_RETENTION_MS),
      },
    });

    return { token: created.token, expiresAt: created.expiresAt };
  }

  /* ------------------------------------------------------------------ */
  /* B.3 — getByToken                                                   */
  /* ------------------------------------------------------------------ */
  async getByToken(token: string): Promise<PublicDemandeDraft> {
    return toPublicDraft(await this.loadUsable(token));
  }

  /* ------------------------------------------------------------------ */
  /* B.2 — update (PATCH partiel)                                       */
  /* ------------------------------------------------------------------ */
  async update(token: string, dto: UpdateDemandeDraftDto): Promise<PublicDemandeDraft> {
    await this.loadUsable(token);

    /* PATCH = seuls les champs PRÉSENTS sont écrits. On liste donc les clés
     * explicitement : passer `dto` tel quel à Prisma exposerait `undefined`
     * (ignoré) mais aussi toute clé parasite — la ValidationPipe globale est
     * en `forbidNonWhitelisted`, c'est déjà bloqué en amont, cette liste est
     * la seconde barrière. */
    const data: Record<string, unknown> = {};
    if (dto.categoryId !== undefined) data.categoryId = dto.categoryId;
    if (dto.domainId !== undefined) data.domainId = dto.domainId;
    if (dto.brandId !== undefined) data.brandId = dto.brandId;
    if (dto.equipmentFamily !== undefined) data.equipmentFamily = dto.equipmentFamily;
    if (dto.description !== undefined) data.description = dto.description.trim();
    if (dto.city !== undefined) data.city = dto.city.trim();
    if (dto.neighborhood !== undefined) data.neighborhood = dto.neighborhood;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.landmark !== undefined) data.landmark = dto.landmark;
    if (dto.contactPhone !== undefined) data.contactPhone = dto.contactPhone;
    if (dto.latitude !== undefined) data.latitude = dto.latitude;
    if (dto.longitude !== undefined) data.longitude = dto.longitude;
    if (dto.requestedMode !== undefined) data.requestedMode = dto.requestedMode;
    const requestedAt = toRequestedAt(dto.requestedAt);
    if (requestedAt !== undefined) data.requestedAt = requestedAt;

    const updated = await this.prisma.demandeDraft.update({
      where: { token },
      data,
    });
    return toPublicDraft(updated);
  }

  /* ------------------------------------------------------------------ */
  /* B.4 — convert                                                      */
  /* ------------------------------------------------------------------ */
  async convert(token: string, userId: string, medias: RequestMediaDto[] = []): Promise<ConvertedDemande> {
    const draft = await this.loadUsable(token);

    /* Idempotence : un second appel sur le même token ne doit PAS créer une
     * seconde Demande — il doit renvoyer celle déjà créée.
     *
     * `loadUsable` lève 409 si le brouillon est converti ; on ne peut donc pas
     * arriver ici avec un `convertedToDemandeId` renseigné... SAUF dans le cas
     * de la conversion concurrente sérialisée ci-dessous, où la première
     * conversion a fini entre-temps. La branche reste donc, elle est la
     * garantie du contrat « relancer la conversion renvoie la même Demande ».
     *
     * La relecture passe par `findForClient(userId, …)` : elle réutilise le
     * contrôle d'appartenance existant et rend la vue API, sans dupliquer ni
     * `clientInclude()` ni `withTechnician()` (tous deux `private`). */
    if (draft.convertedToDemandeId) {
      return this.demandesService.findForClient(userId, draft.convertedToDemandeId);
    }

    /* Sérialisation des conversions concurrentes du MÊME token dans cette
     * instance : deux clics rapides (ou un retry de réseau) ne doivent pas
     * passer entre la lecture ci-dessus et l'écriture du `convertedToDemandeId`.
     * `Map<token, Promise>` — l'entrée est supprimée dans le `finally`.
     *
     * Portée assumée : l'instance. Le dépôt tourne sur une instance unique
     * Railway ; `convertedToDemandeId @unique` reste la barrière en base. */
    const inFlight = this.conversions.get(token);
    if (inFlight) return inFlight;

    const task = this.runConversion(draft, userId, medias).finally(() => {
      this.conversions.delete(token);
    });
    this.conversions.set(token, task);
    return task;
  }

  private readonly conversions = new Map<string, Promise<ConvertedDemande>>();

  private async runConversion(draft: DraftRow, userId: string, medias: RequestMediaDto[]) {
    /* On réutilise `DemandesService.create` À L'IDENTIQUE : validation du
     * domaine / de la marque / de la ville, génération de la référence unique,
     * création des médias, événement `CREATED` et déclenchement du dispatch
     * vague 1. Toute la logique de création reste en un seul endroit. */
    const demandeDto: CreateDemandeDto = {
      categoryId: draft.categoryId,
      description: draft.description,
      city: draft.city,
      ...(draft.domainId ? { domainId: draft.domainId } : {}),
      ...(draft.brandId ? { brandId: draft.brandId } : {}),
      ...(draft.equipmentFamily ? { equipmentFamily: draft.equipmentFamily } : {}),
      ...(draft.neighborhood ? { neighborhood: draft.neighborhood } : {}),
      ...(draft.address ? { address: draft.address } : {}),
      ...(draft.landmark ? { landmark: draft.landmark } : {}),
      ...(draft.contactPhone ? { contactPhone: draft.contactPhone } : {}),
      ...(draft.latitude !== null ? { latitude: draft.latitude } : {}),
      ...(draft.longitude !== null ? { longitude: draft.longitude } : {}),
      ...(draft.requestedAt ? { requestedAt: draft.requestedAt.toISOString() } : {}),
      requestedMode: this.normalizeRequestedMode(draft.requestedMode),
      ...(medias.length > 0 ? { medias } : {}),
    };

    /* `DemandesService.create` possède sa propre transaction : impossible de
     * l'enfermer dans celle du brouillon (Prisma n'imbrique pas les
     * transactions). L'ordre est donc : créer la Demande d'abord, puis
     * marquer le brouillon. Un crash entre les deux laisse un brouillon non
     * converti — donc rejouable, ce qui est le comportement sûr. L'inverse
     * (marquer puis échouer) perdrait définitivement la demande. */
    const created = await this.demandesService.create(userId, demandeDto);

    await this.prisma.$transaction(async (tx) => {
      await tx.demandeDraft.update({
        where: { token: draft.token },
        data: {
          convertedToDemandeId: created.id,
          convertedAt: new Date(),
          convertedByUserId: userId,
        },
      });
    });

    /* `DemandesService.create` renvoie DÉJÀ la vue API (`toApiDemande`) : on la
     * retourne telle quelle, sans relecture ni re-sérialisation. */
    return created;
  }

  /* La colonne est un `String` (migrations plus compatibles qu'un enum), donc
   * on revalide à la conversion : un brouillon écrit par une version de
   * l'API qui aurait accepté autre chose ne doit pas faire planter
   * `DemandesService.create` sur un `@IsIn` silencieusement ignoré. */
  private normalizeRequestedMode(value: string): (typeof REQUEST_TIMINGS)[number] {
    return (REQUEST_TIMINGS as readonly string[]).includes(value)
      ? (value as (typeof REQUEST_TIMINGS)[number])
      : 'ASAP';
  }

  /* ------------------------------------------------------------------ */
  /* Chargement + garde-fous partagés                                    */
  /* ------------------------------------------------------------------ */
  /* 404 inconnu · 409 déjà converti · 410 expiré.
   *
   * L'ordre est délibéré : un brouillon expiré ET converti répond 409 (l user's
   * action — écrire dessus — est interdite pour toujours), pas 410. */
  private async loadUsable(token: string): Promise<DraftRow> {
    const draft = (await this.prisma.demandeDraft.findUnique({
      where: { token },
    })) as DraftRow | null;

    if (!draft) throw new NotFoundException('Brouillon introuvable.');
    if (draft.convertedToDemandeId) {
      throw new ConflictException('Ce brouillon a déjà été converti en demande.');
    }
    if (draft.expiresAt.getTime() < Date.now()) {
      throw new GoneException('Brouillon expiré.');
    }
    return draft;
  }
}