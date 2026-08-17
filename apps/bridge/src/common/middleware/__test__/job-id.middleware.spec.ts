import { describe, expect, it } from 'vitest';

import { JobIdService } from '../../job-id.service';
import { type JobIdRequest, JobIdMiddleware, extractJobIdFromRequest } from '../job-id.middleware';

function makeRequest(overrides: Partial<JobIdRequest> = {}): JobIdRequest {
  return {
    headers: {},
    query: {},
    body: undefined,
    ...overrides,
  };
}

describe('extractJobIdFromRequest — fallback chain', () => {
  it('header: x-brokkr-job-id wins', () => {
    const req = makeRequest({ headers: { 'x-brokkr-job-id': 'job_123_test' } });
    expect(extractJobIdFromRequest(req)).toBe('job_123_test');
  });

  it('query: ?job_id=...', () => {
    const req = makeRequest({ query: { job_id: 'job_456_query' } });
    expect(extractJobIdFromRequest(req)).toBe('job_456_query');
  });

  it('json body: { job_id: ... }', () => {
    const req = makeRequest({
      headers: { 'content-type': 'application/json' },
      body: { job_id: 'job_789_json' },
    });
    expect(extractJobIdFromRequest(req)).toBe('job_789_json');
  });

  it('json body: null body yields ""', () => {
    const req = makeRequest({
      headers: { 'content-type': 'application/json' },
      body: null,
    });
    expect(extractJobIdFromRequest(req)).toBe('');
  });

  it('json body: +json suffix mimetype also matches', () => {
    const req = makeRequest({
      headers: { 'content-type': 'application/vnd.api+json' },
      body: { job_id: 'job_vnd_json' },
    });
    expect(extractJobIdFromRequest(req)).toBe('job_vnd_json');
  });

  it('form-urlencoded body: object form yields job_id', () => {
    const req = makeRequest({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: { job_id: 'job_101_form' },
    });
    expect(extractJobIdFromRequest(req)).toBe('job_101_form');
  });

  it('multipart/form-data body: object form yields job_id', () => {
    const req = makeRequest({
      headers: { 'content-type': 'multipart/form-data; boundary=something' },
      body: { job_id: 'job_102_multipart' },
    });
    expect(extractJobIdFromRequest(req)).toBe('job_102_multipart');
  });

  it('raw body string: job_id=... extracted', () => {
    const req = makeRequest({
      body: 'name=test&job_id=job_103_raw&other=value',
    });
    expect(extractJobIdFromRequest(req)).toBe('job_103_raw');
  });

  it('raw body string: url-encoded job_id decoded', () => {
    const req = makeRequest({
      body: 'name=test&job_id=job_104_encoded+with+spaces&other=value',
    });
    expect(extractJobIdFromRequest(req)).toBe('job_104_encoded with spaces');
  });

  it('raw body string: no job_id key returns ""', () => {
    const req = makeRequest({ body: 'name=test&other=value' });
    expect(extractJobIdFromRequest(req)).toBe('');
  });

  it('raw body Buffer: utf-8 decoded then parsed', () => {
    const req = makeRequest({
      body: Buffer.from('name=test&job_id=job_buf_raw&other=value', 'utf8'),
    });
    expect(extractJobIdFromRequest(req)).toBe('job_buf_raw');
  });

  it('raw body Buffer: legitimately-encoded U+FFFD bytes are preserved', () => {
    const body = Buffer.concat([
      Buffer.from('name=test&job_id=pre', 'utf8'),
      Buffer.from([0xef, 0xbf, 0xbd]),
      Buffer.from('post&other=value', 'utf8'),
    ]);
    const req = makeRequest({ body });
    expect(extractJobIdFromRequest(req)).toBe('pre�post');
  });

  it('raw body Buffer: invalid utf-8 bytes are dropped without inserting U+FFFD', () => {
    const body = Buffer.concat([
      Buffer.from('name=test&job_id=keep', 'utf8'),
      Buffer.from([0xff]),
      Buffer.from('value&other=v', 'utf8'),
    ]);
    const req = makeRequest({ body });
    expect(extractJobIdFromRequest(req)).toBe('keepvalue');
  });

  it('priority: header > query > json body', () => {
    const req = makeRequest({
      headers: { 'x-brokkr-job-id': 'header_job', 'content-type': 'application/json' },
      query: { job_id: 'query_job' },
      body: { job_id: 'json_job' },
    });
    expect(extractJobIdFromRequest(req)).toBe('header_job');
  });

  it('priority: query wins when header missing', () => {
    const req = makeRequest({
      headers: { 'content-type': 'application/json' },
      query: { job_id: 'query_job' },
      body: { job_id: 'json_job' },
    });
    expect(extractJobIdFromRequest(req)).toBe('query_job');
  });

  it('returns "" when nothing matches', () => {
    expect(extractJobIdFromRequest(makeRequest())).toBe('');
  });

  it('empty header value falls through to next source', () => {
    const req = makeRequest({
      headers: { 'x-brokkr-job-id': '' },
      query: { job_id: 'query_job' },
    });
    expect(extractJobIdFromRequest(req)).toBe('query_job');
  });

  it('json content-type with non-object body returns ""', () => {
    const req = makeRequest({
      headers: { 'content-type': 'application/json' },
      body: 'not-an-object',
    });
    expect(extractJobIdFromRequest(req)).toBe('');
  });

  it('json content-type with object body lacking job_id returns ""', () => {
    const req = makeRequest({
      headers: { 'content-type': 'application/json' },
      body: { other: 'value' },
    });
    expect(extractJobIdFromRequest(req)).toBe('');
  });

  it('json body: numeric job_id stops chain and is coerced to string', () => {
    const req = makeRequest({
      headers: { 'content-type': 'application/json' },
      body: { job_id: 123 },
    });
    expect(extractJobIdFromRequest(req)).toBe('123');
  });

  it('json body: zero job_id is falsy and returns ""', () => {
    const req = makeRequest({
      headers: { 'content-type': 'application/json' },
      body: { job_id: 0 },
    });
    expect(extractJobIdFromRequest(req)).toBe('');
  });
});

describe('JobIdMiddleware.use', () => {
  it('runs next() inside an AsyncLocalStorage frame populated with the extracted job_id', () => {
    const jobIdService = new JobIdService();
    const middleware = new JobIdMiddleware(jobIdService);
    const req: JobIdRequest = { headers: { 'x-brokkr-job-id': 'middleware-job' } };

    let observed = '';
    middleware.use(req, {}, () => {
      observed = jobIdService.current();
    });
    expect(observed).toBe('middleware-job');
  });

  it('frames are scoped to the request: outside the frame the current job-id is empty', () => {
    const jobIdService = new JobIdService();
    const middleware = new JobIdMiddleware(jobIdService);

    middleware.use({ headers: { 'x-brokkr-job-id': 'scoped' } }, {}, () => undefined);
    expect(jobIdService.current()).toBe('');
  });

  it('empty extraction stores "" in the frame', () => {
    const jobIdService = new JobIdService();
    const middleware = new JobIdMiddleware(jobIdService);

    let observed = 'sentinel';
    middleware.use({ headers: {} }, {}, () => {
      observed = jobIdService.current();
    });
    expect(observed).toBe('');
  });
});
