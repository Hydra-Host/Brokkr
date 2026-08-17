import { assertNoControlChars, renderEnv, shellQuote, stripTrailingNewline } from './env';
import luksLockTemplate from './templates/luks-lock.sh.njk';
import luksRekeyTemplate from './templates/luks-rekey.sh.njk';
import luksUnlockTemplate from './templates/luks-unlock.sh.njk';

export interface LuksVolumeRenderInput {
  device: string;
  mapper: string;
  mountpoint: string;
  fsType: string;
  label: string;
  luksUuid?: string;
}

// Templates emit `{{ vol.field }}` unquoted — shellQuote supplies the quoting so operator-supplied metacharacters can't break out and run as root.
function toTemplateVolumes(volumes: readonly LuksVolumeRenderInput[]): readonly {
  device: string;
  mapper: string;
  mountpoint: string;
  fs_type: string;
  label: string;
  luks_uuid: string;
}[] {
  return volumes.map((v, i) => {
    const luksUuid = v.luksUuid ?? '';
    assertNoControlChars(`encrypted volume[${i}].device`, v.device);
    assertNoControlChars(`encrypted volume[${i}].mapper`, v.mapper);
    assertNoControlChars(`encrypted volume[${i}].mountpoint`, v.mountpoint);
    assertNoControlChars(`encrypted volume[${i}].fsType`, v.fsType);
    assertNoControlChars(`encrypted volume[${i}].label`, v.label);
    assertNoControlChars(`encrypted volume[${i}].luksUuid`, luksUuid);
    return {
      device: shellQuote(v.device),
      mapper: shellQuote(v.mapper),
      mountpoint: shellQuote(v.mountpoint),
      fs_type: shellQuote(v.fsType),
      label: shellQuote(v.label),
      luks_uuid: shellQuote(luksUuid),
    };
  });
}

export function renderLuksRekey(input: {
  encryptedVolumes: readonly LuksVolumeRenderInput[];
  alreadyKeyed: boolean;
  preservedLuksUuids?: readonly string[];
}): string {
  const preserved = (input.preservedLuksUuids ?? []).filter((u) => u.length > 0);
  preserved.forEach((u, i) => assertNoControlChars(`preserved luks uuid[${i}]`, u));
  return stripTrailingNewline(
    renderEnv.renderString(luksRekeyTemplate, {
      encrypted_volumes: toTemplateVolumes(input.encryptedVolumes),
      already_keyed: input.alreadyKeyed,
      preserved_luks_uuids: preserved.map((u) => shellQuote(u)),
    }),
  );
}

export function renderLuksUnlock(input: { encryptedVolumes: readonly LuksVolumeRenderInput[] }): string {
  return stripTrailingNewline(
    renderEnv.renderString(luksUnlockTemplate, {
      encrypted_volumes: toTemplateVolumes(input.encryptedVolumes),
    }),
  );
}

export function renderLuksLock(input: { encryptedVolumes: readonly LuksVolumeRenderInput[] }): string {
  return stripTrailingNewline(
    renderEnv.renderString(luksLockTemplate, {
      encrypted_volumes: toTemplateVolumes(input.encryptedVolumes),
    }),
  );
}
