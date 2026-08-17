export type XTerminal = import('@xterm/xterm').Terminal;
export type XFitAddon = import('@xterm/addon-fit').FitAddon;

declare global {
  interface Window {
    CheerpX?: {
      Linux: {
        create: (config: CheerpXConfig) => Promise<CheerpXInstance>;
      };
      IDBDevice: {
        create: (name: string) => Promise<CheerpXDevice>;
      };
      OverlayDevice: {
        create: (base: CheerpXDevice, overlay: CheerpXDevice) => Promise<CheerpXDevice>;
      };
      // Disk APIs vary across CheerpX versions: newer builds expose
      // CloudDevice.create, older ones a bare HttpBytesDevice factory.
      CloudDevice?: {
        create: (url: string) => Promise<CheerpXDevice>;
      };
      HttpBytesDevice?: (url: string) => Promise<CheerpXDevice>;
      DataDevice: {
        create: () => Promise<CheerpXDataDevice>;
      };
    };
  }
}

export interface CheerpXConfig {
  mounts: Array<{ type: string; path: string; dev?: CheerpXDevice }>;
  networkInterface?: unknown;
}

export interface CheerpXInstance {
  setConsole: (element: HTMLElement) => void;
  setCustomConsole: (writeFunc: (buf: Uint8Array) => void, cols: number, rows: number) => (keyCode: number) => void;
  run: (executable: string, args: string[], options?: { env?: string[] }) => Promise<{ status: number }>;
}

export type CheerpXDevice = object;

export interface CheerpXDataDevice extends CheerpXDevice {
  writeFile: (path: string, content: string) => Promise<void>;
}

export type LoadingState = 'idle' | 'loading-script' | 'loading-vm' | 'ready' | 'error';

export interface LoadingStep {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'done' | 'error';
}
