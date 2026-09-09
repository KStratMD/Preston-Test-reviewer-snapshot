import { AdminDemoModeService, type AdminDemoModeInput } from '../../../../src/services/settings/AdminDemoModeService';

const validInput: AdminDemoModeInput = {
  enabled: true,
  actorUserId: 'admin-1',
  correlationId: 'corr-1',
  ipAddress: '203.0.113.10',
  userAgent: 'test',
};

describe('AdminDemoModeService', () => {
  const events: string[] = [];
  const demoMode = {
    getDemoMode: jest.fn(async () => false),
    setDemoMode: jest.fn(async () => {
      events.push('mutate');
    }),
  };
  const audit = {
    create: jest.fn(async (row: Record<string, unknown>) => {
      events.push(String(row.action));
      return row;
    }),
  };

  beforeEach(() => {
    events.length = 0;
    jest.clearAllMocks();
    demoMode.getDemoMode.mockResolvedValue(false);
    demoMode.setDemoMode.mockImplementation(async () => {
      events.push('mutate');
    });
    audit.create.mockImplementation(async (row: Record<string, unknown>) => {
      events.push(String(row.action));
      return row;
    });
  });

  it('persists an attempt before changing global state and then records success', async () => {
    const service = new AdminDemoModeService(demoMode as never, audit as never);
    await service.setDemoMode(validInput);

    expect(events).toEqual([
      'settings.demo_mode.change_attempt',
      'mutate',
      'settings.demo_mode.change_succeeded',
    ]);
    expect(audit.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tenant_id: 'global',
        user_id: 'admin-1',
        old_values: { enabled: false },
        new_values: { enabled: true },
        result: 'success',
      }),
    );
  });

  it('blocks mutation when attempt auditing fails', async () => {
    audit.create.mockRejectedValueOnce(new Error('audit unavailable'));
    const service = new AdminDemoModeService(demoMode as never, audit as never);
    await expect(service.setDemoMode(validInput)).rejects.toThrow('audit unavailable');
    expect(demoMode.setDemoMode).not.toHaveBeenCalled();
  });

  it('records sanitized failure without copying the thrown message into details', async () => {
    demoMode.setDemoMode.mockRejectedValueOnce(new Error('DB password=secret-value'));
    const service = new AdminDemoModeService(demoMode as never, audit as never);
    await expect(service.setDemoMode(validInput)).rejects.toThrow();
    expect(audit.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'settings.demo_mode.change_failed',
        result: 'failure',
        error_message: 'demo_mode_update_failed',
      }),
    );
    expect(JSON.stringify(audit.create.mock.calls)).not.toContain('secret-value');
  });

  it('passes the verified actor id to the demo-mode service', async () => {
    const service = new AdminDemoModeService(demoMode as never, audit as never);
    await service.setDemoMode(validInput);
    expect(demoMode.setDemoMode).toHaveBeenCalledWith(true, { userId: 'admin-1' });
  });
});
