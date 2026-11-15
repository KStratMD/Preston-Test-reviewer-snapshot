import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadContractFixture } from '../../helpers/contractFixtures';

const roots: string[] = [];
const provenance = {
  vendor: 'shopify', entity: 'order',
  sourceUrl: 'https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Order',
  docVersion: '2026-07', capturedAt: '2026-09-08', rung: 1,
};
function kit(overrides: Record<string, unknown> = {}, name = 'order') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-kit-'));
  roots.push(root);
  const dir = path.join(root, 'shopify', 'order');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '_provenance.json'), JSON.stringify({ ...provenance, ...overrides }));
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ id: 'synthetic-order-1' }));
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('loads data with validated provenance and optional measured hash', () => {
  const root = kit({ sourceSha256: 'a'.repeat(64) });
  const result = loadContractFixture<{ id: string }>('shopify', 'order', 'order', { root });
  expect(result.data.id).toBe('synthetic-order-1');
  expect(result.provenance).toEqual({ ...provenance, sourceSha256: 'a'.repeat(64) });
});
it('allows a schema-valid provenance without the optional hash', () => {
  expect(loadContractFixture('shopify', 'order', 'order', { root: kit() }).provenance.rung).toBe(1);
});
it.each(['cassette', 'REPLAY'])('refuses %s names below rung 3', name => {
  for (const rung of [1, 2]) {
    expect(() => loadContractFixture('shopify', 'order', name, { root: kit({ rung }, name) })).toThrow(
      `${name} is named like a recording but provenance is rung ${rung}; only rung 3 may be called a cassette or replay`,
    );
  }
  expect(() => loadContractFixture('shopify', 'order', name, { root: kit({ rung: 3 }, name) })).not.toThrow();
});
it('rejects missing provenance, missing fixture and missing directory', () => {
  const root = kit();
  expect(() => loadContractFixture('shopify', 'order', 'absent', { root })).toThrow(/missing fixture/);
  fs.unlinkSync(path.join(root, 'shopify', 'order', '_provenance.json'));
  expect(() => loadContractFixture('shopify', 'order', 'order', { root })).toThrow(/_provenance.json/);
  expect(() => loadContractFixture('absent', 'order', 'order', { root })).toThrow(/_provenance.json/);
});
it.each([
  { rung: 0 }, { rung: 4 }, { vendor: '' }, { entity: '' }, { docVersion: '' },
  { capturedAt: 'yesterday' }, { sourceUrl: 'not a URL' }, { sourceSha256: 'bad-hash' },
])('rejects invalid provenance %j', overrides => {
  expect(() => loadContractFixture('shopify', 'order', 'order', { root: kit(overrides) })).toThrow();
});
it('rejects unpinned latest sources', () => {
  const root = kit({ sourceUrl: 'https://shopify.dev/docs/api/admin-graphql/latest/objects/Order' });
  expect(() => loadContractFixture('shopify', 'order', 'order', { root })).toThrow(/version-pinned/);
});
it.each([['netsuite', 'order'], ['shopify', 'invoice']])('rejects copied provenance claiming %s/%s', (vendor, entity) => {
  const root = kit();
  const sibling = path.join(root, vendor, entity);
  fs.mkdirSync(sibling, { recursive: true });
  fs.copyFileSync(path.join(root, 'shopify', 'order', '_provenance.json'), path.join(sibling, '_provenance.json'));
  expect(() => loadContractFixture(vendor, entity, 'order', { root })).toThrow(
    `provenance mismatch: ${sibling} claims shopify/order`,
  );
});
it('rejects malformed provenance and fixture JSON', () => {
  const root = kit();
  fs.writeFileSync(path.join(root, 'shopify', 'order', 'order.json'), '{');
  expect(() => loadContractFixture('shopify', 'order', 'order', { root })).toThrow();
  fs.writeFileSync(path.join(root, 'shopify', 'order', '_provenance.json'), '{');
  expect(() => loadContractFixture('shopify', 'order', 'order', { root })).toThrow();
});
