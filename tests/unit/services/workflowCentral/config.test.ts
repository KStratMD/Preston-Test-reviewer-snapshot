describe('workflowCentral config', () => {
  const ORIG_ENV = process.env.WORKFLOW_CENTRAL_RECENT_TERMINAL_HYDRATION_DAYS;
  afterEach(() => {
    if (ORIG_ENV === undefined) delete process.env.WORKFLOW_CENTRAL_RECENT_TERMINAL_HYDRATION_DAYS;
    else process.env.WORKFLOW_CENTRAL_RECENT_TERMINAL_HYDRATION_DAYS = ORIG_ENV;
    jest.resetModules();
  });

  function load() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../../../../src/services/workflowCentral/config');
  }

  it('defaults to 7 when env unset', () => {
    delete process.env.WORKFLOW_CENTRAL_RECENT_TERMINAL_HYDRATION_DAYS;
    jest.resetModules();
    expect(load().recentTerminalHydrationDays).toBe(7);
  });

  it('clamps 0 → 1', () => {
    process.env.WORKFLOW_CENTRAL_RECENT_TERMINAL_HYDRATION_DAYS = '0';
    jest.resetModules();
    expect(load().recentTerminalHydrationDays).toBe(1);
  });

  it('clamps 1000 → 90', () => {
    process.env.WORKFLOW_CENTRAL_RECENT_TERMINAL_HYDRATION_DAYS = '1000';
    jest.resetModules();
    expect(load().recentTerminalHydrationDays).toBe(90);
  });

  it("falls back to default on 'banana'", () => {
    process.env.WORKFLOW_CENTRAL_RECENT_TERMINAL_HYDRATION_DAYS = 'banana';
    jest.resetModules();
    expect(load().recentTerminalHydrationDays).toBe(7);
  });

  it('accepts valid 14', () => {
    process.env.WORKFLOW_CENTRAL_RECENT_TERMINAL_HYDRATION_DAYS = '14';
    jest.resetModules();
    expect(load().recentTerminalHydrationDays).toBe(14);
  });
});
