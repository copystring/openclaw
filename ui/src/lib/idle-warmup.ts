type Warmup = () => Promise<unknown>;

const pending = new Set<Warmup>();
let wake: (() => void) | undefined;

/**
 * First-use surfaces such as menu bodies register their lazy loaders here, so
 * opening them after the page settles skips the loading fallback. Registration
 * never loads code; the shell idle owner decides when to call each loader.
 */
export function warmWhenIdle(...loads: Warmup[]): void {
  loads.forEach((load) => pending.add(load));
  wake?.();
}

export function hasIdleWarmups(): boolean {
  return pending.size > 0;
}

/** Shell idle owner only: claims every registered loader. */
export function takeIdleWarmups(): Warmup[] {
  const loads = [...pending];
  pending.clear();
  return loads;
}

/** Shell idle owner only: one listener re-arms idle scheduling after registration. */
export function onIdleWarmupRegistered(listener: () => void): () => void {
  wake = listener;
  return () => {
    if (wake === listener) {
      wake = undefined;
    }
  };
}
