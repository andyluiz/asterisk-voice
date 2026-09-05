function rounded(value) {
  return Number(Number(value ?? 0).toFixed(3));
}

function nanosecondsToMilliseconds(value) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) && numeric > 0 ? rounded(numeric / 1e6) : 0;
}

/**
 * Per-call telemetry for diagnosing RTP output artifacts. This is intentionally
 * diagnostic-only: it does not alter pacing or decide whether an audio packet is sent.
 */
export function createRtpPacingMetrics() {
  let queueHighWaterFrames = 0;
  let modelAudioUnderflowFrames = 0;
  let lateFramesOver5ms = 0;
  let maxLatenessMs = 0;
  let maxUdpSendCallbackDelayMs = 0;

  return {
    observeQueueDepth(depth) {
      queueHighWaterFrames = Math.max(queueHighWaterFrames, Math.max(0, Number(depth) || 0));
    },
    observePacerTick({ latenessMs, modelAudioActive, queuedAudioFrames }) {
      const late = Math.max(0, Number(latenessMs) || 0);
      maxLatenessMs = Math.max(maxLatenessMs, late);
      if (late > 5) lateFramesOver5ms += 1;
      if (modelAudioActive && queuedAudioFrames === 0) modelAudioUnderflowFrames += 1;
    },
    observeUdpSendCallback(delayMs) {
      maxUdpSendCallbackDelayMs = Math.max(maxUdpSendCallbackDelayMs, Math.max(0, Number(delayMs) || 0));
    },
    snapshot(eventLoopDelay) {
      return {
        queueHighWaterFrames,
        modelAudioUnderflowFrames,
        pacing: {
          lateFramesOver5ms,
          maxLatenessMs: rounded(maxLatenessMs),
        },
        udpSendCallback: {
          maxDelayMs: rounded(maxUdpSendCallbackDelayMs),
        },
        eventLoopDelay: {
          minMs: nanosecondsToMilliseconds(eventLoopDelay?.min),
          meanMs: nanosecondsToMilliseconds(eventLoopDelay?.mean),
          maxMs: nanosecondsToMilliseconds(eventLoopDelay?.max),
          p99Ms: nanosecondsToMilliseconds(eventLoopDelay?.percentile?.(99)),
        },
      };
    },
  };
}
