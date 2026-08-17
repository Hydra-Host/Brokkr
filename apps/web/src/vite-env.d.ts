/// <reference types="vite/client" />

interface ImportMetaEnv {
  // 'true' only in the local sim (set by devenv/modules/hub.nix per-process env); gates the MFA-enrollment skip.
  readonly VITE_LOCAL_SIMULATION_ENABLED: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.css' {
  const content: string;
  export default content;
}
