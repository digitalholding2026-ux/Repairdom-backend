/* IA-1 — erreurs internes du AI Gateway (jamais exposées telles quelles).
 *
 * Conventions calquées sur le rail SasPay : erreur interne propre avec
 * `code` machine + `retryable` (rejouable vs terminal), message générique
 * côté utilisateur. AUCUN secret (clé OpenRouter, Authorization) ne doit
 * jamais transiter par ces objets — les constructeurs n'acceptent que des
 * fragments sûrs (statut HTTP, code distant expurgé, libellé court). */

/** Base des erreurs internes IA : gateway seul émetteur, futurs services
 *  consommateurs (jamais de logique métier ici). */
export class AiGatewayException extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly httpStatus: number | null;
  constructor(message: string, code: string, retryable: boolean, httpStatus: number | null = null) {
    super(message);
    this.name = 'AiGatewayException';
    this.code = code;
    this.retryable = retryable;
    this.httpStatus = httpStatus;
  }
}

/** IA désactivée (`AI_ENABLED=false`) ou non configurée (clé absente) :
 *  appel non tenté, non rejouable en l'état. */
export class AiDisabledException extends AiGatewayException {
  constructor(message: string, code = 'AI_DISABLED') {
    super(message, code, false);
    this.name = 'AiDisabledException';
  }
}

/** Échec réseau/timeout ou 5xx distant : rejouable avec backoff côté
 *  appelant (le gateway ne réessaie jamais lui-même en IA-1). */
export class AiUpstreamException extends AiGatewayException {
  constructor(message: string, httpStatus: number | null = null) {
    super(message, 'AI_UPSTREAM', true, httpStatus);
    this.name = 'AiUpstreamException';
  }
}

/** Refus distant définitif (4xx : clé invalide, quota, validation) :
 *  réessayer à l'identique est inutile. */
export class AiTerminalException extends AiGatewayException {
  constructor(message: string, httpStatus: number) {
    super(message, 'AI_TERMINAL', false, httpStatus);
    this.name = 'AiTerminalException';
  }
}

/** Réponse 200 inexploitable (JSON illisible, contrat inattendu) :
 *  non rejouable à l'identique sans changer la demande. */
export class AiInvalidResponseException extends AiGatewayException {
  constructor(message: string) {
    super(message, 'AI_INVALID_RESPONSE', false, 200);
    this.name = 'AiInvalidResponseException';
  }
}
