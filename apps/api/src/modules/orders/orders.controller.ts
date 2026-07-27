import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { CurrentTenant } from '../../common/tenant/current-tenant.decorator';
import { PERMISSIONS } from '../../common/tenant/permissions';
import { PermissionsGuard } from '../../common/tenant/permissions.guard';
import { RequirePermissions } from '../../common/tenant/require-permissions.decorator';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  AddOrderNoteDto,
  CancelOrderDto,
  ChangeOrderStatusDto,
  ConvertToOrderDto,
  ListOrdersQueryDto,
  OrderHistoryEntryResponseDto,
  OrderListItemResponseDto,
  OrderListResponseDto,
  OrderNoteResponseDto,
  OrderResponseDto,
  OrderSummaryResponseDto,
} from './dto/order.dto';
import { OrderConversionService } from './order-conversion.service';
import { OrderTransitionService } from './order-transition.service';
import { OrdersService } from './orders.service';

function actionContext(req: Request) {
  return { userAgent: req.headers['user-agent'], ipAddress: req.ip };
}

/** Conversion + commandes liées à une conversation. */
@ApiTags('orders')
@ApiBearerAuth()
@Controller('organizations/:organizationId/conversations/:conversationId/orders')
@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
export class ConversationOrdersController {
  constructor(
    private readonly conversionService: OrderConversionService,
    private readonly ordersService: OrdersService,
  ) {}

