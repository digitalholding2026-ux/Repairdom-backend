import { describe, expect, it } from 'vitest';
import {
  buildReferralRewardedEmail,
  buildReferralWelcomeEmail,
} from './email-templates.js';

/* Chantier 4B — gabarits e-mails de parrainage. Présentation uniquement,
 * aucun envoi, aucun accès réseau.
 *
 * Ce qui est verrouillé :
 *  1. RÈGLE FCFA — le montant arrive en ENTIER XAF et n'est formaté qu'ici,
 *     jamais stocké pré-formaté ;
 *  2. le message dit CE QUI s'est passé (quelle filleul, quel geste), pas
 *     « une récompense a été versée » ;
 *  3. le filleul comprend que le paiement suit SA première intervention
 *     confirmée, et non son inscription — sinon il croit l'argent acquis ;
 *  4. échappement des données dynamiques : un prénom contenant `<` ne peut
 *     pas injecter de balise dans le HTML.
 */

const LINKS = {
  siteUrl: 'https://relioo.space',
  cguUrl: 'https://relioo.space/conditions-utilisation',
  suiviUrl: 'https://relioo.space/suivi',
};

const REFERRALS_URL = 'https://relioo.space/client/parrainage';
const BALANCE_URL = 'https://relioo.space/client/solde';

describe('buildReferralRewardedEmail (au parrain)', () => {
  const content = buildReferralRewardedEmail('Awa', 'Bobi', 500, REFERRALS_URL, LINKS);

  it('le montant est un entier XAF, présent dans le sujet et le corps', () => {
    expect(content.subject).toContain('500 FCFA');
    expect(content.text).toContain('500 FCFA');
    expect(content.html).toContain('500 FCFA');
  });

  it('nomme la filleul et le geste qui a déclenché la récompense', () => {
    expect(content.text).toContain('Bobi');
    expect(content.text).toContain('première intervention');
  });

  it('mène à la page des parrainages et l\'annonce en CTA', () => {
    expect(content.text).toContain(REFERRALS_URL);
    expect(content.html).toContain(`href="${REFERRALS_URL}"`);
    expect(content.html).toContain('Voir mes parrainages');
  });

  it('incite à continuer d\'inviter', () => {
    expect(content.text).toMatch(/continuer à inviter/i);
  });

  it('prénom vide → formule neutre, jamais une ligne cassée', () => {
    const vide = buildReferralRewardedEmail('', '', 500, REFERRALS_URL, LINKS);
    expect(vide.text).toContain('Bonjour,');
    expect(vide.text).toContain('votre filleul');
  });

  it('échappe les données dynamiques dans le HTML', () => {
    const piégé = buildReferralRewardedEmail(
      'Awa <script>x</script>',
      'Bobi',
      500,
      REFERRALS_URL,
      LINKS,
    );
    expect(piégé.html).not.toContain('<script>');
    expect(piégé.html).toContain('&lt;script&gt;');
  });
});

describe('buildReferralWelcomeEmail (au filleul)', () => {
  const content = buildReferralWelcomeEmail('Bobi', 500, BALANCE_URL, LINKS);

  it('le montant est un entier XAF, présent dans le sujet et le corps', () => {
    expect(content.subject).toContain('500 FCFA');
    expect(content.text).toContain('500 FCFA');
    expect(content.html).toContain('500 FCFA');
  });

  it('rattache explicitement le crédit à l\'intervention confirmée', () => {
    /* Point clé : le filleul ne doit pas croire que l'inscription a payé. */
    expect(content.text).toMatch(/première intervention confirmée/);
    expect(content.html).toMatch(/première intervention confirmée/);
  });

  it('mène à la page solde', () => {
    expect(content.text).toContain(BALANCE_URL);
    expect(content.html).toContain(`href="${BALANCE_URL}"`);
  });

  it('ne mentionne NI le code du parrain NI son e-mail', () => {
    /* Rien qui puisse pousser le filleul à lui transmettre son code. */
    expect(content.text).not.toMatch(/RELIO-[A-Z0-9]{5}/);
    expect(content.html).not.toMatch(/RELIO-[A-Z0-9]{5}/);
    expect(content.text).not.toMatch(/@/);
  });

  it('prénom vide → formule neutre', () => {
    const vide = buildReferralWelcomeEmail('', 500, BALANCE_URL, LINKS);
    expect(vide.text).toContain('Bonjour,');
  });
});
