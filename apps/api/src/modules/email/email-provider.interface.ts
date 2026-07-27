export interface SendEmailOptions {
  to: string;
  subject: string;
  text: string;
}

/**
 * Abstraction de l'envoi d'email. Aucun provider réel n'existe encore :
 * la seule implémentation est ConsoleEmailProvider (mock explicite).
 * Un provider réel (Resend, SES…) sera ajouté derrière cette interface
 * sans toucher aux consommateurs.
 */
export interface EmailProvider {
  send(options: SendEmailOptions): Promise<void>;
}

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');
