/**
 * Chantier 4B — PARRAINAGE : barème et génération de code.
 *
 * Ce module est **pur** : aucune dépendance Nest, aucune base, aucun réseau.
 * C'est ce qui permet de le tester intégralement et de l'utiliser aussi bien
 * côté service que côté DTO (validation d'un code saisi).
 */

/** Préfixe affiché dans l'interface : « RELIO-A7K2M ». */
export const REFERRAL_CODE_PREFIX = 'RELIO-';

/** Nombre de caractères aléatoires APRÈS le préfixe. */
export const REFERRAL_CODE_SUFFIX_LENGTH = 5;

/**
 * Alphabet des codes.
 *
 * Cinq caractères sont volontairement EXCLUSS : `0`, `1`, `I`, `L`, `O`. Ce
 * sont les confusions réelles en lecture à voix haute : « zéro ou O »,
 * « un ou I », « un ou L ». Un code se dicte, se recopie et se lit au
 * téléphone ; retirer ces cinq coûtent 5 caractères d'entropie et évitent
 * l'essentiel des erreurs de saisie.
 *
 * 31 caractères, donc 31⁵ ≈ 28,6 millions de codes pour une audience
 * nationale : le risque de collision sur l'index unique est négligeable, et
 * il reste traité par ailleurs (voir `ReferralsService.getOrCreateMyCode`).
 */
export const REFERRAL_CODE_ALPHABET =
  'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Montant crédité au PARRAIN, en XAF entier. */
export const REFERRAL_REWARD_XAF = 500;

/** Montant crédité au FILLEUL, en XAF entier. */
export const REFERRAL_WELCOME_XAF = 500;

/** Nombre maximum de filleuls rewarded ou registered par parrain. */
export const REFERRAL_MAX_REFERRALS = 5;

/* RÈGLE FCFA : les montants ci-dessus sont des ENTIERS XAF. Le formatage
 * FCFA est fait à l'affichage, jamais ici. */

/**
 * Génère un code `RELIO-XXXXX` (5 caractères alphanumériques).
 *
 * ⚠️ `Math.random` n'est PAS un générateur cryptographique. C'est
 * délibéré et documenté : ce code n'est PAS un secret. Il n'accorde aucun
 * accès, ne déclenche aucun paiement par lui-même — la récompense exige une
 * inscription réelle puis une première mission confirmée. Il sert à
 * identifier le parrain. Utiliser `crypto.randomBytes` pour cela serait de la
 * complexité sans contrepartie.
 *
 * Le risque collision est traité à l'appel (unique en base + retry), pas ici.
 */
export function generateReferralCode(): string {
  let code = REFERRAL_CODE_PREFIX;
  for (let i = 0; i < REFERRAL_CODE_SUFFIX_LENGTH; i += 1) {
    code += REFERRAL_CODE_ALPHABET[
      Math.floor(Math.random() * REFERRAL_CODE_ALPHABET.length)
    ];
  }
  return code;
}

/**
 * Le code est-il syntaxiquement valide ?
 *
 * Utilisé à DEUX endroits : la génération (auto-vérification) et la
 * validation du code saisi à l'inscription. On refuse les espaces et les
 * caractères hors alphabet plutôt que de normaliser : un code mal recopié doit
 * être signalé, pas deviné.
 *
 * Comparaison INSENSIBLE à la casse : un code partagé en majuscules doit
 * fonctionner saisi en minuscules.
 */
export function isValidReferralCode(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string') return false;
  const normalized = raw.trim().toUpperCase();
  if (!normalized.startsWith(REFERRAL_CODE_PREFIX)) return false;
  const suffix = normalized.slice(REFERRAL_CODE_PREFIX.length);
  if (suffix.length !== REFERRAL_CODE_SUFFIX_LENGTH) return false;
  return [...suffix].every((char) => REFERRAL_CODE_ALPHABET.includes(char));
}

/**
 * Normalise une saisie : coupe les espaces, met en majuscules, retire un
 * préfixe absent.
 *
 * `getOrCreateMyCode` stocke toujours la forme canonique ; `referralCode`
 * arriving du frontend est normalisé avant recherche, pour qu'un code
 * recopié en minuscules trouve quand même son porteur.
 */
export function normalizeReferralCode(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (!trimmed) return null;
  const withPrefix = trimmed.startsWith(REFERRAL_CODE_PREFIX)
    ? trimmed
    : `${REFERRAL_CODE_PREFIX}${trimmed}`;
  return isValidReferralCode(withPrefix) ? withPrefix : null;
}