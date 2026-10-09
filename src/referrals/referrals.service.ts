import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { ReferralsNotificationsService } from './referrals-notifications.service.js';
import {
  REFERRAL_MAX_REFERRALS,
  REFERRAL_REWARD_XAF,
  REFERRAL_WELCOME_XAF,
  generateReferralCode,
  isValidReferralCode,
  normalizeReferralCode,
} from './referrals.config.js';

/**
 * Chantier 4B — PARRAINAGE CLIENT.
 *
 * Modèle économique : un client partage un lien `?ref=RELIO-XXXXX`. Son
 * inscription crée un `Referral` en `REGISTERED`. La récompense (500 FCFA de
 * crédit au parrain ET au filleul) n'est versée qu'à la PREMIÈRE mission
 * `CONFIRMED` du filleul.
 *
 * ── Pourquoi PAS à l'inscription ────────────────────────────────────
 * Payer à l'inscription rendrait le mécanisme inépuisable : créer un compte,
 * encaisser 1 000 FCFA, supprimer le compte, recommencer. Le déclencheur est
 * volontairement coûteux : une inscription réelle, une identité vérifiable et
 * une intervention qui va jusqu'à son terme. C'est aussi la seule version
 * où le client a réellement consommé un service.
 *
 * ── Le ledger reste la seule vérité financière ────────────────────────
 * Aucune somme n'est stockée sur `Referral`. La récompense est un barème
 * (`referrals.config.ts`) et le versement est une écriture `FinancialTransaction`.
 * Deux écritures distinctes (`CLIENT_REFERRAL_REWARD` pour le parrain,
 * `CLIENT_REFERRAL_RECEIVED` pour le filleul) plutôt qu'une seule à double
 * sens : le ledger doit pouvoir répondre « qui a été crédité, et pour quoi ».
 *
 * ── Idempotence ──────────────────────────────────────────────────────
 * `referral:${id}:${role}` est la référence d'écriture, UNIQUE en base. Un
 * rejeu (webhook de mission rejoué, double appel) est absorbé par le `P2002` :
 * le client ne peut jamais être crédité deux fois du même parrainage.
 *
 * ── Aucun cycle de modules ───────────────────────────────────────────
 * `ReferralsModule` importe `AuthModule` (EmailService) et `RealtimeModule`,
 * `PushModule`. Il n'importe NI `DemandesModule` NI `FinancialModule` :
 * `DemandesModule` importe `ReferralsModule` pour câbler la confirmation, et
 * le mode financier est lu via `ConfigService` (module global), pas via
 * `FinancialService` — sinon le cycle serait `Demandes → Referrals →
 * Financial → Demandes`.
 */

/** Rôles logiques des deux écritures de récompense. */
type RewardRole = 'referrer' | 'referred';

/** Nombre de tentatives avant d'abandonner face à une collision de code. */
const CODE_GENERATION_ATTEMPTS = 5;

export interface ReferralSummary {
  id: string;
  referredName: string | null;
  /** Jamais l'e-mail du filleul : il est privé, et un téléphone partagé
   *  afficherait une donnée qui ne concerne que son titulaire. */
  referredEmail: string | null;
  status: 'PENDING' | 'REGISTERED' | 'REWARDED' | 'EXPIRED';
  createdAt: string;
  rewardedAt: string | null;
}

export interface MyReferrals {
  code: string;
  shareUrl: string;
  maxReferrals: number;
  usedSlots: number;
  rewardedCount: number;
  referrals: ReferralSummary[];
}

export interface RegisterReferralResult {
  success: boolean;
  /** Prénom du parrain, pour l'accusé de réception côté filleul. */
  referrerName: string;
}

