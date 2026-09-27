/**
 * Surfaces unhandled JavaScript errors instead of letting them kill the app.
 *
 * The phone build is an unsigned Release build, which changes the failure mode completely:
 *
 * * There is no red box and no console, so an error is invisible.
 * * React Native's default global handler ends in `RCTFatal`, which terminates the process. A
 *   throw inside a text input's `onChangeText` therefore presented as "the app closes when I
 *   type", with nothing on screen to explain it. That is exactly how a `TypeError` reached a
 *   user's phone and took several builds to track down.
 *
 * So the handler records the error where the UI can show it and does *not* call the previous
 * handler. The trade is deliberate: a bug that used to end the app now shows a banner and leaves
 * it usable. For a consumer app that is the right way round - the user can finish a backup, and
 * the message can be reported.
 *
 * This is not a replacement for fixing the bug. It is what makes the next one visible.
 */

export interface CapturedError {  /** Monotonic, so a repeated error still registers as new. */
  id: number;
  message: string;
  /** Where it came from, when the engine gives us a stack. */
  stack: string | null;
  at: number;
}

type Listener = (error: CapturedError) => void;

const MAX_MESSAGE_LENGTH = 400;

let latest: CapturedError | null = null;
let nextId = 1;
const listeners = new Set<Listener>();

function truncate(text: string): string {
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text;
}

function describe(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    return { message: truncate(error.message || error.name), stack: error.stack ?? null };
  }
  if (typeof error === 'string') {
    return { message: truncate(error), stack: null };
  }
  return { message: truncate(`Non-error thrown: ${safeStringify(error)}`), stack: null };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function record(error: unknown, isFatal: boolean, extraStack: string | null = null): CapturedError {
  const described = describe(error);
  const captured: CapturedError = {
    id: nextId++,
    message: isFatal ? described.message : described.message,
    stack: extraStack ? `${described.stack ?? described.message}\n${extraStack}` : described.stack,
    at: Date.now(),
  };
  latest = captured;

  // Still worth logging: in a Release build this reaches the native log, which is what a crash
  // report or a sysdiagnose contains. It costs nothing and it is the only trace that survives
  // if the user does not read the banner.
  // eslint-disable-next-line no-console
  console.error(`[LocalDrop] unhandled error: ${captured.message}`, captured.stack ?? '');

  for (const listener of listeners) {
    try {
      listener(captured);
    } catch {
      // A broken listener must not mask the original error.
    }
  }
  return captured;
}

/** The most recent unhandled error, or `null` if there has not been one. */
export function latestError(): CapturedError | null {
  return latest;
}

/**
 * Records an error that was caught rather than thrown at the top level - a render throw caught by
 * `ErrorBoundary`, which then reports it here so the banner and the native log see the same thing.
 */
export function recordErrorForDisplay(error: unknown, extraStack: string | null = null): CapturedError {
  return record(error, false, extraStack);
}

/** Clears the banner. Called when the user dismisses it. */
export function clearLatestError(): void {
  latest = null;
}

/** Subscribes to unhandled errors. Returns an unsubscribe function. */
export function onCapturedError(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Installs the handler. Idempotent, so it is safe to call from module scope and from a test.
 *
 * `ErrorUtils` is React Native's global, not an import, and it is absent under plain Node - which
 * is why this is defensive rather than a straight assignment.
 */
export function installErrorHandler(): void {
  const errorUtils = (globalThis as { ErrorUtils?: { setGlobalHandler?: (h: (e: unknown, isFatal?: boolean) => void) => void } })
    .ErrorUtils;

  if (!errorUtils || typeof errorUtils.setGlobalHandler !== 'function') {
    return;
  }

  errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
    record(error, isFatal === true);
  });
}
