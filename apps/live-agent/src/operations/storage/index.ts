import { registerCurtinApplier } from './curtin';
import { registerDiskDiscoverer } from './discover';
import { registerGptClearer } from './gpt';
import { registerPrepareStorage } from './prepare-storage';
import { registerPreservedDetector } from './preserved';
import { registerRaidDetector } from './raid';
import { registerDiskResolver } from './resolve';
import { registerHolderTeardown } from './teardown-holders';
import { registerUefiDetector } from './uefi';
import { registerUnmounter } from './unmount';
import { registerValidateWipe, registerWriteValidationMarkers } from './validate-wipe';
import { registerRaidArrayDetector, registerVgDetector } from './vg';
import { registerDiskWiper } from './wipe';
import { registerWipeDisks } from './wipe-disks';

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
