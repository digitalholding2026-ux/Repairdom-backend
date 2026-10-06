import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  VerificationReminderScheduler,
  REMINDER_WINDOWS,
  VERIFICATION_REMINDER_INTERVAL_MS,
  windowBounds,
} from './verification-reminder.scheduler.js';
import {
  MAX_VERIFICATION_REMINDERS,
  buildVerificationReminderEmail,
  verificationReminderSubject,
} from './email-templates.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { EmailService } from './email.service.js';

/* Chantier D2.5 — relances de vérification d'e-mail.
 *
 * AUCUNE INFRASTRUCTURE : Prisma est un objet littéral, `EmailService` un
 * double, le temps est figé par un `now` explicite passé à `sweep()`.
 *
 * Ce que ces tests verrouillent, dans l'ordre d'importance :
 *  1. aucune relance à un compte déjà vérifié (le cas le plus gênant : un
 *     e-mail de rappel alors que le compte est actif) ;
 *  2. jamais plus de 3 relances par compte ;
 *  3. le jeton est RÉGÉNÉRÉ — sans ça le rappel porte un token expiré depuis
 *     J+1 et ne fonctionne pas ;
 *  4. un échec d'envoi n'arrête pas les comptes suivants. */

const NOW = new Date('2026-03-10T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    email: 'camille@example.cm',
    firstName: 'Camille',
    createdAt: new Date(NOW.getTime() - DAY),
    ...overrides,
  };
}

function harness(opts: { candidates?: unknown[]; sendFails?: boolean } = {}) {
  const state = {
    updates: [] as unknown[],
    sends: [] as { to: string; firstName: string; link: string; days: number }[],
    verifiedIds: new Set<string>(),
    findManyCalls: [] as unknown[],
  };
  const candidates = opts.candidates ?? [];

  const prisma = {
    user: {
      /* Le double RESPECTE le `where` — c'est ce qui rend le test
       * d'idempotence significatif : sans filtrage par compteur, chaque
       * balayage renverrait le même compte et le double mesurerait la
       * mécanique du scheduler, pas la logique métier. */
      findMany: vi.fn(async (args: unknown) => {
        state.findManyCalls.push(args);
        const where = (args as any).where;
        const clauses: any[] = where.AND ?? [];
        return (candidates as any[]).filter((c) => {
          const count = c.verificationReminderCount ?? 0;
          if (count >= where.verificationReminderCount.lt) return false;
          const createdAt = c.createdAt.getTime();
          return clauses.some(
            (clause) =>
              count === clause.verificationReminderCount &&
              createdAt >= clause.createdAt.gte.getTime() &&
              createdAt < clause.createdAt.lt.getTime(),
          );
        });
      }),
      /* Re-vérification « juste avant l'envoi » : un compte vérifié entre la
       * sélection et l'envoi doit être écarté. */
      findUnique: vi.fn(async ({ where }: any) => {
        const id = where?.id as string;
        if (state.verifiedIds.has(id)) return { emailVerified: true, verificationReminderCount: 1 };
        const found = (candidates as any[]).find((c) => c.id === id);
        return found
          ? { emailVerified: false, verificationReminderCount: found.verificationReminderCount ?? 0 }
          : null;
      }),
      /* L'`update` DOIT refléter l'écriture en base, sinon le 2e balayage
       * relit un compteur inchangé et ré-envoie : le test d'idempotence
       * testerait alors le double, pas la logique du compteur. */
      update: vi.fn(async ({ where, data }: any) => {
        state.updates.push({ where, data });
        const target = (candidates as any[]).find((c) => c.id === where?.id);
        if (target) Object.assign(target, data);
        return {};
      }),
    },
  } as unknown as PrismaService;

  const email = {
    sendVerificationReminderEmail: vi.fn(
      async (to: string, firstName: string, link: string, days: number) => {
        if (opts.sendFails) throw new Error('Resend 500');
        state.sends.push({ to, firstName, link, days });
      },
    ),
  } as unknown as EmailService;

  const config = {
    get: vi.fn((key: string) => (key === 'FRONTEND_URL' ? 'https://www.relioo.space' : undefined)),
  } as never;

  const scheduler = new VerificationReminderScheduler(prisma, email, config);
  return { scheduler, prisma, email, state };
}

