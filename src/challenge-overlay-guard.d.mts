export interface GameplayGuardContext {
  frameSource: unknown;
  expectedOrigin: string;
  phase: string;
  solveStarted: boolean;
  revoked: boolean;
}

export declare function gameplayMessageAccepted(
  event: { source?: unknown; origin?: string },
  ctx: GameplayGuardContext,
): boolean;
