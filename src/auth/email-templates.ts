/* UI-4 — gabarits e-mails transactionnels Relio (présentationnel pur).
 *
 * Deux e-mails existent réellement : vérification CLIENT et dispatch
 * « mission disponible ». Sujets, déclencheurs, destinataires et données
 * injectées inchangés ; seule la présentation est harmonisée (identité
 * Relio, structure partagée, preheader, footer, responsive, CTA).
 *
 * Contraintes e-mail : HTML tabulaire + styles inline (compatibilité
 * clients), stack Arial/Helvetica (pas de police externe), aucun secret
 * ni token dans le texte visible (le lien signé reste dans le href et le
 * bloc URL de secours, jamais exposé ailleurs), valeurs dynamiques
 * systématiquement échappées (XSS/injection).
 *
 * Logo : wordmark texte (aucun raster servi publiquement aujourd'hui —
 * `frontend/logo/Relio-removebg-preview.png` n'est pas sous `public/`, et
 * les SVG `public/brand/*` sont mal supportés en e-mail). Pour un logo
 * image : publier un PNG sous `frontend/public/brand/`, redéployer le
 * frontend, puis référencer son URL HTTPS absolue avec `alt="Relio". */

export const RELIO_EMAIL_PRIMARY = '#007BFF';
export const RELIO_EMAIL_DARK = '#0F172A';

export const VERIFICATION_EMAIL_SUBJECT = 'Vérifiez votre adresse email — Relio';
/** Durée réelle du lien (backend `VERIFICATION_TOKEN_TTL_MS` = 24 h). */
export const VERIFICATION_LINK_VALIDITY_LABEL = '24 heures';

export interface EmailFooterLinks {
  siteUrl: string;
  cguUrl: string;
  suiviUrl: string;
}

/** Échappe une valeur dynamique pour le HTML texte. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Échappe une valeur dynamique pour un attribut HTML entre guillemets. */
export function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

export interface EmailLayoutInput {
  preheader: string;
  title: string;
  /** Corps HTML déjà composé (paragraphes, encadrés) — construire avec `escapeHtml`. */
  bodyHtml: string;
  ctaLabel: string;
  ctaUrl: string;
  links: EmailFooterLinks;
}

/** Structure partagée : preheader, header Relio, titre, corps, CTA, URL de
 *  secours, footer. Fond clair volontaire (lisible même si le client mail
 *  force son propre dark mode). */
export function emailLayout(input: EmailLayoutInput): string {
  const preheader = escapeHtml(input.preheader);
  const title = escapeHtml(input.title);
  const ctaLabel = escapeHtml(input.ctaLabel);
  const ctaUrl = escapeAttr(input.ctaUrl);
  const siteUrl = escapeAttr(input.links.siteUrl);
  const cguUrl = escapeAttr(input.links.cguUrl);
  const suiviUrl = escapeAttr(input.links.suiviUrl);
  const year = new Date().getFullYear();
  return [
    '<!DOCTYPE html>',
    '<html lang="fr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${title}</title>`,
    '<style>@media only screen and (max-width:480px){.relio-cta a{padding:14px 20px !important;}}</style>',
    '</head>',
    '<body style="margin:0;padding:0;background-color:#F1F5F9;">',
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F1F5F9;">',
    '<tr><td align="center" style="padding:24px 12px;">',
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;">',
    `<tr><td style="background-color:${RELIO_EMAIL_PRIMARY};background-image:linear-gradient(135deg,#00AEEF,#8A2BE2);border-radius:12px 12px 0 0;padding:20px 24px;">`,
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:24px;font-weight:700;color:#FFFFFF;letter-spacing:0.5px;">Relio</div>',
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#FFFFFF;opacity:0.9;margin-top:4px;">Dépannage vérifié à domicile</div>',
    '</td></tr>',
    '<tr><td style="background-color:#FFFFFF;border:1px solid #E2E8F0;border-top:0;border-radius:0 0 12px 12px;padding:24px;">',
    `<h1 style="font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:1.35;color:${RELIO_EMAIL_DARK};margin:0 0 12px 0;">${title}</h1>`,
    input.bodyHtml,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="relio-cta" style="margin:20px 0 8px 0;">',
    `<tr><td align="center" style="background-color:${RELIO_EMAIL_PRIMARY};border-radius:8px;"><a href="${ctaUrl}" style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;color:#FFFFFF;text-decoration:none;padding:14px 28px;">${ctaLabel}</a></td></tr>`,
    '</table>',
    `<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#64748B;word-break:break-all;">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br><a href="${ctaUrl}" style="color:${RELIO_EMAIL_PRIMARY};">${escapeHtml(input.ctaUrl)}</a></p>`,
    '</td></tr>',
    '<tr><td align="center" style="padding:16px 8px 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.7;color:#64748B;">',
    '<div>Relio — la plateforme de dépannage vérifié.</div>',
    `<div><a href="${siteUrl}" style="color:${RELIO_EMAIL_PRIMARY};text-decoration:underline;">Accueil</a> · <a href="${cguUrl}" style="color:${RELIO_EMAIL_PRIMARY};text-decoration:underline;">Conditions d’utilisation</a> · <a href="${suiviUrl}" style="color:${RELIO_EMAIL_PRIMARY};text-decoration:underline;">Suivre une intervention</a></div>`,
    `<div>© ${year} Relio</div>`,
    '</td></tr>',
    '</table>',
    '</td></tr>',
    '</table>',
    '</body>',
    '</html>',
  ].join('');
}

