/**
 * isRealPathInsideRoot must fail closed: only a path where nothing exists at all may take the
 * lexical fallback (Copilot review on #1343). fs is mocked at module level because its exports
 * cannot be spied on; the two calls are driven per test.
 */
import * as path from 'path';

const mockRealpath = jest.fn();
const mockLstat = jest.fn();

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    realpathSync: (...args: unknown[]) => mockRealpath(...args),
    lstatSync: (...args: unknown[]) => mockLstat(...args),
  };
});

import { isRealPathInsideRoot } from '../../../src/utils/safeDocsHtml';

const errno = (code: string) => Object.assign(new Error(code), { code });
const root = path.resolve('/r/docs');
const candidate = path.join(root, 'x.md');

it.each(['EACCES', 'EPERM', 'ELOOP', 'EIO'])(
  'refuses when realpath says ENOENT but lstat fails with %s',
  code => {
    mockRealpath.mockImplementation(() => { throw errno('ENOENT'); });
    mockLstat.mockImplementation(() => { throw errno(code); });
    expect(isRealPathInsideRoot(root, candidate)).toBe(false);
  },
);

it('refuses when realpath says ENOENT but lstat finds something (a dangling link)', () => {
  mockRealpath.mockImplementation(() => { throw errno('ENOENT'); });
  mockLstat.mockImplementation(() => ({}));
  expect(isRealPathInsideRoot(root, candidate)).toBe(false);
});

it('keeps the missing-path fallback only when lstat also says ENOENT', () => {
  mockRealpath.mockImplementation(() => { throw errno('ENOENT'); });
  mockLstat.mockImplementation(() => { throw errno('ENOENT'); });
  expect(isRealPathInsideRoot(root, candidate)).toBe(true);
});
