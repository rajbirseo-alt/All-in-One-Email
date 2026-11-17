import type { Provider } from '@nestjs/common';
import { Envelope, StaticKeyProvider } from '@crm/crypto';
import { APP_CONFIG, type AppConfig } from './config/config';

export const ENVELOPE = Symbol('ENVELOPE');

export const envelopeProvider: Provider = {
  provide: ENVELOPE,
  inject: [APP_CONFIG],
  useFactory: (cfg: AppConfig) => new Envelope(new StaticKeyProvider(cfg.ENCRYPTION_KEYS)),
};
