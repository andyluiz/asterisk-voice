function stasisArguments(appData) {
  return String(appData ?? '').split(',').map((value) => value.trim());
}

export function isPendingInboundStasisChannel(channel, ariApp) {
  if (!channel?.id) return false;
  if (!['Ring', 'Ringing'].includes(channel.state)) return false;
  const dialplan = channel.dialplan ?? {};
  if (dialplan.app_name !== 'Stasis') return false;
  const [app, mode] = stasisArguments(dialplan.app_data);
  return app === ariApp && mode === 'inbound-realtime';
}

// This module intentionally performs no ARI media operation. Its sole responsibility is
// to find channels that should have emitted StasisStart and ask the caller to create the
// same pending admission record the event path would create.
export async function reconcileInboundChannels(channels, {
  ariApp,
  hasAdmissionForChannel,
  admit,
} = {}) {
  const allChannels = Array.isArray(channels) ? channels : [];
  const candidates = allChannels.filter((channel) => isPendingInboundStasisChannel(channel, ariApp));
  let admitted = 0;
  let skipped = 0;
  for (const channel of candidates) {
    if (hasAdmissionForChannel(channel.id)) {
      skipped += 1;
      continue;
    }
    await admit(channel);
    admitted += 1;
  }
  return { scanned: allChannels.length, candidates: candidates.length, admitted, skipped };
}
