import 'reflect-metadata';
import { ConsoleLogger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import type { SsoProviderConfig } from './auth/sso.service';
import type { AppConfig } from './config/config';

/** Shared by main.ts and the e2e tests so both run the exact same middleware stack. */
export async function createApp(cfg: AppConfig, opts: { ssoProviders?: SsoProviderConfig[] } = {}): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(cfg, opts), {
    logger: cfg.NODE_ENV === 'test' ? false : new ConsoleLogger({ json: cfg.isProd }),
  });
  app.set('trust proxy', cfg.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '1mb' });
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  return app;
}
