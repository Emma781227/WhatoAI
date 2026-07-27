import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { organizationRoom, SOCKET_CLIENT_EVENTS, userRoom } from '@whauto/shared';
import type { Server, Socket } from 'socket.io';

import { PrismaService } from '../prisma/prisma.service';
import type { AccessTokenPayload } from '../modules/auth/token.service';

interface SocketData {
  userId?: string;
  expiryTimer?: NodeJS.Timeout;
}

type AuthenticatedSocket = Socket & { data: SocketData };

/**
 * Gateway temps réel. Sécurité :
 * - access token dans handshake.auth.token (JAMAIS dans l'URL), vérifié au
 *   handshake — token invalide/expiré → déconnexion immédiate ;
 * - déconnexion PROGRAMMÉE à l'expiration du JWT : le client se reconnecte
 *   avec le token rafraîchi (aucun socket n'écoute avec un token périmé) ;
 * - le nom de room demandé par le client n'est JAMAIS cru : le Membership
 *   ACTIVE est revalidé en base à chaque join ;
 * - room user:{id} jointe côté serveur uniquement — support de l'éviction
 *   ciblée quand un membership est révoqué (MEMBER_REMOVED/LEFT/suspension).
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(socket: AuthenticatedSocket): Promise<void> {
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string' || token === '') {
      socket.disconnect(true);
      return;
    }

    let payload: AccessTokenPayload & { exp?: number };
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload & { exp?: number }>(token);
    } catch {
      socket.disconnect(true);
      return;
    }
    if (payload.type !== 'access' || !payload.sub) {
      socket.disconnect(true);
      return;
    }

    socket.data.userId = payload.sub;
    await socket.join(userRoom(payload.sub));

    if (typeof payload.exp === 'number') {
      const remainingMs = payload.exp * 1000 - Date.now();
      socket.data.expiryTimer = setTimeout(() => {
        socket.disconnect(true);
      }, Math.max(remainingMs, 0));
    }
  }

  handleDisconnect(socket: AuthenticatedSocket): void {
    if (socket.data.expiryTimer) {
      clearTimeout(socket.data.expiryTimer);
    }
  }

  /** Ack { ok } — jamais de détail sur l'existence de l'organisation (anti-énumération). */
  @SubscribeMessage(SOCKET_CLIENT_EVENTS.SUBSCRIBE_ORGANIZATION)
  async onSubscribeOrganization(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: boolean }> {
    const userId = socket.data.userId;
    const organizationId = (body as { organizationId?: unknown } | undefined)?.organizationId;
    if (!userId || typeof organizationId !== 'string' || organizationId === '') {
      return { ok: false };
    }

    const membership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { status: true, organization: { select: { status: true } } },
    });
    if (
      !membership ||
      membership.status !== 'ACTIVE' ||
      membership.organization.status !== 'ACTIVE'
    ) {
      return { ok: false };
    }

    await socket.join(organizationRoom(organizationId));
    return { ok: true };
  }
}
