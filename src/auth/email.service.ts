import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildMissionAvailableEmail,
  buildVerificationEmail,
} from './email-templates.js';

/**
 * Envoi d'e-mails transactionnels (vérification de compte) via Resend (API HTTPS).
 *
 * La clé API est OPTIONNELLE en développement : tant que RESEND_API_KEY n'est
 * pas définie, l'envoi est simplement journalisé côté serveur et l'inscription
 * reste fonctionnelle (le lien peut être renvoyé plus tard via
 * POST /auth/resend-verification). En production (Railway), définir
 * RESEND_API_KEY pour que les liens de vérification arrivent réellement dans
 * la boîte du client.
 *
 * Un échec d'envoi ne rejette JAMAIS : le compte reste créé mais non vérifié
 * (aucun faux état « vérifié »), l'échec est journalisé sans secret ni
 * donnée sensible, et l'utilisateur peut redemander un lien.
 */
const RESEND_API_URL = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 10_000;

interface ResendErrorBody {
  name?: unknown;
  message?: unknown;
}

/** Contenu strictement non privé d'un e-mail « mission disponible ». */
export interface MissionEmailInput {
  demandeLink: string;
  city: string;
  categoryLabel: string;
  reference: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly apiKey: string | null;
  private readonly from: string;
  private readonly siteUrl: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    this.apiKey = apiKey && apiKey.trim() ? apiKey : null;
    // Adresse d'expédition : EMAIL_FROM prime, puis l'ancien SMTP_FROM
    // (compatibilité), puis le défaut de premier fonctionnement Resend
    // (`onboarding@resend.dev`, expéditeur de test officiel utilisable sans
    // domaine vérifié). Pour l'adresse définitive, définir EMAIL_FROM vers
    // un domaine vérifié dans Resend, sans changer de code.
    this.from =
      this.config.get<string>('EMAIL_FROM') ??
      this.config.get<string>('SMTP_FROM') ??
      'Relio <onboarding@resend.dev>';
    // Base publique pour les liens du footer (jamais l'ancien domaine).
    this.siteUrl =
      this.config.get<string>('FRONTEND_URL')?.trim().replace(/\/+$/, '') ||
      'https://relioo.space';
    if (!this.apiKey) {
      this.logger.warn(
        'RESEND_API_KEY non définie : les e-mails (vérification de compte) ne seront pas envoyés. ' +
          'Définir RESEND_API_KEY (Railway → Variables).',
      );
    }
  }

  get isConfigured(): boolean {
    return this.apiKey !== null;
  }

  /* Envoi brut via Resend. Lève une Error assainie (statut + résumé
   * Resend, jamais la clé) en cas d'échec : l'appelant décide de la
   * politique d'erreur (journalisation, poursuite, reprise). */
  private async postEmail(input: { to: string; subject: string; text: string; html: string }): Promise<void> {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: this.from, to: [input.to], subject: input.subject, text: input.text, html: input.html }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} — ${await this.resendErrorSummary(response)}`);
    }
  }

  private footerLinks(): { siteUrl: string; cguUrl: string; suiviUrl: string } {
    return {
      siteUrl: this.siteUrl,
      cguUrl: `${this.siteUrl}/conditions-utilisation`,
      suiviUrl: `${this.siteUrl}/suivi`,
    };
  }

  async sendVerificationEmail(to: string, verificationLink: string): Promise<void> {
    if (!this.apiKey) {
      this.logger.warn(`[email non envoyé] lien de vérification pour ${to} : ${verificationLink}`);
      return;
    }
    try {
      const content = buildVerificationEmail(verificationLink, this.footerLinks());
      await this.postEmail({
        to,
        subject: content.subject,
        text: content.text,
        html: content.html,
      });
      this.logger.log(`E-mail de vérification envoyé à ${to}.`);
    } catch (error) {
      // Réseau/timeout/HTTP : journalisé sans secret, sans propagation (le compte
      // reste non vérifié, un nouveau lien peut être demandé).
      const reason = error instanceof Error ? error.message : 'erreur inconnue';
      this.logger.error(`Échec d'envoi Resend pour ${to} : ${reason}.`);
    }
  }

  /* E-mail « mission disponible » (dispatch V1). Données strictement limitées
   * à ce que le technicien peut déjà consulter (ville, catégorie, référence,
   * lien applicatif) : aucune donnée privée du client. Lève une Error
   * assainie en cas d'échec : c'est le DispatchService qui isole l'erreur
   * par destinataire (In-App conservée) et journalise. */
  async sendMissionAvailable(to: string, input: MissionEmailInput): Promise<void> {
    const content = buildMissionAvailableEmail(input, this.footerLinks());
    await this.postEmail({
      to,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });
  }

  /** Résumé d'erreur Resend (nom + message uniquement : jamais la clé ni le corps brut). */
  private async resendErrorSummary(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as ResendErrorBody;
      const name = typeof body.name === 'string' ? body.name : 'resend_error';
      const message = typeof body.message === 'string' ? body.message : 'réponse illisible';
      return `${name} — ${message}`;
    } catch {
      return 'réponse illisible';
    }
  }
}
