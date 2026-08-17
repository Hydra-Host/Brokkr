import type {
  PluginNetplanRenderer,
  PluginRenderNetplanRequest,
  PluginRenderNetplanResult,
} from '@hydrahost/plugin-sdk';
import { Injectable } from '@nestjs/common';
import { NetplanService } from './netplan.service';

@Injectable()
export class HostPluginNetplanRenderer implements PluginNetplanRenderer {
  constructor(private readonly netplanService: NetplanService) {}

  async renderForDevice(input: PluginRenderNetplanRequest): Promise<PluginRenderNetplanResult> {
    return { yaml: await this.netplanService.renderForDevice(input.deviceId, input.phase) };
  }
}
