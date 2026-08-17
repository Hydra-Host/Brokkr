const SELF_MODULE = 'bridge.core.logging';

export function getContextName(moduleName: string): string {
  if (moduleName === SELF_MODULE) return 'unknown';

  if (moduleName.includes('routes')) return extractRouteName(moduleName);
  if (moduleName.includes('services')) return extractServiceName(moduleName);
  if (moduleName.includes('startup')) return extractStartupName(moduleName);
  if (moduleName.endsWith('brokkr_bridge_api')) return 'bridge-api';
  if (moduleName.endsWith('main') || moduleName.includes('main')) return 'orchestrator';
  if (moduleName.includes('tftpy') || moduleName.toLowerCase().includes('tftp')) return 'tftp';
  if (moduleName.includes('core')) return extractCoreName(moduleName);

  return 'unknown';
}

export function extractRouteName(moduleName: string): string {
  const parts = moduleName.split('.');
  if (parts.length >= 3 && parts.includes('routes')) {
    return `routes-${parts[parts.length - 1]}`;
  }
  return 'routes';
}

export function extractServiceName(moduleName: string): string {
  const parts = moduleName.split('.');
  const idx = parts.indexOf('services');
  if (idx !== -1 && idx + 1 < parts.length) {
    return `service-${parts[idx + 1]}`;
  }
  return 'service';
}

export function extractStartupName(moduleName: string): string {
  const parts = moduleName.split('.');
  const idx = parts.indexOf('startup');
  if (idx !== -1 && idx + 1 < parts.length) {
    return parts[idx + 1];
  }
  return 'startup';
}

export function extractCoreName(moduleName: string): string {
  const parts = moduleName.split('.');
  const idx = parts.indexOf('core');
  if (idx !== -1 && idx + 1 < parts.length) {
    return `core-${parts[idx + 1]}`;
  }
  return 'core';
}