/* ── Fenêtres ──────────────────────────────────────────────────────── */

describe('VerificationReminderScheduler — fenêtres', () => {
  it('trois fenêtres : J+1, J+3, J+7, indexées 0/1/2', () => {
    expect(REMINDER_WINDOWS).toEqual([
      { count: 0, day: 1 },
      { count: 1, day: 3 },
      { count: 2, day: 7 },
    ]);
  });

  it('chaque fenêtre est centrée sur son jour, large de 2 h', () => {
    const { gte, lt } = windowBounds({ day: 1 }, NOW);
    /* J+1 = veille 12:00 ; fenêtre = [11:00 J+1, 13:00 J+1]. */
    expect(gte.getTime()).toBe(NOW.getTime() - DAY - HOUR);
    expect(lt.getTime()).toBe(NOW.getTime() - DAY + HOUR);
  });

  it('le balayage est horaire', () => {
    expect(VERIFICATION_REMINDER_INTERVAL_MS).toBe(60 * 60 * 1000);
  });
});

/* ── Sélection ─────────────────────────────────────────────────────── */

describe('VerificationReminderScheduler — sélection', () => {
  it('ne sélectionne QUE les comptes non vérifiés, actifs et du bon rôle', async () => {
    const { scheduler, state } = harness({ candidates: [] });
    await scheduler.sweep(NOW);
    /* Une SEULE requête pour les trois fenêtres : la sélection groupe d'abord
     * par fenêtre, ce qui rend l'exclusion mutuelle structurelle. */
    expect(state.findManyCalls).toHaveLength(1);
    const where = (state.findManyCalls[0] as any).where;
    expect(where.emailVerified).toBe(false);
    expect(where.isActive).toBe(true);
    expect(where.role).toEqual({ in: ['CLIENT', 'TECHNICIAN'] });
  });

  it('couvre les trois fenêtres dans une seule requête', async () => {
    const { scheduler, state } = harness({ candidates: [] });
    await scheduler.sweep(NOW);
    const where = (state.findManyCalls[0] as any).where;
    /* Une clause par fenêtre : chaque compte doit être au BON index de
     * compteur ET avoir le BON âge, sinon il est ignoré. */
    expect(where.AND).toHaveLength(3);
    expect(where.AND.map((c: any) => c.verificationReminderCount)).toEqual([0, 1, 2]);
  });

  it('plafonne le compteur (jamais au-delà de MAX)', async () => {
    const { scheduler, state } = harness({ candidates: [] });
    await scheduler.sweep(NOW);
    const where = (state.findManyCalls[0] as any).where;
    expect(where.verificationReminderCount).toEqual({ lt: MAX_VERIFICATION_REMINDERS });
  });

  it('un compte n’est retenu que par la fenêtre qui correspond à son âge', async () => {
    /* Un compte J+1 (count 0) ne doit PAS être capté par la fenêtre J+3. */
    const { scheduler, email } = harness({ candidates: [user()] });
    await scheduler.sweep(NOW);
    expect(email.sendVerificationReminderEmail).toHaveBeenCalledTimes(1);
  });

  it('exige 20 h entre deux relances', async () => {
    const { scheduler, state } = harness({ candidates: [] });
    await scheduler.sweep(NOW);
    const where = (state.findManyCalls[0] as any).where;
    expect(where.OR).toEqual([
      { lastVerificationReminderAt: null },
      {
        lastVerificationReminderAt: {
          lt: new Date(NOW.getTime() - 20 * HOUR),
        },
      },
    ]);
  });

  it('un compte déjà vérifié entre la sélection et l’envoi ne reçoit rien', async () => {
    const { scheduler, email, state } = harness({ candidates: [user()] });
    /* Simule l'utilisateur qui clique sur le lien PENDANT le balayage. */
    state.verifiedIds.add('u1');
    const sent = await scheduler.sweep(NOW);
    expect(sent).toBe(0);
    expect(email.sendVerificationReminderEmail).not.toHaveBeenCalled();
  });

  it('un compte dont le compteur atteint 3 ne reçoit plus rien', async () => {
    const { scheduler, email } = harness({
      candidates: [user({ verificationReminderCount: MAX_VERIFICATION_REMINDERS })],
    });
    const sent = await scheduler.sweep(NOW);
    expect(sent).toBe(0);
    expect(email.sendVerificationReminderEmail).not.toHaveBeenCalled();
    expect(MAX_VERIFICATION_REMINDERS).toBe(3);
  });
});

