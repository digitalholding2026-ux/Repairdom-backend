import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Role } from '../generated/prisma/enums.js';
import { toApiEvent } from '../mission-events/mission-events.js';

/* Nombre max de comptes clients retournés par la recherche admin. */
export const ADMIN_CLIENT_SEARCH_LIMIT = 20;

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

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
