import {
  deepEqual,
  headerValue,
  isDigitString,
  isEmptyRecord,
  JsonRecord,
  logger,
  PropertyAccessError,
  RecordTypeError,
  sleep,
} from './base.js';
import { RedfishDiscoveryHandler } from './discovery.js';
// Side-effect: ensure brand VendorProfiles are registered before quirk lookups.
import './register-brands.js';
import { resolveVendorProfile } from './registry.js';

const APP_CLASS = 'adapters-redfish';

export type BiosParamValue = boolean | number | string | readonly string[];

const READ_ONLY_DEPENDENT_MESSAGE =
  'Unable to modify the attribute because the attribute is read-only and depends on other attributes.';

const RETRY_RESOLUTIONS: ReadonlySet<string> = new Set([
  'Wait for the indicated retry duration and retry the operation.',
  'Wait for the data to be available and retry the operation. If the issue persists, contact your service provider.',
  'Wait for the current import or export operation to complete and retry the operation. If the issue persists, contact your service provider.',
  'Resubmit the request.  If the problem persists, consider resetting the service.',
]);

const TRUE_STRINGS = ['t', 'true', '1', 'y', 'yes', 'on'];
const FALSE_STRINGS = ['f', 'false', '0', 'n', 'no', 'off'];

export class RedfishBiosHandler extends RedfishDiscoveryHandler {
  async setBiosParam(key: string, value: BiosParamValue, parentKey: string | null = null): Promise<boolean | null> {
    let newValue: BiosParamValue | null = null;

    if (!this.device.biosPatchEndpoint) {
      logger.error("can't apply new parameters, failed to determine the BIOS endpoint", {
        jobId: this.jobId,
        appClassName: APP_CLASS,
      });
      return null;
    }

    let biosAttr: JsonRecord = {};
    const hasRegistry = !isEmptyRecord(this.device.registry);
    if (hasRegistry) {
      const exact = this.device.registry[key];
      if (exact !== undefined) {
        biosAttr = exact;
      } else {
        const similarKeys = Object.keys(this.device.registry).filter((registryKey) => registryKey.startsWith(key));
        const similarKey = similarKeys[0];
        if (similarKeys.length === 1 && similarKey !== undefined) {
          logger.warning(`bios parameter "${key}" not found in the registry, but found a similar key: ${similarKey}`, {
            jobId: this.jobId,
            appClassName: APP_CLASS,
          });
          biosAttr = this.device.registry[similarKey] ?? {};
        } else {
          logger.error(`bios parameter "${key}" not found in the registry`, {
            jobId: this.jobId,
            appClassName: APP_CLASS,
          });
          return null;
        }
      }

      if (biosAttr['ReadOnly'] || ('Immutable' in biosAttr && biosAttr['Immutable'])) {
        logger.info(`bios parameter "${key}" is read-only`, { jobId: this.jobId, appClassName: APP_CLASS });
        return true;
      }

      const attrType = biosAttr['Type'];
      if (attrType === 'Boolean') {
        if (typeof value === 'string') {
          if (TRUE_STRINGS.includes(value.toLowerCase())) {
            newValue = true;
          } else if (FALSE_STRINGS.includes(value.toLowerCase())) {
            newValue = false;
          }
        } else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isInteger(value))) {
          const numeric = typeof value === 'boolean' ? (value ? 1 : 0) : value;
          newValue = numeric === 1;
          if (!newValue) {
            newValue = numeric === 0;
          }
        }
      } else if (attrType === 'Integer') {
        if (typeof value === 'number' || typeof value === 'boolean') {
          newValue = value;
        } else if (typeof value === 'string' && isDigitString(value)) {
          newValue = Number.parseInt(value, 10);
        }
        if (newValue === null) {
          logger.error(`${value} is not a valid integer`, { jobId: this.jobId, appClassName: APP_CLASS });
          return null;
        }
        if (typeof newValue === 'number' || typeof newValue === 'boolean') {
          const numericValue = typeof newValue === 'boolean' ? (newValue ? 1 : 0) : newValue;
          if (!Number.isInteger(numericValue)) {
            logger.error(`${value} is not a valid integer`, { jobId: this.jobId, appClassName: APP_CLASS });
            return null;
          }
          const lowerBound = biosAttr['LowerBound'] as number;
          if (numericValue < lowerBound) {
            logger.error(`${value} is less than the minimum value of ${lowerBound}`, {
              jobId: this.jobId,
              appClassName: APP_CLASS,
            });
            return null;
          }
          const upperBound = biosAttr['UpperBound'] as number;
          if (numericValue > upperBound) {
            logger.error(`${value} is greater than the maximum value of ${upperBound}`, {
              jobId: this.jobId,
              appClassName: APP_CLASS,
            });
            return null;
          }
          const scalarIncrement = biosAttr['ScalarIncrement'] as number;
          if (scalarIncrement !== 0 && numericValue % scalarIncrement !== 0) {
            logger.error(`${value} is not a multiple of ${scalarIncrement}`, {
              jobId: this.jobId,
              appClassName: APP_CLASS,
            });
            return null;
          }
        }
      } else if (attrType === 'Enumeration') {
        const values = biosAttr['Value'];
        if (!Array.isArray(values)) {
          throw new RecordTypeError(`'${values === null ? 'null' : typeof values}' is not iterable`);
        }
        const permittedValues = resolveVendorProfile(this.device.tag()).normalizeEnumValues(
          values.map((item) => (item as Record<string, unknown>)?.['ValueName']),
          values,
        );
        if (
          !permittedValues.some(
            (permitted) =>
              permitted === value ||
              (typeof permitted === 'boolean' && typeof value === 'number' && (permitted ? 1 : 0) === value) ||
              (typeof value === 'boolean' && typeof permitted === 'number' && (value ? 1 : 0) === permitted),
          )
        ) {
          logger.error(
            `${value} is not a valid value for ${key}, valid values are: ${permittedValues.map((item) => String(item)).join(', ')}`,
            {
              jobId: this.jobId,
              appClassName: APP_CLASS,
            },
          );
          return null;
        }
        newValue = value;
      } else if (attrType === 'String') {
        const valueExpression = biosAttr['ValueExpression'];
        if (valueExpression !== null && valueExpression !== undefined) {
          if (typeof valueExpression !== 'string') {
            throw new PropertyAccessError(`cannot read property 'match' of ${typeof valueExpression}`);
          }
          if (!new RegExp(`^(?:${valueExpression})`).test(String(value))) {
            logger.error(`${value} does not match the value expression for "${key}" (${valueExpression})`, {
              jobId: this.jobId,
              appClassName: APP_CLASS,
            });
            return null;
          }
        }

        const length = String(value).length;
        const maxLength = biosAttr['MaxLength'] as number;
        if (length > maxLength) {
          logger.error(`${value} is too long for "${key}", maximum length is ${maxLength}`, {
            jobId: this.jobId,
            appClassName: APP_CLASS,
          });
          return null;
        }
        const minLength = biosAttr['MinLength'] as number;
        if (length < minLength) {
          logger.error(`${value} is too short for "${key}", minimum length is ${minLength}`, {
            jobId: this.jobId,
            appClassName: APP_CLASS,
          });
          return null;
        }

        newValue = value;
      } else {
        logger.error(`unable to match the new value for "${key}" to a valid type: ${String(attrType)}`, {
          jobId: this.jobId,
          appClassName: APP_CLASS,
        });
        return null;
      }
    } else {
      newValue = value;
    }

    const keyPath = parentKey ? `${parentKey}&&&${key}` : key;

    if (this.extractNestedValue(this.device.biosPendingParams, keyPath, '&&&') !== null) {
      logger.warning(`bios parameter "${key}" is already scheduled to be set to "${value}" at the next reboot`, {
        jobId: this.jobId,
        appClassName: APP_CLASS,
      });
      return true;
    }
    const currentValue = this.extractNestedValue(this.device.biosParams, keyPath, '&&&');
    if (
      currentValue === newValue ||
      (typeof currentValue === 'boolean' && typeof newValue === 'number' && (currentValue ? 1 : 0) === newValue) ||
      (typeof newValue === 'boolean' && typeof currentValue === 'number' && (newValue ? 1 : 0) === currentValue) ||
      deepEqual(currentValue, newValue)
    ) {
      logger.info(`bios parameter "${key}" is already set to "${value}"`, {
        jobId: this.jobId,
        appClassName: APP_CLASS,
      });
      return true;
    }

    const payload: JsonRecord = parentKey
      ? { Attributes: { [parentKey]: { [key]: newValue } } }
      : { Attributes: { [key]: newValue } };

    const patchHeaders: Record<string, string> = {};
    if (resolveVendorProfile(this.device.tag()).requiresEtag) {
      await this.fetch('GET', this.device.biosGetEndpoint, {});
      const etag = headerValue(this.lastResponseHeaders(), 'ETag');
      if (etag) {
        patchHeaders['If-Match'] = etag;
      }
    }

    await this.fetch('PATCH', this.device.biosPatchEndpoint, payload, patchHeaders);
    let messages = this.lastResponseMessages();
    let resolutions = this.lastResponseResolutions();

    if (messages.includes(READ_ONLY_DEPENDENT_MESSAGE)) {
      logger.warning(`bios parameter ${key} could not be modified: ${JSON.stringify(messages)}`, {
        jobId: this.jobId,
        appClassName: APP_CLASS,
      });
      return true;
    }

    let retryAttempt = 0;
    while (
      retryAttempt < this.device.biosRetryAttempts &&
      resolutions.some((resolution) => typeof resolution === 'string' && RETRY_RESOLUTIONS.has(resolution))
    ) {
      retryAttempt += 1;
      // Upstream bug-for-bug: the dynamic-pause-duration extract always raised, so 15 is the effective value.
      const pauseDuration = 15;
      logger.info(`bios is not ready to accept the setting, retrying ${key} after ${pauseDuration} seconds`, {
        jobId: this.jobId,
        appClassName: APP_CLASS,
      });
      await sleep(pauseDuration * 1000);
      await this.fetch('PATCH', this.device.biosPatchEndpoint, payload, patchHeaders);
      resolutions = this.lastResponseResolutions();
    }

    messages = this.lastResponseMessages();

    if (messages.length === 0) {
      return null;
    }
    const firstMessage = messages[0];
    if (typeof firstMessage !== 'string') {
      throw new PropertyAccessError(`cannot read property 'toLowerCase' of ${typeof firstMessage}`);
    }
    const message = firstMessage.toLowerCase();

    if (message.includes('successfully completed') || message.includes('completed successfully')) {
      logger.warning(`bios parameter ${key} has been set to "${newValue}"`, {
        jobId: this.jobId,
        appClassName: APP_CLASS,
      });
      if (hasRegistry) {
        if (biosAttr['ResetRequired']) {
          logger.info(`bios parameter ${key} is set to "${newValue}" but requires a reset to take effect`, {
            jobId: this.jobId,
            appClassName: APP_CLASS,
          });
          this.device.rebootNeeded = true;

          if (parentKey) {
            if (!(parentKey in this.device.biosPendingParams)) {
              this.device.biosPendingParams[parentKey] = {};
            }
            (this.device.biosPendingParams[parentKey] as JsonRecord)[key] = newValue as never;
          } else {
            this.device.biosPendingParams[key] = newValue;
          }
        } else {
          if (parentKey) {
            if (!(parentKey in this.device.biosParams)) {
              this.device.biosParams[parentKey] = {};
            }
            (this.device.biosParams[parentKey] as JsonRecord)[key] = newValue as never;
          } else {
            this.device.biosParams[key] = newValue;
          }
        }
      } else {
        logger.warning('no registry available, requesting a reboot to apply the setting', {
          jobId: this.jobId,
          appClassName: APP_CLASS,
        });
        this.device.rebootNeeded = true;
      }

      return true;
    }

    logger.error(`failed to set bios parameter ${key} to "${newValue}": ${message}`, {
      jobId: this.jobId,
      appClassName: APP_CLASS,
    });
    return null;
  }

  /** @internal Public so brand TEE profiles (vendor/<brand>/) can drive multi-attr apply. */
  async applySequentialBiosSettings(settings: Record<string, number | string>): Promise<boolean> {
    for (const [key, value] of Object.entries(settings)) {
      const settingResult = await this.setBiosParam(key, value);
      if (settingResult === null) {
        logger.error(`failed to set ${key}`, { jobId: this.jobId, appClassName: APP_CLASS });
        return false;
      }
    }

    return true;
  }
}
