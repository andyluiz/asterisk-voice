export function callerExplicitlyRequestedHangup(transcript) {
  const text = String(transcript || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase();
  return /\b(?:(?:pode|quero|gostaria de) (?:encerrar|desligar|finalizar|concluir)(?: (?:a )?chamada)?|vamos (?:encerrar|desligar|finalizar)|desligue|pode fechar a ligacao|hang up|end (?:the )?call|you can (?:hang up|end the call)|tot ziens|hang op)\b/.test(text);
}
