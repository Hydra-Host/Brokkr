// Process-wide singleton so host/plugin module load order doesn't matter; deliberately a registry, not a lifecycle gate — attach must complete BEFORE bridge provisioning, and gate deferral doesn't compose with billing's `provision.authorize`.

export interface ClusterAttachRequest {
  deploymentId: string;
  deviceId: string;
  organizationId: string;
  zoneId: string;
}

export interface ClusterAttachResult {
  clusterId: string;
}

export interface ClusterDetachRequest {
  deploymentId: string;
  deviceId: string;
  organizationId: string;
}

export interface ClusterNetworkProvider {
  readonly provider: string;
  attach(request: ClusterAttachRequest): Promise<ClusterAttachResult>;
  detach(request: ClusterDetachRequest): Promise<void>;
}

export class ClusterProviderRegistry {
  private static readonly providers = new Map<string, ClusterNetworkProvider>();

  static register(provider: ClusterNetworkProvider): void {
    this.providers.set(provider.provider, provider);
  }

  static resolve(name: string): ClusterNetworkProvider | undefined {
    return this.providers.get(name);
  }

  static list(): ClusterNetworkProvider[] {
    return [...this.providers.values()];
  }

  static reset(): void {
    this.providers.clear();
  }
}
