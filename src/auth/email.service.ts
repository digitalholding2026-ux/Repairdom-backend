import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Envoi d'e-mails transactionnels (vérification de compte).
 *
 * Le SMTP est OPTIONNEL en développement : tant que SMTP_HOST/USER/PASS ne
 * sont pas définis, l'envoi est simplement journalisé côté serveur et
 * l'inscription reste fonctionnelle. En production (Railway), définir
 * SMTP_HOST/SMTP_PORT/SMTP_SECURE/SMTP_USER/SMTP_PASS/SMTP_FROM pour que les
 * liens de vérification arrivent dans la boîte du client.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transporter: Transporter | null = null;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    this.from = this.config.get<string>('SMTP_FROM') ?? 'RepairDom <noreply@repairdom.app>';
    const host = this.config.get<string>('SMTP_HOST');
    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASS');
    if (!host || !user || !pass) {
      this.logger.warn(
        'SMTP non configuré : les e-mails (vérification de compte) ne seront pas envoyés. ' +
          'Définir SMTP_HOST / SMTP_USER / SMTP_PASS / SMTP_FROM (Railway → Variables).',
      );
      this.transporter = null;
      return;
    }
    this.transporter = nodemailer.createTransport({
      host,
      port: Number(this.config.get<string>('SMTP_PORT') ?? '587'),
      secure: this.config.get<string>('SMTP_SECURE') === '1',
      auth: { user, pass },
    });
  }

  get isConfigured(): boolean {
    return this.transporter !== null;
  }

  async sendVerificationEmail(to: string, verificationLink: string): Promise<void> {
    if (!this.transporter) {
      this.logger.warn(`[email non envoyé] lien de vérification pour ${to} : ${verificationLink}`);
      return;
    }
    await this.transporter.sendMail({
      from: this.from,
      to,
      subject: 'Vérifiez votre adresse email — RepairDom',
      text: [
        'Bonjour,',
        '',
        'Bienvenue sur RepairDom. Pour activer votre compte et passer vos premières demandes de dépannage,',
        'confirmez votre adresse email en cliquant sur le lien ci-dessous :',
        '',
        verificationLink,
        '',
        'Ce lien est valable 24 heures. Si vous n\'êtes pas à l\'origine de cette inscription, ignorez cet e-mail.',
        '',
        'À bientôt,',
        "L'équipe RepairDom",
      ].join('\n'),
      html: [
        '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#111827">',
        '<h2 style="color:#0f766e">Bienvenue sur RepairDom</h2>',
        '<p>Pour activer votre compte et passer vos premières demandes de dépannage,',
        'confirmez votre adresse email en cliquant sur le bouton ci-dessous :</p>',
        '<p style="margin:24px 0"><a href="' + verificationLink + '" style="background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">Je vérifie mon adresse email</a></p>',
        '<p style="font-size:13px;color:#6b7280">Ce lien est valable 24 heures.',
        'Si vous n\'êtes pas à l\'origine de cette inscription, ignorez cet e-mail.</p>',
        '<p style="color:#6b7280;font-size:12px">— L\'équipe RepairDom</p>',
        '</div>',
      ].join(''),
    });
    this.logger.log(`E-mail de vérification envoyé à ${to}.`);
  }
}