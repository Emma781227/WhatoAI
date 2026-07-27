import { Injectable, Logger } from '@nestjs/common';
import { organizationRoom, SOCKET_EVENTS, userRoom } from '@whauto/shared';
import type { MembershipRevokedEvent } from '@whauto/shared';

import { RealtimeGateway } from './realtime.gateway';

/**
 * Façade d'émission temps réel côté API. Fire-and-forget : une émission ne
 * fait jamais échouer un flux métier (PostgreSQL est la source de vérité,
 * les clients se réconcilient à la reconnexion).
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);

  constructor(private readonly gateway: RealtimeGateway) {}

  emitToOrganization(organizationId: string, event: string, payload: unknown): void {
    try {
      this.gateway.server?.to(organizationRoom(organizationId)).emit(event, payload);
    } catch (error) {
      this.logger.warn(`Émission ${event} échouée`, error instanceof Error ? error.message : error);
    }
  }

  /**
   * Éviction immédiate d'un user dont l'accès à l'organisation a été révoqué
   * (retrait, départ, suspension) — sans attendre l'expiration du token.
   * Fonctionne aussi multi-instances (rooms résolues via le redis-adapter).
   */
  async evictUserFromOrganization(userId: string, organizationId: string): Promise<void> {
    try {
      const server = this.gateway.server;
      if (!server) {
        return;
      }
      const payload: MembershipRevokedEvent = { organizationId };
      server.to(userRoom(userId)).emit(SOCKET_EVENTS.MEMBERSHIP_REVOKED, payload);
      server.in(userRoom(userId)).socketsLeave(organizationRoom(organizationId));
    } catch (error) {
      this.logger.warn(
        `Éviction temps réel échouée (user ${userId}, org ${organizationId})`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}
