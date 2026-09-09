import {
  PayloadRefError,
  PayloadRefRecordNotFoundError,
  PayloadRefConnectorUnavailableError,
  PayloadRefAuthExpiredError,
  PayloadRefForbiddenError,
  PayloadRefSystemUnknownError,
  PayloadRefSchemaInvalidError,
  EphemeralPayloadExpiredError,
  EphemeralPayloadNotAllowedError,
} from '../../../../../src/services/workflowCentral/payload/errors';

describe('WorkflowPayload errors', () => {
  it.each([
    [PayloadRefRecordNotFoundError, 404, 'PAYLOAD_REF_RECORD_NOT_FOUND'],
    [PayloadRefConnectorUnavailableError, 503, 'PAYLOAD_REF_CONNECTOR_UNAVAILABLE'],
    [PayloadRefAuthExpiredError, 401, 'PAYLOAD_REF_AUTH_EXPIRED'],
    [PayloadRefForbiddenError, 403, 'PAYLOAD_REF_FORBIDDEN'],
    [PayloadRefSystemUnknownError, 400, 'PAYLOAD_REF_SYSTEM_UNKNOWN'],
    [PayloadRefSchemaInvalidError, 400, 'PAYLOAD_REF_SCHEMA_INVALID'],
    [EphemeralPayloadExpiredError, 410, 'EPHEMERAL_PAYLOAD_EXPIRED'],
    [EphemeralPayloadNotAllowedError, 403, 'EPHEMERAL_PAYLOAD_NOT_ALLOWED'],
  ] as const)('%p has statusCode %i and code %s', (ErrCls, expectedStatus, expectedCode) => {
    const err = new ErrCls('test message');
    expect(err.statusCode).toBe(expectedStatus);
    expect(err.code).toBe(expectedCode);
    expect(err.message).toBe('test message');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PayloadRefError);
    expect(err.name).toBe(ErrCls.name);
  });

  it('preserves the context object when provided', () => {
    const err = new PayloadRefRecordNotFoundError('not found', { system: 'netsuite', recordId: '12345' });
    expect(err.context).toEqual({ system: 'netsuite', recordId: '12345' });
  });

  it('context is optional', () => {
    const err = new PayloadRefRecordNotFoundError('not found');
    expect(err.context).toBeUndefined();
  });

  it('typed errors discriminate via instanceof — each class is its own concrete type', () => {
    const notFound = new PayloadRefRecordNotFoundError('x');
    const unavailable = new PayloadRefConnectorUnavailableError('x');
    expect(notFound).toBeInstanceOf(PayloadRefRecordNotFoundError);
    expect(notFound).not.toBeInstanceOf(PayloadRefConnectorUnavailableError);
    expect(unavailable).toBeInstanceOf(PayloadRefConnectorUnavailableError);
    expect(unavailable).not.toBeInstanceOf(PayloadRefRecordNotFoundError);
  });
});
