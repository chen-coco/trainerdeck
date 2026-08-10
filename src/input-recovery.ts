export interface InputRecoveryRequest {
  appId: number;
}

export interface InputRecoveryOperation {
  appId: number;
  epoch: number;
}

export type InputRecoveryStatus =
  | "restored"
  | "app-changed"
  | "focus-api-unavailable"
  | "focus-timeout"
  | "focus-rejected"
  | "focus-failed";

export interface InputRecoveryResult {
  status: InputRecoveryStatus;
  detail?: string;
}

export interface InputRecoveryDependencies {
  currentRunningAppId: () => number;
  focusTimeoutMs?: number;
  raiseWindowForGame?: ((appId: number) => Promise<number> | number) | null;
}

const RAISE_GAME_WINDOW_SUCCESS = 2;

function resolveRaiseWindowForGame():
  | ((appId: number) => Promise<number> | number)
  | null {
  type SteamClientGlobals = typeof globalThis & {
    SteamClient?: {
      Apps?: {
        RaiseWindowForGame?: (appId: number) => Promise<number> | number;
      };
    };
  };
  const apps = (globalThis as SteamClientGlobals).SteamClient?.Apps;
  return typeof apps?.RaiseWindowForGame === "function"
    ? (appId) => apps.RaiseWindowForGame!(appId)
    : null;
}

/**
 * Return to the requested running game through Steam's native game-window API.
 *
 * The caller must first mount and paint the full-screen recovery route. That
 * real GamepadUI focus cycle is what refreshes Gamescope/Steam Input; this
 * function deliberately does not mutate Steam's frontend WindowStore.
 */
export async function restoreForegroundControllerInput(
  request: InputRecoveryRequest,
  dependencies: InputRecoveryDependencies,
): Promise<InputRecoveryResult> {
  if (dependencies.currentRunningAppId() !== request.appId) {
    return { status: "app-changed" };
  }
  const raiseWindowForGame = dependencies.raiseWindowForGame === undefined
    ? resolveRaiseWindowForGame()
    : dependencies.raiseWindowForGame;
  if (!raiseWindowForGame) {
    return { status: "focus-api-unavailable" };
  }
  let timeout: number | undefined;
  try {
    const outcome = await Promise.race([
      Promise.resolve(raiseWindowForGame(request.appId)).then((value) => ({
        timedOut: false as const,
        value: Number(value),
      })),
      new Promise<{ timedOut: true }>((resolve) => {
        timeout = globalThis.setTimeout(
          () => resolve({ timedOut: true }),
          dependencies.focusTimeoutMs ?? 3000,
        );
      }),
    ]);
    if (outcome.timedOut) {
      return {
        status: "focus-timeout",
        detail: "Steam RaiseWindowForGame did not complete in time",
      };
    }
    const result = outcome.value;
    return result === RAISE_GAME_WINDOW_SUCCESS
      ? { status: "restored" }
      : {
          status: "focus-rejected",
          detail: `Steam RaiseWindowForGame returned ${result}`,
        };
  } catch (error) {
    return { status: "focus-failed", detail: String(error) };
  } finally {
    if (timeout !== undefined) {
      globalThis.clearTimeout(timeout);
    }
  }
}

export class QamInputRecoveryController {
  private appId: number;
  private closeObserved = false;
  private epoch = 1;
  private inFlight = 0;
  private issued = false;
  private successfulOperation = false;
  private visible: boolean;

  constructor(initialVisible = false, initialAppId = 0) {
    this.visible = initialVisible;
    this.appId = initialAppId;
  }

  reset(appId: number, visible = this.visible): void {
    this.epoch += 1;
    this.appId = appId;
    this.visible = visible;
    this.clearSession();
  }

  cancelCurrentSession(): void {
    this.epoch += 1;
    this.clearSession();
  }

  observeVisibility(
    visible: boolean,
    appId: number,
  ): InputRecoveryRequest | null {
    const wasVisible = this.visible;
    if (this.appId !== appId) {
      this.reset(appId, wasVisible);
    }
    this.visible = visible;

    if (!wasVisible && visible) {
      this.epoch += 1;
      this.clearSession();
      return null;
    }
    if (visible) {
      return null;
    }
    if (wasVisible) {
      this.closeObserved = true;
      return this.takeReadyRequest();
    }
    return null;
  }

  beginOperation(appId: number): InputRecoveryOperation | null {
    if (!this.visible || appId <= 0) {
      return null;
    }
    if (this.appId !== appId) {
      this.reset(appId, this.visible);
    }
    this.inFlight += 1;
    return { appId, epoch: this.epoch };
  }

  finishOperation(
    operation: InputRecoveryOperation | null,
    succeeded: boolean,
  ): InputRecoveryRequest | null {
    if (
      !operation ||
      operation.appId !== this.appId ||
      operation.epoch !== this.epoch
    ) {
      return null;
    }
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (succeeded) {
      this.successfulOperation = true;
    }
    return this.takeReadyRequest();
  }

  private clearSession(): void {
    this.closeObserved = false;
    this.inFlight = 0;
    this.issued = false;
    this.successfulOperation = false;
  }

  private takeReadyRequest(): InputRecoveryRequest | null {
    if (
      !this.closeObserved ||
      !this.successfulOperation ||
      this.inFlight > 0 ||
      this.issued ||
      this.appId <= 0
    ) {
      return null;
    }
    this.issued = true;
    return { appId: this.appId };
  }
}

/** Shared with the global QAM watcher so panel unmounts cannot lose a session. */
export const qamInputRecoveryController = new QamInputRecoveryController();
