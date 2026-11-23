import { createServer as createHttp, type Server as HttpServer } from 'node:http';
import { createServer as createTcp, type Server as TcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { signS3, type S3Config } from '../src/storage/s3';

/** The standard EICAR antivirus test string (harmless; every scanner reports it). */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * A clamd stand-in speaking the real INSTREAM protocol: length-prefixed chunks, a zero-length
 * terminator, then "stream: OK" or "stream: <signature> FOUND". Flags EICAR. `down` closes
 * connections without answering (scanner outage).
 */
export class FakeClamd {
  private server!: TcpServer;
  port = 0;
  scans = 0;
  down = false;

  async start() {
    this.server = createTcp((sock) => {
      if (this.down) return void sock.destroy();
      let buf = Buffer.alloc(0);
      let body = Buffer.alloc(0);
      let headerDone = false;
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (!headerDone) {
          const end = buf.indexOf(0);
          if (end < 0) return;
          if (buf.subarray(0, end).toString() !== 'zINSTREAM') return void sock.end('UNKNOWN COMMAND\0');
          buf = buf.subarray(end + 1);
          headerDone = true;
        }
        while (buf.length >= 4) {
          const len = buf.readUInt32BE(0);
          if (len === 0) {
            this.scans++;
            const infected = body.includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE'));
            sock.end(infected ? 'stream: Win.Test.EICAR_HDB-1 FOUND\0' : 'stream: OK\0');
            return;
          }
          if (buf.length < 4 + len) return;
          body = Buffer.concat([body, buf.subarray(4, 4 + len)]);
          buf = buf.subarray(4 + len);
        }
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }
  stop() {
    this.server?.close();
  }
}

/**
 * An S3 stand-in (path-style PUT/GET/DELETE) that **verifies AWS SigV4**: it recomputes the
 * signature from the request with the shared secret and refuses mismatches (403), so the
 * client's signing is exercised for real.
 */
export class FakeS3 {
  private server!: HttpServer;
  objects = new Map<string, Buffer>();
  rejected = 0;
  cfg!: S3Config;

  async start(bucket = 'crm-files') {
    this.server = createHttp((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const prefix = `/${bucket}/`;
        const path = req.url ?? '';
        if (!path.startsWith(prefix)) return void res.writeHead(404).end();
        const key = path.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
        const amzDate = String(req.headers['x-amz-date'] ?? '');
        const when = new Date(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
        const expected = signS3(this.cfg, req.method!, key, body, when).headers.authorization;
        if (req.headers.authorization !== expected) {
          this.rejected++;
          return void res.writeHead(403).end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
        }
        if (req.method === 'PUT') {
          this.objects.set(key, body);
          return void res.writeHead(200).end();
        }
        if (req.method === 'GET') {
          const o = this.objects.get(key);
          return void (o ? res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(o) : res.writeHead(404).end());
        }
        if (req.method === 'DELETE') {
          this.objects.delete(key);
          return void res.writeHead(204).end();
        }
        res.writeHead(405).end();
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const port = (this.server.address() as AddressInfo).port;
    this.cfg = { endpoint: `http://127.0.0.1:${port}`, region: 'auto', bucket, accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test-key' };
    return this;
  }
  env(): Record<string, string> {
    return { S3_ENDPOINT: this.cfg.endpoint, S3_REGION: this.cfg.region, S3_BUCKET: this.cfg.bucket, S3_ACCESS_KEY_ID: this.cfg.accessKeyId, S3_SECRET_ACCESS_KEY: this.cfg.secretAccessKey };
  }
  stop() {
    this.server?.close();
  }
}
