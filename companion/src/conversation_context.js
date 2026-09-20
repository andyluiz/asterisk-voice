const MAX_CONVERSATION_TURNS = 8;
const MAX_CONTEXT_CHARS = 2_000;

export function appendConversationTurn(history, role, text, limit = MAX_CONVERSATION_TURNS) {
  const value = String(text ?? '').trim();
  if (!value) return Array.isArray(history) ? history : [];
  const normalizedRole = role === 'assistant' ? 'assistant' : 'caller';
  return [...(Array.isArray(history) ? history : []), { role: normalizedRole, text: value }]
    .slice(-Math.max(1, Number(limit) || MAX_CONVERSATION_TURNS));
}

export function formatRecentConversation(history, maxChars = MAX_CONTEXT_CHARS) {
  const entries = (Array.isArray(history) ? history : [])
    .filter((entry) => entry && typeof entry.text === 'string' && entry.text.trim())
    .map((entry) => `${entry.role === 'assistant' ? 'Hal' : 'Caller'}: ${entry.text.trim()}`);
  if (entries.length === 0) return '';
  const header = 'Conversation context (chronological):';
  const body = entries.join('\n');
  const bounded = body.length > maxChars ? body.slice(-maxChars) : body;
  return `${header}\n${bounded}`;
}