@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: ReferralsNotificationsService,
    private readonly realtime?: RealtimeService,
    /* `ConfigService` est global (`ConfigModule.forRoot({ isGlobal: true })`)
     * : il n'a pas besoin d'être importé par `ReferralsModule`. Il sert à lire
     * `FRONTEND_URL` et `FINANCIAL_MODE` — voir `currentMode()`. */
    private readonly config?: ConfigService,
  ) {}

  /**
   * Code personnel du client, généré à la première demande.
   *
   * Un code n'est PAS créé à l'inscription : un compte qui n'a jamais parrainé
   * n'a pas besoin d'en porter un, et pré-remplir la colonne unique pour
   * tout le monde ne ferait que grossir l'index.
   *
   * Collision : le code est tiré au sort puis persisté ; l'index unique
   * `User.referralCode` est l'arbitre. Sur un `P2002`, on regénère et on
   * recommence — cinq tentatives suffisent très largement (28,6 millions de
   * codes possibles).
   */
  async getOrCreateMyCode(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { referralCode: true },
    });
    if (!user) throw new BadRequestException('Compte introuvable.');
    if (user.referralCode) return user.referralCode;

    for (let attempt = 0; attempt < CODE_GENERATION_ATTEMPTS; attempt += 1) {
      const code = generateReferralCode();
      /* Auto-vérification : un alphabet amputé par un futur refactor ne doit
       * pas produire un code que l'application refusera ensuite. */
      if (!isValidReferralCode(code)) continue;
      try {
        await this.prisma.user.update({
          where: { id: userId },
          data: { referralCode: code },
        });
        return code;
      } catch (error) {
        if ((error as { code?: string }).code !== 'P2002') throw error;
        /* Collision : code déjà pris par un autre compte. On regénère. */
        this.logger.warn(`Code de parrainage déjà pris, nouvelle tentative (${attempt + 1}).`);
      }
    }
    throw new BadRequestException(
      'Impossible de générer un code de parrainage. Réessayez dans un instant.',
    );
  }

  /**
   * Lie un nouveau client à son parrain.
   *
   * Règles anti-abus, TOUTES vérifiées avant toute écriture :
   *   1. le code doit exister et être syntaxiquement valide ;
   *   2. le filleul ne peut pas être son propre parrain ;
   *   3. un client ne peut avoir qu'un parrain (`referredId` UNIQUE) ;
   *   4. un parrain à la limite ne peut plus en accueillir.
   *
   * La règle 4 est volontairement un SILENCE et non une erreur : l'appelant
   * est le parcours d'inscription, et un compte à la limite doit pouvoir
   * s'inscrire normalement. Le refus est journalisé, pas signalé au client.
   *
   * @throws BadRequestException si le code est invalide ou déjà utilisé.
   *   Le parcours d'inscription rattrape ces deux cas.
   */
  async registerReferral(
    userId: string,
    rawCode: string,
    referredEmail?: string | null,
  ): Promise<RegisterReferralResult> {
    const code = normalizeReferralCode(rawCode);
    if (!code) {
      throw new BadRequestException('Code de parrainage invalide.');
    }

    const referrer = await this.prisma.user.findUnique({
      where: { referralCode: code },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    if (!referrer) {
      throw new BadRequestException('Code de parrainage inconnu.');
    }
    /* Règle 2 — auto-parrainage. Un compte qui saisit son propre code ne peut
     * rien gagner : on refuse explicitement plutôt que de créer une ligne qui
     * créditerait deux fois le même compte. */
    if (referrer.id === userId) {
      throw new BadRequestException('Vous ne pouvez pas utiliser votre propre code.');
    }

    /* Règle 3 — déjà parrainé ? L'index UNIQUE sur `referredId` est l'arbitre
     * réel ; on ne le pré-empêche qu'avec une lecture pour pouvoir renvoyer un
     * message clair. */
    const existing = await this.prisma.referral.findUnique({
      where: { referredId: userId },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException('Ce compte est déjà rattaché à un parrainage.');
    }

    /* Règle 4 — limite du parrain. Seuls les filleuls REGISTERED et REWARDED
     * occupent un emplacement : un lien partagé (PENDING) n'a pas encore
     * consomme de place, sinon un parrain qui partage son lien à droite et à
     * gauche épuiserait ses 5 emplacements avant qu'un seul ne s'inscrive. */
    const usedSlots = await this.prisma.referral.count({
      where: {
        referrerId: referrer.id,
        status: { in: ['REGISTERED', 'REWARDED'] },
      },
    });
    if (usedSlots >= REFERRAL_MAX_REFERRALS) {
      this.logger.warn(
        `Parrainage ${referrer.id} : limite de ${REFERRAL_MAX_REFERRALS} filleuls atteinte, ` +
          `le compte ${userId} s'inscrit sans parrainage.`,
      );
      /* On crée quand même la ligne, en EXPIRED : le compte est bien
       * rattaché à ce parrain, mais il ne sera jamais récompensé. Sans cela,
       * un filleul à la limite pourrait être « offert » à un autre parrain
       * via un second code, ce qui contournerait la limite. */
      await this.prisma.referral.create({
        data: {
          referrerId: referrer.id,
          referredId: userId,
          code,
          referredEmail: referredEmail?.trim() || null,
          status: 'EXPIRED',
        },
      });
      return { success: false, referrerName: '' };
    }

    await this.prisma.referral.create({
      data: {
        referrerId: referrer.id,
        referredId: userId,
        code,
        referredEmail: referredEmail?.trim() || null,
        status: 'REGISTERED',
      },
    });

    return {
      success: true,
      referrerName: referrer.firstName?.trim() || 'votre parrain',
    };
  }

  /**
   * Récompense le parrainage après la PREMIÈRE mission confirmée du filleul.
   *
   * Appelé par `DemandesService` APRÈS la transaction de confirmation, dans
   * le même `try/catch` que le programme de récompenses : un échec ici ne doit
   * jamais faire échouer une confirmation de mission déjà réglée.
   *
   * Renvoie `true` si une récompense a été versée, `false` sinon (aucun
   * parrainage en attente, ou déjà récompensé).
   */
  async onReferredMissionConfirmed(referredUserId: string): Promise<boolean> {
    const referral = await this.prisma.referral.findFirst({
      where: { referredId: referredUserId, status: 'REGISTERED' },
      select: {
        id: true,
        referrerId: true,
        referredId: true,
        /* Le prénom du parrain est relu par le service de notifications
         * (il construit l'e-mail) : inutile ici. */
        referrer: false,
        referred: { select: { firstName: true, lastName: true } },
      },
    });
    if (!referral?.referredId) return false;

    const rewardedAt = new Date();
    const mode = this.currentMode();

    /* Claim atomique AVANT les écritures : le `where` porte le statut lu,
     * donc deux confirmations simultanées (double webhook) ne créditent
     * qu'une fois. C'est le verrou principal : les écritures ledger sont
     * idempotentes, mais sans ce claim deux transactions pourraient toutes
     * deux passer avant que la première ne commite. */
    const claimed = await this.prisma.referral.updateMany({
      where: { id: referral.id, status: 'REGISTERED' },
      data: { status: 'REWARDED', rewardedAt },
    });
    if (claimed.count === 0) {
      this.logger.warn(
        `Parrainage ${referral.id} déjà récompensé : deuxième confirmation ignorée.`,
      );
      return false;
    }

    await this.prisma.$transaction(async (tx) => {
      await this.writeReward(tx, referral.referrerId, 'referrer', mode, {
        referralId: referral.id,
      });
      await this.writeReward(tx, referral.referredId!, 'referred', mode, {
        referralId: referral.id,
      });
    });

    /* Notifications APRÈS commit : un push ou un e-mail ne doit jamais
     * pouvoir faire croire à une récompense qui n'a pas été créditée. */
    const referredName =
      [referral.referred?.firstName, referral.referred?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim() || 'votre filleul';
    await this.notifications.notifyReferrerRewarded(
      referral.referrerId,
      referredName,
    );
    await this.notifications.notifyReferredRewarded(referral.referredId!);

    /* Rafraîchit aussi la page parrainage du parrain si elle est ouverte. */
    this.realtime?.publishToUser(referral.referrerId, 'client.referrals_updated', {
      referralId: referral.id,
      status: 'REWARDED',
    });

    return true;
  }

  /**
   * Une écriture de ledger de récompense.
   *
   * Référence déterministe et UNIQUE : `referral:{id}:{role}`. Le rôle est
   * dans la clé et non dans le type pour qu'un rejeu du même côté ne puisse
   * jamais être confondu avec le premier versement. Le `P2002` est absorbé :
   * le crédit est déjà fait, ne pas le refaire est le comportement correct.
   */
  private async writeReward(
    tx: Prisma.TransactionClient,
    userId: string,
    role: RewardRole,
    mode: 'REAL' | 'SIMULATION',
    extra: Record<string, string>,
  ): Promise<void> {
    const isReferrer = role === 'referrer';
    const amount = isReferrer ? REFERRAL_REWARD_XAF : REFERRAL_WELCOME_XAF;
    try {
      await tx.financialTransaction.create({
        data: {
          userId,
          /* La récompense n'est rattachée à AUCUNE mission : elle vient d'un
           * geste commercial (un parrainage), pas d'une prestation. */
          demandeId: null,
          type: isReferrer ? 'CLIENT_REFERRAL_REWARD' : 'CLIENT_REFERRAL_RECEIVED',
          direction: 'CREDIT',
          amount,
          status: 'VALIDATED',
          mode,
          reference: `referral:${extra.referralId}:${role}`,
          createdById: userId,
          metadata: {
            ...extra,
            role,
            amountXAF: amount,
            currency: 'XAF',
            /* Aucun encaissement n'a lieu : c'est un avantage acquis par un
             * tiers, jamais une recharge. */
            source: 'referral_program',
          },
        },
      });
    } catch (error) {
      /* Rejeu : la référence existe déjà, le crédit est déjà fait. */
      if ((error as { code?: string }).code === 'P2002') return;
      throw error;
    }
  }

  /**
   * Vue « mes parrainages » : code, lien de partage, progression, liste.
   *
   * Le code est CRÉÉ au besoin : afficher la page `/client/parrainage` doit
   * fonctionner même pour un client qui n'en a jamais demandé.
   */
  async getMyReferrals(userId: string): Promise<MyReferrals> {
    const code = await this.getOrCreateMyCode(userId);
    const rows = await this.prisma.referral.findMany({
      where: { referrerId: userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        referredId: true,
        referredEmail: true,
        status: true,
        createdAt: true,
        rewardedAt: true,
        referred: { select: { firstName: true, lastName: true } },
      },
    });

    const referrals: ReferralSummary[] = rows.map((row) => ({
      id: row.id,
      referredName:
        [row.referred?.firstName, row.referred?.lastName].filter(Boolean).join(' ').trim() ||
        null,
      referredEmail: row.referredEmail,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      rewardedAt: row.rewardedAt ? row.rewardedAt.toISOString() : null,
    }));

    const rewardedCount = referrals.filter((r) => r.status === 'REWARDED').length;
    /* Les emplacements occupés sont ceux qui comptent : REGISTERED et
     * REWARDED. Un EXPIRED ne consomme rien, un PENDING pas encore. */
    const usedSlots = referrals.filter(
      (r) => r.status === 'REGISTERED' || r.status === 'REWARDED',
    ).length;

    return {
      code,
      shareUrl: `${this.frontendUrl()}/client/inscription?ref=${encodeURIComponent(code)}`,
      maxReferrals: REFERRAL_MAX_REFERRALS,
      usedSlots,
      rewardedCount,
      referrals,
    };
  }

  /**
   * Mode financier autoritaire du serveur.
   *
   * Lu via `ConfigService` (module global) et NON via `FinancialService` :
   * ce dernier vit dans `FinancialModule`, qui importe `DemandesModule`, qui
   * importerait `ReferralsModule` — un cycle. Le mode reste une décision
   * serveur dans les deux cas, jamais un choix du client.
   */
  private currentMode(): 'REAL' | 'SIMULATION' {
    const raw = this.config?.get<string>('FINANCIAL_MODE')?.trim().toUpperCase();
    return raw === 'REAL' ? 'REAL' : 'SIMULATION';
  }

  private frontendUrl(): string {
    const configured = this.config?.get<string>('FRONTEND_URL')?.trim().replace(/\/+$/, '');
    return configured || 'https://relioo.space';
  }
}