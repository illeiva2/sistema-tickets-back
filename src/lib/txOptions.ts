// Presupuesto de las transacciones interactivas Serializable del módulo IT.
// El default de Prisma (timeout 5s, maxWait 2s) queda corto cuando la API corre
// lejos de la base (Render us-west <-> Neon sa-east-1): flujos como el alta de
// activo desde un agente hacen ~14 round-trips y exceden los 5s de presupuesto.
export const SERIALIZABLE_TX_OPTIONS = {
  maxWait: 5_000,
  timeout: 15_000,
} as const;
