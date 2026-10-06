import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmailService } from './email.service.js';
import { MAX_VERIFICATION_REMINDERS } from './email-templates.js';

/* Chantier D2.5 — relances automatiques de vérification d'e-mail.
 *
 * Une inscription dont l'e-mail n'est jamais confirmé laisse un compte
 * inutilisable (le `RoleGuard` bloque l'accès au dashboard). Ce scheduler
 * rattrape ces comptes en envoyant 3 rappels espacés : J+1, J+3, J+7.
 *
 * AUCUNE dépendance (pas de `@nestjs/schedule`, pas de queue) : le même
 * `onModuleInit` + `setInterval` que `DispatchScheduler`. Un redémarrage ne
 * perd rien, la vérité est en base.
 *
 * OUVERTURE DE TOKEN — point non évident mais déterminant : le token de
 * vérification initial expire au bout de 24 h. Un rappel envoyé à J+1 ou J+3
 * porterait donc un token DÉJÀ MORT. Chaque relance régénère un token neuf
 * (`randomBytes(24)`) avec sa nouvelle expiration, exactement comme le fait
 * `resendVerification`. Sans cela, le rappel serait un e-mail qui ne marche
 * pas — le pire des deux mondes. */

/* Balayage horaire. Les fenêtres sont larges de 2 h (voir `REMINDER_WINDOWS`)
 * pour qu'un balayage tardif ou manqué rattrape le compte au balayage suivant. */
export const VERIFICATION_REMINDER_INTERVAL_MS = 60 * 60 * 1000;

/* Délai minimal entre deux relances du MÊME compte. Une fenêtre de 2 h ne
 * suffit pas à empêcher deux sweeps d'envoyer le même rappel : le compteur est
 * incrementé APRÈS l'envoi, donc deux sweeps concurrents le liraient encore à
 * la même valeur. */
const REMINDER_MIN_GAP_MS = 20 * 60 * 60 * 1000;

/** TTL du token régénéré pour une relance (identique à celui d'origine). */
const REMINDER_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

/** Fenêtres de relance : jour ciblé + demi-largeur en heures.
 *
 * `count` est l'index de la fenêtre ET la valeur attendue de
 * `verificationReminderCount` : un compte qui n'a jamais eu de relance est à 0,
 * donc seule la fenêtre J+1 (count 0) le sélectionne. Une fois le compteur à 1,
 * la fenêtre J+1 ne le re-sélectionne plus. C'est le mécanisme d'idempotence. */
export const REMINDER_WINDOWS: ReadonlyArray<{ count: number; day: number }> = [
  { count: 0, day: 1 },
  { count: 1, day: 3 },
  { count: 2, day: 7 },
];

const HALF_WINDOW_HOURS = 1;

export interface ReminderCandidate {
  id: string;
  email: string;
  firstName: string;
  createdAt: Date;
}

/** Bornes de la fenêtre pour une fenêtre donnée, relatives à `now`. */
export function windowBounds(
  window: { day: number },
  now: Date,
): { gte: Date; lt: Date } {
  const center = now.getTime() - window.day * 24 * HOUR_MS;
  return {
    gte: new Date(center - HALF_WINDOW_HOURS * HOUR_MS),
    lt: new Date(center + HALF_WINDOW_HOURS * HOUR_MS),
  };
}

