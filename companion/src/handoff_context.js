const MAX_RECENT_CALLER_TURNS = 3;

/**
 * Produces the authoritative handoff input from Realtime's own finalized
 * caller transcriptions. This deliberately does not reuse the model-generated
 * function argument, which can be a paraphrase or a false premise.
 */
export function callerHandoffTranscript(transcript, limit = MAX_RECENT_CALLER_TURNS) {
  const turns = String(transcript ?? '')
    .split(/\r?\n/)
    .map((turn) => turn.trim())
    .filter(Boolean)
    .slice(-Math.max(1, Number(limit) || MAX_RECENT_CALLER_TURNS));
  if (turns.length === 0) return '';
  return [
    'Caller utterances (verbatim, chronological):',
    ...turns.map((turn, index) => `${index + 1}. ${turn}`),
  ].join('\n');
}
