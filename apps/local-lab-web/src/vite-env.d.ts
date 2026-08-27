/// <reference types="vite/client" />

interface ImportMetaEnv {
  // the stack's LAB_API_TOKEN, exported only under lan.expose (devenv.nix processes.lab-web); absent otherwise.
  readonly VITE_LAB_API_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
