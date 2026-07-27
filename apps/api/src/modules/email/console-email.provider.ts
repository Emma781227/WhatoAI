import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EmailProvider, SendEmailOptions } from './email-provider.interface';

/**
 * Mock explicite : n'envoie aucun email réel.
 * En development, affiche le contenu complet (donc les liens de vérification/reset)
 * dans les logs pour permettre de tester les flux à la main.
 * Hors development, ne logge jamais le corps (il contient des tokens bruts) —
 * uniquement destinataire et sujet, avec un avertissement.
 */
@Injectable()
export class ConsoleEmailProvider implements EmailProvider {
  private readonly logger = new Logger(ConsoleEmailProvider.name);

  constructor(private readonly configService: ConfigService) {}

  async send(options: SendEmailOptions): Promise<void> {
    const from = this.configService.get<string>('EMAIL_FROM');

    if (this.configService.get<string>('NODE_ENV') === 'development') {
      this.logger.log(
        `[MOCK EMAIL] from=${from} to=${options.to} subject="${options.subject}"\n${options.text}`,
      );
      return;
    }

    this.logger.warn(
      `[MOCK EMAIL — aucun provider réel configuré] to=${options.to} subject="${options.subject}" (corps non loggé)`,
    );
  }
}
