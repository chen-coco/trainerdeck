import { routerHook } from "@decky/api";
import {
  DialogButton,
  Focusable,
  getGamepadNavigationTrees,
  NavEntryPositionPreferences,
  Router,
  type WindowRouter,
  useParams,
} from "@decky/ui";
import { useEffect, useRef, useState } from "react";

import {
  type InputRecoveryRequest,
  qamInputRecoveryController,
  restoreForegroundControllerInput,
} from "./input-recovery";
import { currentRunningAppId } from "./steam";

export const INPUT_RECOVERY_ROUTE = "/trainerdeck/input-recovery";
export const INPUT_RECOVERY_ROUTE_PATTERN =
  `${INPUT_RECOVERY_ROUTE}/:token`;
export const INPUT_RECOVERY_WATCHER =
  "TrainerDeckInputRecoveryWatcher";

const ROUTE_MINIMUM_DWELL_MS = 150;
const ROUTE_FOCUS_TIMEOUT_MS = 650;
const ROUTE_PAINT_TIMEOUT_MS = 300;
const ROUTE_MOUNT_TIMEOUT_MS = 5000;
const ROUTE_EXIT_TIMEOUT_MS = 1200;

type TransitionState =
  | "navigating"
  | "mounted"
  | "exiting"
  | "raising"
  | "complete";

interface TransitionTicket {
  cancelled: boolean;
  exitTimer?: number;
  focusConfirmed: boolean;
  mountTimer?: number;
  raiseAfterExit: boolean;
  request: InputRecoveryRequest;
  routeMounted: boolean;
  router: WindowRouter;
  state: TransitionState;
  token: string;
}

interface FocusSignal {
  readonly resolved: boolean;
  promise: Promise<void>;
  resolve(): void;
}

let activeTicket: TransitionTicket | null = null;
let lastQuickAccessVisible: boolean | null = null;
let tokenSequence = 0;

function mainWindowRouter(): WindowRouter | null {
  return Router.WindowStore?.GamepadUIMainWindowInstance ??
    Router.WindowStore?.SteamUIWindows?.[0] ??
    null;
}

function quickAccessWindow(): Window | null {
  try {
    const trees = getGamepadNavigationTrees();
    return trees.find((tree: any) => tree?.id === "QuickAccess-NA")
      ?.m_Root?.m_element?.ownerDocument?.defaultView ?? null;
  } catch {
    return null;
  }
}

/** Retry discovery because Decky global components can mount before QAM does. */
function useReliableQuickAccessVisible(): boolean | null {
  const [visible, setVisible] = useState<boolean | null>(null);

  useEffect(() => {
    let observedWindow: Window | null = null;
    let retryTimer: number | undefined;
    let disposed = false;

    const update = () => {
      if (observedWindow) {
        setVisible(!observedWindow.document.hidden);
      }
    };
    const refresh = () => {
      if (disposed) {
        return;
      }
      const candidate = quickAccessWindow();
      if (candidate !== observedWindow) {
        observedWindow?.document.removeEventListener(
          "visibilitychange",
          update,
        );
        observedWindow = candidate;
        observedWindow?.document.addEventListener(
          "visibilitychange",
          update,
        );
      }
      if (observedWindow) {
        update();
      } else {
        setVisible(null);
      }
      retryTimer = globalThis.setTimeout(refresh, observedWindow ? 1000 : 250);
    };
    refresh();
    return () => {
      disposed = true;
      if (retryTimer !== undefined) {
        globalThis.clearTimeout(retryTimer);
      }
      observedWindow?.document.removeEventListener(
        "visibilitychange",
        update,
      );
    };
  }, []);

  return visible;
}

function createToken(): string {
  tokenSequence += 1;
  return `${Date.now().toString(36)}-${tokenSequence.toString(36)}`;
}

