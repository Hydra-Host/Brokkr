import { registerChrootOps } from './chroot';
import { registerPowerCycleCleaner } from './cleanup';
import { registerCloudInitWriter } from './cloudinit';
import { registerDeployOS } from './deployOS';
import { registerEfiFinalizer } from './efi';
import { registerFstabWriters } from './fstab';
import { registerGrubInstaller } from './grub';
import { registerHttpsLayerOp } from './https';
import { registerLuksScriptInstaller } from './luks';
import { registerMdadmConfigurer } from './mdadm';
import { registerRoceChrootConfigurer } from './roce';
import { registerWhiteoutRemover } from './whiteout';

export function registerDeployOperations(): void {
  registerChrootOps();
  registerHttpsLayerOp();
  registerWhiteoutRemover();
  registerMdadmConfigurer();
  registerFstabWriters();
  registerLuksScriptInstaller();
  registerGrubInstaller();
  registerCloudInitWriter();
  registerEfiFinalizer();
  registerRoceChrootConfigurer();
  registerPowerCycleCleaner();

  registerDeployOS();
}
