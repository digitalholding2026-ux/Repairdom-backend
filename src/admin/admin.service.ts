import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Role, DemandeStatus, ConfirmationStatus, FinancialTransactionStatus, FundsHoldStatus, ClientType } from '../generated/prisma/enums.js';
import { hashPassword } from '../auth/password-hash.js';
import { toApiEvent } from '../mission-events/mission-events.js';
import { V2_TO_DEMANDE_STATUS, V2_TO_EVENT_TYPE, type AdminDemandeStatus } from './dto/update-admin-demande-status.dto.js';

/* Nombre max de comptes clients retournés par la recherche admin. */
export const ADMIN_CLIENT_SEARCH_LIMIT = 20;

export const ADMIN_DEMANDE_PAGE_LIMIT = 50;

const logger = new Logger('AdminService');

/* Génère un mot de passe aléatoire robuste qui respecte les règles de
 * validation `assertPasswordStrong()` :
 * - longueur 12 caractères ;
 * - au moins 1 majuscule (A-Z) ;
 * - au moins 1 minuscule (a-z) ;
 * - au moins 1 chiffre (0-9) ;
 * - au moins 1 caractère spécial (! @ # $ % *).
 */
function generateRandomPassword(): string {
  const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const LOWER = 'abcdefghijklmnopqrstuvwxyz';
  const DIGIT = '0123456789';
  const SPECIAL = '!@#$%*';
  const ALL = UPPER + LOWER + DIGIT + SPECIAL;

  const bytes = randomBytes(12);
  const pick = (pool: string): string => pool[bytes[0] % pool.length];

  /* Position fixe pour garantir chaque catégorie, le reste est aléatoire. */
  const chars = [
    pick(UPPER),
    pick(LOWER),
    pick(DIGIT),
    pick(SPECIAL),
  ];
  for (let i = 4; i < 12; i += 1) {
    chars.push(ALL[bytes[i] % ALL.length]);
  }

  /* Mélange pour ne pas laisser les catégories en tête. */
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = bytes[i % bytes.length] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join('');
}

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  /* ── Supervision des demandes (liste globale admin) ────────────────────── */
  /* Liste paginée de toutes les demandes, avec filtre optionnel par statut.
   * Lecture seule, réservée à l'admin. Le frontend appelle
   * `GET /api/admin/demandes` pour alimenter la page "Demandes" du cockpit. */

  async listAdminDemandes(params: {
    status?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(params.page ?? 1, 1);
    const limit = Math.min(Math.max(params.limit ?? ADMIN_DEMANDE_PAGE_LIMIT, 1), 100);
    const where = params.status ? { status: params.status as DemandeStatus } : {};

    const [items, total] = await this.prisma.$transaction([
      this.prisma.demande.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          reference: true,
          status: true,
          category: true,
          description: true,
          city: true,
          neighborhood: true,
          address: true,
          landmark: true,
          contactPhone: true,
          domainId: true,
          brandId: true,
          modelId: true,
          problemId: true,
          clientId: true,
          finalAmount: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.demande.count({ where }),
    ]);

    return {
      items: items.map((d) => ({
        id: d.id,
        reference: d.reference,
        status: d.status,
        category: d.category,
        description: d.description ?? '',
        contact: {
          city: d.city,
          neighborhood: d.neighborhood ?? null,
          address: d.address ?? null,
          contactPhone: d.contactPhone ?? null,
        },
        device: {
          domain: null,
          brand: null,
          model: null,
          problem: null,
        },
        client: null,
        finalAmount: d.finalAmount ?? null,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
      })),
      page,
      limit,
      total,
    };
  }

  /* ── Tableau de bord admin (indicateurs cockpit opérateur) ──────────────── */
  /* Lecture seule, réservée à l'ADMIN. Alimente GET /api/admin/dashboard/stats. */

  async getDashboardStats() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    /* Demandes en attente : reçues (SUBMITTED, PENDING) ou devis (ACCEPTED). */
    const demandesEnAttente = await this.prisma.demande.count({
      where: {
        status: {
          in: [DemandeStatus.SUBMITTED, DemandeStatus.PENDING, DemandeStatus.ACCEPTED],
        },
      },
    });

    /* Demandes en cours : planifiées ou en intervention. */
    const demandesEnCours = await this.prisma.demande.count({
      where: {
        status: {
          in: [DemandeStatus.SCHEDULED, DemandeStatus.IN_PROGRESS],
        },
      },
    });

    /* CA du mois : écritures ledger VALIDATED liées à une mission, ce mois-ci. */
    const caResult = await this.prisma.financialTransaction.aggregate({
      where: {
        status: FinancialTransactionStatus.VALIDATED,
        demandeId: { not: null },
        createdAt: { gte: monthStart },
      },
      _sum: { amount: true },
    });
    const caMois = caResult._sum.amount ?? 0;

    /* 5 dernières demandes avec client et service. */
    const dernieresDemandes = await this.prisma.demande.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        reference: true,
        status: true,
        category: true,
        createdAt: true,
        client: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    return {
      demandesEnAttente,
      demandesEnCours,
      caMois,
      dernieresDemandes: dernieresDemandes.map((d) => ({
        id: d.id,
        reference: d.reference,
        status: d.status,
        service: d.category,
        client: d.client ? `${d.client.firstName} ${d.client.lastName ?? ''}`.trim() : '—',
        createdAt: d.createdAt.toISOString(),
      })),
    };
  }

  /* ── Confirmation de rendez-vous (workflow WhatsApp, M2) ────────────────── */
  /* Confirme le RDV d'une demande. Pour le service SMARTPHONE, l'escrow doit
   * être payé (FundsHold ACTIVE) avant de pouvoir confirmer. */

  async confirmDemande(demandeId: string, actorUserId: string) {
    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      select: { id: true, reference: true, category: true, confirmationStatus: true, clientId: true },
    });
    if (!demande) throw new NotFoundException('Demande introuvable.');
    if (demande.confirmationStatus === ConfirmationStatus.CONFIRMED) {
      throw new BadRequestException('Le rendez-vous est déjà confirmé.');
    }

    /* Smartphone : l'escrow doit être payé (FundsHold ACTIVE) avant confirmation. */
    if (demande.category === 'SMARTPHONE') {
      const hold = await this.prisma.fundsHold.findFirst({
        where: { demandeId, status: FundsHoldStatus.ACTIVE },
        select: { id: true },
      });
      if (!hold) {
        throw new ForbiddenException(
          "L'escrow smartphone doit être payé avant de confirmer le rendez-vous.",
        );
      }
    }

    const updated = await this.prisma.demande.update({
      where: { id: demandeId },
      data: { confirmationStatus: ConfirmationStatus.CONFIRMED },
      select: { id: true, reference: true, confirmationStatus: true },
    });

    logger.log(
      `Demande ${demande.reference} : confirmationStatus -> CONFIRMED (acteur ${actorUserId}).`,
    );
    return updated;
  }

  /* Marque une demande comme « client absent » (no-show) :
   * isNoShow = true, libération du FundsHold de dépôt (frais de déplacement)
   * en faveur de Relio, statut global = CANCELED. */

  async noShowDemande(demandeId: string, actorUserId: string) {
    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      select: { id: true, reference: true, status: true, clientId: true },
    });
    if (!demande) throw new NotFoundException('Demande introuvable.');
    if (demande.status === DemandeStatus.CANCELED) {
      throw new BadRequestException('La demande est déjà annulée.');
    }

    /* Libère le hold de dépôt (frais de déplacement) s'il est encore ACTIVE.
     * Aucun écriture ledger : restitution interne, le hold n'est plus déduit
     * du disponible. Les fonds restent acquis à Relio. */
    const activeHold = await this.prisma.fundsHold.findFirst({
      where: { demandeId, status: FundsHoldStatus.ACTIVE },
      select: { id: true },
    });
    if (activeHold) {
      await this.prisma.fundsHold.update({
        where: { id: activeHold.id },
        data: { status: FundsHoldStatus.RELEASED, releasedAt: new Date() },
      });
    }

    const updated = await this.prisma.demande.update({
      where: { id: demandeId },
      data: {
        confirmationStatus: ConfirmationStatus.CANCELLED_BY_ADMIN,
        isNoShow: true,
        status: DemandeStatus.CANCELED,
      },
      select: { id: true, reference: true, status: true, isNoShow: true, confirmationStatus: true },
    });

    logger.log(
      `Demande ${demande.reference} : NO_SHOW -> confirmationStatus=CANCELLED_BY_ADMIN, isNoShow, hold libéré, statut CANCELED (acteur ${actorUserId}).`,
    );
    return updated;
  }

  /* Met à jour le statut d'une demande (workflow V2 admin).
   * Accepte RECEIVED, IN_PROGRESS, COMPLETED, CANCELLED et les mappe vers
   * l'enum Prisma DemandeStatus. Enregistre un événement DemandeEvent à
   * chaque changement pour l'historique de suivi public. */
  async updateDemandeStatus(demandeId: string, v2Status: AdminDemandeStatus, actorUserId: string) {
    const cible = V2_TO_DEMANDE_STATUS[v2Status];
    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      select: { id: true, reference: true, status: true, clientId: true },
    });
    if (!demande) throw new NotFoundException('Demande introuvable.');
    if (demande.status === cible) {
      throw new BadRequestException(`La demande est déjà en statut ${v2Status}.`);
    }

    /* Transitions autorisées côté admin : depuis n'importe quel statut vers
     * n'importe quel statut V2 (l'admin supervise tout le cycle). */
    const updated = await this.prisma.$transaction(async (tx) => {
      const d = await tx.demande.update({
        where: { id: demandeId },
        data: { status: cible as DemandeStatus },
        select: { id: true, reference: true, status: true },
      });
      await tx.demandeEvent.create({
        data: {
          demandeId,
          actorUserId,
          type: V2_TO_EVENT_TYPE[v2Status] as any,
          fromStatus: demande.status,
          toStatus: cible as DemandeStatus,
          metadata: { source: 'admin_status_update' },
        },
      });
      return d;
    });

    logger.log(
      `Demande ${demande.reference} : statut ${demande.status} → ${cible} (acteur ${actorUserId}).`,
    );
    return updated;
  }

  /* ── Supervision des missions (Sprint 8.6.5) ────────────────── */
  /* Recherche d'une mission par sa référence publique « RD-XXXXXX ».
   * Lecture seule, réservée à l'admin : la chronologie réutilise les
   * événements métier existants (toApiEvent) sans système parallèle, et le
   * DTO n'expose aucun secret (pas de chemin de pièce jointe, ni de données
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

    return {
      reference: demande.reference,
      status: demande.status,
      category: demande.category,
      description: demande.description,
      depositAmount: demande.depositAmount ?? null,
      depositPaid: demande.depositPaid,
      isNoShow: demande.isNoShow,
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
   * (id / prénom / nom / email) — jamais de données financières
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
        phone: true,
        clientType: true,
        companyName: true,
        codePro: true,
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
        phone: user.phone,
        clientType: user.clientType,
        companyName: user.companyName,
        codePro: user.codePro,
      })),
    };
  }

  /* ── Création d'un compte B2B par l'admin ───────────────────────────────── */
  /* POST /api/admin/clients/b2b — réservé ADMIN. Génère un mot de passe
   * aléatoire et un proCode unique, crée le compte (role CLIENT,
   * clientType B2B) et renvoie les identifiants à l'admin pour qu'il les
   * communique au client. Le mot de passe en clair n'est JAMAIS stocké. */
  async createB2BClient(input: {
    email: string;
    firstName: string;
    lastName?: string;
    companyName: string;
    phone?: string;
  }) {
    const existing = await this.prisma.user.findUnique({
      where: { email: input.email.toLowerCase().trim() },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException('Un compte existe déjà avec cette adresse e-mail.');
    }

    /* Mot de passe aléatoire 12 caractères : garantit au moins 1 majuscule,
     * 1 minuscule, 1 chiffre et 1 caractère spécial. Passe assertPasswordStrong(). */
    const plainPassword = generateRandomPassword();
    const passwordHash = await hashPassword(plainPassword);

    /* proCode unique : RELIO-XXXXX (5 hex octets). Retentative en cas de
     * collision sur l'index unique @unique(codePro). */
    let proCode: string;
    for (let attempt = 0; attempt < 5; attempt++) {
      proCode = `RELIO-${randomBytes(3).toString('hex').toUpperCase()}`;
      try {
        const user = await this.prisma.user.create({
          data: {
            email: input.email.toLowerCase().trim(),
            firstName: input.firstName.trim(),
            lastName: input.lastName?.trim() || null,
            phone: input.phone?.trim() || null,
            companyName: input.companyName.trim(),
            role: Role.CLIENT,
            clientType: ClientType.B2B,
            codePro: proCode,
            passwordHash,
            emailVerified: true,
          },
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            companyName: true,
            codePro: true,
            clientType: true,
            createdAt: true,
          },
        });
        return { user, plainPassword };
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') {
          continue; // codePro collision : regénérer
        }
        throw error;
      }
    }
    throw new BadRequestException('Impossible de générer un proCode unique. Réessayez.');
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

  /* Suppression administrative d'un compte CLIENT.
   * Règle fondamentale : l'historique (missions, devis, diagnostics, ledger,
   * pièces jointes) n'est jamais détruit.
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
   * Demande.clientId destructrice, RESTRICT ledger, diagnostics et devis liés). */
  private async countUserDependencies(userId: string) {
    const [
      demandesClient,
      messages,
      diagnostics,
      devis,
      notifications,
      transactions,
      evenements,
      avisRediges,
      avisRecus,
    ] = await Promise.all([
      this.prisma.demande.count({ where: { clientId: userId } }),
      this.prisma.message.count({ where: { senderId: userId } }),
      this.prisma.diagnostic.count({ where: { technicianId: userId } }),
      this.prisma.quote.count({ where: { technicianId: userId } }),
      this.prisma.notification.count({ where: { userId } }),
      this.prisma.financialTransaction.count({ where: { userId } }),
      this.prisma.demandeEvent.count({ where: { actorUserId: userId } }),
      this.prisma.review.count({ where: { authorId: userId } }),
      this.prisma.review.count({ where: { targetId: userId } }),
    ]);
    return {
      demandesClient,
      messages,
      diagnostics,
      devis,
      notifications,
      transactions,
      evenements,
      avisRediges,
      avisRecus,
    };
  }
}
