import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch } from '@nestjs/common';
import { DomainError } from '@whauto/shared';
import type { Response } from 'express';

/**
 * Mappe toute DomainError (et sous-classes) vers une réponse HTTP propre :
 * statut porté par l'erreur + code métier stable pour le frontend.
 * Aucun détail interne (stack, requête SQL…) ne sort de l'API.
 */
@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: DomainError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.status(exception.httpStatus).json({
      statusCode: exception.httpStatus,
      code: exception.code,
      message: exception.message,
      // Détails structurés non sensibles (ex. { canConfirm: true }) si présents.
      ...(exception.details ? { details: exception.details } : {}),
    });
  }
}
