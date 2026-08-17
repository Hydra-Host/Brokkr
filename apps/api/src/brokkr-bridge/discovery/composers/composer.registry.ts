import { Injectable } from '@nestjs/common';
import type { Composer } from './composer.types';

@Injectable()
export class ComposerRegistry {
  private readonly composers: Composer[] = [];

  register(composer: Composer): void {
    this.composers.push(composer);
  }

  all(): Composer[] {
    return [...this.composers];
  }
}
