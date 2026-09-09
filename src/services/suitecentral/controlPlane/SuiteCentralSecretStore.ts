import { inject, injectable } from 'inversify';
import { createHash, timingSafeEqual } from 'crypto';
import { TYPES } from '../../../inversify/types';
import type { SecretManager } from '../../SecretManager';
import { SuiteCentralValidationError } from './errors';

/**
 * Write-only secret lifecycle for SuiteCentral credential profiles.
 *
 * Secret material enters ONLY through {@link store}/{@link rotate} and never
 * leaves except via {@link resolve} (which returns the raw value to the
 * application/connector layer — never to a route). Callers persist only the
 * deterministic, PII-free `secret_ref` returned by {@link referenceFor}; the
 * store recomputes that reference from `(tenantId, profileId)` and timing-safely
 * compares it to the caller-supplied `storedRef` BEFORE touching the backing
 * SecretManager, so a forged/tampered reference is rejected without a backend
 * round-trip and can never point the read at another tenant's secret.
 */
@injectable()
export class SuiteCentralSecretStore {
  constructor(@inject(TYPES.SecretManager) private readonly secretManager: SecretManager) {}

  /**
   * Deterministic, PII-free reference for a credential profile's secret.
   *
   * The components are JSON-encoded (which escapes control characters and
   * delimits with structural quotes/commas) so the mapping is INJECTIVE even if
   * a tenant/profile id contains a NUL or other separator — `("a\0b","c")` and
   * `("a","b\0c")` produce different digests. A plain delimiter would not.
   */
  referenceFor(tenantId: string, profileId: string): string {
    const digest = createHash('sha256')
      .update(JSON.stringify(['suitecentral', tenantId, profileId]), 'utf8')
      .digest('hex');
    return `suitecentral-${digest}`;
  }

  private assertReference(tenantId: string, profileId: string, storedRef: string): string {
    const expected = this.referenceFor(tenantId, profileId);
    const mismatch = () =>
      new SuiteCentralValidationError(
        'secret_reference_mismatch',
        'Stored secret reference does not match the expected deterministic reference.',
      );
    // Cheap string-length pre-check so a maliciously large storedRef is rejected
    // before we allocate a Buffer for the constant-time comparison. The expected
    // reference is fixed-length ASCII, so an unequal length is always a mismatch.
    if (storedRef.length !== expected.length) {
      throw mismatch();
    }
    const expectedBuf = Buffer.from(expected, 'utf8');
    const storedBuf = Buffer.from(storedRef, 'utf8');
    if (expectedBuf.length !== storedBuf.length || !timingSafeEqual(expectedBuf, storedBuf)) {
      throw mismatch();
    }
    return expected;
  }

  /** Store a new secret and return the reference the caller must persist. */
  async store(tenantId: string, profileId: string, value: string): Promise<string> {
    const ref = this.referenceFor(tenantId, profileId);
    await this.secretManager.setSecret(ref, value);
    return ref;
  }

  /** Replace the secret for an existing profile after verifying its reference. */
  async rotate(tenantId: string, profileId: string, storedRef: string, value: string): Promise<void> {
    const ref = this.assertReference(tenantId, profileId, storedRef);
    await this.secretManager.setSecret(ref, value);
  }

  /**
   * Resolve the raw secret value for the application/connector layer only.
   *
   * SuiteCentral secrets are read with `bypassCache` (never held in the
   * SecretManager in-memory cache — enforces the "secret is never cached"
   * property) and `noEnvFallback` (a provider outage fails closed instead of
   * silently returning a `process.env` credential).
   */
  async resolve(input: { tenantId: string; profileId: string; storedRef: string }): Promise<string> {
    const ref = this.assertReference(input.tenantId, input.profileId, input.storedRef);
    const secret = await this.secretManager.getSecret(ref, { bypassCache: true, noEnvFallback: true });
    return secret.value;
  }

  /** Permanently delete the secret after verifying its reference. */
  async delete(tenantId: string, profileId: string, storedRef: string): Promise<void> {
    const ref = this.assertReference(tenantId, profileId, storedRef);
    await this.secretManager.deleteSecret(ref);
  }
}
