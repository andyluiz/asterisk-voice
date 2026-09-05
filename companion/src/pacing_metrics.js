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
  let lateFramesOver5ms = 0;
  let maxLatenessMs = 0;
  let maxUdpSendCallbackDelayMs = 0;
  let realtimeAudioDeltaCount = 0;
  let realtimeAudioTotalBytes = 0;
  let lastRealtimeAudioDeltaAt = null;
  let maxRealtimeAudioInterDeltaMs = 0;
  let realtimeAudioGapsOver100ms = 0;
  let maxRealtimeAudioBurstFrames = 0;
  let maxQueueDepthBeforeDeltaFrames = 0;

  return {
    observeQueueDepth(depth) {
      queueHighWaterFrames = Math.max(queueHighWaterFrames, Math.max(0, Number(depth) || 0));
    },
    observeRealtimeAudioDelta({ atMs, bytes, queueDepthBefore }) {
      const at = Number(atMs);
      const byteCount = Math.max(0, Number(bytes) || 0);
      if (lastRealtimeAudioDeltaAt != null && Number.isFinite(at)) {
        const gapMs = Math.max(0, at - lastRealtimeAudioDeltaAt);
        maxRealtimeAudioInterDeltaMs = Math.max(maxRealtimeAudioInterDeltaMs, gapMs);
        if (gapMs > 100) realtimeAudioGapsOver100ms += 1;
      }
      if (Number.isFinite(at)) lastRealtimeAudioDeltaAt = at;
      realtimeAudioDeltaCount += 1;
      realtimeAudioTotalBytes += byteCount;
      maxRealtimeAudioBurstFrames = Math.max(maxRealtimeAudioBurstFrames, Math.ceil(byteCount / 160));
      maxQueueDepthBeforeDeltaFrames = Math.max(maxQueueDepthBeforeDeltaFrames, Math.max(0, Number(queueDepthBefore) || 0));
    },
    observePacerTick({ latenessMs }) {
      const late = Math.max(0, Number(latenessMs) || 0);
      maxLatenessMs = Math.max(maxLatenessMs, late);
      if (late > 5) lateFramesOver5ms += 1;
    },
    observeUdpSendCallback(delayMs) {
      maxUdpSendCallbackDelayMs = Math.max(maxUdpSendCallbackDelayMs, Math.max(0, Number(delayMs) || 0));
    },
    snapshot(eventLoopDelay) {
      return {
        queueHighWaterFrames,
        pacing: {
          lateFramesOver5ms,
          maxLatenessMs: rounded(maxLatenessMs),
        },
        udpSendCallback: {
          maxDelayMs: rounded(maxUdpSendCallbackDelayMs),
        },
        realtimeAudio: {
          deltaCount: realtimeAudioDeltaCount,
          totalBytes: realtimeAudioTotalBytes,
          maxInterDeltaMs: rounded(maxRealtimeAudioInterDeltaMs),
          gapsOver100ms: realtimeAudioGapsOver100ms,
          maxBurstFrames: maxRealtimeAudioBurstFrames,
          maxQueueDepthBeforeDeltaFrames,
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