  @Post()
  @RequirePermissions(PERMISSIONS.ORDERS_CREATE)
  @ApiOperation({
    summary:
      'Convertir le checkout CONFIRMED en Order (atomique, idempotent — 200 si déjà convertie)',
  })
  @ApiCreatedResponse({ type: OrderResponseDto })
  async convert(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Body() dto: ConvertToOrderDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderResponseDto> {
    const { order, created } = await this.conversionService.convert(
      tenant,
      conversationId,
      dto,
      actionContext(req),
    );
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return OrderResponseDto.fromOrder(order);
  }

  @Get()
  @RequirePermissions(PERMISSIONS.ORDERS_READ)
  @ApiOperation({ summary: 'Commandes liées à la conversation (inbox)' })
  @ApiOkResponse({ type: [OrderListItemResponseDto] })
  async listForConversation(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
  ): Promise<OrderListItemResponseDto[]> {
    const rows = await this.ordersService.listForConversation(tenant, conversationId);
    return rows.map(OrderListItemResponseDto.fromRow);
  }
}

@ApiTags('orders')
@ApiBearerAuth()
@Controller('organizations/:organizationId/orders')
@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly transitionService: OrderTransitionService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ORDERS_READ)
  @ApiOperation({ summary: 'Liste paginée — tous les filtres appliqués avant pagination' })
  @ApiOkResponse({ type: OrderListResponseDto })
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: ListOrdersQueryDto,
  ): Promise<OrderListResponseDto> {
    const result = await this.ordersService.list(tenant, {
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      search: query.search,
      shopId: query.shopId,
      contactId: query.contactId,
      conversationId: query.conversationId,
      status: query.status,
      paymentStatus: query.paymentStatus,
      fulfillmentStatus: query.fulfillmentStatus,
      fulfillmentType: query.fulfillmentType,
      createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
      createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      minTotalMinor: query.minTotalMinor,
      maxTotalMinor: query.maxTotalMinor,
      sortBy: query.sortBy ?? 'createdAt',
      sortDir: query.sortDir ?? 'desc',
    });
    return {
      items: result.items.map(OrderListItemResponseDto.fromRow),
      total: result.total,
      page: result.page,
      limit: result.limit,
    };
  }

  @Get(':orderId')
  @RequirePermissions(PERMISSIONS.ORDERS_READ)
  @ApiOperation({ summary: 'Détail complet (snapshots — jamais le catalogue courant)' })
  @ApiOkResponse({ type: OrderResponseDto })
  async detail(
    @CurrentTenant() tenant: TenantContext,
    @Param('orderId') orderId: string,
  ): Promise<OrderResponseDto> {
    return OrderResponseDto.fromOrder(await this.ordersService.getDetail(tenant, orderId));
  }

  @Patch(':orderId/status')
  @RequirePermissions(PERMISSIONS.ORDERS_UPDATE_STATUS)
  @ApiOperation({ summary: 'Transition de statut (service centralisé — CANCELLED via /cancel)' })
  @ApiOkResponse({ type: OrderResponseDto })
  async changeStatus(
    @CurrentTenant() tenant: TenantContext,
    @Param('orderId') orderId: string,
    @Body() dto: ChangeOrderStatusDto,
    @Req() req: Request,
  ): Promise<OrderResponseDto> {
    return OrderResponseDto.fromOrder(
      await this.transitionService.changeStatus(tenant, orderId, dto, actionContext(req)),
    );
  }

  @Post(':orderId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ORDERS_CANCEL)
  @ApiOperation({
    summary: 'Annuler (CONFIRMED/PROCESSING/READY) — restitution du stock consommé, idempotent',
  })
  @ApiOkResponse({ type: OrderResponseDto })
  async cancel(
    @CurrentTenant() tenant: TenantContext,
    @Param('orderId') orderId: string,
    @Body() dto: CancelOrderDto,
    @Req() req: Request,
  ): Promise<OrderResponseDto> {
    return OrderResponseDto.fromOrder(
      await this.transitionService.cancel(tenant, orderId, dto, actionContext(req)),
    );
  }

  @Post(':orderId/notes')
  @RequirePermissions(PERMISSIONS.ORDERS_ADD_NOTE)
  @ApiOperation({ summary: 'Note interne append-only (jamais envoyée au client)' })
  @ApiCreatedResponse({ type: OrderResponseDto })
  async addNote(
    @CurrentTenant() tenant: TenantContext,
    @Param('orderId') orderId: string,
    @Body() dto: AddOrderNoteDto,
    @Req() req: Request,
  ): Promise<OrderResponseDto> {
    return OrderResponseDto.fromOrder(
      await this.transitionService.addNote(tenant, orderId, dto, actionContext(req)),
    );
  }

  @Get(':orderId/notes')
  @RequirePermissions(PERMISSIONS.ORDERS_ADD_NOTE)
  @ApiOperation({ summary: 'Notes internes chronologiques' })
  @ApiOkResponse({ type: [OrderNoteResponseDto] })
  async notes(
    @CurrentTenant() tenant: TenantContext,
    @Param('orderId') orderId: string,
  ): Promise<OrderNoteResponseDto[]> {
    const rows = await this.ordersService.getNotes(tenant, orderId);
    return rows.map(OrderNoteResponseDto.fromRow);
  }

  @Get(':orderId/history')
  @RequirePermissions(PERMISSIONS.ORDERS_VIEW_HISTORY)
  @ApiOperation({ summary: 'Historique immuable des statuts (timeline)' })
  @ApiOkResponse({ type: [OrderHistoryEntryResponseDto] })
  async history(
    @CurrentTenant() tenant: TenantContext,
    @Param('orderId') orderId: string,
  ): Promise<OrderHistoryEntryResponseDto[]> {
    const rows = await this.ordersService.getHistory(tenant, orderId);
    return rows.map(OrderHistoryEntryResponseDto.fromRow);
  }

  @Get(':orderId/summary-text')
  @RequirePermissions(PERMISSIONS.ORDERS_READ)
  @ApiOperation({ summary: 'Résumé texte serveur (inséré dans le composer — jamais envoyé auto)' })
  @ApiOkResponse({ type: OrderSummaryResponseDto })
  async summaryText(
    @CurrentTenant() tenant: TenantContext,
    @Param('orderId') orderId: string,
  ): Promise<OrderSummaryResponseDto> {
    return this.ordersService.summaryText(tenant, orderId);
  }
}
