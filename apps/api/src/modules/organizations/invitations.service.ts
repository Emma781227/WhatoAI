import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@whauto/database';
import type { InvitationRole, MembershipRole } from '@whauto/database';
import {
  InvalidRoleTransitionError,
  InvitationAlreadyExistsError,
  InvitationAlreadyUsedError,
  InvitationEmailMismatchError,
  InvitationExpiredError,
  InvitationNotFoundError,
  OrganizationArchivedError,
  OrganizationSuspendedError,
  UserAlreadyMemberError,
} from '@whauto/shared';

import { canAssignRole } from '../../common/tenant/permissions';
import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { EMAIL_PROVIDER } from '../email/email-provider.interface';
import type { EmailProvider } from '../email/email-provider.interface';
import { TokenService } from '../auth/token.service';
import type { AuditActionContext } from './organization-audit.service';
import { OrganizationAuditService } from './organization-audit.service';
import { INVITATION_PUBLIC_SELECT, ORGANIZATION_PUBLIC_SELECT } from './organizations.mapper';
import type { InvitationPublic, OrganizationPublic } from './organizations.mapper';
import type { PaginationQueryDto } from './dto/pagination.dto';

export interface InviteMemberInput {
  email: string;
  role: InvitationRole;
}

export interface InvitationIssued {
  invitation: InvitationPublic;
  resent: boolean;
  /** Présent uniquement en development avec AUTH_EXPOSE_TEST_TOKENS=true. */
  devLink?: string;
}

