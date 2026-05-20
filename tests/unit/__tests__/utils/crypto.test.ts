import { CryptoUtils } from '../../utils/crypto';

describe('CryptoUtils.generatePassword', () => {
  it('enforces minimum character type counts', () => {
    const password = CryptoUtils.generatePassword(12, true, {
      minUppercase: 2,
      minDigits: 3,
      minSymbols: 2,
    });

    expect(password).toHaveLength(12);
    const uppercaseCount = (password.match(/[A-Z]/g) ?? []).length;
    const digitCount = (password.match(/[0-9]/g) ?? []).length;
    // Count non-alphanumeric characters as symbols
    const symbolCount = (password.match(/[^a-zA-Z0-9]/g) ?? []).length;

    expect(uppercaseCount).toBeGreaterThanOrEqual(2);
    expect(digitCount).toBeGreaterThanOrEqual(3);
    expect(symbolCount).toBeGreaterThanOrEqual(2);
  });

  it('can generate passwords without symbols when disabled', () => {
    const password = CryptoUtils.generatePassword(10, false, {
      minUppercase: 1,
      minDigits: 1,
      minSymbols: 0,
    });

    expect(password).toHaveLength(10);
    expect(/[^a-zA-Z0-9]/.test(password)).toBe(false);
    const uppercaseCount = (password.match(/[A-Z]/g) ?? []).length;
    const digitCount = (password.match(/[0-9]/g) ?? []).length;
    expect(uppercaseCount).toBeGreaterThanOrEqual(1);
    expect(digitCount).toBeGreaterThanOrEqual(1);
  });
});
