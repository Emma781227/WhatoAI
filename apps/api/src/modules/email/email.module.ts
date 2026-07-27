import { Module } from '@nestjs/common';

import { ConsoleEmailProvider } from './console-email.provider';
import { EMAIL_PROVIDER } from './email-provider.interface';

@Module({
  providers: [{ provide: EMAIL_PROVIDER, useClass: ConsoleEmailProvider }],
  exports: [EMAIL_PROVIDER],
})
export class EmailModule {}
