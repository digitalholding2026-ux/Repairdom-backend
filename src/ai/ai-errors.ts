/* IA-1 — erreurs internes du AI Gateway (jamais exposées telles quelles).
 *
 * Conventions calquées sur le rail SasPay : erreur interne propre avec
 * `code` machine + `retryable` (rejouable vs terminal), message générique
 * côté utilisateur. AUCUN secret (clé OpenRouter, Authorization) ne doit
 * jamais transiter par ces objets — les constructeurs n'acceptent que des
 * fragments sûrs (statut HTTP, code distant expurgé, libellé court). */

/* IA-11.3 — classification transport (diagnostic sans contenu) :
 * - request_timeout : fetch avortée par le timeout avant les en-têtes ;
 * - request_network_error : fetch rompue hors timeout ;
 * - upstream_rate_limited / upstream_server_error : 429 / 5xx ;
 * - provider_refused : autre 4xx ;
 * - body_read_error : statut reçu mais corps illisible (dont avorté
 *   pendant la lecture : `abortReason=timeout`, cas prod HTTP 200 à
 *   ~8000 ms) ;
 * - invalid_openrouter_payload : corps JSON valide mais forme inattendue
 *   (pas de `choices` exploitable). */
export type AiTransportReason =
  | 'disabled'
  | 'request_timeout'
  | 'request_network_error'
  | 'upstream_rate_limited'
  | 'upstream_server_error'
  | 'provider_refused'
  | 'body_read_error'
  | 'invalid_openrouter_payload';

/** Cause d'avort : `timeout` (signal/timeout expiré) ou `none`. */
export type AiAbortReason = 'timeout' | 'none';

/** Base des erreurs internes IA : gateway seul émetteur, futurs services
 *  consommateurs (jamais de logique métier ici). */
export class AiGatewayException extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly httpStatus: number | null;
  readonly transportReason: AiTransportReason | null;
  readonly abortReason: AiAbortReason | null;
  constructor(
    message: string,
    code: string,
    retryable: boolean,
    httpStatus: number | null = null,
    transportReason: AiTransportReason | null = null,
    abortReason: AiAbortReason | null = null,
  ) {
    super(message);
    this.name = 'AiGatewayException';
    this.code = code;
    this.retryable = retryable;
    this.httpStatus = httpStatus;
    this.transportReason = transportReason;
    this.abortReason = abortReason;
  }
}

/** IA désactivée (`AI_ENABLED=false`) ou non configurée (clé absente) :
 *  appel non tenté, non rejouable en l'état. */
export class AiDisabledException extends AiGatewayException {
  constructor(message: string, code = 'AI_DISABLED') {
    super(message, code, false, null, 'disabled', 'none');
    this.name = 'AiDisabledException';
  }
}

/** Échec réseau/timeout ou 5xx distant : rejouable avec backoff côté
 *  appelant (le gateway ne réessaie jamais lui-même en IA-1). */
export class AiUpstreamException extends AiGatewayException {
  constructor(
    message: string,
    httpStatus: number | null = null,
    transportReason: AiTransportReason | null = null,
    abortReason: AiAbortReason | null = null,
  ) {
    super(message, 'AI_UPSTREAM', true, httpStatus, transportReason, abortReason);
    this.name = 'AiUpstreamException';
  }
}

/** Refus distant définitif (4xx : clé invalide, quota, validation) :
 *  réessayer à l'identique est inutile. */
export class AiTerminalException extends AiGatewayException {
  constructor(message: string, httpStatus: number, transportReason: AiTransportReason | null = null) {
    super(message, 'AI_TERMINAL', false, httpStatus, transportReason);
    this.name = 'AiTerminalException';
  }
}

/** Réponse 200 inexploitable (JSON illisible, contrat inattendu) :
 *  non rejouable à l'identique sans changer la demande.
 *  IA-11.2 — `finishReason` OpenRouter propagé pour le diagnostic
 *  (`length` = troncature par `max_tokens`, jamais réparée). */
export class AiInvalidResponseException extends AiGatewayException {
  readonly finishReason: string | null;
  constructor(
    message: string,
    finishReason: string | null = null,
    transportReason: AiTransportReason | null = null,
    abortReason: AiAbortReason | null = null,
  ) {
    super(message, 'AI_INVALID_RESPONSE', false, 200, transportReason, abortReason);
    this.name = 'AiInvalidResponseException';
    this.finishReason = finishReason;
  }
}
