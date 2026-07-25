export interface ModerationPageButton {
  disabled: boolean;
}

export function runModerationPageAction(
  button: ModerationPageButton,
  task: () => Promise<void>,
): Promise<void>;

export interface ModerationRequestGeneration {
  begin(): number;
  capture(): number;
  isCurrent(token: number): boolean;
}

export function createModerationRequestGeneration(): ModerationRequestGeneration;

export function runExclusiveModerationAction(
  buttons: ModerationPageButton[],
  task: () => Promise<void>,
): Promise<boolean>;

export function runKeyedModerationAction(
  inFlight: Set<string>,
  key: string,
  buttons: ModerationPageButton[],
  task: () => Promise<void>,
): Promise<boolean>;
