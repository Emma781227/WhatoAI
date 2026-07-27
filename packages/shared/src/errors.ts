export class DomainError extends Error {
  public readonly code: string;
  /** Statut HTTP suggéré pour ce type d'erreur, utilisé par le filtre d'exception global. */
  public readonly httpStatus: number;
  /**
   * Détails structurés NON sensibles, joints à la réponse HTTP (ex.
   * `{ canConfirm: true }` pour une suggestion stale). Jamais de donnée interne.
   */
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code = 'DOMAIN_ERROR',
    httpStatus = 400,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string) {
    super(message, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, 'CONFLICT', 409);
    this.name = 'ConflictError';
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
    this.name = 'ValidationError';
  }
}
