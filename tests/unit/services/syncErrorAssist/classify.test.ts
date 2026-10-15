import { classify } from '../../../../src/services/syncErrorAssist/classify';
import { SyncErrorAssistTimeoutError } from '../../../../src/services/syncErrorAssist/errors';
import { GovernanceBlockedError, PendingApprovalError } from '../../../../src/services/governance/OutboundGovernanceErrors';
import { AppError, ServiceUnavailableAppError } from '../../../../src/errors/AppError';

class TestAppError extends AppError {
  constructor(message: string, statusCode: number) {
    super(message, statusCode, 'TEST');
  }
}

describe('classify', () => {
  it('SyncErrorAssistTimeoutError → failed_retryable when attempts < 3', () => {
    const err = new SyncErrorAssistTimeoutError('AI call', 5000);
    expect(classify(err, 1)).toBe('failed_retryable');
    expect(classify(err, 2)).toBe('failed_retryable');
  });

  it('SyncErrorAssistTimeoutError → failed_non_retryable when attempts >= 3', () => {
    const err = new SyncErrorAssistTimeoutError('AI call', 5000);
    expect(classify(err, 3)).toBe('failed_non_retryable');
  });

  it('SyncErrorAssistTimeoutError with operation="NetSuite create" → failed_non_retryable regardless of attempts', () => {
    const err = new SyncErrorAssistTimeoutError('NetSuite create', 300000);
    expect(classify(err, 1)).toBe('failed_non_retryable');
    expect(classify(err, 2)).toBe('failed_non_retryable');
    expect(classify(err, 3)).toBe('failed_non_retryable');
  });

  it('GovernanceBlockedError → failed_non_retryable', () => {
    const err = new GovernanceBlockedError({} as any);
    expect(classify(err, 1)).toBe('failed_non_retryable');
  });

  it('PendingApprovalError → failed_non_retryable', () => {
    const err = new PendingApprovalError({} as any);
    expect(classify(err, 1)).toBe('failed_non_retryable');
  });

  it('ServiceUnavailableAppError → failed_retryable until exhausted', () => {
    const err = new ServiceUnavailableAppError('NS down');
    expect(classify(err, 1)).toBe('failed_retryable');
    expect(classify(err, 3)).toBe('failed_non_retryable');
  });

  it('AppError 5xx → failed_retryable until exhausted', () => {
    const err = new TestAppError('NS 502', 502);
    expect(classify(err, 1)).toBe('failed_retryable');
    expect(classify(err, 3)).toBe('failed_non_retryable');
  });

  it('AppError 429 → failed_retryable until exhausted', () => {
    const err = new TestAppError('rate limit', 429);
    expect(classify(err, 2)).toBe('failed_retryable');
    expect(classify(err, 3)).toBe('failed_non_retryable');
  });

  it('AppError 4xx (other) → failed_non_retryable', () => {
    const err = new TestAppError('Bad Request', 400);
    expect(classify(err, 1)).toBe('failed_non_retryable');
  });

  it('AI parse error in message → failed_non_retryable', () => {
    expect(classify(new Error('AI parse failure: unstructured response'), 1)).toBe('failed_non_retryable');
  });

  it('generic Error → failed_non_retryable', () => {
    expect(classify(new Error('something else'), 1)).toBe('failed_non_retryable');
  });

  it('non-Error value → failed_non_retryable', () => {
    expect(classify('weird', 1)).toBe('failed_non_retryable');
  });
});
