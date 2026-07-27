import { PasswordReuseError, WeakPasswordError } from '@whauto/shared';

import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hache puis vérifie un mot de passe (aller-retour)', async () => {
    const hash = await service.hash('correct-horse-battery');
    expect(hash).not.toContain('correct-horse-battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(service.verify(hash, 'correct-horse-battery')).resolves.toBe(true);
    await expect(service.verify(hash, 'wrong-password')).resolves.toBe(false);
  });

  it('produit un hash différent à chaque appel (sel aléatoire)', async () => {
    const [first, second] = await Promise.all([
      service.hash('correct-horse-battery'),
      service.hash('correct-horse-battery'),
    ]);
    expect(first).not.toBe(second);
  });

  it('rejette un mot de passe trop court', () => {
    expect(() => service.validateStrength('short')).toThrow(WeakPasswordError);
  });

  it('rejette un mot de passe trop long', () => {
    expect(() => service.validateStrength('x'.repeat(129))).toThrow(WeakPasswordError);
  });

  it('accepte un mot de passe aux bornes (8 et 128 caractères)', () => {
    expect(() => service.validateStrength('x'.repeat(8))).not.toThrow();
    expect(() => service.validateStrength('x'.repeat(128))).not.toThrow();
  });

  it('assertNotReused rejette le même mot de passe et accepte un différent', async () => {
    const hash = await service.hash('correct-horse-battery');
    await expect(service.assertNotReused('correct-horse-battery', hash)).rejects.toThrow(
      PasswordReuseError,
    );
    await expect(service.assertNotReused('another-password-42', hash)).resolves.toBeUndefined();
  });
});
