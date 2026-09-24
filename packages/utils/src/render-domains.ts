export const RENDER_DOMAINS = ['device_record', 'server_token', 'deploy_token', 'netplan', 'device_secret'] as const;

export type RenderDomain = (typeof RENDER_DOMAINS)[number];
