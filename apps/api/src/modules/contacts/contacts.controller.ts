import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentTenant } from '../../common/tenant/current-tenant.decorator';
import { PERMISSIONS } from '../../common/tenant/permissions';
import { PermissionsGuard } from '../../common/tenant/permissions.guard';
import { RequirePermissions } from '../../common/tenant/require-permissions.decorator';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PaginatedResponseDto } from '../organizations/dto/pagination.dto';
import { ContactResponseDto } from './dto/contact-responses.dto';
import { ListContactsQueryDto } from './dto/list-contacts.query.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { ContactsService } from './contacts.service';

@ApiTags('contacts')
@ApiBearerAuth()
@Controller('organizations/:organizationId/contacts')
@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
export class ContactsController {
  constructor(private readonly contactsService: ContactsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.CONTACTS_READ)
  @ApiOperation({ summary: 'Contacts de l’organisation (paginés, filtres shopId/status/search)' })
  @ApiOkResponse({ type: PaginatedResponseDto<ContactResponseDto> })
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: ListContactsQueryDto,
  ): Promise<PaginatedResponseDto<ContactResponseDto>> {
    const { items, total } = await this.contactsService.list(tenant, query);
    return PaginatedResponseDto.of(
      items.map((contact) => ContactResponseDto.fromContact(contact)),
      total,
      query,
    );
  }

  @Get(':contactId')
  @RequirePermissions(PERMISSIONS.CONTACTS_READ)
  @ApiOperation({ summary: 'Détail d’un contact' })
  @ApiOkResponse({ type: ContactResponseDto })
  async get(
    @CurrentTenant() tenant: TenantContext,
    @Param('contactId') contactId: string,
  ): Promise<ContactResponseDto> {
    return ContactResponseDto.fromContact(await this.contactsService.getForTenant(tenant, contactId));
  }

  @Patch(':contactId')
  @RequirePermissions(PERMISSIONS.CONTACTS_UPDATE)
  @ApiOperation({
    summary:
      'Modifier un contact — undefined = inchangé, null = effacement. Téléphone jamais modifiable.',
  })
  @ApiOkResponse({ type: ContactResponseDto })
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Param('contactId') contactId: string,
    @Body() dto: UpdateContactDto,
  ): Promise<ContactResponseDto> {
    return ContactResponseDto.fromContact(
      await this.contactsService.update(tenant, contactId, dto),
    );
  }
}
