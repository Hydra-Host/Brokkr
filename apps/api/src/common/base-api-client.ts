import { HttpService } from '@nestjs/axios';
import { HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sleep } from '@repo/utils';
import { AxiosError, AxiosRequestConfig, RawAxiosRequestHeaders } from 'axios';
import * as qs from 'qs';
import { firstValueFrom } from 'rxjs';
import { LoggerService } from 'src/logger/logger.service';
import { z, ZodError } from 'zod';

@Injectable()
export class BaseApiClient {
  protected baseUrl: string;
  protected headers: RawAxiosRequestHeaders;
  protected params?: AxiosRequestConfig['params'];
  protected readonly httpService: HttpService;
  protected readonly configService: ConfigService;
  constructor(protected readonly logger: LoggerService) {}

  private static readonly REQUEST_TIMEOUT = 15_000;
  private static readonly MAX_RETRIES = 5;
  private static readonly RETRY_BACKOFF_MS = 1_000;
  private static readonly MAX_BACKOFF_MS = 30_000;

  private static readonly NON_IDEMPOTENT_METHODS = new Set(['POST', 'PATCH']);

  private get className(): string {
    return this.constructor.name;
  }

  private isRetryable(error: unknown, method: string | undefined, retryNonIdempotent: boolean): boolean {
    if (!(error instanceof AxiosError)) return false;
    const status = error.response?.status;
    const transient =
      error.code === 'ECONNABORTED' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ECONNRESET' ||
      status === 429 ||
      status === 502 ||
      status === 503 ||
      status === 504;
    if (!transient) return false;
    const normalized = (method ?? 'GET').toUpperCase();
    if (BaseApiClient.NON_IDEMPOTENT_METHODS.has(normalized) && !retryNonIdempotent) return false;
    return true;
  }

  protected static backoffDelayMs(attempt: number): number {
    return Math.min(BaseApiClient.RETRY_BACKOFF_MS * Math.pow(2, attempt - 1), BaseApiClient.MAX_BACKOFF_MS);
  }

  protected async request<T extends z.ZodType<any, any>>(
    config: Pick<AxiosRequestConfig, 'method' | 'url' | 'data' | 'params' | 'headers' | 'httpsAgent'> & {
      schema: T;
      retryNonIdempotent?: boolean;
    },
  ): Promise<z.infer<T>> {
    const { method, url, schema, params, data, headers, httpsAgent, retryNonIdempotent = false } = config;
    const startTime = Date.now();
    this.logger.log(`[REQUEST] {${url}, ${method}} → ${this.baseUrl}`);

    const requestConfig: AxiosRequestConfig = {
      headers: { ...this.headers, ...headers },
      baseURL: this.baseUrl,
      paramsSerializer: (params) => qs.stringify(params, { arrayFormat: 'repeat' }),
      timeout: BaseApiClient.REQUEST_TIMEOUT,
      method,
      url,
      params: { ...this.params, ...params },
      data,
    };

    if (httpsAgent) {
      requestConfig.httpsAgent = httpsAgent;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= BaseApiClient.MAX_RETRIES; attempt++) {
      try {
        const response = await firstValueFrom(this.httpService.request(requestConfig));

        this.logger.debug(
          `[RESPONSE] {${url}, ${method}, ${response.status}} bytes=${JSON.stringify(response.data)?.length ?? 0}`,
        );
        const result = schema.parse(response.data);
        this.logger.log(`Response {${url}, ${method}, ${response.status}} +${Date.now() - startTime}ms`);
        return result;
      } catch (error) {
        lastError = error;
        if (attempt < BaseApiClient.MAX_RETRIES && this.isRetryable(error, method, retryNonIdempotent)) {
          const delay = BaseApiClient.backoffDelayMs(attempt);
          this.logger.warn(
            `Request {${url}, ${method}} failed (attempt ${attempt}/${BaseApiClient.MAX_RETRIES}), retrying in ${delay}ms`,
          );
          await sleep(delay);
          continue;
        }
        break;
      }
    }

    this.logRequestError(lastError);
    return this.returnHttpException(lastError);
  }

  private logRequestError(error: unknown) {
    if (error instanceof ZodError) {
      this.logger.error(`${this.className} response failed Zod validation: \n${this.formatZodErrors(error)}`);
    } else if (error instanceof AxiosError) {
      if (error.response) {
        // never log the raw upstream body — it can carry secrets/PII; surface only status + a known scalar message
        const detail = error.response.data?.error?.message;
        this.logger.error(
          `${this.className} request failed: status=${error.response.status}` +
            (typeof detail === 'string' ? ` message=${detail}` : ''),
        );
      } else {
        this.logger.error(
          `${this.className} request failed: No response received (${error.code ?? 'unknown'}) → ${error.message ?? ''}`,
        );
      }
    } else if (error instanceof Error) {
      this.logger.error(`${this.className} request failed: ${error.message}`);
    } else {
      this.logger.error(`${this.className} request failed: An unknown error occurred`);
    }
  }

  private returnHttpException(error: unknown): never {
    if (error instanceof AxiosError && error.response) {
      if (error.response.status === 404) {
        throw new NotFoundException('Requested resource not found in external service');
      }
      throw new HttpException(
        `${this.className} request failed with status ${error.response.status}`,
        error.response.status,
      );
    }
    throw new HttpException('Unable to fetch data from external service', HttpStatus.INTERNAL_SERVER_ERROR);
  }

  private formatZodErrors(error: ZodError) {
    return error.issues
      .map((issue) => {
        const path = issue.path.join('.');
        let log = `[${path}]: message: ${issue.message}`;
        if (issue.code === 'invalid_type') {
          log += ` expected: ${issue.expected} received: ${issue.received}`;
        }
        return log;
      })
      .join('\n');
  }
}
