import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Envelope } from '@crm/crypto';
import { ApiException } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { ENVELOPE } from '../crypto.provider';
import { clamdScan, type ScanResult } from './scanner';
import { S3Client } from './s3';

export type ScanOutcome = 'CLEAN' | 'SKIPPED';

/**
 * Attachment files: virus scanning (ClamAV) and object storage (any S3-compatible bucket).
 *
 * - **Scanning** is on when CLAMAV_HOST is set. Then every uploaded file, every received file
 *   before it is downloaded or forwarded, is scanned; infected files are refused and an
 *   unreachable scanner refuses too (fail closed). Without CLAMAV_HOST files are marked SKIPPED
 *   and the health check reports scanning as off.
 * - **Storage**: with S3_BUCKET set, uploads and downloaded received files are kept in the
 *   bucket, envelope-encrypted with the app's keys (so the bucket alone reveals nothing). Without
 *   it, uploads stay in the database and received files are fetched from the mailbox each time.
 */
@Injectable()
export class FileStore {
  private readonly log = new Logger(FileStore.name);
  private readonly s3: S3Client | null;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(ENVELOPE) private readonly envelope: Envelope,
  ) {
    this.s3 = cfg.S3_BUCKET
      ? new S3Client({ endpoint: cfg.S3_ENDPOINT!, region: cfg.S3_REGION, bucket: cfg.S3_BUCKET, accessKeyId: cfg.S3_ACCESS_KEY_ID!, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY! })
      : null;
  }

  get scanning() {
    return !!this.cfg.CLAMAV_HOST;
  }
  get storing() {
    return !!this.s3;
  }

  async scan(data: Buffer): Promise<ScanResult | { status: 'SKIPPED' }> {
    if (!this.cfg.CLAMAV_HOST) return { status: 'SKIPPED' };
    return clamdScan(this.cfg.CLAMAV_HOST, this.cfg.CLAMAV_PORT, data);
  }

  /** Scans and throws for an infected file (422 MALWARE) or an unavailable scanner (503). */
  async assertClean(data: Buffer, what: string): Promise<ScanOutcome> {
    const r = await this.scan(data);
    if (r.status === 'INFECTED') {
      throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, 'MALWARE', `${what} contains malware (${r.signature}) and was blocked`);
    }
    if (r.status === 'FAILED') throw this.unavailable(r.error);
    return r.status;
  }

  /** 503 for a scan that could not run (files are never let through unscanned when scanning is on). */
  unavailable(error: string) {
    this.log.error(`Virus scan failed: ${error}`);
    return new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'SCANNER_UNAVAILABLE', 'The virus scanner is not available right now. Try again in a few minutes.');
  }

  /** Object key of an attachment's content. */
  key(attachmentId: string) {
    return `attachments/${attachmentId}`;
  }

  async put(attachmentId: string, data: Buffer): Promise<string> {
    if (!this.s3) throw new Error('Object storage is not configured');
    const key = this.key(attachmentId);
    await this.s3.put(key, await this.envelope.encryptToBytes(data, `attachment:${attachmentId}`));
    return key;
  }

  async get(attachmentId: string, key: string): Promise<Buffer | null> {
    if (!this.s3) return null;
    const blob = await this.s3.get(key);
    return blob ? this.envelope.decryptFromBytes(blob, `attachment:${attachmentId}`) : null;
  }

  /** Best effort: a failed delete leaves an encrypted orphan, never an error for the user. */
  async remove(keys: (string | null | undefined)[]) {
    if (!this.s3) return;
    for (const k of keys) {
      if (!k) continue;
      await this.s3.delete(k).catch((e: Error) => this.log.warn(`Could not delete ${k} from object storage: ${e.message}`));
    }
  }
}
