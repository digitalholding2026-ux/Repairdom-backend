import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
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
import { RealtimeService } from '../realtime/realtime.service.js';
import { PushService } from '../push/push.service.js';
import { EmailService } from '../auth/email.service.js';
import { ConfigService } from '@nestjs/config';
import { buildNotificationMetadata } from '../notifications/notification-metadata.js';
import {
  TECHNICIAN_MINIMUM_AGE,
  computeAge,
  isAtLeastAge,
} from '../technician/technician-age.js';

const ALLOWED_KYC_STATUSES: KycStatus[] = ['NOT_SUBMITTED', 'PENDING', 'VERIFIED', 'REJECTED'];

/* Nombre max de comptes clients retournés par la recherche admin. */
export const ADMIN_CLIENT_SEARCH_LIMIT = 20;

/** Durée de validité des signed URLs de consultation KYC : 5 minutes. */
export const KYC_SIGNED_URL_TTL_SECONDS = 300;

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
    /* Chantier #5A : la décision KYC notifie le technicien sur 4 canaux.
     * Les 4 paramètres sont OPTIONNELS au sens TypeScript (`?`) afin que les
     * tests unitaires puissent n'instancier qu'(PRISMA, storage) — même
     * convention que `TechnicianService`. Côté Nest, la résolution est
     * effective : `AdminModule` importe `RealtimeModule` + `PushModule`, et
     * `AuthModule` exporte `EmailService` (`ConfigModule` est global). */
    private readonly realtime?: RealtimeService,
    private readonly push?: PushService,
    private readonly email?: EmailService,
    private readonly config?: ConfigService,
  ) {}

  /* Base publique du frontend, pour les liens des e-mails KYC. Repli
   * identique à celui d'`EmailService` : un env Railway sans FRONTEND_URL ne
   * doit pas produire un lien relatif dans un e-mail. */
  private frontendUrl(): string {
    const configured = this.config?.get<string>('FRONTEND_URL')?.trim().replace(/\/+$/, '');
    return configured || 'https://relioo.space';
  }

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
        whatsapp: technician.whatsapp,
        avatarUrl: profile.avatarUrl,
        city: profile.city,
        categories: profile.categories,
        specialties: profile.specialties,
        experience: profile.experience,
        serviceDescription: profile.serviceDescription,
        bio: profile.bio,
        // Chantier profil/KYC — identité et activité pour la vérification
        // admin complète (âge calculé exactement, jamais année − année).
        birthDate: profile.birthDate
          ? [
              profile.birthDate.getUTCFullYear(),
              String(profile.birthDate.getUTCMonth() + 1).padStart(2, '0'),
              String(profile.birthDate.getUTCDate()).padStart(2, '0'),
            ].join('-')
          : null,
        /* Âge calculé signalé au backoffice pour aider la décision (§17) :
         * SANS port de garde. Un dossier à 17 ans reste visible et
         * rejetable — l'admin doit pouvoir le constater, pas le découvrir
         * par un 403 opaque. Le blocage effectif est posé par le technicien
         * à l'activation (`assertAdultWhenActivating`) et à la soumission KYC.
         * NB : un `age` incohérent (null avec birthDate) est un défaut de
         * données, pas un bug d'affichage. */
        age: profile.birthDate ? computeAge(profile.birthDate) : null,
        ageBelowMinimum:
          profile.birthDate !== null &&
          !isAtLeastAge(profile.birthDate, TECHNICIAN_MINIMUM_AGE),
        nationality: profile.nationality,
        kycIdentityDocType: profile.kycIdentityDocType,
        activityType: profile.activityType,
        experienceYears: profile.experienceYears,
        familyCodes: profile.familyCodes,
        isAvailable: profile.isAvailable,
        kycStatus: profile.kycStatus,
        kycRejectionReason: profile.kycRejectionReason,
        completedInterventions,
        registeredAt: technician.createdAt.toISOString(),
      },
      documents: technician.kycDocuments.map((document) => ({
        id: document.id,
        type: document.type,
        side: document.side,
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
      /* Chantier #5A : l'e-mail de décision se personalize (prénom) et
       * s'adresse au bon destinataire → on joint le compte. */
      include: { user: { select: { email: true, firstName: true } } },
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

    /* Chantier #5A — la décision est ENREGISTRÉE. On notifie maintenant le
     * technicien sur 4 canaux (in-app, SSE, push, e-mail).
     *
     * Deux règles absolues :
     *  1. AUCUN canal ne peut faire échouer la décision déjà commitée : chaque
     *     envoi est isolé, l'échec est journalisé sans donnée sensible, et
     *     l'admin reçoit toujours son 200 + le dossier à jour ;
     *  2. AUCUNE duplication possible : la garde `kycStatus !== 'PENDING'`
     *     ci-dessus rend un second appel impossible (409), donc un seul
     *     envoi par décision.
     *
     * Le `metadata` passe par `buildNotificationMetadata` (contrat #2D) :
     * les clés KYC y sont désormais déclarées, sinon elles seraient
     * silencieusement écartées.
     */
    const verdict = dto.status;
    const isVerified = verdict === 'VERIFIED';
    const title = isVerified ? 'Identité vérifiée' : 'Vérification à compléter';
    const message = isVerified
      ? 'Vous pouvez maintenant accepter des missions.'
      : 'Votre dossier doit être corrigé pour être validé.';

    /* ── Canal 1 : notification in-app (persistée) ── */
    let notificationId: string | null = null;
    try {
      const notification = await this.prisma.notification.create({
        data: {
          userId: technicianId,
          /* KYC ≠ mission : `demandeId` reste `null`, donc l'app affiche la
           * notification à plat (jamais regroupée par mission). */
          demandeId: null,
          type: isVerified ? 'KYC_VERIFIED' : 'KYC_REJECTED',
          title,
          message,
          metadata: buildNotificationMetadata({
            kycStatus: verdict,
            kycRejectionReason: isVerified ? null : reason,
            kycAction: isVerified ? 'view_missions' : 'fix_kyc',
          }),
        },
      });
      notificationId = notification.id;
    } catch (error) {
      this.logKycChannelFailure('notification in-app', technicianId, error);
    }

    /* ── Canal 2 : SSE (signal temps réel + notification) ── */
    if (this.realtime) {
      try {
        if (notificationId) {
          this.realtime.publishToUser(technicianId, 'notification.created', {
            notificationId,
            kind: isVerified ? 'KYC_VERIFIED' : 'KYC_REJECTED',
          });
        }
        this.realtime.publishToUser(
          technicianId,
          isVerified ? 'technician.kyc_verified' : 'technician.kyc_rejected',
          {
            technicianId,
            kycStatus: verdict,
            reason: isVerified ? null : reason,
          },
        );
      } catch (error) {
        this.logKycChannelFailure('SSE', technicianId, error);
      }
    }

    /* ── Canal 3 : push web VAPID (onglet fermé) ── */
    if (this.push) {
      try {
        /* `sendToUser` ne lève jamais (il retourne `{failed}`) et SUPPRIME
         * l'envoi si une connexion SSE est active : c'est voulu, pas de
         * doublon. `tag` par dossier : un push KYC écrase le précédent. */
        await this.push.sendToUser(technicianId, {
          title: isVerified ? 'Identité vérifiée' : 'Dossier à compléter',
          body: isVerified
            ? 'Vous pouvez maintenant accepter des missions.'
            : 'Corrigez votre dossier pour être validé.',
          tag: `kyc-${technicianId}`,
          url: isVerified ? '/technicien/demandes' : '/technicien/kyc',
          type: isVerified ? 'kyc_verified' : 'kyc_rejected',
        });
      } catch (error) {
        this.logKycChannelFailure('push', technicianId, error);
      }
    }

    /* ── Canal 4 : e-mail (Resend) ── */
    const recipient = profile.user;
    if (this.email && recipient?.email) {
      try {
        const base = this.frontendUrl();
        if (isVerified) {
          await this.email.sendKycVerifiedEmail(
            recipient.email,
            recipient.firstName,
            `${base}/technicien/demandes`,
          );
        } else {
          await this.email.sendKycRejectedEmail(
            recipient.email,
            recipient.firstName,
            reason ?? '',
            `${base}/technicien/kyc`,
          );
        }
      } catch (error) {
        this.logKycChannelFailure('e-mail', technicianId, error);
      }
    }

    return this.getKycFolder(technicianId);
  }

  /* Journalise l'échec d'un canal de notification. Aucun secret, aucune
   * donnée personnelle : uniquement l'identifiant technique du technicien.
   * Le message est volontairement neutre — la même méthode sert la décision
   * KYC et la notification de barème, où il n'y a pas de « décision » à
   * mentionner. */
  private logKycChannelFailure(
    channel: string,
    technicianId: string,
    error: unknown,
  ): void {
    const reason = error instanceof Error ? error.message : 'erreur inconnue';
    this.logger.warn(
      `Canal « ${channel} » en échec pour ${technicianId} : ${reason}. ` +
        'Les autres canaux et les autres destinataires sont traités normalement.',
    );
  }

  /* ── Chantier 4-FONDATIONS-A — notification du nouveau barème ──── */
  /* ⚠️ CET ENVOI N'EST PAS AUTOMATIQUE. Aucun scheduler, aucun déclenchement
   * au déploiement : c'est une action UNIQUE et VOLONTAIRE de l'admin, à
   * déclencher une fois le nouveau barème Visible par les techniciens
   * (l'e-mail renvoie vers `/technicien/demandes`, qui affiche désormais la
   * commission). L'ordre de grandeur est celui du chantier KYC : mêmes quatre
   * canaux, mêmes protections.
   *
   * Isolation stricte : chaque technicien est traité dans son propre
   * try/catch. Un e-mail en échec n'empêche NI la notification in-app du même
   * technicien NI l'envoi aux techniciens suivants. Le compte rendu
   * `{ sent, failed }` est le seul contrat de la route.
   *
   * Aucun montant pré-formaté dans la notification : le barème est écrit en
   * toutes lettres (règle FCFA), et `metadata` reste vide. */

  /** Notifications du changement de barème envoyées avec succès. */
  private async notifyTechnicianChannels(
    technician: { id: string; firstName: string; email: string },
    missionsUrl: string,
  ): Promise<string[]> {
    const failed: string[] = [];

    /* Canal 1 : notification in-app (persistée). `ADMIN_MESSAGE` est le type
     * déjà utilisé par `sendTechnicianMessage` : aucun nouveau type, aucune
     * migration, et le technicien la voit dans son espace existant. */
    let notificationId: string | null = null;
    try {
      const notification = await this.prisma.notification.create({
        data: {
          userId: technician.id,
          /* Barème ≠ mission : `demandeId` reste `null`, donc l'app affiche la
           * notification à plat (jamais regroupée par mission). */
          demandeId: null,
          type: 'ADMIN_MESSAGE',
          title: 'Nouveau barème Relio',
          message:
            'La commission Relio est désormais de 500 FCFA + 4 % par mission, ' +
            'avec un minimum de 5 000 FCFA par intervention. Votre commission ' +
            'est affichée dans chaque devis.',
        },
      });
      notificationId = notification.id;
    } catch (error) {
      failed.push('notification');
      this.logKycChannelFailure('notification in-app (barème)', technician.id, error);
    }

    /* Canal 2 : SSE (onglet ouvert). */
    if (this.realtime) {
      try {
        if (notificationId) {
          this.realtime.publishToUser(technician.id, 'notification.created', {
            notificationId,
            kind: 'ADMIN_MESSAGE',
          });
        }
        this.realtime.publishToUser(technician.id, 'technician.fee_changed', {
          technicianId: technician.id,
        });
      } catch (error) {
        failed.push('sse');
        this.logKycChannelFailure('SSE (barème)', technician.id, error);
      }
    }

    /* Canal 3 : push web VAPID (onglet fermé). `sendToUser` ne lève jamais et
     * SUPPRIME l'envoi si une connexion SSE est active : pas de doublon. */
    if (this.push) {
      try {
        await this.push.sendToUser(technician.id, {
          title: 'Nouveau barème Relio',
          body: 'Commission : 500 FCFA + 4 % par mission. Minimum 5 000 FCFA par intervention.',
          tag: `fee-change-${technician.id}`,
          url: '/technicien/demandes',
          type: 'fee_change',
        });
      } catch (error) {
        failed.push('push');
        this.logKycChannelFailure('push (barème)', technician.id, error);
      }
    }

    /* Canal 4 : e-mail (Resend). */
    if (this.email && technician.email) {
      try {
        await this.email.sendFeeChangeEmail(
          technician.email,
          technician.firstName,
          missionsUrl,
        );
      } catch (error) {
        failed.push('email');
        this.logKycChannelFailure('e-mail (barème)', technician.id, error);
      }
    }

    return failed;
  }

  /**
   * Notifie TOUS les techniciens actifs du nouveau barème (500 FCFA + 4 %,
   * minimum 5 000 FCFA par intervention). Déclenchement manuel par l'admin.
   */
  async notifyTechniciansFeeChange() {
    const technicians = await this.prisma.user.findMany({
      where: { role: 'TECHNICIAN', isActive: true },
      select: { id: true, firstName: true, email: true },
      orderBy: { createdAt: 'asc' },
    });

    const missionsUrl = `${this.frontendUrl()}/technicien/demandes`;

    let sent = 0;
    const failedChannels: Record<string, number> = {};
    for (const technician of technicians) {
      try {
        const failures = await this.notifyTechnicianChannels(technician, missionsUrl);
        if (failures.length === 0) {
          sent += 1;
        } else {
          for (const channel of failures) {
            failedChannels[channel] = (failedChannels[channel] ?? 0) + 1;
          }
        }
      } catch (error) {
        /* Filet de sécurité : un échec inattendu sur UN technicien
         * n'interrompt jamais la campagne. */
        this.logKycChannelFailure('canal (barème)', technician.id, error);
        failedChannels['inconnu'] = (failedChannels['inconnu'] ?? 0) + 1;
      }
    }

    const failed = technicians.length - sent;
    this.logger.log(
      `Notification du nouveau barème : ${sent} technicien(s) notifié(s), ${failed} en échec ` +
        `sur ${technicians.length} technicien(s) actif(s).`,
    );

    return {
      sent,
      failed,
      total: technicians.length,
      /* Détail par canal, pour que l'admin sache SI l'e-mail est parti ou
       * si seul un canal a échoué. */
      failedChannels,
      /* Le contenu exact, afin que l'admin puisse le comparer au gabarit
       * affiché dans l'interface avant de déclencher. */
      rule: {
        commission: '500 FCFA + 4 % du montant du devis',
        minimumQuote: '5 000 FCFA',
      },
    };
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
            audioStoragePath: true,
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
        // Présence d'une note vocale (chemin privé jamais exposé).
        hasAudio: !!diagnostic.audioStoragePath,
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

  /* ── Gestion des comptes (Sprint ADMIN SUPER POWERS) ──────── */
  /* Recherche de comptes TECHNICIAN (miroir de la recherche clients) :
   * identité minimale (id / prénom / nom / email / actif), réservé ADMIN. */
  async searchTechnicianUsers(query: string) {
    const q = query.trim();
    if (!q) return { items: [] };

    const users = await this.prisma.user.findMany({
      where: {
        role: Role.TECHNICIAN,
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
        isActive: true,
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
        isActive: user.isActive,
      })),
    };
  }

  /* Détail d'un compte pour l'admin : identité, rôle, état, dates, et
   * compteurs de dépendances qui conditionnent la stratégie de suppression
   * (physique si tout est à zéro, désactivation logique sinon). */
  async getUserAccount(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        isActive: true,
        createdAt: true,
      },
    });
    if (!user) throw new NotFoundException('Compte introuvable.');
    const dependencies = await this.countUserDependencies(userId);
    return {
      ...user,
      createdAt: user.createdAt.toISOString(),
      dependencies,
      deletable: Object.values(dependencies).every((count) => count === 0),
    };
  }

  /* Suppression administrative d'un compte CLIENT ou TECHNICIAN.
   * Règle fondamentale : l'historique (missions, devis, diagnostics, ledger,
   * KYC) n'est jamais détruit.
   *   - zéro dépendance → suppression PHYSIQUE ;
   *   - au moins une dépendance → DÉSACTIVATION (isActive = false) : le
   *     compte ne peut plus se connecter, mais toutes ses données restent
   *     lisibles (missions, finances, réconciliation).
   * Garde-fous backend : jamais sur un compte ADMIN, jamais sur soi-même. */
  async deleteUserAccount(adminId: string, userId: string) {
    if (adminId === userId) {
      throw new BadRequestException('Vous ne pouvez pas supprimer votre propre compte.');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, firstName: true, lastName: true, email: true, isActive: true },
    });
    if (!user) throw new NotFoundException('Compte introuvable.');
    if (user.role === 'ADMIN') {
      throw new ForbiddenException('Un compte administrateur ne peut pas être supprimé.');
    }

    const dependencies = await this.countUserDependencies(userId);
    const total = Object.values(dependencies).reduce((sum, count) => sum + count, 0);
    if (total === 0) {
      await this.prisma.user.delete({ where: { id: userId } });
      return {
        id: userId,
        role: user.role,
        action: 'DELETED' as const,
        message: 'Compte supprimé (aucune donnée liée).',
        dependencies,
      };
    }
    await this.prisma.user.update({ where: { id: userId }, data: { isActive: false } });
    const details = Object.entries(dependencies)
      .filter(([, count]) => count > 0)
      .map(([name, count]) => `${count} ${name}`)
      .join(', ');
    return {
      id: userId,
      role: user.role,
      action: 'DEACTIVATED' as const,
      message: `Compte désactivé (données conservées : ${details}). Connexion bloquée.`,
      dependencies,
    };
  }

  /* Compte toutes les relations d'un User qui portent de l'historique.
   * Une suppression physique avec un total > 0 est interdite (cascade
   * Demande.clientId destructrice, RESTRICT ledger, profils/KYC liés). */
  private async countUserDependencies(userId: string) {
    const [
      demandesClient,
      demandesTechnicien,
      messages,
      diagnostics,
      devis,
      notifications,
      transactions,
      vaguesDispatch,
      evenements,
      avisRediges,
      avisRecus,
      documentsKyc,
      revuesKyc,
      profil,
    ] = await Promise.all([
      this.prisma.demande.count({ where: { clientId: userId } }),
      this.prisma.demande.count({ where: { technicianId: userId } }),
      this.prisma.message.count({ where: { senderId: userId } }),
      this.prisma.diagnostic.count({ where: { technicianId: userId } }),
      this.prisma.quote.count({ where: { technicianId: userId } }),
      this.prisma.notification.count({ where: { userId } }),
      this.prisma.financialTransaction.count({ where: { userId } }),
      this.prisma.dispatchWave.count({ where: { userId } }),
      this.prisma.demandeEvent.count({ where: { actorUserId: userId } }),
      this.prisma.review.count({ where: { authorId: userId } }),
      this.prisma.review.count({ where: { targetId: userId } }),
      this.prisma.kycDocument.count({ where: { technicianId: userId } }),
      this.prisma.kycReview.count({ where: { technicianId: userId } }),
      this.prisma.technicianProfile.count({ where: { userId } }),
    ]);
    return {
      demandesClient,
      demandesTechnicien,
      messages,
      diagnostics,
      devis,
      notifications,
      transactions,
      vaguesDispatch,
      evenements,
      avisRediges,
      avisRecus,
      documentsKyc,
      revuesKyc,
      profil,
    };
  }

  /* ── Message direct ADMIN → TECHNICIEN (Sprint ADMIN SUPER POWERS) ─ */
  /* Le destinataire est résolu côté backend depuis son email normalisé
   * (minuscules, espaces rognés) ; aucun userId frontend ne fait foi.
   * Vérifications : existence, rôle TECHNICIAN, compte actif. Le message est
   * stocké comme Notification (type ADMIN_MESSAGE, sans mission) et apparaît
   * dans l'espace technicien via la liste existante (pas de système
   * parallèle). Réservé ADMIN par le guard du controller. */
  async sendTechnicianMessage(adminId: string, email: string, message: string) {
    void adminId;
    const normalized = email.toLowerCase().trim();
    if (!normalized) throw new BadRequestException('Adresse email invalide.');
    const content = message.trim();
    if (!content) throw new BadRequestException('Le message ne peut pas être vide.');
    if (content.length > 1000) {
      throw new BadRequestException('Le message ne peut pas dépasser 1000 caractères.');
    }

    const technician = await this.prisma.user.findUnique({
      where: { email: normalized },
      select: { id: true, role: true, firstName: true, lastName: true, email: true, isActive: true },
    });
    if (!technician) {
      throw new NotFoundException('Aucun compte technicien trouvé pour cette adresse email.');
    }
    if (technician.role !== 'TECHNICIAN') {
      throw new BadRequestException('Cette adresse email ne correspond pas à un compte technicien.');
    }
    if (!technician.isActive) {
      throw new BadRequestException('Ce compte technicien est désactivé.');
    }

    /* Aucun `metadata` : le message EST le contenu (texte rédigé par l'admin,
     * borné à 1000 caractères, jamais de montant pré-formaté). La colonne reste
     * `null` — on ne remplit pas `metadata` avec une donnée qui ferait doublon
     * avec `message`. */
    const notification = await this.prisma.notification.create({
      data: {
        userId: technician.id,
        demandeId: null,
        type: 'ADMIN_MESSAGE',
        title: 'Message de Relio',
        message: content,
      },
    });

    return {
      id: notification.id,
      technician: {
        id: technician.id,
        firstName: technician.firstName,
        lastName: technician.lastName,
        email: technician.email,
      },
      createdAt: notification.createdAt.toISOString(),
    };
  }
}