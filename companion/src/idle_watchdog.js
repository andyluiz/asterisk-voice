export function shouldResetIdleWatchdog(reason, activeResponseReason = null) {
  return !(reason === 'assistant-transcript' && activeResponseReason === 'idle-warning');
}

export function createIdleWatchdog({
  warningMs,
  timeoutMs,
  onWarning,
  onTimeout,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  if (!Number.isFinite(warningMs) || warningMs <= 0) throw new Error('warningMs must be positive');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= warningMs) throw new Error('timeoutMs must exceed warningMs');

  let warningTimer = null;
  let timeoutTimer = null;
  let paused = true;
  let stopped = false;

  function clearTimers() {
    if (warningTimer !== null) clearTimeoutFn(warningTimer);
    if (timeoutTimer !== null) clearTimeoutFn(timeoutTimer);
    warningTimer = null;
    timeoutTimer = null;
  }

  function arm() {
    clearTimers();
    if (paused || stopped) return;
    warningTimer = setTimeoutFn(() => {
      warningTimer = null;
      if (!paused && !stopped) onWarning();
    }, warningMs);
    timeoutTimer = setTimeoutFn(() => {
      timeoutTimer = null;
      if (!paused && !stopped) onTimeout();
    }, timeoutMs);
  }

  return {
    reset() {
      if (stopped) return;
      paused = false;
      arm();
    },
    pause() {
      if (stopped) return;
      paused = true;
      clearTimers();
    },
    resume() {
      if (stopped) return;
      paused = false;
      arm();
    },
    stop() {
      stopped = true;
      clearTimers();
    },
  };
}
