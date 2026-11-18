import { Module, type DynamicModule } from '@nestjs/common';
import { mailProviders } from './app.module';
import { AuditService } from './audit/audit.service';
import { APP_CONFIG, type AppConfig } from './config/config';
import { envelopeProvider } from './crypto.provider';
import type { MailEndpoints } from './mail/mail-endpoints';
import { MailWorkerService } from './mail/mail-worker.service';
import { FlagPushService } from './mail/flag-push.service';
import { RetentionService } from './mail/retention.service';
import { PrismaService } from './prisma/prisma.service';

/** The background worker: mail sync, push renewal, retention purge. No HTTP server. */
@Module({})
export class WorkerModule {
  static register(cfg: AppConfig, opts: { mailEndpoints?: MailEndpoints } = {}): DynamicModule {
    return {
      module: WorkerModule,
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        envelopeProvider,
        PrismaService,
        AuditService,
        ...mailProviders(cfg, opts.mailEndpoints),
        RetentionService,
        FlagPushService,
        MailWorkerService,
      ],
    };
  }
}
