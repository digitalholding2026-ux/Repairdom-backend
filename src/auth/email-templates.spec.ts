import { describe, expect, it } from 'vitest';
import {
  buildMissionAvailableEmail,
  buildVerificationEmail,
  escapeAttr,
  escapeHtml,
  RELIO_EMAIL_PRIMARY,
  VERIFICATION_EMAIL_SUBJECT,
  VERIFICATION_LINK_VALIDITY_LABEL,
} from './email-templates.js';

/* UI-4 — gabarits e-mails Relio : présentation uniquement, aucun envoi.
 * Vérifie sujets, CTA/routes réelles, branding, absence de secrets et
 * d'ancien domaine, échappement des données dynamiques, durée 24 h. */

const LINKS = {
  siteUrl: 'https://relioo.space',
  cguUrl: 'https://relioo.space/conditions-utilisation',
  suiviUrl: 'https://relioo.space/suivi',
};

describe('buildVerificationEmail', () => {
  const link = 'https://relioo.space/client/verification?token=abc123';
  const content = buildVerificationEmail(link, LINKS);

  it('sujet et route réelle inchangés', () => {
    expect(content.subject).toBe(VERIFICATION_EMAIL_SUBJECT);
    expect(content.html).toContain(`href="${link}"`);
    expect(content.text).toContain(link);
  });

  it('durée réelle 24 h mentionnée', () => {
    expect(VERIFICATION_LINK_VALIDITY_LABEL).toBe('24 heures');
    expect(content.html).toContain('24 heures');
    expect(content.text).toContain('24 heures');
  });

  it('branding Relio : palette, wordmark, preheader, footer', () => {
    expect(content.html).toContain(RELIO_EMAIL_PRIMARY);
    expect(content.html).toContain('>Relio<');
    expect(content.html).toContain('Je vérifie mon adresse email');
    expect(content.html).toContain('Conditions d’utilisation');
    expect(content.html).toContain(LINKS.cguUrl);
    expect(content.html).toContain(LINKS.suiviUrl);
    expect(content.html).toContain('© ');
  });

  it('aucun secret, aucun ancien domaine', () => {
    for (const body of [content.html, content.text]) {
      expect(body).not.toContain('repairdom.vercel.app');
      expect(body).not.toContain('sk_live_');
      expect(body).not.toContain('sk_test_');
      expect(body).not.toContain('Bearer');
    }
  });
});

describe('buildMissionAvailableEmail', () => {
  const input = {
    demandeLink: 'https://relioo.space/technicien/demandes/d-1',
    city: 'Douala',
    categoryLabel: 'Plomberie',
    reference: 'RD-ABC123',
  };
  const content = buildMissionAvailableEmail(input, LINKS);

  it('sujet, CTA et route mission réels', () => {
    expect(content.subject).toBe('Nouvelle mission disponible — Relio (RD-ABC123)');
    expect(content.html).toContain(`href="${input.demandeLink}"`);
    expect(content.text).toContain(input.demandeLink);
    expect(content.html).toContain('Voir la mission');
  });

  it('données strictement limitées, KYC rappelé, aucune donnée privée', () => {
    expect(content.html).toContain('RD-ABC123');
    expect(content.html).toContain('Plomberie');
    expect(content.html).toContain('Douala');
    expect(content.html).toContain('KYC');
    expect(content.html).not.toContain('repairdom.vercel.app');
  });

  it('valeurs dynamiques échappées (XSS)', () => {
    const evil = buildMissionAvailableEmail(
      {
        ...input,
        city: '<script>alert(1)</script>',
        categoryLabel: '"><img src=x onerror=alert(2)>',
      },
      LINKS,
    );
    expect(evil.html).not.toContain('<script>alert(1)</script>');
    expect(evil.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(evil.html).not.toContain('"><img src=x');
  });
});

describe('escapeHtml / escapeAttr', () => {
  it('échappe les caractères HTML et les guillemets', () => {
    expect(escapeHtml('<b>"&"</b>')).toBe('&lt;b&gt;&quot;&amp;&quot;&lt;/b&gt;');
    expect(escapeAttr("a'b\"c")).toBe('a&#39;b&quot;c');
  });
});
