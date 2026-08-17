import { registerCurtinApplier } from './curtin';
import { registerDiskDiscoverer } from './discover';
import { registerGptClearer } from './gpt';
import { registerPrepareStorage } from './prepareStorage';
import { registerPreservedDetector } from './preserved';
import { registerRaidDetector } from './raid';
import { registerDiskResolver } from './resolve';
import { registerHolderTeardown } from './teardownHolders';
import { registerUefiDetector } from './uefi';
import { registerUnmounter } from './unmount';
import { registerValidateWipe, registerWriteValidationMarkers } from './validateWipe';
import { registerRaidArrayDetector, registerVgDetector } from './vg';
import { registerDiskWiper } from './wipe';
import { registerWipeDisks } from './wipeDisks';

export function registerStorageOperations(): void {
  registerUefiDetector();
  registerVgDetector();
  registerRaidArrayDetector();
  registerGptClearer();
  registerUnmounter();
  registerDiskDiscoverer();
  registerDiskResolver();
  registerRaidDetector();
  registerPreservedDetector();
  registerDiskWiper();
  registerWriteValidationMarkers();
  registerValidateWipe();
  registerHolderTeardown();
  registerCurtinApplier();

  registerWipeDisks();
  registerPrepareStorage();
}
