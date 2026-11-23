import { connect } from 'node:net';

export type ScanResult = { status: 'CLEAN' } | { status: 'INFECTED'; signature: string } | { status: 'FAILED'; error: string };

/**
 * ClamAV over the clamd TCP protocol (INSTREAM): the file is streamed in chunks, each prefixed
 * with its 4-byte big-endian length, then a zero-length chunk. clamd replies
 * "stream: OK" or "stream: <Signature> FOUND".
 */
export async function clamdScan(host: string, port: number, data: Buffer, timeoutMs = 30_000): Promise<ScanResult> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    let reply = '';
    let settled = false;
    const done = (r: ScanResult) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(timeoutMs, () => done({ status: 'FAILED', error: 'virus scanner timed out' }));
    sock.on('error', (e) => done({ status: 'FAILED', error: `virus scanner unreachable: ${e.message}` }));
    sock.on('data', (d) => {
      reply += d.toString('utf8');
      if (reply.includes('\0') || reply.includes('\n')) finish();
    });
    sock.on('end', () => finish());
    const finish = () => {
      const line = reply.replace(/\0/g, '').trim();
      if (/^stream: OK$/.test(line)) return done({ status: 'CLEAN' });
      const found = /^stream: (.+) FOUND$/.exec(line);
      if (found) return done({ status: 'INFECTED', signature: found[1]! });
      done({ status: 'FAILED', error: `virus scanner said: ${line.slice(0, 200) || 'nothing'}` });
    };
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      const CHUNK = 64 * 1024;
      for (let i = 0; i < data.length; i += CHUNK) {
        const part = data.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        sock.write(len);
        sock.write(part);
      }
      sock.write(Buffer.alloc(4)); // end of stream
    });
  });
}
