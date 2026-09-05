const CALLBACK_NOTICE = 'Não consigo confirmar agora. Vou ligar novamente assim que tiver a resposta. Obrigado.';

/** Normalize a Hermes decision into caller-facing speech and terminal-call behavior. */
export function decisionCompletionPlan(response) {
  if (response?.decision === 'callback') {
    return { say: CALLBACK_NOTICE, endAfterResponse: true };
  }
  return { say: String(response?.say ?? '').trim(), endAfterResponse: false };
}