function clearTicketTimers(ticket: TransitionTicket): void {
  if (ticket.mountTimer !== undefined) {
    globalThis.clearTimeout(ticket.mountTimer);
    ticket.mountTimer = undefined;
  }
  if (ticket.exitTimer !== undefined) {
    globalThis.clearTimeout(ticket.exitTimer);
    ticket.exitTimer = undefined;
  }
}

function clearTicket(ticket: TransitionTicket): void {
  clearTicketTimers(ticket);
  ticket.state = "complete";
  ticket.routeMounted = false;
  if (activeTicket === ticket) {
    activeTicket = null;
  }
}

function beginTransitionExit(
  ticket: TransitionTicket,
  raiseAfterExit: boolean,
): boolean {
  if (
    activeTicket !== ticket ||
    ticket.state !== "mounted" ||
    !ticket.routeMounted
  ) {
    return false;
  }
  ticket.raiseAfterExit = raiseAfterExit && !ticket.cancelled;
  ticket.state = "exiting";
  ticket.exitTimer = globalThis.setTimeout(() => {
    if (
      activeTicket !== ticket ||
      ticket.state !== "exiting" ||
      !ticket.routeMounted
    ) {
      return;
    }
    console.warn("TrainerDeck input recovery route did not exit; retrying");
    ticket.exitTimer = globalThis.setTimeout(() => {
      if (
        activeTicket !== ticket ||
        ticket.state !== "exiting" ||
        !ticket.routeMounted
      ) {
        return;
      }
      const shouldRaise = ticket.raiseAfterExit && !ticket.cancelled;
      console.warn(
        "TrainerDeck input recovery route remained mounted after retry",
      );
      if (shouldRaise) {
        // Return the user to the game even if Steam silently ignored both
        // history pops, but do not report this as a confirmed transition.
        ticket.focusConfirmed = false;
        ticket.state = "raising";
        globalThis.setTimeout(() => void finishNativeRaise(ticket), 0);
      } else {
        clearTicket(ticket);
      }
    }, 400);
    try {
      ticket.router.NavigateBack();
    } catch (error) {
      console.warn("TrainerDeck could not retry leaving the recovery route", error);
    }
  }, ROUTE_EXIT_TIMEOUT_MS);
  try {
    // This is the exact main-router instance that pushed this tokenized route.
    ticket.router.NavigateBack();
    return true;
  } catch (error) {
    if (ticket.exitTimer !== undefined) {
      globalThis.clearTimeout(ticket.exitTimer);
      ticket.exitTimer = undefined;
    }
    ticket.state = "mounted";
    ticket.raiseAfterExit = false;
    ticket.cancelled = true;
    console.warn("TrainerDeck could not remove the input recovery route", error);
    return false;
  }
}

async function finishNativeRaise(ticket: TransitionTicket): Promise<void> {
  if (
    activeTicket !== ticket ||
    ticket.state !== "raising" ||
    ticket.cancelled
  ) {
    clearTicket(ticket);
    return;
  }
  const result = await restoreForegroundControllerInput(ticket.request, {
    currentRunningAppId,
  });
  const stillCurrent = activeTicket === ticket && !ticket.cancelled;
  clearTicket(ticket);
  if (!stillCurrent) {
    return;
  }
  if (result.status === "restored" && ticket.focusConfirmed) {
    console.info(
      "TrainerDeck restored game input through a confirmed GamepadUI focus transition",
      ticket.request,
    );
    return;
  }
  if (result.status === "restored") {
    console.warn(
      "TrainerDeck returned to the game, but GamepadUI foreground focus was not confirmed",
      ticket.request,
    );
    return;
  }
  console.warn(
    `TrainerDeck input recovery did not complete: ${result.status}`,
    result.detail ?? "",
  );
}

