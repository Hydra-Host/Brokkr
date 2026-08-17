import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BaseApiClient } from 'src/common/base-api-client';
import { LoggingMiddleware } from 'src/common/logging-middleware';
import { HttpExceptionFilter } from './errors/http-exception.filter';
import { ThrottlerExceptionFilter } from './errors/throttler-exception.filter';
import { ValidationException } from './errors/validation-exception.error';

@Module({
  imports: [HttpModule, ConfigModule],
  providers: [BaseApiClient, LoggingMiddleware, HttpExceptionFilter, ValidationException, ThrottlerExceptionFilter],
  exports: [
    BaseApiClient,
    LoggingMiddleware,
    HttpModule,
    ConfigModule,
    HttpExceptionFilter,
    ValidationException,
    ThrottlerExceptionFilter,
  ],
})
export class CommonModule {}