@Injectable()
export class VerificationReminderScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VerificationReminderScheduler.name);
  private readonly frontendUrl: string;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    config: ConfigService,
  ) {
    this.frontendUrl =
      config.get<string>('FRONTEND_URL')?.replace(/\/+$/, '') ?? 'https://relioo.space';
  }

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.sweep();
    }, VERIFICATION_REMINDER_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Balayage public : existe pour les tests et pour un déclenchement manuel. */
  async sweep(now = new Date()): Promise<number> {
    /* Garde anti-chevauchement : un sweep lent (Resend lent) ne doit pas
     * s'empiler avec le suivant. */
    if (this.running) return 0;
    this.running = true;
    let sent = 0;
    try {
      const gapThreshold = new Date(now.getTime() - REMINDER_MIN_GAP_MS);

      /* UNE seule requête pour les trois fenêtres.
       *
       * Pourquoi pas trois requêtes (une par fenêtre, plus simple à lire) :
       * incrémenter le compteur après l'envoi de la fenêtre J+1 rendait le
       * compte éligible à la fenêtre J+3 *dans le même balayage* — les
       * fenêtres se contaminent dès qu'un compteur bouge. Avec les intervalles
       * réels sur `createdAt` cela n'arrive pas en production (un compte J+1
       * n'a pas 3 jours), mais c'est une dépendance cachée à la donnée, pas une
       * garantie. En groupant d'abord par fenêtre, l'exclusion devient
       * STRUCTURELLE : un compte ne reçoit qu'une relance par balayage, quoi
       * qu'il arrive à son compteur ensuite. */
      const bounds = REMINDER_WINDOWS.map((window) => ({
        window,
        ...windowBounds(window, now),
      }));

      const candidates = (await this.prisma.user.findMany({
        where: {
          /* Seuls les comptes en attente de vérification : un compte vérifié
           * n'a plus rien à prouver, et un compte désactivé ne doit plus
           * recevoir d'e-mail. */
          emailVerified: false,
          isActive: true,
          role: { in: ['CLIENT', 'TECHNICIAN'] },
          /* Plafond global, en plus du `count` exact vérifié plus bas. */
          verificationReminderCount: { lt: MAX_VERIFICATION_REMINDERS },
          /* `null` (jamais relancé) ou ancien de plus de 20 h. */
          OR: [
            { lastVerificationReminderAt: null },
            { lastVerificationReminderAt: { lt: gapThreshold } },
          ],
          /* L'appartenance à UNE fenêtre : compte encore au bon index ET
           * `createdAt` dans la plage correspondante. */
          AND: bounds.map((b) => ({
            verificationReminderCount: b.window.count,
            createdAt: { gte: b.gte, lt: b.lt },
          })),
        },
        select: { id: true, email: true, firstName: true, createdAt: true },
      })) as ReminderCandidate[];

        for (const candidate of candidates) {
        const match = bounds.find(
          (b) =>
            candidate.createdAt.getTime() >= b.gte.getTime() &&
            candidate.createdAt.getTime() < b.lt.getTime(),
        );
        /* Filet de sécurité : si `createdAt` ne tombe dans aucune plage (cas
         * impossible avec la requête ci-dessus), on n'envoie rien plutôt que
         * d'inventer une fenêtre. */
        if (!match) continue;
        sent += await this.sendReminder(candidate, match.window, now);
      }
    } catch (error) {
      this.logger.error(
        `Balayage des relances impossible : ${error instanceof Error ? error.message : 'erreur inconnue'}.`,
      );
    } finally {
      this.running = false;
    }
    return sent;
  }

  /** Envoie AU PLUS une relance à un compte. Toute la sélection a déjà été
   * faite dans `sweep` : ici on ne fait que les garde-fous de dernier moment
   * et l'écriture. */
  private async sendReminder(
    candidate: ReminderCandidate,
    window: { count: number; day: number },
    now: Date,
  ): Promise<number> {
    /* Re-vérification JUSTE avant l'envoi : le compte a pu être vérifié entre
     * la sélection et l'envoi (l'utilisateur clique sur le lien pendant le
     * balayage). Envoyer un rappel à un compte déjà actif serait absurde. */
    const fresh = await this.prisma.user.findUnique({
      where: { id: candidate.id },
      select: { emailVerified: true, verificationReminderCount: true },
    });
    if (!fresh || fresh.emailVerified) return 0;
    /* Plafond dur : même si une régression survenait sur le filtre de
     * sélection, on ne dépasse pas 3 e-mails par compte. */
    if (fresh.verificationReminderCount >= MAX_VERIFICATION_REMINDERS) return 0;

    try {
      /* Token NEUF à chaque relance : le token d'origine expire à 24 h, donc un
       * rappel J+3 porterait sinon un lien déjà mort. */
      const token = randomBytes(24).toString('hex');
      const expiresAt = new Date(now.getTime() + REMINDER_TOKEN_TTL_MS);
      const link = `${this.frontendUrl}/client/verification?token=${token}`;
      const days = Math.max(
        1,
        Math.round((now.getTime() - candidate.createdAt.getTime()) / (24 * HOUR_MS)),
      );

      await this.prisma.user.update({
        where: { id: candidate.id },
        data: {
          emailVerificationToken: token,
          emailVerificationExpiresAt: expiresAt,
        },
      });
      await this.email.sendVerificationReminderEmail(
        candidate.email,
        candidate.firstName,
        link,
        days,
      );
      await this.prisma.user.update({
        where: { id: candidate.id },
        data: {
          verificationReminderCount: window.count + 1,
          lastVerificationReminderAt: now,
        },
      });
      return 1;
    } catch (error) {
      /* Le token a pu être régénéré sans que l'e-mail parte : le compteur
       * n'est PAS incrémenté, donc le compte sera repris au prochain
       * balayage. C'est le comportement voulu (mieux vaut un rappel en
       * double qu'un rappel perdu). */
      const reason = error instanceof Error ? error.message : 'erreur inconnue';
      this.logger.error(`Relance de vérification impossible pour un compte : ${reason}.`);
      return 0;
    }
  }
}