function routeUnmounted(ticket: TransitionTicket): void {
  ticket.routeMounted = false;
  if (ticket.exitTimer !== undefined) {
    globalThis.clearTimeout(ticket.exitTimer);
    ticket.exitTimer = undefined;
  }
  if (activeTicket !== ticket) {
    return;
  }
  if (ticket.state === "exiting") {
    if (ticket.raiseAfterExit && !ticket.cancelled) {
      ticket.state = "raising";
      // The next macrotask guarantees NavigateBack's React commit/cleanup has
      // completed before Steam is asked to foreground the game.
      globalThis.setTimeout(() => void finishNativeRaise(ticket), 0);
    } else {
      clearTicket(ticket);
    }
    return;
  }
  if (ticket.state === "mounted") {
    // Do not pop again: this unmount was caused by the user's own navigation.
    globalThis.setTimeout(() => {
      if (
        activeTicket === ticket &&
        ticket.state === "mounted" &&
        !ticket.routeMounted
      ) {
        ticket.cancelled = true;
        clearTicket(ticket);
      }
    }, 0);
  }
}

function cancelInputRecoveryTransition(leaveMountedRoute: boolean): void {
  const ticket = activeTicket;
  if (!ticket) {
    return;
  }
  ticket.cancelled = true;
  ticket.raiseAfterExit = false;
  if (leaveMountedRoute && ticket.state === "navigating") {
    // Navigate() has already synchronously pushed this token on the captured
    // main router. Remove that exact top entry even if React has not committed
    // the route component yet, then retire the token before another request.
    try {
      ticket.router.NavigateBack();
    } catch (error) {
      console.warn(
        "TrainerDeck could not cancel the pending input recovery route",
        error,
      );
    }
    clearTicket(ticket);
    return;
  }
  if (
    leaveMountedRoute &&
    ticket.state === "mounted" &&
    ticket.routeMounted
  ) {
    beginTransitionExit(ticket, false);
    return;
  }
  if (ticket.state === "raising") {
    clearTicket(ticket);
  }
}

export function cancelInputRecoverySession(): void {
  qamInputRecoveryController.cancelCurrentSession();
  cancelInputRecoveryTransition(true);
}

export function shutdownInputRecovery(): void {
  qamInputRecoveryController.cancelCurrentSession();
  const ticket = activeTicket;
  if (ticket?.state === "navigating") {
    ticket.cancelled = true;
    try {
      ticket.router.NavigateBack();
    } catch {
      // The route may not have committed yet; unloading removes it regardless.
    }
    clearTicket(ticket);
  } else {
    cancelInputRecoveryTransition(true);
  }
  lastQuickAccessVisible = null;
}

export function requestInputRecoveryTransition(
  request: InputRecoveryRequest,
): void {
  if (
    lastQuickAccessVisible !== false ||
    currentRunningAppId() !== request.appId
  ) {
    return;
  }
  if (activeTicket) {
    console.warn(
      "TrainerDeck ignored a duplicate input recovery request while another token is active",
    );
    return;
  }
  const router = mainWindowRouter();
  if (!router) {
    console.warn(
      "TrainerDeck could not resolve the main GamepadUI router for input recovery",
    );
    return;
  }
  const ticket: TransitionTicket = {
    cancelled: false,
    focusConfirmed: false,
    raiseAfterExit: false,
    request,
    routeMounted: false,
    router,
    state: "navigating",
    token: createToken(),
  };
  activeTicket = ticket;
  ticket.mountTimer = globalThis.setTimeout(() => {
    if (activeTicket === ticket && ticket.state === "navigating") {
      ticket.cancelled = true;
      console.warn("TrainerDeck input recovery route did not mount in time");
      clearTicket(ticket);
    }
  }, ROUTE_MOUNT_TIMEOUT_MS);
  try {
    // The main router is explicit, so no post-QAM delay is needed to guess the
    // focused WindowRouter. Navigating on the close edge preserves the same
    // real focus cycle observed when opening TrainerDeck settings.
    router.Navigate(`${INPUT_RECOVERY_ROUTE}/${ticket.token}`);
  } catch (error) {
    console.warn("TrainerDeck could not open the input recovery route", error);
    clearTicket(ticket);
  }
}

