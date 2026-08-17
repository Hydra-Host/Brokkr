// GRPC_VERBOSITY=ERROR suppresses grpc C-core INFO lines that pollute captured ipmitool stderr; must be set BEFORE any grpc-js import.

export function envSetDefault(name: string, value: string): void {
  if (!Object.prototype.hasOwnProperty.call(process.env, name)) {
    process.env[name] = value;
  }
}

export function applyEnvPreboot(): void {
  envSetDefault('GRPC_VERBOSITY', 'ERROR');
}
