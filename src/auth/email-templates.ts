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

export const PASSWORD_RESET_EMAIL_SUBJECT = 'Réinitialisez votre mot de passe — Relio';
/** Durée réelle du lien (backend TTL reset = 1 heure par défaut). */
export const PASSWORD_RESET_LINK_VALIDITY_LABEL = '1 heure';

export const KYC_VERIFIED_EMAIL_SUBJECT = 'Votre identité est vérifiée — Relio';
export const KYC_REJECTED_EMAIL_SUBJECT =
  'Votre dossier de vérification nécessite une correction — Relio';

/* Chantier #4A — récompenses client. Le sujet est générique : il ne contient
 * NI le nom du palier ni un montant, pour ne pas être coûteux en dollars pour
 * une notification qu'un push et l'in-app ont déjà délivrée. */
export const REWARD_TIER_REACHED_EMAIL_SUBJECT =
  'Vous avez débloqué une nouvelle récompense — Relio';

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

export interface PasswordResetEmailContent {
  subject: string;
  text: string;
  html: string;
}

/** E-mail de réinitialisation. Route réelle : `/reinitialiser-mot-de-passe?token=…`
 *  (top-level, rôle détecté après reset). Même structure visuelle que
 *  `buildVerificationEmail` (layout partagé, CTA, URL de secours, footer). */
export function buildPasswordResetEmail(
  firstName: string,
  link: string,
  links: EmailFooterLinks,
): PasswordResetEmailContent {
  const name = firstName.trim() || 'Bonjour';
  const text = [
    `${name},`,
    '',
    'Vous avez demandé à réinitialiser votre mot de passe Relio.',
    'Cliquez sur le lien ci-dessous pour choisir un nouveau mot de passe :',
    '',
    link,
    '',
    `Ce lien expire dans ${PASSWORD_RESET_LINK_VALIDITY_LABEL}. Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.`,
    '',
    'À bientôt,',
    "L'équipe Relio",
    '',
    `Relio — ${links.siteUrl} — Conditions : ${links.cguUrl}`,
  ].join('\n');
  const html = emailLayout({
    preheader: 'Réinitialisez votre mot de passe Relio (lien valable 1 heure).',
    title: 'Réinitialisez votre mot de passe',
    bodyHtml: [
      `<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#334155;margin:0 0 12px 0;">${escapeHtml(name)}, vous avez demandé à réinitialiser votre mot de passe Relio. Cliquez sur le bouton ci-dessous pour en choisir un nouveau :</p>`,
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0;"><tr><td style="background-color:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:12px 14px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.7;color:#334155;">Validité du lien : <strong>${PASSWORD_RESET_LINK_VALIDITY_LABEL}</strong></td></tr></table>`,
      `<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.65;color:#64748B;margin:0 0 12px 0;">Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.</p>`,
    ].join(''),
    ctaLabel: 'Je réinitialise mon mot de passe',
    ctaUrl: link,
    links,
  });
  return { subject: PASSWORD_RESET_EMAIL_SUBJECT, text, html };
}

