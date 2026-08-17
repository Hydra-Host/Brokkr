export function isLocalSimulationEnabled(): boolean {
  return import.meta.env.VITE_LOCAL_SIMULATION_ENABLED === 'true';
}
