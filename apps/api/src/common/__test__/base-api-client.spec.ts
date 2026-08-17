import { HttpService } from '@nestjs/axios';
import { HttpException, HttpStatus } from '@nestjs/common';
import { AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { of } from 'rxjs';
import { LoggerService } from 'src/logger/logger.service';
import { afterEach, describe, expect, it, Mock, vi } from 'vitest';
import { z } from 'zod';
import { BaseApiClient } from '../base-api-client';

const BodySchema = z.object({ ok: z.boolean() });

class TestApiClient extends BaseApiClient {
  constructor(
    protected readonly httpService: HttpService,
    logger: LoggerService,
  ) {
    super(logger);
    this.baseUrl = 'https://upstream.test';
    this.headers = { 'Content-Type': 'application/json' };
  }

  call(method: string, retryNonIdempotent?: boolean) {
    return this.request({ method, url: '/thing', schema: BodySchema, retryNonIdempotent });
  }

  static backoff(attempt: number): number {
    return TestApiClient.backoffDelayMs(attempt);
  }
}

function makeLogger(): LoggerService {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    setContext: vi.fn().mockReturnThis(),
  } as unknown as LoggerService;
}

function axiosError(status: number, data: unknown = {}, request: unknown = {}): AxiosError {
  const config = { headers: {} } as InternalAxiosRequestConfig;
  const response: AxiosResponse = {
    status,
    statusText: '',
    data,
    headers: {},
    config,
  };
  return new AxiosError(`HTTP ${status}`, 'ERR_BAD_RESPONSE', config, request, response);
}

function axiosConnectionError(code: string): AxiosError {
  const config = { headers: {} } as InternalAxiosRequestConfig;
  return new AxiosError(code, code, config, {});
}

const okResponse: AxiosResponse = {
  status: 200,
  statusText: 'OK',
  data: { ok: true },
  headers: {},
  config: { headers: {} } as InternalAxiosRequestConfig,
};

function makeClient(): { client: TestApiClient; request: Mock } {
  const request = vi.fn();
  const httpService = { request } as unknown as HttpService;
  const client = new TestApiClient(httpService, makeLogger());
  return { client, request };
}

describe('BaseApiClient retry policy', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not retry a POST that always 503s', async () => {
    const { client, request } = makeClient();
    request.mockImplementation(() => {
      throw axiosError(503);
    });

    await expect(client.call('POST')).rejects.toBeInstanceOf(HttpException);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('retries a POST when retryNonIdempotent is opted in', async () => {
    const { client, request } = makeClient();
    request.mockImplementationOnce(() => {
      throw axiosError(503);
    });
    request.mockImplementationOnce(() => of(okResponse));

    await expect(client.call('POST', true)).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not retry a PATCH that always 503s', async () => {
    const { client, request } = makeClient();
    request.mockImplementation(() => {
      throw axiosError(503);
    });

    await expect(client.call('PATCH')).rejects.toBeInstanceOf(HttpException);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('retries a GET on a connection-reset error', async () => {
    const { client, request } = makeClient();
    request.mockImplementationOnce(() => {
      throw axiosConnectionError('ECONNRESET');
    });
    request.mockImplementationOnce(() => of(okResponse));

    await expect(client.call('GET')).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('retries a GET on a transient 503', async () => {
    const { client, request } = makeClient();
    request.mockImplementationOnce(() => {
      throw axiosError(503);
    });
    request.mockImplementationOnce(() => of(okResponse));

    await expect(client.call('GET')).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not retry a GET on a non-transient 400', async () => {
    const { client, request } = makeClient();
    request.mockImplementation(() => {
      throw axiosError(400);
    });

    await expect(client.call('GET')).rejects.toBeInstanceOf(HttpException);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('clamps exponential backoff at the MAX_BACKOFF_MS ceiling', () => {
    expect(TestApiClient.backoff(1)).toBe(1000);
    expect(TestApiClient.backoff(4)).toBe(8000);
    expect(TestApiClient.backoff(6)).toBe(30000);
    expect(TestApiClient.backoff(10)).toBe(30000);
  });

  it('caps at MAX_RETRIES attempts with exponential backoff delays', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const { client, request } = makeClient();
    request.mockImplementation(() => {
      throw axiosError(503);
    });

    const pending = client.call('GET');
    const assertion = expect(pending).rejects.toBeInstanceOf(HttpException);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    expect(request).toHaveBeenCalledTimes(5);
    const delays = setTimeoutSpy.mock.calls.map((args) => args[1]);
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });
});

describe('BaseApiClient upstream errors', () => {
  it('includes the client name and upstream status for a non-404 response', async () => {
    const { client, request } = makeClient();
    request.mockImplementation(() => {
      throw axiosError(HttpStatus.BAD_REQUEST);
    });

    await expect(client.call('GET')).rejects.toMatchObject({
      message: 'TestApiClient request failed with status 400',
      status: HttpStatus.BAD_REQUEST,
    });
  });

  it('does not include the upstream body for a non-404 response', async () => {
    const { client, request } = makeClient();
    request.mockImplementation(() => {
      throw axiosError(HttpStatus.BAD_REQUEST, { secret: 'upstream body' });
    });

    const error = await client.call('GET').catch((error: unknown) => error);

    expect(error).toBeInstanceOf(HttpException);
    expect(JSON.stringify(error)).not.toContain('upstream body');
  });

  it('does not include the Axios request as the cause for a non-404 response', async () => {
    const { client, request } = makeClient();
    request.mockImplementation(() => {
      throw axiosError(HttpStatus.BAD_REQUEST, {}, { secret: 'request details' });
    });

    await expect(client.call('GET')).rejects.not.toHaveProperty('cause');
  });

  it('keeps the generic message for a 404 response', async () => {
    const { client, request } = makeClient();
    request.mockImplementation(() => {
      throw axiosError(HttpStatus.NOT_FOUND, { secret: 'upstream body' });
    });

    await expect(client.call('GET')).rejects.toMatchObject({
      message: 'Requested resource not found in external service',
      status: HttpStatus.NOT_FOUND,
    });
  });

  it('keeps the generic message when no upstream response exists', async () => {
    const { client, request } = makeClient();
    request.mockImplementation(() => {
      throw axiosConnectionError('ECONNREFUSED');
    });

    await expect(client.call('GET')).rejects.toMatchObject({
      message: 'Unable to fetch data from external service',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
    });
  });
});
