import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { MetaAppCallbacksService } from './meta-app-callbacks.service';

/**
 * Callbacks d'App Review Meta — PUBLICS (aucun guard tenant), déclenchés par
 * Meta avec un `signed_request` (l'App Secret est l'autorité). Contrôleur
 * ultra-fin : il extrait `signed_request` et délègue. Exclu de Swagger.
 */
@ApiExcludeController()
@Controller('webhooks/whatsapp/meta')
export class MetaAppCallbacksController {
  constructor(private readonly callbacks: MetaAppCallbacksService) {}

  /** L'utilisateur/business retire l'App → teardown + révocation des tokens. */
  @Post('deauthorize')
  @HttpCode(HttpStatus.OK)
  deauthorize(@Body('signed_request') signedRequest: string): Promise<{ success: true }> {
    return this.callbacks.handleDeauthorize(signedRequest);
  }

  /** Demande de suppression de données → { url, confirmation_code } (format Meta). */
  @Post('data-deletion')
  @HttpCode(HttpStatus.OK)
  dataDeletion(
    @Body('signed_request') signedRequest: string,
  ): Promise<{ url: string; confirmation_code: string }> {
    return this.callbacks.handleDataDeletion(signedRequest);
  }

  /** Statut d'une demande de suppression (URL publique renvoyée ci-dessus). */
  @Get('data-deletion/status')
  status(@Query('code') code: string): Promise<{ status: string; confirmation_code: string }> {
    return this.callbacks.getDeletionStatus(code);
  }
}
