interface RuntimeEnv {
  DOCS_URL?: string;
  RADAR_PUBLISHABLE_KEY?: string;
}

declare global {
  interface Window {
    __ENV__?: Readonly<RuntimeEnv>;
  }
}

const runtimeEnv: RuntimeEnv = (typeof window !== 'undefined' && window.__ENV__) || {};

export function getDocsUrl(): string {
  return runtimeEnv.DOCS_URL?.trim() || 'https://brokkr.hydrahost.com/';
}
