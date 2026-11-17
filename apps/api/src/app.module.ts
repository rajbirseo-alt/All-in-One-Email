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

@Module({})
export class AppModule {
  /** `ssoProviders` lets tests substitute a local OIDC issuer; production builds them from env. */
  static register(cfg: AppConfig, opts: { ssoProviders?: SsoProviderConfig[] } = {}): DynamicModule {
    setLoginRateLimit(cfg.LOGIN_RATE_LIMIT_PER_MIN);
    return {
      module: AppModule,
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }])],
      controllers: [AuthController, UsersController, RolesController, OrgController, AuditController, HealthController],
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
        // Order matters: rate-limit first, then authentication/authorisation.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
    };
  }
}
