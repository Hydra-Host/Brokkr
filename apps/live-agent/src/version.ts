declare const __AGENT_VERSION__: string | undefined;

export const AGENT_VERSION: string = typeof __AGENT_VERSION__ !== 'undefined' ? __AGENT_VERSION__ : '0.0.0-dev';