/* ── Envoi ─────────────────────────────────────────────────────────── */

describe('VerificationReminderScheduler — envoi', () => {
  beforeEach(() => vi.useFakeTimers());

  it('envoie une relance J+1 au compte correspondant', async () => {
    const { scheduler, state } = harness({ candidates: [user()] });
    const sent = await scheduler.sweep(NOW);
    expect(sent).toBe(1);
    expect(state.sends).toHaveLength(1);
    expect(state.sends[0].to).toBe('camille@example.cm');
    expect(state.sends[0].days).toBe(1);
  });

  it('RÉGÉNÈRE un token valide dans le lien envoyé', async () => {
    /* Point le plus subtil du chantier : le token d'origine expire à 24 h,
     * donc un rappel J+3 porterait un lien mort. */
    const { scheduler, state } = harness({ candidates: [user()] });
    await scheduler.sweep(NOW);
    const link = state.sends[0].link;
    expect(link).toMatch(/^https:\/\/www\.relioo\.space\/client\/verification\?token=[0-9a-f]{48}$/);
    const updates = state.updates as any[];
    const tokenUpdate = updates.find((u) => u.data.emailVerificationToken);
    expect(tokenUpdate).toBeDefined();
    expect(tokenUpdate.data.emailVerificationToken).toMatch(/^[0-9a-f]{48}$/);
    expect(tokenUpdate.data.emailVerificationExpiresAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('incrémente le compteur et horodate la relance', async () => {
    const { scheduler, state } = harness({ candidates: [user()] });
    await scheduler.sweep(NOW);
    const last = (state.updates as any[]).at(-1);
    expect(last.data.verificationReminderCount).toBe(1);
    expect(last.data.lastVerificationReminderAt).toEqual(NOW);
  });

  it('deux balayages consécutifs n’envoient qu’un rappel', async () => {
    /* L'idempotence repose sur le compteur : le 2e sweep voit 1 et ne
     * sélectionne plus le compte pour la fenêtre J+1. */
    const { scheduler, email } = harness({ candidates: [user()] });
    await scheduler.sweep(NOW);
    await scheduler.sweep(NOW);
    expect(email.sendVerificationReminderEmail).toHaveBeenCalledTimes(1);
  });

  it('un échec d’envoi n’empêche PAS les comptes suivants', async () => {
    const { scheduler, email, state } = harness({
      candidates: [user({ id: 'u1' }), user({ id: 'u2', email: 'b@example.cm' })],
      sendFails: true,
    });
    /* Les deux échouent, mais les DEUX ont été tentés : le scheduler n'a pas
     * court-circuité sur le premier échec. */
    const sent = await scheduler.sweep(NOW);
    expect(sent).toBe(0);
    expect(email.sendVerificationReminderEmail).toHaveBeenCalledTimes(2);
    /* Et aucun compteur n'a été incrémenté : les comptes seront repris au
     * prochain balayage (mieux vaut un doublon qu'un rappel perdu). */
    const counterUpdates = (state.updates as any[]).filter(
      (u) => u.data.verificationReminderCount !== undefined,
    );
    expect(counterUpdates).toHaveLength(0);
  });

  it('un échec sur le 1er compte laisse partir le 2e', async () => {
    const { scheduler, email } = harness({
      candidates: [user({ id: 'u1' }), user({ id: 'u2', email: 'b@example.cm' })],
    });
    let call = 0;
    (email.sendVerificationReminderEmail as any).mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new Error('Resend 500');
    });
    const sent = await scheduler.sweep(NOW);
    expect(sent).toBe(1);
    expect(email.sendVerificationReminderEmail).toHaveBeenCalledTimes(2);
  });

  it('un balayage déjà en cours est ignoré', async () => {
    const { scheduler, email } = harness({ candidates: [user()] });
    await Promise.all([scheduler.sweep(NOW), scheduler.sweep(NOW)]);
    expect(email.sendVerificationReminderEmail).toHaveBeenCalledTimes(1);
  });
});

/* ── Template ──────────────────────────────────────────────────────── */

const LINKS = {
  siteUrl: 'https://www.relioo.space',
  cguUrl: 'https://www.relioo.space/conditions-utilisation',
  suiviUrl: 'https://www.relioo.space/suivi',
};

describe('buildVerificationReminderEmail', () => {
  it('suit le sujet selon le jour', () => {
    expect(verificationReminderSubject(1)).toBe(
      'Rappel : vérifiez votre email pour activer votre compte Relio',
    );
    expect(verificationReminderSubject(3)).toBe(
      'Toujours là ? Finalisez votre inscription Relio',
    );
    expect(verificationReminderSubject(7)).toBe('Dernier rappel : activez votre compte Relio');
  });

  it('ne produit jamais de sujet vide pour un jour inattendu', () => {
    /* Un index hors liste ne doit surtout pas produire `undefined` en objet
     * d'e-mail. Le ton suit l'ordre décroissant : 99 jours → dernier rappel. */
    expect(verificationReminderSubject(99)).toBe('Dernier rappel : activez votre compte Relio');
    expect(verificationReminderSubject(0)).toBe(
      'Rappel : vérifiez votre email pour activer votre compte Relio',
    );
    expect(verificationReminderSubject(2)).toBe(
      'Rappel : vérifiez votre email pour activer votre compte Relio',
    );
  });

  it('construit un contenu complet (sujet + texte + HTML)', () => {
    const content = buildVerificationReminderEmail(
      'Camille',
      'https://www.relioo.space/client/verification?token=abc',
      1,
      LINKS,
    );
    expect(content.subject).toContain('Relio');
    expect(content.text).toContain('Camille');
    expect(content.text).toContain('abc');
    expect(content.html).toContain('<!DOCTYPE html>');
    expect(content.html).toContain('Camille');
  });

  it('échappe le prénom (injection HTML)', () => {
    const content = buildVerificationReminderEmail(
      '<script>alert(1)</script>',
      'https://www.relioo.space/x?token=abc',
      1,
      LINKS,
    );
    expect(content.html).not.toContain('<script>');
    expect(content.html).toContain('&lt;script&gt;');
  });

  it('change de ton entre J+1 et J+7', () => {
    const j1 = buildVerificationReminderEmail('C', 'https://x/y', 1, LINKS);
    const j7 = buildVerificationReminderEmail('C', 'https://x/y', 7, LINKS);
    expect(j1.subject).not.toBe(j7.subject);
    expect(j7.text).not.toBe(j1.text);
  });

  it('reste non culpabilisant : aucune menace de suppression automatique', () => {
    const content = buildVerificationReminderEmail('C', 'https://x/y', 7, LINKS);
    expect(content.text.toLowerCase()).not.toContain('supprimé automatiquement');
    expect(content.text.toLowerCase()).not.toContain('seront supprim');
  });
});