const OUTBOUND_HANDOFF = Object.freeze({
  timeoutMs: 20_000,
  timeoutReply: 'Preciso confirmar esse detalhe com Anderson e retorno em breve.',
  endAfterTimeout: true,
});

const HERMES_VOICE_HANDOFF = Object.freeze({
  timeoutMs: 90_000,
  timeoutReply: 'Ainda não consegui verificar isso. Podemos continuar e eu confirmo depois.',
  endAfterTimeout: false,
});

export function handoffPolicy(interactionMode) {
  return interactionMode === 'hermes_voice' ? HERMES_VOICE_HANDOFF : OUTBOUND_HANDOFF;
}
