import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_CONFIG, type AppConfig } from './config/config';
import { PrismaService } from './prisma/prisma.service';
import { envelopeProvider } from './crypto.provider';
import { ApiExceptionFilter } from './common/exception.filter';
import { AuditService } from './audit/audit.service';
import { AuditController } from './audit/audit.controller';
import { PermissionService } from './access/permission.service';
import { AccessPolicy } from './access/access-policy.service';
import { AuthGuard } from './auth/auth.guard';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { MfaService } from './auth/mfa.service';
import { PasswordService } from './auth/password.service';
import { SessionService } from './auth/session.service';
import { SSO_PROVIDERS, SsoService, buildSsoProviders, type SsoProviderConfig } from './auth/sso.service';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';
import { RolesController } from './roles/roles.controller';
import { RolesService } from './roles/roles.service';
import { OrgController } from './org/org.controller';
import { OrgService } from './org/org.service';
import { HealthController } from './health/health.controller';
import { setLoginRateLimit } from './auth/login-throttle';
import { MAIL_ENDPOINTS, buildMailEndpoints, type MailEndpoints } from './mail/mail-endpoints';
import { CredentialService } from './mail/credential.service';
import { IngestService } from './mail/ingest.service';
import { SyncService } from './mail/sync.service';
import { SubscriptionService } from './mail/subscription.service';
import { QueueService } from './mail/queue.service';
import { MailboxConnectService } from './mail/mailbox-connect.service';
import { MailboxService } from './mail/mailbox.service';
import { MailboxController } from './mail/mailbox.controller';
import { WebhooksController } from './mail/webhooks.controller';
import { EventsHub, EventsPublisher } from './events/events.service';
import { EventsController } from './events/events.controller';
import { AccessPolicy as AccessPolicyForMail } from './access/access-policy.service';
import { AssignmentService } from './assignment/assignment.service';
import { RoutingService } from './assignment/routing.service';
import { RulesService } from './assignment/rules.service';
import { CollabService } from './assignment/collab.service';
import { AssignmentController } from './assignment/assignment.controller';
import { ThreadsController } from './threads/threads.controller';
import { ThreadsService } from './threads/threads.service';
import { AttachmentsService } from './threads/attachments.service';
import { ThreadActionsService } from './threads/thread-actions.service';
import { ComposeController } from './compose/compose.controller';
import { DraftsService } from './compose/drafts.service';
import { SignaturesService, TemplatesService } from './compose/library.service';
import { NotificationsService } from './notifications/notifications.service';
import { NotificationsController } from './notifications/notifications.controller';
import { SlaService } from './sla/sla.service';
import { SlaAdminService } from './sla/sla-admin.service';
import { SlaController } from './sla/sla.controller';
import { StatusService } from './status/status.service';
import { StatusController } from './status/status.controller';
import { CrmAccess } from './crm/crm-access';
import { ContactLinkService } from './crm/contact-link.service';
import { TasksService } from './crm/tasks.service';
import { LeadsService } from './crm/leads.service';
import { ContactsService } from './crm/contacts.service';
import { CrmController } from './crm/crm.controller';

/** Providers shared by the HTTP API and the worker process. */
export function mailProviders(cfg: AppConfig, mailEndpoints?: MailEndpoints) {
  return [
    { provide: MAIL_ENDPOINTS, useFactory: () => mailEndpoints ?? buildMailEndpoints(cfg) },
    EventsPublisher,
    AccessPolicyForMail,
    NotificationsService,
    CrmAccess,
    ContactLinkService,
    TasksService,
    LeadsService,
    SlaService,
    StatusService,
    AssignmentService,
    RoutingService,
    CredentialService,
    IngestService,
    SyncService,
    SubscriptionService,
    QueueService,
  ];
}

export interface AppModuleOptions {
  ssoProviders?: SsoProviderConfig[];
  /** Tests point the mail module at local fake Google / Microsoft servers. */
  mailEndpoints?: MailEndpoints;
}

@Module({})
export class AppModule {
  /** `ssoProviders` / `mailEndpoints` let tests substitute local fakes; production builds them from env. */
  static register(cfg: AppConfig, opts: AppModuleOptions = {}): DynamicModule {
    setLoginRateLimit(cfg.LOGIN_RATE_LIMIT_PER_MIN);
    return {
      module: AppModule,
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }])],
      controllers: [AuthController, UsersController, RolesController, OrgController, AuditController, HealthController, MailboxController, WebhooksController, AssignmentController, StatusController, CrmController, ThreadsController, ComposeController, EventsController, SlaController, NotificationsController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: SSO_PROVIDERS, useFactory: () => opts.ssoProviders ?? buildSsoProviders(cfg) },
        envelopeProvider,
        PrismaService,
        AuditService,
        PermissionService,
        AccessPolicy,
        SessionService,
        PasswordService,
        MfaService,
        SsoService,
        AuthService,
        UsersService,
        RolesService,
        OrgService,
        ...mailProviders(cfg, opts.mailEndpoints),
        MailboxConnectService,
        MailboxService,
        ThreadsService,
        AttachmentsService,
        ThreadActionsService,
        DraftsService,
        EventsHub,
        RulesService,
        CollabService,
        SignaturesService,
        TemplatesService,
        SlaAdminService,
        ContactsService,
        // Order matters: rate-limit first, then authentication/authorisation.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
    };
  }
}
