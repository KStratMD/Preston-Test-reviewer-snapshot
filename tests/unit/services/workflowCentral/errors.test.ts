import {
  WorkflowInstanceMissingError,
  WorkflowDefinitionMissingError,
  InvalidStateTransitionError,
  InstancePausedError,
  InvalidActionError,
  NotFoundError,
  AlreadyDispositionedError,
  RaceLostError,
} from '../../../../src/services/workflowCentral/errors';

describe('workflowCentral typed errors', () => {
  it('WorkflowInstanceMissingError has code workflow_instance_missing', () => {
    const e = new WorkflowInstanceMissingError('tnt_a', 'I1');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('workflow_instance_missing');
    expect(e.tenantId).toBe('tnt_a');
    expect(e.instanceId).toBe('I1');
  });

  it('WorkflowDefinitionMissingError has code workflow_definition_missing', () => {
    const e = new WorkflowDefinitionMissingError('WF1');
    expect(e.code).toBe('workflow_definition_missing');
    expect(e.workflowId).toBe('WF1');
  });

  it('InvalidStateTransitionError carries from/to/required', () => {
    const e = new InvalidStateTransitionError('tnt_a', 'I1', 'completed', 'pause', ['running', 'waiting']);
    expect(e.code).toBe('invalid_state_transition');
    expect(e.currentStatus).toBe('completed');
    expect(e.attempted).toBe('pause');
    expect(e.validSources).toEqual(['running', 'waiting']);
  });

  it('InstancePausedError has code instance_paused', () => {
    const e = new InstancePausedError('tnt_a', 'I1');
    expect(e.code).toBe('instance_paused');
  });

  it('InvalidActionError carries actionId and validActionIds (spec §3.2 step 3a)', () => {
    const e = new InvalidActionError('xyz', ['approve', 'reject']);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('invalid_action');
    expect(e.actionId).toBe('xyz');
    expect(e.validActionIds).toEqual(['approve', 'reject']);
    expect(e.message).toContain('xyz');
    expect(e.message).toContain('approve');
  });

  it('NotFoundError has code not_found', () => {
    const e = new NotFoundError('resource not found');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('not_found');
  });

  it('AlreadyDispositionedError has code already_dispositioned', () => {
    const e = new AlreadyDispositionedError('task already completed');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('already_dispositioned');
  });

  it('All errors are instanceof Error', () => {
    expect(new WorkflowInstanceMissingError('t', 'i')).toBeInstanceOf(Error);
    expect(new WorkflowDefinitionMissingError('w')).toBeInstanceOf(Error);
    expect(new InvalidStateTransitionError('t', 'i', 'completed', 'pause', [])).toBeInstanceOf(Error);
    expect(new InstancePausedError('t', 'i')).toBeInstanceOf(Error);
    expect(new InvalidActionError('a', [])).toBeInstanceOf(Error);
    expect(new NotFoundError('msg')).toBeInstanceOf(Error);
    expect(new AlreadyDispositionedError('msg')).toBeInstanceOf(Error);
  });

  it('Errors carry stack traces', () => {
    const e = new WorkflowInstanceMissingError('t', 'i');
    expect(e.stack).toBeDefined();
  });

  it('err.name is the class name (audit error_class column relies on err.constructor.name)', () => {
    expect(new WorkflowInstanceMissingError('t', 'i').name).toBe('WorkflowInstanceMissingError');
    expect(new InvalidActionError('a', []).name).toBe('InvalidActionError');
  });

  it('RaceLostError re-export from errors.ts resolves (smoke test for D25 colocation)', () => {
    expect(typeof RaceLostError).toBe('function');
  });
});