function observeQuickAccessVisibility(visible: boolean): void {
  const reopened = lastQuickAccessVisible === false && visible;
  lastQuickAccessVisible = visible;
  if (reopened) {
    cancelInputRecoveryTransition(true);
  }
  const request = qamInputRecoveryController.observeVisibility(
    visible,
    currentRunningAppId(),
  );
  if (request) {
    requestInputRecoveryTransition(request);
  }
}

/** This stays mounted outside the active plugin panel and survives QAM close. */
export function TrainerDeckInputRecoveryWatcher() {
  const quickAccessVisible = useReliableQuickAccessVisible();

  useEffect(() => {
    if (quickAccessVisible === null) {
      lastQuickAccessVisible = null;
      qamInputRecoveryController.reset(currentRunningAppId(), false);
      return;
    }
    observeQuickAccessVisibility(quickAccessVisible);
  }, [quickAccessVisible]);

  return null;
}

function ticketForToken(token: string): TransitionTicket | null {
  const ticket = activeTicket;
  return ticket?.token === token ? ticket : null;
}

function commitTicket(ticket: TransitionTicket): boolean {
  if (activeTicket !== ticket) {
    return false;
  }
  if (ticket.state === "mounted" && !ticket.routeMounted) {
    // React Strict Effects replays setup after cleanup without constructing a
    // new component. Re-commit the same token before the zero-delay cleanup.
    ticket.routeMounted = true;
    return true;
  }
  if (ticket.state !== "navigating") {
    return false;
  }
  if (ticket.mountTimer !== undefined) {
    globalThis.clearTimeout(ticket.mountTimer);
    ticket.mountTimer = undefined;
  }
  ticket.state = "mounted";
  ticket.routeMounted = true;
  return true;
}

function createFocusSignal(): FocusSignal {
  let resolvePromise: (() => void) | undefined;
  let didResolve = false;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    get resolved() {
      return didResolve;
    },
    promise,
    resolve() {
      if (didResolve) {
        return;
      }
      didResolve = true;
      resolvePromise?.();
    },
  };
}

function wait(view: Window, milliseconds: number): Promise<void> {
  return new Promise((resolve) => view.setTimeout(resolve, milliseconds));
}

function waitForTwoPaints(view: Window): Promise<void> {
  return new Promise((resolve) => {
    view.requestAnimationFrame(() => {
      view.requestAnimationFrame(() => resolve());
    });
  });
}

function documentHasForegroundFocus(view: Window): boolean {
  try {
    return !view.document.hidden && view.document.hasFocus();
  } catch {
    return false;
  }
}

function registerNativeFocusSignal(
  signal: FocusSignal,
  view: Window,
): { unregister(): void } | undefined {
  type SteamClientGlobals = typeof globalThis & {
    SteamClient?: {
      System?: {
        UI?: {
          RegisterForFocusChangeEvents?: (
            callback: () => void,
          ) => { unregister(): void };
        };
      };
    };
  };
  const ui = (globalThis as SteamClientGlobals).SteamClient?.System?.UI;
  if (typeof ui?.RegisterForFocusChangeEvents !== "function") {
    return undefined;
  }
  try {
    return ui.RegisterForFocusChangeEvents(() => {
      if (documentHasForegroundFocus(view)) {
        signal.resolve();
      }
    });
  } catch (error) {
    console.warn("TrainerDeck could not observe native focus changes", error);
    return undefined;
  }
}

