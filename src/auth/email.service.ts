import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly apiKey: string | null;
  private readonly from: string;

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

  async sendVerificationEmail(to: string, verificationLink: string): Promise<void> {
    if (!this.apiKey) {
      this.logger.warn(`[email non envoyé] lien de vérification pour ${to} : ${verificationLink}`);
      return;
    }
    try {
      const response = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [to],
          subject: 'Vérifiez votre adresse email — Relio',
          text: [
            'Bonjour,',
            '',
            'Bienvenue sur Relio. Pour activer votre compte et passer vos premières demandes de dépannage,',
            'confirmez votre adresse email en cliquant sur le lien ci-dessous :',
            '',
            verificationLink,
            '',
            'Ce lien est valable 24 heures. Si vous n\'êtes pas à l\'origine de cette inscription, ignorez cet e-mail.',
            '',
            'À bientôt,',
            "L'équipe Relio",
          ].join('\n'),
          html: [
            '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#111827">',
            '<h2 style="color:#007bff">Bienvenue sur Relio</h2>',
            '<p>Pour activer votre compte et passer vos premières demandes de dépannage,',
            'confirmez votre adresse email en cliquant sur le bouton ci-dessous :</p>',
            '<p style="margin:24px 0"><a href="' +
              verificationLink +
              '" style="background:#007bff;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">Je vérifie mon adresse email</a></p>',
            '<p style="font-size:13px;color:#6b7280">Ce lien est valable 24 heures.',
            'Si vous n\'êtes pas à l\'origine de cette inscription, ignorez cet e-mail.</p>',
            '<p style="color:#6b7280;font-size:12px">— L\'équipe Relio</p>',
            '</div>',
          ].join(''),
        }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.error(
          `Échec d'envoi Resend pour ${to} : HTTP ${response.status} — ${await this.resendErrorSummary(response)}.`,
        );
        return;
      }
      this.logger.log(`E-mail de vérification envoyé à ${to}.`);
    } catch (error) {
      // Réseau/timeout : journalisé sans secret, sans propagation (le compte
      // reste non vérifié, un nouveau lien peut être demandé).
      const reason = error instanceof Error ? error.message : 'erreur inconnue';
      this.logger.error(`Échec d'envoi Resend pour ${to} : ${reason}.`);
    }
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
