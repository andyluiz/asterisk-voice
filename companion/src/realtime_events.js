/** Return base64 audio only for explicit Realtime audio-delta event types. */
export function readRealtimeAudioDelta(event) {
  if (!event || !['response.audio.delta', 'response.output_audio.delta'].includes(event.type)) return null;
  return typeof event.delta === 'string' && event.delta.length > 0 ? event.delta : null;
}
