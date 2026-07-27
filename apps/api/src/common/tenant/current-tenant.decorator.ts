import type { ExecutionContext } from '@nestjs/common';
import { createParamDecorator } from '@nestjs/common';

import type { RequestWithTenant, TenantContext } from './tenant-context.interface';

/** Injecte le TenantContext attaché à la requête par TenantGuard. */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantContext => {
    const request = context.switchToHttp().getRequest<RequestWithTenant>();
    return request.tenant;
  },
);
