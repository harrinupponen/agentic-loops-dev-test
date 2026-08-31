import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/lib/password.js';

describe('password hashing', () => {
  it('round-trips a password', async () => {
    const digest = await hashPassword('correct-horse-battery-staple');
    expect(digest).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(digest, 'correct-horse-battery-staple')).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const digest = await hashPassword('correct-horse-battery-staple');
    await expect(verifyPassword(digest, 'wrong-horse-battery-staple')).resolves.toBe(false);
  });

  it('salts, so identical passwords hash differently', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same-password'),
      hashPassword('same-password'),
    ]);
    expect(a).not.toBe(b);
  });

  it('returns false rather than throwing on a malformed digest', async () => {
    await expect(verifyPassword('not-a-hash', 'whatever')).resolves.toBe(false);
  });
});
