export const LAYER_SLUGS = {
  drivers: {
    NVIDIA_535: 'nvidia-driver-535',
    NVIDIA_580: 'nvidia-driver-580',
    NVIDIA_595: 'nvidia-driver-595',
  },
  cuda: {
    V11_8: 'cuda-11.8',
    V12_1: 'cuda-12.1',
    V12_2: 'cuda-12.2',
    V12_4: 'cuda-12.4',
    V12_6: 'cuda-12.6',
    V12_8: 'cuda-12.8',
    V13_0: 'cuda-13.0',
    V13_1: 'cuda-13.1',
    V13_2: 'cuda-13.2',
  },
  pytorch: {
    CU118: 'pytorch-cu118',
    CU121: 'pytorch-cu121',
    CU124: 'pytorch-cu124',
    CU126: 'pytorch-cu126',
    CU128: 'pytorch-cu128',
    CU130: 'pytorch-cu130',
  },
  misc: {
    MELLANOX_OFED: 'mellanox-ofed',
    NVIDIA_CONTAINER_TOOLKIT: 'nvidia-container-toolkit',
    DOCKER: 'docker',
  },
  tee: {
    TEE_SETUP: 'tee-setup',
  },
} as const;
