/**
 * Role labels reaching the bootstrap logs come from the request body, which
 * express.json accepts up to 10 MB of. Logging them whole let any host — or
 * anyone holding an account service token — inflate log volume and ingestion
 * cost at will, with no authentication beyond the token the host already has.
 *
 * The COUNT is what an operator acts on; the sample only makes the line
 * actionable. So both the list and each label are bounded, and this pins that:
 * an unbounded log is only "fixed" if something keeps it bounded.
 */
import { sampleRoleLabels } from '../../../../src/routes/embedded/hostBootstrapRouter';

describe('bootstrap role-label log bounds', () => {
  it('caps how many labels are sampled', () => {
    const many = Array.from({ length: 10_000 }, (_, i) => `role_${i}`);
    const sample = sampleRoleLabels(many);
    expect(sample).toHaveLength(5);
    expect(sample[0]).toBe('role_0');
  });

  it('caps the length of a single label', () => {
    // A cap on the array alone would be defeated by one enormous role.
    const huge = 'a'.repeat(100_000);
    const [only] = sampleRoleLabels([huge]);
    expect(only.length).toBeLessThanOrEqual(41); // 40 + the ellipsis
    expect(only.endsWith('…')).toBe(true);
  });

  it('bounds the total serialized size even for a hostile payload', () => {
    const hostile = Array.from({ length: 10_000 }, () => 'x'.repeat(50_000));
    const serialized = JSON.stringify(sampleRoleLabels(hostile));
    // Without the caps this would be ~500 MB.
    expect(serialized.length).toBeLessThan(500);
  });

  it('leaves ordinary labels untouched', () => {
    expect(sampleRoleLabels(['finance', 'ops'])).toEqual(['finance', 'ops']);
    expect(sampleRoleLabels([])).toEqual([]);
  });
});
