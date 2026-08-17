import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation } from '../collector.types';
import { type KernelParamsInput, kernelParamsSchema } from './kernel_params.schema';

@Injectable()
export class KernelParamsHandler implements CollectorHandler<KernelParamsInput> {
  readonly name = 'kernel_params' as const;
  readonly schema = kernelParamsSchema;

  async handle(input: KernelParamsInput): Promise<DeviceMutation> {
    const warnings: string[] = [];
    for (const issue of input.issues_detected) {
      if (typeof issue === 'string') warnings.push(`kernel_params issue: ${issue}`);
      else if (issue && typeof issue === 'object') warnings.push(`kernel_params issue: ${JSON.stringify(issue)}`);
    }

    return {
      serverUpdate: { kernelCmdline: input.current_cmdline },
      warnings: warnings.length ? warnings : undefined,
    };
  }
}
