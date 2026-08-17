import { createHmac, timingSafeEqual } from 'node:crypto';

import type { WhatsAppProvider } from './provider.interface';
import type {
  InboundMessageContentType,
  MarkMessageAsReadInput,
  NormalizedInboundEvent,
  NormalizedInboundStatusEvent,
  ProviderErrorClass,
  RawInboundEvent,
  SendMessageResult,
  SendTextMessageInput,
  WhatsAppBusinessProfile,
  WhatsAppBusinessProfileUpdate,
  WhatsAppProviderName,
} from './types';
import { WhatsAppProviderSendError } from './types';

/**
 * Provider WhatsApp Business Cloud API (Meta). TypeScript PUR : la
 * configuration (secrets inclus) est INJECTÉE par l'app — le package ne lit
 * jamais process.env. Aucun secret n'est loggé ni renvoyé.
 *
 * `graphBaseUrl` est configurable : les tests pointent l'envoi vers un faux
 * serveur Graph local et exercent ainsi le VRAI code (URL, en-têtes, payload,
 * timeout, mapping d'erreurs) sans jamais appeler Meta.
 */
export interface MetaCloudProviderConfig {
  /** App Secret — requis pour la vérification HMAC des webhooks. */
  appSecret?: string;
  /** Token serveur — requis pour l'envoi (worker) et les tests de config (API). */
  accessToken?: string;
  /** Phone Number ID Meta — requis pour l'envoi. */
  phoneNumberId?: string;
  graphApiVersion: string;
  graphBaseUrl: string;
  requestTimeoutMs?: number;
}

interface MetaMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
}

interface MetaStatus {
  id?: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: Array<{ code?: number; title?: string; message?: string; error_data?: unknown }>;
}

interface MetaContact {
  wa_id?: string;
  profile?: { name?: string };
}

const META_TYPE_MAP: Record<string, InboundMessageContentType> = {
  text: 'TEXT',
  image: 'IMAGE',
  audio: 'AUDIO',
  video: 'VIDEO',
  document: 'DOCUMENT',
  location: 'LOCATION',
  contacts: 'CONTACTS',
  sticker: 'STICKER',
};

export class MetaCloudWhatsAppProvider implements WhatsAppProvider {
  constructor(private readonly config: MetaCloudProviderConfig) {}

  getProviderName(): WhatsAppProviderName {
    return 'META_CLOUD';
  }

  /**
   * Autorité cryptographique du webhook (HMAC-SHA256 du corps BRUT avec l'App
   * Secret, comparaison timing-safe). Signature/corps absents → false (l'appelant
   * refuse). Meta n'est pas configuré → erreur de configuration explicite.
   */
  validateInboundEvent(event: RawInboundEvent): boolean {
    if (!this.config.appSecret) {
      throw new WhatsAppProviderSendError(
        'Meta app secret is not configured.',
        'META_NOT_CONFIGURED',
        'CONFIGURATION_ERROR',
      );
    }
    const { rawBody, signature } = event;
    if (typeof rawBody !== 'string' || rawBody.length === 0 || !signature) {
      return false;
    }
    const expected =
      'sha256=' + createHmac('sha256', this.config.appSecret).update(rawBody, 'utf8').digest('hex');
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (signatureBuffer.length !== expectedBuffer.length) {
      return false;
    }
    return timingSafeEqual(signatureBuffer, expectedBuffer);
  }

  /**
   * Traduit un webhook Meta en événements normalisés (un webhook peut en
   * porter plusieurs). Défensif : un type inconnu devient UNSUPPORTED (jamais
   * d'exception) ; un payload sans événement actionnable renvoie [].
   */
  parseInboundEvent(event: RawInboundEvent): NormalizedInboundEvent[] {
    const body = event.body as { entry?: unknown } | null | undefined;
    if (typeof body !== 'object' || body === null || !Array.isArray(body.entry)) {
      return [];
    }

    const normalized: NormalizedInboundEvent[] = [];
    for (const entry of body.entry) {
      const changes = (entry as { changes?: unknown })?.changes;
      if (!Array.isArray(changes)) {
        continue;
      }
      for (const change of changes) {
        normalized.push(...this.parseChangeValue((change as { value?: unknown })?.value));
      }
    }
    return normalized;
  }

