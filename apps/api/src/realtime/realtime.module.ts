import { Global, Module } from '@nestjs/common';

import { AuthModule } from '../modules/auth/auth.module';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

/**
 * Global : RealtimeService est une façade transverse (conversations,
 * messages, memberships) — l'import explicite partout créerait des cycles
 * avec OrganizationsModule.
 */
@Global()
@Module({
  imports: [AuthModule],
  providers: [RealtimeGateway, RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