export function TrainerDeckInputRecoveryPage() {
  const { token } = useParams<{ token?: string }>();
  const hostRef = useRef<HTMLDivElement>(null);
  const focusSignal = useRef<FocusSignal | null>(null);
  const ticketRef = useRef<TransitionTicket | null>(null);
  if (focusSignal.current === null) {
    focusSignal.current = createFocusSignal();
  }
  if (ticketRef.current === null) {
    // Read-only lookup is safe during render; the commit happens in useEffect.
    ticketRef.current = ticketForToken(String(token ?? ""));
  }
  const ticket = ticketRef.current;

  useEffect(() => {
    if (!ticket || !commitTicket(ticket)) {
      return;
    }
    let disposed = false;
    const signal = focusSignal.current!;
    const view = hostRef.current?.ownerDocument.defaultView ??
      ticket.router.BrowserWindow;
    const registration = registerNativeFocusSignal(signal, view);

    if (ticket.cancelled) {
      beginTransitionExit(ticket, false);
    } else {
      void (async () => {
        await Promise.race([
          waitForTwoPaints(view),
          wait(view, ROUTE_PAINT_TIMEOUT_MS),
        ]);
        await wait(view, ROUTE_MINIMUM_DWELL_MS);
        if (!signal.resolved && !documentHasForegroundFocus(view)) {
          await Promise.race([
            signal.promise,
            wait(view, ROUTE_FOCUS_TIMEOUT_MS),
          ]);
        }
        if (
          disposed ||
          activeTicket !== ticket ||
          ticket.state !== "mounted" ||
          !ticket.routeMounted
        ) {
          return;
        }
        if (ticket.cancelled || currentRunningAppId() !== ticket.request.appId) {
          beginTransitionExit(ticket, false);
          return;
        }
        ticket.focusConfirmed =
          signal.resolved || documentHasForegroundFocus(view);
        if (!ticket.focusConfirmed) {
          console.warn(
            "TrainerDeck recovery route painted, but foreground focus was not confirmed",
          );
        }
        // Always return the user to the game; focusConfirmed controls whether
        // this is reported as a verified recovery or an unconfirmed fallback.
        beginTransitionExit(ticket, true);
      })().catch((error: unknown) => {
        if (disposed || activeTicket !== ticket) {
          return;
        }
        console.warn("TrainerDeck input recovery route failed", error);
        ticket.focusConfirmed = false;
        beginTransitionExit(ticket, true);
      });
    }

    return () => {
      disposed = true;
      try {
        registration?.unregister();
      } catch (error) {
        console.warn("TrainerDeck could not remove the focus observer", error);
      }
      routeUnmounted(ticket);
    };
  }, [ticket]);

  const signalFocus = () => focusSignal.current?.resolve();
  const leaveStaleRoute = () => {
    if (ticket && ticket.state === "mounted") {
      ticket.cancelled = true;
      beginTransitionExit(ticket, false);
      return;
    }
    try {
      mainWindowRouter()?.NavigateBack();
    } catch (error) {
      console.warn("TrainerDeck could not leave a stale recovery route", error);
    }
  };

  return (
    <div
      ref={hostRef}
      style={{
        alignItems: "center",
        boxSizing: "border-box",
        display: "flex",
        justifyContent: "center",
        minHeight: "100%",
        padding: "48px",
      }}
    >
      <Focusable
        navEntryPreferPosition={NavEntryPositionPreferences.PREFERRED_CHILD}
        onCancelButton={leaveStaleRoute}
        onGamepadFocus={signalFocus}
        style={{ maxWidth: "520px", width: "100%" }}
      >
        <DialogButton
          onClick={ticket ? signalFocus : leaveStaleRoute}
          onGamepadFocus={signalFocus}
          preferredFocus
        >
          {ticket ? "正在恢复游戏输入…" : "恢复会话已失效，返回"}
        </DialogButton>
      </Focusable>
    </div>
  );
}

export function registerInputRecoveryUi(): void {
  routerHook.addRoute(
    INPUT_RECOVERY_ROUTE_PATTERN,
    TrainerDeckInputRecoveryPage,
    { exact: true },
  );
  routerHook.addGlobalComponent(
    INPUT_RECOVERY_WATCHER,
    TrainerDeckInputRecoveryWatcher,
  );
}

export function unregisterInputRecoveryUi(): void {
  shutdownInputRecovery();
  routerHook.removeGlobalComponent(INPUT_RECOVERY_WATCHER);
  routerHook.removeRoute(INPUT_RECOVERY_ROUTE_PATTERN);
}
