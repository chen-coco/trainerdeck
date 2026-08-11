export interface AutomaticAddContext {
  appId: number;
  backendReady: boolean;
  bindingReady: boolean;
  cheatDeckConfigured: boolean;
  enabled: boolean;
  hasBinding: boolean;
  query: string;
  queryReady: boolean;
  settingsReady: boolean;
  targetRunning: boolean;
}

export type AutomaticAddDecision =
  | { action: "wait" }
  | { action: "skip-cheatdeck"; key: string }
  | { action: "run"; key: string; query: string };

export function decideAutomaticAdd(
  context: AutomaticAddContext,
): AutomaticAddDecision {
  if (
    !context.settingsReady ||
    !context.enabled ||
    !context.targetRunning ||
    context.appId <= 0 ||
    !context.bindingReady ||
    context.hasBinding
  ) {
    return { action: "wait" };
  }
  if (context.cheatDeckConfigured) {
    return { action: "skip-cheatdeck", key: `cheatdeck:${context.appId}` };
  }
  const query = context.query.trim();
  if (!context.backendReady || !context.queryReady || query.length < 2) {
    return { action: "wait" };
  }
  return {
    action: "run",
    key: `add:${context.appId}:${query}`,
    query,
  };
}