  /**
   * Comme {@link parseInboundEvent}, mais GROUPE les événements par
   * `phone_number_id` — indispensable au routage MULTI-TENANT : un même webhook
   * Meta peut porter des `change` pour des numéros (donc des commerçants)
   * différents ; chaque groupe doit être ingéré dans SON canal, jamais fusionné.
   * Un `change` sans phone_number_id ou sans événement actionnable est ignoré.
   */
  parseInboundEventsByPhoneNumber(
    event: RawInboundEvent,
  ): Array<{ phoneNumberId: string; events: NormalizedInboundEvent[] }> {
    const body = event.body as { entry?: unknown } | null | undefined;
    if (typeof body !== 'object' || body === null || !Array.isArray(body.entry)) {
      return [];
    }

    // Regroupe par phone_number_id en préservant l'ordre d'apparition.
    const groups = new Map<string, NormalizedInboundEvent[]>();
    for (const entry of body.entry) {
      const changes = (entry as { changes?: unknown })?.changes;
      if (!Array.isArray(changes)) {
        continue;
      }
      for (const change of changes) {
        const value = (change as { value?: unknown })?.value;
        const phoneNumberId = (value as { metadata?: { phone_number_id?: unknown } } | undefined)
          ?.metadata?.phone_number_id;
        if (typeof phoneNumberId !== 'string' || phoneNumberId.length === 0) {
          continue;
        }
        const events = this.parseChangeValue(value);
        if (events.length === 0) {
          continue;
        }
        const bucket = groups.get(phoneNumberId);
        if (bucket) {
          bucket.push(...events);
        } else {
          groups.set(phoneNumberId, events);
        }
      }
    }

    return Array.from(groups, ([phoneNumberId, events]) => ({ phoneNumberId, events }));
  }

  /** Événements normalisés d'un unique `change.value` (messages + statuts). */
  private parseChangeValue(rawValue: unknown): NormalizedInboundEvent[] {
    const value = rawValue as
      | {
          messages?: MetaMessage[];
          statuses?: MetaStatus[];
          contacts?: MetaContact[];
        }
      | undefined;
    if (!value) {
      return [];
    }

    const contactsByWaId = new Map<string, string>();
    for (const contact of value.contacts ?? []) {
      if (contact.wa_id && contact.profile?.name) {
        contactsByWaId.set(contact.wa_id, contact.profile.name);
      }
    }

    const events: NormalizedInboundEvent[] = [];
    for (const message of value.messages ?? []) {
      const parsed = this.parseMessage(message, contactsByWaId);
      if (parsed) {
        events.push(parsed);
      }
    }
    for (const status of value.statuses ?? []) {
      const parsed = this.parseStatus(status);
      if (parsed) {
        events.push(parsed);
      }
    }
    return events;
  }

  private parseMessage(
    message: MetaMessage,
    contactsByWaId: Map<string, string>,
  ): NormalizedInboundEvent | null {
    if (!message.id || !message.from || !message.timestamp) {
      return null;
    }
    const messageType = META_TYPE_MAP[message.type ?? ''] ?? 'UNSUPPORTED';
    return {
      kind: 'message',
      // message.id (wamid) est globalement unique chez Meta : dédup directe.
      externalEventId: message.id,
      externalMessageId: message.id,
      from: message.from,
      displayName: contactsByWaId.get(message.from),
      messageType,
      text: messageType === 'TEXT' ? (message.text?.body ?? '') : null,
      providerTimestamp: this.toIso(message.timestamp),
    };
  }

  private parseStatus(status: MetaStatus): NormalizedInboundStatusEvent | null {
    if (!status.id || !status.status || !status.timestamp) {
      return null;
    }
    const mapped = this.mapStatus(status.status);
    if (mapped === null) {
      // 'sent' n'a pas d'équivalent entrant (déjà porté par l'envoi) ; types inconnus ignorés.
      return null;
    }
    const firstError = status.errors?.[0];
    return {
      kind: 'status',
      // Un id peut porter plusieurs statuts successifs : chacun est un événement distinct.
      externalEventId: `status:${status.id}:${mapped}`,
      externalMessageId: status.id,
      status: mapped,
      providerTimestamp: this.toIso(status.timestamp),
      errorCode: firstError?.code !== undefined ? String(firstError.code) : undefined,
      // Titre/message non sensibles uniquement (jamais error_data brut).
      errorMessage: firstError?.title ?? firstError?.message,
    };
  }

