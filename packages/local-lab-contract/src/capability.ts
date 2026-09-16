/** What a lab route demands of the caller's token. Ordered: each capability implies the ones before it. */
export const LAB_CAPABILITIES = ['read', 'operate', 'admin', 'host-exec'] as const;

export type LabCapability = (typeof LAB_CAPABILITIES)[number];

/** The refusal both sides agree on: the lab composes it, the browser matches it to know a second
 *  token would help. Declared here so rewording it cannot silently strand the client. */
export function capabilityRefusalMessage(capability: LabCapability): string {
  return `this lab route requires the '${capability}' capability: present a token that carries it`;
}

/** Whether a refusal body names this capability, so the caller can prompt instead of showing a 403. */
export function isCapabilityRefusal(message: string, capability: LabCapability): boolean {
  return message.includes(capabilityRefusalMessage(capability));
}
