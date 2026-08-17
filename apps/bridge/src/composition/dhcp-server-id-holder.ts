type ServerIdGetter = () => string;

let getter: ServerIdGetter | null = null;

export function setDhcpServerIdGetter(value: ServerIdGetter | null): void {
  getter = value;
}

export function clearDhcpServerIdGetter(): void {
  getter = null;
}

export function isDhcpServerIdGetterBound(): boolean {
  return getter !== null;
}

export function getDhcpServerId(): string {
  return getter?.() ?? '';
}

export function resetDhcpServerIdGetterForTests(): void {
  getter = null;
}