function infoBox(lines: string[]): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0;"><tr><td style="background-color:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:12px 14px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.7;color:#334155;">${lines.join('<br>')}</td></tr></table>`;
}

function paragraph(text: string, muted = false): string {
  const color = muted ? '#64748B' : '#334155';
  const size = muted ? 13 : 15;
  return `<p style="font-family:Arial,Helvetica,sans-serif;font-size:${size}px;line-height:1.65;color:${color};margin:0 0 12px 0;">${text}</p>`;
}

export interface VerificationEmailContent {
  subject: string;
  text: string;
  html: string;
}

/** E-mail de vérification CLIENT. Route réelle : `/client/verification?token=…`. */
export function buildVerificationEmail(link: string, links: EmailFooterLinks): VerificationEmailContent {
  const text = [
    'Bonjour,',
    '',
    'Bienvenue sur Relio. Pour activer votre compte et passer vos premières demandes de dépannage,',
    'confirmez votre adresse email en cliquant sur le lien ci-dessous :',
    '',
    link,
    '',
    `Ce lien est valable ${VERIFICATION_LINK_VALIDITY_LABEL}. Si vous n'êtes pas à l'origine de cette inscription, ignorez cet e-mail.`,
    '',
    'À bientôt,',
    "L'équipe Relio",
    '',
    `Relio — ${links.siteUrl} — Conditions : ${links.cguUrl}`,
  ].join('\n');
  const html = emailLayout({
    preheader: 'Activez votre compte Relio en confirmant votre adresse email.',
    title: 'Bienvenue sur Relio',
    bodyHtml: [
      paragraph('Pour activer votre compte et passer vos premières demandes de dépannage, confirmez votre adresse email en cliquant sur le bouton ci-dessous :'),
      infoBox([`Validité du lien : <strong>${VERIFICATION_LINK_VALIDITY_LABEL}</strong>`]),
      paragraph(
        "Si vous n'êtes pas à l'origine de cette inscription, ignorez cet e-mail.",
        true,
      ),
    ].join(''),
    ctaLabel: 'Je vérifie mon adresse email',
    ctaUrl: link,
    links,
  });
  return { subject: VERIFICATION_EMAIL_SUBJECT, text, html };
}

export interface MissionAvailableEmailInput {
  demandeLink: string;
  city: string;
  categoryLabel: string;
  reference: string;
}

export interface MissionAvailableEmailContent {
  subject: string;
  text: string;
  html: string;
}

/** E-mail dispatch « mission disponible ». Données strictement limitées à
 *  ce que le technicien peut déjà consulter (aucune donnée privée client). */
export function buildMissionAvailableEmail(
  input: MissionAvailableEmailInput,
  links: EmailFooterLinks,
): MissionAvailableEmailContent {
  const city = input.city;
  const categoryLabel = input.categoryLabel;
  const reference = input.reference;
  const text = [
    'Bonjour,',
    '',
    'Une nouvelle mission est disponible dans votre secteur ' +
      `(${categoryLabel}, ${city}, réf. ${reference}).`,
    'Consultez les détails dans l’application pour accepter la mission :',
    '',
    input.demandeLink,
    '',
    'Connectez-vous, et complétez votre vérification KYC si nécessaire.',
    '',
    'À bientôt,',
    "L'équipe Relio",
    '',
    `Relio — ${links.siteUrl}`,
  ].join('\n');
  const html = emailLayout({
    preheader: `Nouvelle mission ${reference} disponible dans votre secteur.`,
    title: 'Nouvelle mission disponible',
    bodyHtml: [
      paragraph(
        'Une intervention correspondant à votre zone est disponible. Consultez les détails dans l’application pour accepter la mission :',
      ),
      infoBox([
        `Référence : <strong>${escapeHtml(reference)}</strong>`,
        `Catégorie : <strong>${escapeHtml(categoryLabel)}</strong>`,
        `Ville : <strong>${escapeHtml(city)}</strong>`,
      ]),
      paragraph('Connectez-vous, et complétez votre vérification KYC si nécessaire.', true),
    ].join(''),
    ctaLabel: 'Voir la mission',
    ctaUrl: input.demandeLink,
    links,
  });
  return { subject: `Nouvelle mission disponible — Relio (${reference})`, text, html };
}
