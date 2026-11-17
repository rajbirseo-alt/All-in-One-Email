'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** Shows the QR code + manual key for an authenticator app. */
export function TotpSetup({ secret, otpauthUri }: { secret: string; otpauthUri: string }) {
  const [svg, setSvg] = useState<string>('');
  useEffect(() => {
    QRCode.toString(otpauthUri, { type: 'svg', margin: 1, width: 176 }).then(setSvg, () => setSvg(''));
  }, [otpauthUri]);
  return (
    <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
      <div
        className="size-[176px] shrink-0 overflow-hidden rounded-md border border-border bg-white"
        role="img"
        aria-label="QR code for your authenticator app"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div className="text-[13px] text-text-2">
        <p>Scan with Google Authenticator, Microsoft Authenticator, 1Password or any TOTP app.</p>
        <p className="mt-2">Can’t scan? Enter this key:</p>
        <code className="mt-1 block rounded bg-surface-2 px-2 py-1.5 font-mono text-[12.5px] break-all text-text select-all">{secret.match(/.{1,4}/g)?.join(' ')}</code>
      </div>
    </div>
  );
}
