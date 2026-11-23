import 'reflect-metadata';
import { ConsoleLogger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule, type AppModuleOptions } from './app.module';
import type { AppConfig } from './config/config';
import { PrismaService } from './prisma/prisma.service';

/** Shared by main.ts and the e2e tests so both run the exact same middleware stack. */
export async function createApp(cfg: AppConfig, opts: AppModuleOptions = {}): Promise<INestApplication> {
  // Every statement of the API states its caller for Postgres RLS (the worker process does not).
  PrismaService.rlsContext = true;
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(cfg, opts), {
    logger: cfg.NODE_ENV === 'test' ? false : new ConsoleLogger({ json: cfg.isProd }),
  });
  app.set('trust proxy', cfg.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '3mb' }); // draft bodies up to 2 MB; files use multipart
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  return app;
}
