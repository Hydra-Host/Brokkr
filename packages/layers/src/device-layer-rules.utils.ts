import { LAYER_SLUGS } from './layer-catalog';

const MISC_LAYERS = Object.values(LAYER_SLUGS.misc);
const ALL_DRIVERS = Object.values(LAYER_SLUGS.drivers);
const ALL_CUDA = Object.values(LAYER_SLUGS.cuda);
const ALL_PYTORCH = Object.values(LAYER_SLUGS.pytorch);

const TEE_GPU_PATTERN = /\b(h100|h200|b200|b300)\b/i;
const TEE_GPU_RTX_PRO_SERVER = /rtx\s+pro\s+6000\s+blackwell\s+server\s+edition/i;

const UNIVERSAL_GPU_TAGS = [
  'h100',
  'h200',
  'gh200',
  'a100',
  'a30',
  'l40s',
  'rtx 6000 ada',
  'rtx a6000',
  'rtx 3080',
  'rtx 3090',
  'rtx 4090',
  'rtx 5090',
  'quadro rtx 8000',
];

export function hardwareEligibleLayerSlugs(gpuModel: string | null, teeCapable: boolean): string[] {
  return [...baseSlugs(gpuModel), ...teeSetupSlugs(gpuModel, teeCapable)];
}

function baseSlugs(gpuModel: string | null): string[] {
  if (!gpuModel) {
    return [LAYER_SLUGS.misc.MELLANOX_OFED, LAYER_SLUGS.misc.DOCKER];
  }

  const cat = gpuModel.toLowerCase();

  if (cat.includes('b300')) {
    return [
      LAYER_SLUGS.drivers.NVIDIA_580,
      LAYER_SLUGS.drivers.NVIDIA_595,
      LAYER_SLUGS.cuda.V13_0,
      LAYER_SLUGS.cuda.V13_1,
      LAYER_SLUGS.pytorch.CU130,
      ...MISC_LAYERS,
    ];
  }

  if (cat.includes('b200')) {
    return [
      LAYER_SLUGS.drivers.NVIDIA_580,
      LAYER_SLUGS.drivers.NVIDIA_595,
      LAYER_SLUGS.cuda.V12_6,
      LAYER_SLUGS.cuda.V13_0,
      LAYER_SLUGS.cuda.V13_1,
      LAYER_SLUGS.pytorch.CU126,
      LAYER_SLUGS.pytorch.CU130,
      ...MISC_LAYERS,
    ];
  }

  if (cat.includes('rtx pro 6000 blackwell')) {
    return [
      LAYER_SLUGS.drivers.NVIDIA_580,
      LAYER_SLUGS.drivers.NVIDIA_595,
      LAYER_SLUGS.cuda.V13_0,
      LAYER_SLUGS.cuda.V13_1,
      LAYER_SLUGS.pytorch.CU130,
      ...MISC_LAYERS,
    ];
  }

  if (UNIVERSAL_GPU_TAGS.some((tag) => cat.includes(tag))) {
    return [...ALL_DRIVERS, ...ALL_CUDA, ...ALL_PYTORCH, ...MISC_LAYERS];
  }

  return [];
}

function teeSetupSlugs(gpuModel: string | null, teeCapable: boolean): string[] {
  if (!teeCapable) return [];
  if (!gpuModel) return [];
  if (!TEE_GPU_PATTERN.test(gpuModel) && !TEE_GPU_RTX_PRO_SERVER.test(gpuModel)) return [];
  return [LAYER_SLUGS.tee.TEE_SETUP];
}
