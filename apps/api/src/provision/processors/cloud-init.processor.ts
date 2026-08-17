import { BadRequestException, Injectable } from '@nestjs/common';
import { CLOUD_INIT_MAX_BYTES, CloudInitJsonSchema, type CloudInit, type CloudInitJson } from '@repo/api-client';
import * as yaml from 'js-yaml';
import { getErrorMessage } from 'src/common/error-utils';

const CLOUD_INIT_MAX_NODES = 100_000;

@Injectable()
export class CloudInitProcessor {
  parseYaml(yamlString: string): CloudInitJson {
    try {
      // JSON_SCHEMA: null/bool/number/string/map/seq only — blocks !!js/* tags.
      const parsed = yaml.load(yamlString, { schema: yaml.JSON_SCHEMA });
      const result = CloudInitJsonSchema.safeParse(parsed);

      if (!result.success) {
        const errorMessages = result.error.errors.map((e) => e.message).join(', ');
        throw new BadRequestException(`Invalid cloud-init configuration: ${errorMessages}`);
      }

      return result.data;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(`Failed to parse cloud-init YAML: ${getErrorMessage(error)}`);
    }
  }

  encodeToBase64(cloudInit: CloudInitJson): string {
    let nodeCount = 0;
    let approxChars = 0;
    let json: string;
    try {
      json = JSON.stringify(cloudInit, function (this: unknown, key: string, value: unknown) {
        if (++nodeCount > CLOUD_INIT_MAX_NODES) {
          throw new BadRequestException('Cloud-init is too large or too deeply nested');
        }
        approxChars += (Array.isArray(this) ? 0 : key.length) + (typeof value === 'string' ? value.length : 0);
        if (approxChars > CLOUD_INIT_MAX_BYTES) {
          throw new BadRequestException('Cloud-init payload must not exceed 64 KB');
        }
        return value;
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Cloud-init must not contain circular references');
    }
    if (Buffer.byteLength(json) > CLOUD_INIT_MAX_BYTES) {
      throw new BadRequestException('Cloud-init payload must not exceed 64 KB');
    }
    return Buffer.from(json).toString('base64');
  }

  process(input: CloudInit): string | null {
    if (input === null || input === undefined) {
      return null;
    }

    if (typeof input === 'string') {
      if (!input.trim()) return null;
      const parsed = this.parseYaml(input);
      return parsed ? this.encodeToBase64(parsed) : null;
    }

    const result = CloudInitJsonSchema.safeParse(input);
    if (!result.success) {
      const errorMessages = result.error.errors.map((e) => e.message).join(', ');
      throw new BadRequestException(`Invalid cloud-init configuration: ${errorMessages}`);
    }

    return result.data ? this.encodeToBase64(result.data) : null;
  }
}