export interface AcceptedInvitation {
  organization: OrganizationPublic;
  membershipId: string;
  role: MembershipRole;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly configService: ConfigService,
    private readonly auditService: OrganizationAuditService,
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProvider,
  ) {}

  // ------------------------------------------------------------------- create

  /**
   * Crée une invitation, ou — s'il existe déjà une invitation PENDING pour ce
   * couple (organisation, email) — la RENOUVELLE en place (validé) : même
   * ligne, nouveau tokenHash (l'ancien lien devient immédiatement invalide),
   * nouveau expiresAt, rôle mis à jour, audit INVITATION_RESENT.
   *
   * Concurrence : le renouvellement est un updateMany conditionnel atomique ;
   * la création est protégée par l'index unique partiel PostgreSQL
   * (organizationId, email) WHERE status='PENDING' — deux créations
   * simultanées ne produisent jamais deux lignes PENDING.
   */
  async createOrResend(
    tenant: TenantContext,
    input: InviteMemberInput,
    context: AuditActionContext,
  ): Promise<InvitationIssued> {
    const email = input.email.trim().toLowerCase();

    // InvitationRole ⊂ MembershipRole : la hiérarchie s'applique telle quelle.
    if (!canAssignRole(tenant.role, input.role)) {
      throw new InvalidRoleTransitionError(
        `role ${tenant.role} cannot invite a member as ${input.role}`,
      );
    }

    await this.assertNotAlreadyMember(tenant.organizationId, email);

    const token = this.tokenService.generateOpaqueToken();
    const tokenHash = this.tokenService.hashOpaqueToken(token);
    const expiresAt = this.invitationExpiry();

    let resent = await this.tryRenewPending(tenant, email, input.role, tokenHash, expiresAt);

    if (!resent) {
      try {
        await this.prisma.organizationInvitation.create({
          data: {
            organizationId: tenant.organizationId,
            email,
            role: input.role,
            tokenHash,
            invitedByUserId: tenant.userId,
            expiresAt,
          },
          select: { id: true },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        // Course perdue contre une création concurrente : on bascule en renouvellement.
        resent = await this.tryRenewPending(tenant, email, input.role, tokenHash, expiresAt);
        if (!resent) {
          throw new InvitationAlreadyExistsError();
        }
      }
    }

    const invitation = await this.prisma.organizationInvitation.findUniqueOrThrow({
      where: { tokenHash },
      select: INVITATION_PUBLIC_SELECT,
    });

    const link = `${this.webUrl()}/invitations/accept?token=${token}`;
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: tenant.organizationId },
      select: { name: true },
    });
    await this.emailProvider.send({
      to: email,
      subject: `Invitation à rejoindre ${organization.name} sur Whauto AI`,
      text: `Vous êtes invité(e) à rejoindre l'organisation « ${organization.name} » en tant que ${input.role}.\nPour accepter, ouvrez ce lien (valable ${this.expiryDays()} jours) :\n${link}\n\nSi vous n'attendiez pas cette invitation, ignorez cet email.`,
    });

    await this.auditService.recordSafe({
      organizationId: tenant.organizationId,
      eventType: resent ? 'INVITATION_RESENT' : 'MEMBER_INVITED',
      actorUserId: tenant.userId,
      metadata: { email, role: input.role },
      context,
    });

    return { invitation, resent, devLink: this.maybeExpose(link) };
  }

  private async tryRenewPending(
    tenant: TenantContext,
    email: string,
    role: InvitationRole,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<boolean> {
    const renewed = await this.prisma.organizationInvitation.updateMany({
      where: { organizationId: tenant.organizationId, email, status: 'PENDING' },
      data: { tokenHash, expiresAt, role, invitedByUserId: tenant.userId },
    });
    return renewed.count === 1;
  }

  private async assertNotAlreadyMember(organizationId: string, email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) {
      return; // Pas de compte : l'invitation reste valable, la personne s'inscrira.
    }
    const membership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId: user.id, organizationId } },
      select: { status: true },
    });
    // ACTIVE : déjà membre. SUSPENDED : jamais réactivé automatiquement (validé),
    // donc pas invitable non plus. Seul LEFT autorise une réinvitation.
    if (membership && membership.status !== 'LEFT') {
      throw new UserAlreadyMemberError();
    }
  }

  // --------------------------------------------------------------------- read

  async listForOrganization(tenant: TenantContext, pagination: PaginationQueryDto) {
    const where = { organizationId: tenant.organizationId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.organizationInvitation.findMany({
        where,
        select: INVITATION_PUBLIC_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.prisma.organizationInvitation.count({ where }),
    ]);
    return { items: items.map((item) => this.withEffectiveStatus(item)), total };
  }

  /** Invitations PENDING non expirées adressées à l'email du compte connecté. */
  async listMine(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) {
      return [];
    }
    return this.prisma.organizationInvitation.findMany({
      where: {
        email: user.email.toLowerCase(),
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
      select: {
        ...INVITATION_PUBLIC_SELECT,
        organization: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Une invitation PENDING dont expiresAt est passé est fonctionnellement
   * expirée quel que soit son status stocké (transition paresseuse).
   */
  private withEffectiveStatus<T extends { status: string; expiresAt: Date }>(invitation: T): T {
    if (invitation.status === 'PENDING' && invitation.expiresAt <= new Date()) {
      return { ...invitation, status: 'EXPIRED' };
    }
    return invitation;
  }

  // ------------------------------------------------------------------- accept

  /**
   * Acceptation atomique : updateMany conditionnel (PENDING + non expirée,
   * count===1) puis création OU réactivation (LEFT uniquement) du Membership
   * et audit INVITATION_ACCEPTED — le tout dans une transaction. Deux
   * acceptations simultanées du même token : une seule passe.
   */
  async accept(
    userId: string,
    token: string,
    context: AuditActionContext,
  ): Promise<AcceptedInvitation> {
    const now = new Date();
    const invitation = await this.findByToken(token);

    if (invitation.status === 'ACCEPTED') {
      throw new InvitationAlreadyUsedError();
    }
    if (invitation.status !== 'PENDING') {
      // CANCELLED / DECLINED / EXPIRED : réponse indistincte d'un token inconnu.
      throw new InvitationNotFoundError();
    }
    if (invitation.expiresAt <= now) {
      await this.lazilyMarkExpired(invitation.id);
      throw new InvitationExpiredError();
    }

    if (invitation.organization.status === 'ARCHIVED') {
      throw new OrganizationArchivedError();
    }
    if (invitation.organization.status === 'SUSPENDED') {
      throw new OrganizationSuspendedError();
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });
    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw new InvitationEmailMismatchError();
    }

    const existingMembership = await this.prisma.membership.findUnique({
      where: {
        userId_organizationId: { userId, organizationId: invitation.organizationId },
      },
      select: { id: true, status: true },
    });
    if (existingMembership && existingMembership.status !== 'LEFT') {
      throw new UserAlreadyMemberError();
    }

    const role = invitation.role as MembershipRole;

    const membershipId = await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.organizationInvitation.updateMany({
        where: { id: invitation.id, status: 'PENDING', expiresAt: { gt: now } },
        data: { status: 'ACCEPTED', acceptedAt: now },
      });
      if (consumed.count !== 1) {
        throw new InvitationAlreadyUsedError();
      }

      let id: string;
      if (existingMembership) {
        // Réactivation d'un membre parti (LEFT uniquement — validé) :
        // nouveau rôle, nouveau joinedAt, createdAt d'origine conservé.
        const reactivated = await tx.membership.updateMany({
          where: { id: existingMembership.id, status: 'LEFT' },
          data: { status: 'ACTIVE', role, joinedAt: now },
        });
        if (reactivated.count !== 1) {
          throw new UserAlreadyMemberError();
        }
        id = existingMembership.id;
      } else {
        try {
          const created = await tx.membership.create({
            data: {
              userId,
              organizationId: invitation.organizationId,
              role,
              status: 'ACTIVE',
              joinedAt: now,
            },
            select: { id: true },
          });
          id = created.id;
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new UserAlreadyMemberError();
          }
          throw error;
        }
      }

      await this.auditService.record(
        {
          organizationId: invitation.organizationId,
          eventType: 'INVITATION_ACCEPTED',
          actorUserId: userId,
          targetUserId: userId,
          metadata: { role },
          context,
        },
        tx,
      );

      return id;
    });

    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: invitation.organizationId },
      select: ORGANIZATION_PUBLIC_SELECT,
    });

    return { organization, membershipId, role };
  }

  // ------------------------------------------------------------------ decline

  async decline(userId: string, token: string, context: AuditActionContext): Promise<void> {
    const now = new Date();
    const invitation = await this.findByToken(token);

    if (invitation.status !== 'PENDING') {
      throw new InvitationNotFoundError();
    }
    if (invitation.expiresAt <= now) {
      await this.lazilyMarkExpired(invitation.id);
      throw new InvitationExpiredError();
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });
    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw new InvitationEmailMismatchError();
    }

    const declined = await this.prisma.organizationInvitation.updateMany({
      where: { id: invitation.id, status: 'PENDING' },
      data: { status: 'DECLINED', declinedAt: now },
    });
    if (declined.count !== 1) {
      throw new InvitationAlreadyUsedError();
    }

    await this.auditService.recordSafe({
      organizationId: invitation.organizationId,
      eventType: 'INVITATION_DECLINED',
      actorUserId: userId,
      targetUserId: userId,
      context,
    });
  }

  // ------------------------------------------------------------------- cancel

  async cancel(
    tenant: TenantContext,
    invitationId: string,
    context: AuditActionContext,
  ): Promise<void> {
    const cancelled = await this.prisma.organizationInvitation.updateMany({
      // organizationId dans le filtre : impossible d'annuler l'invitation d'un autre tenant.
      where: { id: invitationId, organizationId: tenant.organizationId, status: 'PENDING' },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });

    if (cancelled.count !== 1) {
      const existing = await this.prisma.organizationInvitation.findFirst({
        where: { id: invitationId, organizationId: tenant.organizationId },
        select: { id: true },
      });
      if (existing) {
        throw new InvitationAlreadyUsedError();
      }
      throw new InvitationNotFoundError();
    }

    await this.auditService.recordSafe({
      organizationId: tenant.organizationId,
      eventType: 'INVITATION_CANCELLED',
      actorUserId: tenant.userId,
      metadata: { invitationId },
      context,
    });
  }

  // ------------------------------------------------------------------ helpers

  private async findByToken(token: string) {
    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { tokenHash: this.tokenService.hashOpaqueToken(token) },
      select: {
        id: true,
        organizationId: true,
        email: true,
        role: true,
        status: true,
        expiresAt: true,
        organization: { select: { status: true } },
      },
    });
    if (!invitation) {
      throw new InvitationNotFoundError();
    }
    return invitation;
  }

  private async lazilyMarkExpired(invitationId: string): Promise<void> {
    await this.prisma.organizationInvitation.updateMany({
      where: { id: invitationId, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
  }

  private invitationExpiry(): Date {
    return new Date(Date.now() + this.expiryDays() * 24 * 60 * 60 * 1000);
  }

  private expiryDays(): number {
    return this.configService.get<number>('INVITATION_EXPIRES_IN_DAYS', 7);
  }

  private webUrl(): string {
    return this.configService.get<string>('APP_WEB_URL', 'http://localhost:3000');
  }

  private maybeExpose(link: string): string | undefined {
    const isDevelopment = this.configService.get<string>('NODE_ENV') === 'development';
    const exposeEnabled = this.configService.get<boolean>('AUTH_EXPOSE_TEST_TOKENS') === true;
    return isDevelopment && exposeEnabled ? link : undefined;
  }
}