  private mapStatus(status: string): NormalizedInboundStatusEvent['status'] | null {
    switch (status) {
      case 'delivered':
        return 'DELIVERED';
      case 'read':
        return 'READ';
      case 'failed':
        return 'FAILED';
      default:
        return null; // 'sent' et inconnus : non traités comme événement entrant.
    }
  }

  /** Extrait le phone_number_id d'un webhook (sélection du Channel, sans confiance crypto). */
  extractPhoneNumberIds(body: unknown): string[] {
    const parsed = body as { entry?: unknown } | null | undefined;
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.entry)) {
      return [];
    }
    const ids = new Set<string>();
    for (const entry of parsed.entry) {
      const changes = (entry as { changes?: unknown })?.changes;
      if (!Array.isArray(changes)) {
        continue;
      }
      for (const change of changes) {
        const id = (change as { value?: { metadata?: { phone_number_id?: unknown } } })?.value
          ?.metadata?.phone_number_id;
        if (typeof id === 'string' && id.length > 0) {
          ids.add(id);
        }
      }
    }
    return [...ids];
  }

  async sendTextMessage(input: SendTextMessageInput): Promise<SendMessageResult> {
    if (!this.config.accessToken || !this.config.phoneNumberId) {
      throw new WhatsAppProviderSendError(
        'Meta send configuration is incomplete.',
        'META_NOT_CONFIGURED',
        'CONFIGURATION_ERROR',
      );
    }
    const url = `${this.config.graphBaseUrl}/${this.config.graphApiVersion}/${this.config.phoneNumberId}/messages`;
    const response = await this.post(url, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.to,
      type: 'text',
      text: { preview_url: false, body: input.text },
    });
    const messageId = (response as { messages?: Array<{ id?: string }> }).messages?.[0]?.id;
    if (!messageId) {
      throw new WhatsAppProviderSendError(
        'Meta response did not contain a message id.',
        'META_INVALID_RESPONSE',
        'RETRYABLE',
      );
    }
    return { externalMessageId: messageId };
  }

  async markMessageAsRead(input: MarkMessageAsReadInput): Promise<void> {
    if (!this.config.accessToken || !this.config.phoneNumberId) {
      return; // Best-effort : ne jamais faire échouer un flux métier.
    }
    const url = `${this.config.graphBaseUrl}/${this.config.graphApiVersion}/${this.config.phoneNumberId}/messages`;
    try {
      await this.post(url, {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: input.externalMessageId,
      });
    } catch {
      // Marquage lu non critique : on avale l'erreur.
    }
  }

  /**
   * Vérifie la configuration SANS envoyer de message : GET Graph sur le Phone
   * Number ID (retourne les infos du numéro). Ne renvoie aucun secret.
   */
  async validateConfiguration(): Promise<{
    phoneNumberId: string;
    displayPhoneNumber?: string;
    verifiedName?: string;
  }> {
    if (!this.config.accessToken || !this.config.phoneNumberId) {
      throw new WhatsAppProviderSendError(
        'Meta configuration is incomplete.',
        'META_NOT_CONFIGURED',
        'CONFIGURATION_ERROR',
      );
    }
    const url = `${this.config.graphBaseUrl}/${this.config.graphApiVersion}/${this.config.phoneNumberId}?fields=display_phone_number,verified_name`;
    const response = (await this.get(url)) as {
      id?: string;
      display_phone_number?: string;
      verified_name?: string;
    };
    return {
      phoneNumberId: response.id ?? this.config.phoneNumberId,
      displayPhoneNumber: response.display_phone_number,
      verifiedName: response.verified_name,
    };
  }

  /**
   * Lit le profil WhatsApp Business (endpoint `whatsapp_business_profile`).
   * GET Graph, aucun envoi. Ne renvoie aucun secret. `profile_picture_url` est
   * exposé en lecture seule (la mise à jour de la photo est hors périmètre).
   */
  async getBusinessProfile(): Promise<WhatsAppBusinessProfile> {
    if (!this.config.accessToken || !this.config.phoneNumberId) {
      throw new WhatsAppProviderSendError(
        'Meta configuration is incomplete.',
        'META_NOT_CONFIGURED',
        'CONFIGURATION_ERROR',
      );
    }
    const fields = 'about,address,description,email,profile_picture_url,vertical,websites';
    const url = `${this.config.graphBaseUrl}/${this.config.graphApiVersion}/${this.config.phoneNumberId}/whatsapp_business_profile?fields=${fields}`;
    const response = (await this.get(url)) as { data?: Array<Record<string, unknown>> };
    const profile = response.data?.[0] ?? {};
    const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
    return {
      about: asString(profile.about),
      address: asString(profile.address),
      description: asString(profile.description),
      email: asString(profile.email),
      vertical: asString(profile.vertical),
      websites: Array.isArray(profile.websites) ? (profile.websites as string[]) : [],
      profilePictureUrl: asString(profile.profile_picture_url),
    };
  }

  /**
   * Met à jour le profil WhatsApp Business (POST Graph). Seuls les champs
   * FOURNIS sont envoyés (`undefined` = inchangé). La photo n'est pas gérée ici
   * (nécessite un handle Resumable Upload). Renvoie void ; l'appelant relit le
   * profil pour l'état frais.
   */
  async updateBusinessProfile(input: WhatsAppBusinessProfileUpdate): Promise<void> {
    if (!this.config.accessToken || !this.config.phoneNumberId) {
      throw new WhatsAppProviderSendError(
        'Meta configuration is incomplete.',
        'META_NOT_CONFIGURED',
        'CONFIGURATION_ERROR',
      );
    }
    const payload: Record<string, unknown> = { messaging_product: 'whatsapp' };
    if (input.about !== undefined) payload.about = input.about;
    if (input.address !== undefined) payload.address = input.address;
    if (input.description !== undefined) payload.description = input.description;
    if (input.email !== undefined) payload.email = input.email;
    if (input.vertical !== undefined) payload.vertical = input.vertical;
    if (input.websites !== undefined) payload.websites = input.websites;
    const url = `${this.config.graphBaseUrl}/${this.config.graphApiVersion}/${this.config.phoneNumberId}/whatsapp_business_profile`;
    await this.post(url, payload);
  }

  private async post(url: string, payload: unknown): Promise<unknown> {
    return this.request('POST', url, payload);
  }

  private async get(url: string): Promise<unknown> {
    return this.request('GET', url);
  }

  private async request(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs ?? 30000);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        body: method === 'POST' ? JSON.stringify(payload) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      throw new WhatsAppProviderSendError(
        isAbort ? 'Meta request timed out.' : 'Meta request failed (network).',
        isAbort ? 'META_TIMEOUT' : 'META_NETWORK_ERROR',
        'RETRYABLE',
      );
    } finally {
      clearTimeout(timeout);
    }

    const bodyText = await response.text();
    let parsed: unknown = undefined;
    try {
      parsed = bodyText.length > 0 ? JSON.parse(bodyText) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      throw this.mapMetaError(response.status, parsed);
    }
    return parsed;
  }

  /**
   * Mapping centralisé des erreurs Meta → classe de retry. Ne conserve que le
   * code et un message non sensible (jamais le token, jamais error_data brut).
   */
  mapMetaError(httpStatus: number, body: unknown): WhatsAppProviderSendError {
    const error = (body as { error?: { code?: number; message?: string; error_subcode?: number } })
      ?.error;
    const code = error?.code;
    const subcode = error?.error_subcode;
    const label = `META_${code ?? httpStatus}${subcode ? `_${subcode}` : ''}`;

    let errorClass: ProviderErrorClass = 'RETRYABLE';
    if (code === 190 || code === 200 || code === 10 || httpStatus === 401 || httpStatus === 403) {
      errorClass = 'CONFIGURATION_ERROR'; // token invalide / permissions.
    } else if (code === 131047 || code === 131051 || code === 131026 || subcode === 2018278) {
      errorClass = 'REQUIRES_TEMPLATE'; // fenêtre fermée / template requis.
    } else if (code === 131008 || code === 100 || code === 131009 || httpStatus === 400) {
      errorClass = 'NON_RETRYABLE'; // payload / numéro invalide.
    } else if (code === 4 || code === 80007 || code === 130429 || httpStatus === 429 || httpStatus >= 500) {
      errorClass = 'RETRYABLE'; // rate limit / erreur serveur.
    }

    return new WhatsAppProviderSendError('Meta API error.', label, errorClass);
  }

  private toIso(metaTimestamp: string): string {
    const seconds = Number(metaTimestamp);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return new Date().toISOString();
    }
    return new Date(seconds * 1000).toISOString();
  }
}
