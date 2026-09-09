// writeDescriptorEncryption unit tests (PR 13c-2 Task 3).
//
// Covers the round-trip + fail-closed invariants on
// `governance_approvals.write_descriptor` persistence:
//   1. encryptDescriptor → decryptDescriptor returns the original.
//   2. Persisted JSON does NOT contain plaintext args (smoke check).
//   3. Decrypt fails closed on unknown version.
//   4. Decrypt fails closed on tampered ciphertext (auth-tag mismatch).
//   5. Decrypt fails closed on shape violations (missing version, etc.).
//   6. `integrationConfigId` round-trips outside the encrypted envelope.

import 'reflect-metadata';
import { EncryptionService } from '../../../../src/services/security/EncryptionService';
import {
  encryptDescriptor,
  decryptDescriptor,
  WriteDescriptorEncryptionError,
} from '../../../../src/services/governance/writeDescriptorEncryption';
import type { EncryptedWriteDescriptorPayload } from '../../../../src/services/governance/writeDescriptorEncryption';
import type { WriteDescriptor } from '../../../../src/governance/sourceOfTruth/guardedWrite';

const RAW_KEY = '0'.repeat(64); // 32-byte hex.

function makeDescriptor(): WriteDescriptor {
  return {
    targetSystemId: 'hubspot',
    operation: 'create',
    entityType: 'Contact',
    args: { email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace' },
    integrationConfigId: 'cfg-7c5e9bcb-1234',
    ownership: {
      entity: 'customer',
      declaredOwner: 'hubspot',
      callerSystem: 'netsuite',
      targetSystem: 'hubspot',
    },
  };
}

describe('writeDescriptorEncryption', () => {
  let enc: EncryptionService;
  let prevKey: string | undefined;

  beforeAll(() => {
    prevKey = process.env.AI_CONFIG_ENCRYPTION_KEY;
    process.env.AI_CONFIG_ENCRYPTION_KEY = RAW_KEY;
    enc = new EncryptionService();
  });

  afterAll(() => {
    if (prevKey === undefined) delete process.env.AI_CONFIG_ENCRYPTION_KEY;
    else process.env.AI_CONFIG_ENCRYPTION_KEY = prevKey;
  });

  it('round-trips through encrypt → decrypt to the original descriptor', async () => {
    const original = makeDescriptor();
    const payload = await encryptDescriptor(original, enc);
    const recovered = await decryptDescriptor(payload, enc);
    expect(recovered).toEqual(original);
  });

  it('persisted JSON does NOT contain any plaintext arg substring (smoke check)', async () => {
    const original = makeDescriptor();
    const payload = await encryptDescriptor(original, enc);
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain('ada@example.com');
    expect(serialized).not.toContain('Ada');
    expect(serialized).not.toContain('Lovelace');
    // But manifest vocabulary stays plaintext (queryable).
    expect(serialized).toContain('hubspot');
    expect(serialized).toContain('customer');
    expect(serialized).toContain('cfg-7c5e9bcb-1234');
  });

  it('round-trips when integrationConfigId is absent', async () => {
    const original = makeDescriptor();
    delete original.integrationConfigId;
    const payload = await encryptDescriptor(original, enc);
    const recovered = await decryptDescriptor(payload, enc);
    expect(recovered).toEqual(original);
    expect(recovered.integrationConfigId).toBeUndefined();
  });

  it('decrypt fails closed on unknown version', async () => {
    const original = makeDescriptor();
    const payload = await encryptDescriptor(original, enc);
    const tampered = { ...payload, version: 999 } as unknown as EncryptedWriteDescriptorPayload;

    await expect(decryptDescriptor(tampered, enc)).rejects.toBeInstanceOf(WriteDescriptorEncryptionError);
    await expect(decryptDescriptor(tampered, enc)).rejects.toThrow(/unknown version/i);
  });

  it('decrypt fails closed on tampered ciphertext (auth-tag mismatch)', async () => {
    const original = makeDescriptor();
    const payload = await encryptDescriptor(original, enc);
    // Flip one hex char in the encryptedText — AES-256-GCM auth tag must
    // detect the tamper and the underlying EncryptionService throws.
    const tampered: EncryptedWriteDescriptorPayload = {
      ...payload,
      argsEncrypted: {
        ...payload.argsEncrypted,
        encryptedText:
          payload.argsEncrypted.encryptedText.slice(0, -1) +
          (payload.argsEncrypted.encryptedText.slice(-1) === '0' ? '1' : '0'),
      },
    };

    await expect(decryptDescriptor(tampered, enc)).rejects.toBeInstanceOf(WriteDescriptorEncryptionError);
  });

  it('decrypt fails closed on missing version field', async () => {
    const original = makeDescriptor();
    const payload = await encryptDescriptor(original, enc);
    const { version: _omitted, ...rest } = payload;
    await expect(decryptDescriptor(rest as unknown, enc)).rejects.toBeInstanceOf(WriteDescriptorEncryptionError);
  });

  it('decrypt fails closed on missing argsEncrypted field', async () => {
    const original = makeDescriptor();
    const payload = await encryptDescriptor(original, enc);
    const { argsEncrypted: _omitted, ...rest } = payload;
    await expect(decryptDescriptor(rest as unknown, enc)).rejects.toBeInstanceOf(WriteDescriptorEncryptionError);
  });

  it('decrypt fails closed on null input', async () => {
    await expect(decryptDescriptor(null, enc)).rejects.toBeInstanceOf(WriteDescriptorEncryptionError);
  });

  it('decrypt fails closed on non-object input', async () => {
    await expect(decryptDescriptor('not-an-object', enc)).rejects.toBeInstanceOf(WriteDescriptorEncryptionError);
  });

  it('encrypt fails with serialize_failed code on circular-reference args', async () => {
    // Circular ref makes JSON.stringify throw — Copilot R0 #1 on PR #853
    // says this must surface as `serialize_failed`, NOT `encrypt_failed`,
    // so operators can route the alert to a caller-input bug rather than
    // a key/cipher misconfiguration.
    const circular: Record<string, unknown> = { name: 'Ada' };
    circular.self = circular;
    const desc: WriteDescriptor = { ...makeDescriptor(), args: circular };
    let caughtCode: string | undefined;
    try {
      await encryptDescriptor(desc, enc);
    } catch (err) {
      if (err instanceof WriteDescriptorEncryptionError) caughtCode = err.code;
    }
    expect(caughtCode).toBe('serialize_failed');
  });

  it('round-trips when args is undefined (JSON.stringify drops undefined-valued properties — symmetric absence)', async () => {
    // Under the metadata-digest binding (Copilot R3), the encrypted
    // cleartext is `{args, metadataDigest}`. JSON.stringify drops
    // undefined-valued properties, so an args=undefined input encrypts
    // to a cleartext with only metadataDigest. decryptDescriptor reads
    // back parsedObj.args as undefined — symmetric round-trip. Distinct
    // from non-serializable values (functions, symbols) which are caller
    // bugs that DO surface as serialize_failed (see next test).
    const desc: WriteDescriptor = { ...makeDescriptor(), args: undefined };
    const payload = await encryptDescriptor(desc, enc);
    const recovered = await decryptDescriptor(payload, enc);
    expect(recovered.args).toBeUndefined();
    expect(recovered.targetSystemId).toBe(desc.targetSystemId);
  });

  it('encrypt fails with serialize_failed when args is a function (JSON-undefined value, drops silently)', async () => {
    // Functions / symbols cause JSON.stringify to silently drop the
    // property. The encrypt path detects that drop and throws
    // serialize_failed so the caller-input bug surfaces explicitly.
    const desc: WriteDescriptor = { ...makeDescriptor(), args: () => 'not-json' as any };
    let caughtCode: string | undefined;
    try {
      await encryptDescriptor(desc, enc);
    } catch (err) {
      if (err instanceof WriteDescriptorEncryptionError) caughtCode = err.code;
    }
    expect(caughtCode).toBe('serialize_failed');
  });

  // Copilot R7 on PR #853: the previous top-level-only check missed nested
  // non-JSON values. JSON.stringify silently turns `{a: () => {}}` into
  // `{}` while keeping the top-level `"args"` key, so a lossy payload
  // would have been persisted. The replacer-based guard now throws on any
  // function/symbol/BigInt at any depth.
  it('encrypt fails with serialize_failed when args contains a NESTED function (deep tree)', async () => {
    const desc: WriteDescriptor = {
      ...makeDescriptor(),
      args: { customer: { name: 'Ada', onSave: () => 'side-effect' } } as any,
    };
    let caughtCode: string | undefined;
    try {
      await encryptDescriptor(desc, enc);
    } catch (err) {
      if (err instanceof WriteDescriptorEncryptionError) caughtCode = err.code;
    }
    expect(caughtCode).toBe('serialize_failed');
  });

  it('encrypt fails with serialize_failed when args contains a NESTED symbol', async () => {
    const desc: WriteDescriptor = {
      ...makeDescriptor(),
      args: { customer: { name: 'Ada', tag: Symbol('vip') } } as any,
    };
    let caughtCode: string | undefined;
    try {
      await encryptDescriptor(desc, enc);
    } catch (err) {
      if (err instanceof WriteDescriptorEncryptionError) caughtCode = err.code;
    }
    expect(caughtCode).toBe('serialize_failed');
  });

  it('encrypt fails with serialize_failed when args contains a NESTED BigInt', async () => {
    const desc: WriteDescriptor = {
      ...makeDescriptor(),
      args: { customer: { id: 99n, name: 'Ada' } } as any,
    };
    let caughtCode: string | undefined;
    try {
      await encryptDescriptor(desc, enc);
    } catch (err) {
      if (err instanceof WriteDescriptorEncryptionError) caughtCode = err.code;
    }
    expect(caughtCode).toBe('serialize_failed');
  });

  it('encrypt fails with serialize_failed when a deeply nested ARRAY element is a function', async () => {
    const desc: WriteDescriptor = {
      ...makeDescriptor(),
      args: { items: [{ id: 1 }, { id: 2, handler: () => null }] } as any,
    };
    let caughtCode: string | undefined;
    try {
      await encryptDescriptor(desc, enc);
    } catch (err) {
      if (err instanceof WriteDescriptorEncryptionError) caughtCode = err.code;
    }
    expect(caughtCode).toBe('serialize_failed');
  });

  // Copilot R8 on PR #853: JSON.stringify([undefined]) silently becomes
  // [null] — undefined-in-array would corrupt the resumed write. The
  // replacer now fail-closes on undefined inside array positions while
  // permitting undefined for object properties + the top-level args slot
  // (where JSON.stringify drops the key cleanly and round-trip semantics
  // preserve absence).
  it('encrypt fails with serialize_failed when args contains undefined in an ARRAY position', async () => {
    const desc: WriteDescriptor = {
      ...makeDescriptor(),
      args: { items: [{ id: 1 }, undefined, { id: 3 }] } as any,
    };
    let caughtCode: string | undefined;
    try {
      await encryptDescriptor(desc, enc);
    } catch (err) {
      if (err instanceof WriteDescriptorEncryptionError) caughtCode = err.code;
    }
    expect(caughtCode).toBe('serialize_failed');
  });

  it('encrypt fails with serialize_failed when args is itself an ARRAY containing undefined', async () => {
    const desc: WriteDescriptor = {
      ...makeDescriptor(),
      args: ['a', undefined, 'c'] as any,
    };
    let caughtCode: string | undefined;
    try {
      await encryptDescriptor(desc, enc);
    } catch (err) {
      if (err instanceof WriteDescriptorEncryptionError) caughtCode = err.code;
    }
    expect(caughtCode).toBe('serialize_failed');
  });

  it('encrypt PERMITS undefined-valued properties at object positions (round-trip semantics)', async () => {
    // {a: undefined} is dropped to {} — caller intent preserved; not a
    // corruption. The replacer must not fail-close this case.
    const desc: WriteDescriptor = {
      ...makeDescriptor(),
      args: { name: 'Ada', maybeMissing: undefined, age: 30 } as any,
    };
    const payload = await encryptDescriptor(desc, enc);
    expect(payload.argsEncrypted).toBeDefined();
  });

  // PR 13c-2 R1: tightened isPayloadShape (Copilot R1 on PR #853). Each of
  // these mutates a valid payload by deleting / typing one required field
  // and asserts decrypt fails with code='shape_invalid' rather than
  // letting the malformed row reach EncryptionService.decrypt (which would
  // surface a less actionable error).
  describe('isPayloadShape — tightened structural checks', () => {
    async function buildPayload(): Promise<Record<string, unknown>> {
      const orig = makeDescriptor();
      const payload = await encryptDescriptor(orig, enc);
      return JSON.parse(JSON.stringify(payload));
    }

    async function expectShapeInvalid(mutate: (p: Record<string, unknown>) => void): Promise<void> {
      const p = await buildPayload();
      mutate(p);
      let caughtCode: string | undefined;
      try {
        await decryptDescriptor(p, enc);
      } catch (err) {
        if (err instanceof WriteDescriptorEncryptionError) caughtCode = err.code;
      }
      expect(caughtCode).toBe('shape_invalid');
    }

    it('argsEncrypted missing algorithm → shape_invalid', async () => {
      await expectShapeInvalid((p) => {
        delete (p.argsEncrypted as Record<string, unknown>).algorithm;
      });
    });

    it('ownership missing declaredOwner → shape_invalid', async () => {
      await expectShapeInvalid((p) => {
        delete (p.ownership as Record<string, unknown>).declaredOwner;
      });
    });

    it('ownership missing targetSystem → shape_invalid', async () => {
      await expectShapeInvalid((p) => {
        delete (p.ownership as Record<string, unknown>).targetSystem;
      });
    });

    it('ownership.callerSystem is a non-string → shape_invalid', async () => {
      await expectShapeInvalid((p) => {
        (p.ownership as Record<string, unknown>).callerSystem = 42;
      });
    });

    it('integrationConfigId present but non-string → shape_invalid', async () => {
      await expectShapeInvalid((p) => {
        p.integrationConfigId = 99;
      });
    });
  });

  // PR 13c-2 R3: Copilot raised that AES-GCM only authenticates the
  // ciphertext + AAD; plaintext metadata fields persisted outside the
  // encrypted envelope could be tampered at the DB tier and the resume
  // handler would dispatch with the wrong target. The implementation now
  // embeds a SHA-256 of the canonical plaintext metadata INSIDE the
  // AES-GCM-authenticated cleartext; decryptDescriptor recomputes the
  // digest from the persisted plaintext and rejects with code='metadata_tampered'
  // on any mismatch.
  describe('metadata-tamper binding (Copilot R3 on PR #853)', () => {
    async function buildPayload(): Promise<Record<string, unknown>> {
      const orig = makeDescriptor();
      const payload = await encryptDescriptor(orig, enc);
      return JSON.parse(JSON.stringify(payload));
    }

    async function expectMetadataTampered(mutate: (p: Record<string, unknown>) => void): Promise<void> {
      const p = await buildPayload();
      mutate(p);
      let caughtCode: string | undefined;
      try {
        await decryptDescriptor(p, enc);
      } catch (err) {
        if (err instanceof WriteDescriptorEncryptionError) caughtCode = err.code;
      }
      expect(caughtCode).toBe('metadata_tampered');
    }

    it('mutated targetSystemId → metadata_tampered', async () => {
      await expectMetadataTampered((p) => {
        p.targetSystemId = 'shopify'; // was 'hubspot'
      });
    });

    it("mutated operation ('create' → 'delete') → metadata_tampered", async () => {
      await expectMetadataTampered((p) => {
        p.operation = 'delete';
      });
    });

    it('mutated entityType → metadata_tampered', async () => {
      await expectMetadataTampered((p) => {
        p.entityType = 'Account'; // was 'Contact'
      });
    });

    it('mutated ownership.declaredOwner → metadata_tampered', async () => {
      await expectMetadataTampered((p) => {
        (p.ownership as Record<string, unknown>).declaredOwner = 'salesforce';
      });
    });

    it('mutated integrationConfigId → metadata_tampered', async () => {
      await expectMetadataTampered((p) => {
        p.integrationConfigId = 'cfg-attacker';
      });
    });

    it('added a previously-absent integrationConfigId → metadata_tampered (asymmetric: present-vs-absent must hash differently)', async () => {
      const orig = makeDescriptor();
      delete orig.integrationConfigId;
      const payload = await encryptDescriptor(orig, enc);
      const tampered = JSON.parse(JSON.stringify(payload));
      tampered.integrationConfigId = 'cfg-attacker';
      let caughtCode: string | undefined;
      try {
        await decryptDescriptor(tampered, enc);
      } catch (err) {
        if (err instanceof WriteDescriptorEncryptionError) caughtCode = err.code;
      }
      expect(caughtCode).toBe('metadata_tampered');
    });
  });
});
