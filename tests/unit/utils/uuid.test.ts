import { uuidv4 } from '../../../src/utils/uuid';

describe('uuidv4', () => {
  it('returns an RFC 4122 version 4 UUID string', () => {
    const value = uuidv4();

    expect(value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
