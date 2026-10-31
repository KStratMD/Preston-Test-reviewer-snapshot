import express from 'express';
import request from 'supertest';
import { createFileUploadRouter } from '../../../../src/routes/fileUpload';

describe('File upload with real Multer multipart parsing', () => {
  const app = express();
  app.use(createFileUploadRouter());

  it('validates a CSV upload through the route', async () => {
    const response = await request(app)
      .post('/api/file-upload/field-mappings/import')
      .field('validateOnly', 'true')
      .attach('file', Buffer.from('sourceField,targetField\nfirstName,first_name\n'), {
        filename: 'mappings.csv',
        contentType: 'text/csv',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, valid: true });
  });

  it('rejects an unsupported multipart file type', async () => {
    const response = await request(app)
      .post('/api/file-upload/field-mappings/import')
      .attach('file', Buffer.from('{}'), {
        filename: 'mappings.json',
        contentType: 'application/json',
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('UNSUPPORTED_FILE_TYPE');
  });

  it('rejects an oversized multipart CSV', async () => {
    const response = await request(app)
      .post('/api/file-upload/field-mappings/import')
      .attach('file', Buffer.alloc(5 * 1024 * 1024 + 1), {
        filename: 'large.csv',
        contentType: 'text/csv',
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('FILE_TOO_LARGE');
  });
});
