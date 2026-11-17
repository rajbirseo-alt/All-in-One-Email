import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';

/** argon2id, 64 MiB, t=3 (docs/05 §2). */
const OPTIONS = { algorithm: Algorithm.Argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 } as const;

@Injectable()
export class PasswordService {
  /** Verified against when the user does not exist, so response time doesn't reveal accounts. */
  private dummy: Promise<string> = hash('not-a-real-password-placeholder', OPTIONS);

  hash(password: string) {
    return hash(password, OPTIONS);
  }

  async verify(storedHash: string | null | undefined, password: string): Promise<boolean> {
    try {
      return await verify(storedHash ?? (await this.dummy), password);
    } catch {
      return false;
    }
  }
}
