import { githubApi, publishStatus } from '../../../src/blueprint/githubReviews';
import { approved, pull } from './helpers';

const reply = (data: unknown, link?: string) => new Response(JSON.stringify(data), { status: 200, headers: link ? { Link: link } : {} });
afterEach(() => { jest.restoreAllMocks(); delete process.env.GITHUB_API_URL; });
it('reads every review and file page and raw contents at the requested SHA', async () => {
  const fetcher = jest.spyOn(global, 'fetch').mockResolvedValueOnce(reply(pull()))
    .mockResolvedValueOnce(reply([approved()], '<https://api.github.com/repos/o/r/pulls/5/reviews?page=2>; rel="next"'))
    .mockResolvedValueOnce(reply([approved(undefined, 'abc', 'COMMENTED', 78)]))
    .mockResolvedValueOnce(reply([{ filename: 'docs/' + 'blueprints/x.json', status: 'modified' }], '<https://api.github.com/repos/o/r/pulls/5/files?page=2>; rel="next"'))
    .mockResolvedValueOnce(reply([{ filename: 'other', status: 'removed' }]))
    .mockResolvedValueOnce(new Response('{"raw":true}\r\n'))
    .mockResolvedValueOnce(reply({ commit: { sha: 'canonical' } }));
  const api = githubApi('test-token', 'o', 'r', 5);
  expect((await api.getPull()).head.sha).toBe('abc');
  expect(await api.listReviews()).toHaveLength(2); expect(await api.listFiles()).toHaveLength(2);
  expect(await api.getFileAtRef('docs/' + 'blueprints/x.json', 'abc')).toBe('{"raw":true}\r\n');
  expect(fetcher.mock.calls[5][1]?.headers).toMatchObject({ Accept: 'application/vnd.github.raw+json' });
  expect(String(fetcher.mock.calls[5][0])).toContain('?ref=abc');
  expect(await api.getBranchHead('Working-Branch')).toBe('canonical');
});
it('does not follow pagination to another origin or resource', async () => {
  for (const link of ['https://attacker.test/steal', 'https://api.github.com/repos/other/r/pulls/1/reviews']) {
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(reply([], `<${link}>; rel="next"`));
    await expect(githubApi('test-token', 'o', 'r', 5).listReviews()).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1); fetcher.mockRestore();
  }
});
it('rejects refused and malformed API responses and pagination cycles', async () => {
  for (const response of [new Response('denied', { status: 403 }), reply({ not: 'reviews' }), reply([], '<https://api.github.com/repos/o/r/pulls/5/reviews?per_page=100>; rel="next"')]) {
    jest.spyOn(global, 'fetch').mockResolvedValue(response);
    await expect(githubApi('test-token', 'o', 'r', 5).listReviews()).rejects.toThrow(); jest.restoreAllMocks();
  }
});
it.each(['reviews', 'files'] as const)('normalizes reordered pagination queries for %s', async resource => {
  const root = `https://api.github.com/repos/o/r/pulls/5/${resource}`;
  const fetcher = jest.spyOn(global, 'fetch')
    .mockResolvedValueOnce(reply([], `<${root}?page=2&per_page=100>; rel="next"`))
    .mockResolvedValueOnce(reply([], `<${root}?per_page=100&page=2#ignored>; rel="next"`))
    .mockRejectedValue(new Error('unexpected third request'));
  const api = githubApi('test-token', 'o', 'r', 5);
  await expect(resource === 'reviews' ? api.listReviews() : api.listFiles()).rejects.toThrow('Unsafe or cyclic GitHub pagination');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each(['reviews', 'files'] as const)('fails closed rather than returning partial %s after 100 pages', async resource => {
  let page = 0;
  const fetcher = jest.spyOn(global, 'fetch').mockImplementation(async () => {
    if (++page > 100) throw new Error('unexpected request beyond cap');
    return reply([], `<https://api.github.com/repos/o/r/pulls/5/${resource}?page=${page + 1}>; rel="next"`);
  });
  const api = githubApi('test-token', 'o', 'r', 5);
  await expect(resource === 'reviews' ? api.listReviews() : api.listFiles()).rejects.toThrow('GitHub pagination exceeds 100 pages');
  expect(fetcher).toHaveBeenCalledTimes(100);
});
it.each(['reviews', 'files'] as const)('accepts a terminal 100th page for %s', async resource => {
  let page = 0;
  jest.spyOn(global, 'fetch').mockImplementation(async () => {
    ++page;
    return reply([], page === 100 ? undefined : `<https://api.github.com/repos/o/r/pulls/5/${resource}?page=${page + 1}>; rel="next"`);
  });
  const api = githubApi('test-token', 'o', 'r', 5);
  await expect(resource === 'reviews' ? api.listReviews() : api.listFiles()).resolves.toEqual([]);
  expect(page).toBe(100);
});
it('publishes the named context only to the requested head', async () => {
  const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(reply({}));
  await publishStatus('test-token', 'o', 'r', 'abc', 'success', 'valid draft');
  expect(String(fetcher.mock.calls[0][0])).toBe('https://api.github.com/repos/o/r/statuses/abc');
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ state: 'success', context: 'blueprint-verify', description: 'valid draft' });
});