export interface MissionAvailableEmailInput {  demandeLink: string;
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

/* ── Chantier #5A — décision KYC (technicien) ───────────────────────────── */

export interface KycEmailContent {
  subject: string;
  text: string;
  html: string;
}

/** E-mail « identité vérifiée ». Ton rassurant, non technique : le technicien
 *  n'a rien à faire, c'est une bonne nouvelle qui débloque les missions. */
export function buildKycVerifiedEmail(
  firstName: string,
  dashboardUrl: string,
  links: EmailFooterLinks,
): KycEmailContent {
  const name = firstName.trim() || 'Bonjour';
  const text = [
    `${name},`,
    '',
    'Félicitations, votre identité a été vérifiée par Relio.',
    'Vous pouvez maintenant accepter des missions dans vos zones.',
    '',
    'Consulter les missions disponibles :',
    '',
    dashboardUrl,
    '',
    'À bientôt,',
    "L'équipe Relio",
    '',
    `Relio — ${links.siteUrl}`,
  ].join('\n');
  const html = emailLayout({
    preheader: 'Votre identité est vérifiée : vous pouvez accepter des missions.',
    title: 'Votre identité est vérifiée',
    bodyHtml: [
      paragraph(
        `${escapeHtml(name)}, <strong>votre identité a été vérifiée par Relio.</strong> Vous pouvez maintenant accepter des missions dans vos zones.`,
      ),
      paragraph(
        "Aucune autre démarche n'est nécessaire de votre côté : consultez les missions proposées dans votre secteur et acceptez celles qui vous conviennent.",
        true,
      ),
    ].join(''),
    ctaLabel: 'Voir les missions disponibles',
    ctaUrl: dashboardUrl,
    links,
  });
  return { subject: KYC_VERIFIED_EMAIL_SUBJECT, text, html };
}

/** E-mail « dossier à compléter ». Ton empathique et factuel : le motif est
 *  cité tel quel (décision humaine, pas une formule), jamais une sanction. */
export function buildKycRejectedEmail(
  firstName: string,
  reason: string,
  kycUrl: string,
  links: EmailFooterLinks,
): KycEmailContent {
  const name = firstName.trim() || 'Bonjour';
  /* Le motif vient d'un saisie admin : on le borne pour ne pas déformer le
   * gabarit (le DTO backend limite déjà à 500 caractères). */
  const motif = reason.trim().slice(0, 500) || 'aucun motif renseigné';
  const text = [
    `${name},`,
    '',
    'Votre dossier de vérification n’a pas pu être validé pour le moment.',
    `Motif : ${motif}`,
    '',
    'Vous pouvez corriger et renvoyer votre dossier depuis votre espace :',
    '',
    kycUrl,
    '',
    'À bientôt,',
    "L'équipe Relio",
    '',
    `Relio — ${links.siteUrl}`,
  ].join('\n');
  const html = emailLayout({
    preheader: 'Votre dossier de vérification nécessite une correction.',
    title: 'Votre dossier de vérification nécessite une correction',
    bodyHtml: [
      paragraph(
        `${escapeHtml(name)}, votre dossier de vérification n’a pas pu être validé. Vous pouvez le corriger et le renvoyer : rien n’est perdu, vos accès restent actifs.`,
      ),
      infoBox([`Motif : <strong>${escapeHtml(motif)}</strong>`]),
      paragraph('Corrigez le point indiqué, puis renvoyez votre dossier.', true),
    ].join(''),
    ctaLabel: 'Corriger mon dossier',
    ctaUrl: kycUrl,
    links,
  });
  return { subject: KYC_REJECTED_EMAIL_SUBJECT, text, html };
}

/* ── Chantier #4A — récompenses client ─────────────────────────────────
 *
 * E-mail « palier atteint ». Ton congratulatoire et factuel.
 *
 * RÈGLE FCFA : aucun montant n'est FORMATÉ ici. Les seuils arrivent en XAF
 * entier (`tierSeuilXAF`, `nextTierThresholdXAF`) et le gabarit n'affiche donc
 * que les PALIERS, jamais de somme pré-formatée : la mécanique d'attribution
 * peut évoluer sans que l'e-mail déjà envoyé mente. Les libellés sont échappés.
 *
 * Chantier 4-FONDATIONS-C : la progression porte désormais sur la MARGE
 * CUMULÉE, plus sur un nombre de missions. Il n'y a donc plus de « X missions
 * restantes » — le client n'a aucun compteur de missions à’interpréter.
 */
export function buildRewardTierReachedEmail(
  firstName: string,
  tierLabel: string,
  rewardsUrl: string,
  nextTierThresholdXAF: number | null,
  links: EmailFooterLinks,
): KycEmailContent {
  const name = firstName.trim() || 'Bonjour';
  const tier = tierLabel.trim() || 'palier';
  const suite = nextTierThresholdXAF
    ? `Encore un peu de marge cumulée pour atteindre le palier suivant.`
    : 'Vous avez atteint le dernier palier du programme. Bravo.';

  const text = [
    `${name},`,
    '',
    `Vous avez atteint le palier ${tier} du programme de fidélité Relio.`,
    '',
    'Votre statut de client fidèle a changé, et avec lui vos avantages :',
    'des crédits cumulables et des récompenses.',
    '',
    suite,
    '',
    'Voir mes récompenses :',
    '',
    rewardsUrl,
    '',
    'À bientôt,',
    "L'équipe Relio",
    '',
    `Relio — ${links.siteUrl}`,
  ].join('\n');

  const html = emailLayout({
    preheader: `Vous avez atteint le palier ${tier} de votre programme de fidélité Relio.`,
    title: `Vous avez atteint le palier ${tier}`,
    bodyHtml: [
      paragraph(
        `${escapeHtml(name)}, <strong>vous avez atteint le palier ${escapeHtml(tier)}</strong> de votre programme de fidélité Relio.`,
      ),
      paragraph(
        'Votre statut de client fidèle vient de progresser : des crédits cumulables vous attendent, ainsi que les récompenses que vous avez débloquées.',
      ),
      paragraph(escapeHtml(suite), true),
    ].join(''),
    ctaLabel: 'Voir mes récompenses',
    ctaUrl: rewardsUrl,
    links,
  });
  return { subject: REWARD_TIER_REACHED_EMAIL_SUBJECT, text, html };
}

/* ── Chantier 4-FONDATIONS-A — nouveau barème de commission technicien ────
 *
 * Ton VOLONTAIREMENT positif et non défensif : la commission augmente, mais
 * elle est TRÈS compensée par un plancher de 5 000 FCFA qui écarte les
 * interventions à perte. Annoncer le changement par un e-mail qui commence par
 * « nous augmentons vos frais » ferait partir des techniciens ; l'e-mail
 * commence donc par ce qui s'améliore pour eux.
 *
 * AUCUN MONTANT PRÉ-FORMATÉ : le barème est écrit EN TOUTES LETTRES (« 500
 * FCFA + 4 % »), conformément à la règle FCFA (XAF entier en base,
 * formatage par `formatFCFA` à l'affichage). Le message ne contient aucun
 * token ni secret.
 */
export const FEE_CHANGE_EMAIL_SUBJECT = 'Nouveau barème Relio : plus simple, plus équitable';

/** Libellé public du barème, réutilisé dans le corps de l'e-mail. */
export const FEE_CHANGE_SCHEDULE_LABEL = '500 FCFA + 4 % par mission';
/** Seuil minimum de devis, en toutes lettres (jamais de montant formaté). */
export const FEE_CHANGE_MIN_QUOTE_LABEL = '5 000 FCFA';

export function buildFeeChangeEmail(
  firstName: string,
  missionsUrl: string,
  links: EmailFooterLinks,
): KycEmailContent {
  const name = firstName.trim() || 'Bonjour';

  const text = [
    `${name},`,
    '',
    `À partir d'aujourd'hui, la commission Relio est de ${FEE_CHANGE_SCHEDULE_LABEL}.`,
    '',
    'Concrètement, pour chaque mission confirmée par le client :',
    '- une part fixe de 500 FCFA, quelle que soit l\'intervention ;',
    '- 4 % du montant que vous avez proposé dans votre devis.',
    '',
    'Ce qui change pour le meilleur :',
    '- chaque intervention porte sur un devis d\'au moins 5 000 FCFA :',
    '  plus aucune intervention à perte pour vous ;',
    '- votre commission est affichée dans le récapitulatif de chaque devis,',
    '  vous voyez donc exactement ce que vous gagnez et ce que vous recevez ;',
    '- le programme de fidélité côté client se renforce, ce qui doit relancer',
    '  le volume de missions disponibles.',
    '',
    'Vos frais de déplacement (2 000 FCFA) ne sont pas concernés : ils vous',
    'sont intégralement reversés, en plus de votre devis.',
    '',
    'Le nouveau barème s\'applique immédiatement, y compris aux missions en cours.',
    '',
    'Voir mes missions :',
    '',
    missionsUrl,
    '',
    'À bientôt,',
    "L'équipe Relio",
    '',
    `Relio — ${links.siteUrl}`,
  ].join('\n');

  const html = emailLayout({
    preheader: `Nouveau barème Relio : ${FEE_CHANGE_SCHEDULE_LABEL}, et un minimum de ${FEE_CHANGE_MIN_QUOTE_LABEL} par intervention.`,
    title: 'Nouveau barème Relio : plus simple, plus équitable',
    bodyHtml: [
      paragraph(
        `${escapeHtml(name)}, à partir d'aujourd'hui la commission Relio est de <strong>${escapeHtml(FEE_CHANGE_SCHEDULE_LABEL)}</strong>.`,
      ),
      infoBox([
        'Pour chaque mission confirmée par le client :',
        `une part fixe de 500 FCFA, quelle que soit l'intervention ;`,
        `4 % du montant que vous avez proposé dans votre devis.`,
      ]),
      paragraph('Ce qui change pour le meilleur :'),
      infoBox([
        `chaque intervention porte sur un devis d'au moins ${escapeHtml(FEE_CHANGE_MIN_QUOTE_LABEL)} : plus aucune intervention à perte pour vous ;`,
        'votre commission est affichée dans le récapitulatif de chaque devis ;',
        'le programme de fidélité côté client se renforce, ce qui doit relancer le volume de missions disponibles.',
      ]),
      paragraph(
        "Vos frais de déplacement (2 000 FCFA) ne sont pas concernés : ils vous sont intégralement reversés, en plus de votre devis.",
        true,
      ),
      paragraph(
        "Le nouveau barème s'applique immédiatement, y compris aux missions en cours.",
        true,
      ),
    ].join(''),
    ctaLabel: 'Voir mes missions',
    ctaUrl: missionsUrl,
    links,
  });

  return { subject: FEE_CHANGE_EMAIL_SUBJECT, text, html };
}

/* ── Chantier D2.5 — relances de vérification d'e-mail ────────────────
 *
 * Ton VOLONTAIREMENT non culpabilisant : l'utilisateur n'a rien fait de mal,
 * il a juste créé un compte et peut-être changé d'avis. Menacer ou
 * dramatiser (« votre compte sera supprimé ») ferait fuir ; on rappelle
 * l'intérêt de l'action et on laisse le choix.
 *
 * Trois variantes selon le jour : J+1 (trivial), J+3 (douce relance),
 * J+7 (dernier rappel, sans ultimatum). */

export interface VerificationReminderEmailContent {
  subject: string;
  text: string;
  html: string;
}

/** Nombre maximal de relances envoyées par compte (jamais de 4e e-mail). */
export const MAX_VERIFICATION_REMINDERS = 3;

/* Sujets par jour. Un `switch` plutôt qu'un tableau indexé : un jour hors
 * liste ne doit surtout pas produire un `undefined` en sujet d'e-mail. */
export function verificationReminderSubject(daysSinceCreation: number): string {
  if (daysSinceCreation >= 7) return 'Dernier rappel : activez votre compte Relio';
  if (daysSinceCreation >= 3) return 'Toujours là ? Finalisez votre inscription Relio';
  return 'Rappel : vérifiez votre email pour activer votre compte Relio';
}

/* Paragraphes d'introduction, par palier. */
function reminderIntro(daysSinceCreation: number): string {
  if (daysSinceCreation >= 7) {
    return 'C’est le dernier rappel concernant la confirmation de votre adresse email sur Relio. Vous pouvez continuer à utiliser Relio uniquement avec une adresse vérifiée — c’est ce qui nous permet de vous prévenir en cas de mouvement sur vos demandes.';
  }
  if (daysSinceCreation >= 3) {
    return 'Vous avez créé un compte Relio il y a quelques jours. Il ne reste qu’un détail pour qu’il soit pleinement opérationnel : confirmer votre adresse email.';
  }
  return 'Bienvenue sur Relio ! Il vous reste une petite étape pour que votre compte soit opérationnel : confirmer votre adresse email.';
}

/* Ce que l'utilisateur perd s'il ne vérifie pas — honnête, sans menace. */
function reminderStakes(daysSinceCreation: number): string {
  if (daysSinceCreation >= 7) {
    return 'Sans confirmation, vous ne pourrez plus déposer ni suivre de demande de dépannage depuis ce compte. Vous pouvez aussi nous demander de supprimer votre compte à tout moment.';
  }
  return 'Sans confirmation, vous ne pourrez pas encore déposer de demande de dépannage ni suivre vos interventions.';
}

export function buildVerificationReminderEmail(
  firstName: string,
  link: string,
  daysSinceCreation: number,
  links: EmailFooterLinks,
): VerificationReminderEmailContent {
  const safeName = escapeHtml(firstName);
  const safeDays = Math.max(0, Math.round(daysSinceCreation));
  const subject = verificationReminderSubject(safeDays);
  const text = [
    `Bonjour ${firstName},`,
    '',
    reminderIntro(safeDays),
    '',
    `Pour confirmer votre adresse, cliquez sur le lien ci-dessous :`,
    '',
    link,
    '',
    reminderStakes(safeDays),
    '',
    "Si vous n'êtes pas à l'origine de cette inscription, ignorez cet e-mail.",
    '',
    'À bientôt,',
    "L’équipe Relio",
    '',
    `Relio — ${links.siteUrl} — Conditions : ${links.cguUrl}`,
  ].join('\n');
  const html = emailLayout({
    preheader: reminderIntro(safeDays),
    title: 'Confirmez votre adresse email',
    bodyHtml: [
      paragraph(
        `Bonjour ${safeName}, ${escapeHtml(reminderIntro(safeDays))}`,
      ),
      infoBox([
        `Validité du lien : <strong>${VERIFICATION_LINK_VALIDITY_LABEL}</strong>`,
        `Compte créé il y a <strong>${safeDays} jour${safeDays > 1 ? 's' : ''}</strong>`,
      ]),
      paragraph(escapeHtml(reminderStakes(safeDays))),
      paragraph(
        "Si vous n'êtes pas à l'origine de cette inscription, ignorez cet e-mail.",
        true,
      ),
    ].join(''),
    ctaLabel: 'Je vérifie mon adresse email',
    ctaUrl: link,
    links,
  });
  return { subject, text, html };
}
