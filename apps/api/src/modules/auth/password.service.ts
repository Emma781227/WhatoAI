import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { PasswordReuseError, WeakPasswordError } from '@whauto/shared';

// `Algorithm` est un const enum ambiant, inaccessible avec isolatedModules :
// on fixe la valeur numérique (Argon2id = 2) directement.
const ARGON2ID = 2;

// Recommandation OWASP pour Argon2id côté serveur (config 19 MiB / 2 passes / 1 thread).
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

/**
 * Seul point d'entrée du projet autorisé à importer @node-rs/argon2 directement.
 */
@Injectable()
export class PasswordService {
  validateStrength(password: string): void {
    if (password.length < MIN_LENGTH) {
      throw new WeakPasswordError(`must be at least ${MIN_LENGTH} characters long`);
    }
    if (password.length > MAX_LENGTH) {
      throw new WeakPasswordError(`must be at most ${MAX_LENGTH} characters long`);
    }
  }

  async hash(password: string): Promise<string> {
    this.validateStrength(password);
    return hash(password, ARGON2_OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    return verify(passwordHash, password);
  }

  async assertNotReused(newPassword: string, currentPasswordHash: string): Promise<void> {
    const isSamePassword = await this.verify(currentPasswordHash, newPassword);
    if (isSamePassword) {
      throw new PasswordReuseError();
    }
  }
}
