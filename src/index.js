import { randomUUID } from "node:crypto";
import dgram from "node:dgram";
import { WebSocket } from "ws";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  createRealtimeVoiceBridgeSession,
  resolveConfiguredRealtimeVoiceProvider,
} from "openclaw/plugin-sdk/realtime-voice";

const DEFAULT_CONFIG = {
  enabled: true,
  ariUrl: "http://127.0.0.1:8088/ari",
  ariUsername: "openclaw",
  ariPassword: "openclaw-local-change-me",
  ariApp: "openclaw",
  defaultContext: "internal",
  defaultTo: "1001",
  externalMediaHost: "host.docker.internal",
  realtime: {
    enabled: true,
    provider: "openai",
    providers: { openai: { model: "gpt-realtime-2" } },
    instructions:
      "Voce e Hal, assistente do Anderson. Responda em portugues do Brasil, de forma curta e natural.",
    greeting: "Oi Anderson, aqui e o Hal. Pode falar.",
  },
};

function nowIso() {
  return new Date().toISOString();
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function resolveConfig(rawConfig) {
  const input = asObject(rawConfig);
  const realtime = { ...DEFAULT_CONFIG.realtime, ...asObject(input.realtime) };
  realtime.providers =
    Object.keys(asObject(realtime.providers)).length > 0
      ? asObject(realtime.providers)
      : DEFAULT_CONFIG.realtime.providers;
  const config = { ...DEFAULT_CONFIG, ...input, realtime };
  config.ariUrl = String(config.ariUrl || DEFAULT_CONFIG.ariUrl).replace(/\/+$/, "");
  config.ariWsUrl =
    typeof input.ariWsUrl === "string" && input.ariWsUrl.trim()
      ? input.ariWsUrl.trim()
      : `${config.ariUrl.replace(/^http/i, "ws")}/events`;
  return config;
}

function parseRtpPacket(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 12) return null;
  if (packet[0] >> 6 !== 2) return null;
  const hasExtension = Boolean(packet[0] & 0x10);
  const csrcCount = packet[0] & 0x0f;
  let offset = 12 + csrcCount * 4;
  if (packet.length < offset) return null;
  if (hasExtension) {
    if (packet.length < offset + 4) return null;
    offset += 4 + packet.readUInt16BE(offset + 2) * 4;
    if (packet.length < offset) return null;
  }
  return {
    payloadType: packet[1] & 0x7f,
    sequenceNumber: packet.readUInt16BE(2),
    timestamp: packet.readUInt32BE(4),
    ssrc: packet.readUInt32BE(8),
    payload: packet.subarray(offset),
  };
}

function buildRtpPacket({ payload, sequenceNumber, timestamp, ssrc, payloadType = 0 }) {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = payloadType & 0x7f;
  header.writeUInt16BE(sequenceNumber & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([header, payload]);
}

function safeCall(call) {
  if (!call) return null;
  const { realtimeCleanup, realtimeSession, ...publicCall } = call;
  return publicCall;
}

function normalizeEndpoint(config, params = {}) {
  const target = params.endpoint ?? params.to ?? config.defaultTo;
  if (typeof target !== "string" || !target.trim()) {
    throw new Error("Provide endpoint or to");
  }
  const trimmed = target.trim();
  if (trimmed.startsWith("PJSIP/") || trimmed.startsWith("Local/")) return trimmed;
  if (/^local:/i.test(trimmed)) {
    const extension = trimmed.slice(trimmed.indexOf(":") + 1).trim();
    if (!extension) throw new Error("Local target must include an extension");
    return `Local/${extension}@${config.defaultContext}`;
  }
  if (/^\d+$/.test(trimmed)) return `PJSIP/${trimmed}`;
  throw new Error(`Unsupported endpoint format: ${trimmed}`);
}

class AsteriskVoiceRuntime {
  constructor({ api, config, logger }) {
    this.api = api;
    this.config = config;
    this.logger = logger;
    this.calls = new Map();
    this.channelToCallId = new Map();
    this.ariWs = null;
    this.ariWsConnected = false;
    this.reconnectTimer = null;
    this.stopped = false;
  }

  async start() {
    this.stopped = false;
    this.connectAriWebSocket();
  }

  async stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.ariWs?.close();
    } catch {}
    for (const call of this.calls.values()) {
      if (typeof call.realtimeCleanup === "function") {
        await call.realtimeCleanup("runtime-stop");
      }
    }
  }

  authHeader() {
    const token = Buffer.from(`${this.config.ariUsername}:${this.config.ariPassword}`).toString("base64");
    return `Basic ${token}`;
  }

  ariRestUrl(path) {
    return new URL(path.replace(/^\/+/, ""), `${this.config.ariUrl}/`).toString();
  }

  async ariRequest(path, options = {}) {
    const response = await fetch(this.ariRestUrl(path), {
      ...options,
      headers: {
        Authorization: this.authHeader(),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      const error = new Error(`ARI ${options.method ?? "GET"} ${path} failed: ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  async getChannelVariable(channelId, variable) {
    const params = new URLSearchParams({ variable });
    const result = await this.ariRequest(`/channels/${encodeURIComponent(channelId)}/variable?${params}`);
    return typeof result?.value === "string" ? result.value : null;
  }

  async health() {
    let ari;
    try {
      const info = await this.ariRequest("/asterisk/info");
      ari = { ok: true, system: info?.system ?? null };
    } catch (error) {
      ari = { ok: false, status: error.status ?? null, error: formatErrorMessage(error) };
    }
    return {
      ok: ari.ok && this.ariWsConnected,
      ari,
      wsConnected: this.ariWsConnected,
      knownCallCount: [...this.calls.values()].filter((call) => call.status !== "ended").length,
    };
  }

  emitCallEvent(type, callId, data = {}) {
    const event = { type, callId, at: nowIso(), ...data };
    const call = this.calls.get(callId);
    if (call) {
      call.updatedAt = event.at;
      call.events.push(event);
    }
    this.logger?.debug?.(`asterisk-voice ${type} ${callId}`);
    return event;
  }

  findCallByChannel(channelId) {
    if (!channelId) return null;
    const mappedCallId = this.channelToCallId.get(channelId);
    if (mappedCallId) return this.calls.get(mappedCallId) ?? null;
    for (const call of this.calls.values()) {
      if (call.channelId === channelId || call.externalChannelId === channelId) return call;
    }
    return null;
  }

  async startCall(params = {}) {
    const callId = typeof params.callId === "string" && params.callId ? params.callId : randomUUID();
    const endpoint = normalizeEndpoint(this.config, params);
    const call = {
      id: callId,
      mode: params.realtime === false ? "ari" : "realtime",
      endpoint,
      requestedTo: params.to ?? this.config.defaultTo,
      status: "created",
      channelId: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      events: [],
    };
    this.calls.set(callId, call);
    const originateParams = new URLSearchParams({
      endpoint,
      app: this.config.ariApp,
      appArgs: callId,
      channelId: callId,
    });
    const originate = await this.ariRequest(`/channels/originate?${originateParams}`, { method: "POST" });
    if (originate?.id) {
      call.channelId = originate.id;
      call.primaryChannelId = originate.id;
      this.channelToCallId.set(originate.id, callId);
    }
    call.status = "originating";
    this.emitCallEvent("call.initiated", callId, { endpoint, channelId: call.channelId, mode: call.mode });
    return safeCall(call);
  }

  getCall(callId) {
    if (!callId) return [...this.calls.values()].map(safeCall);
    const call = this.calls.get(callId);
    if (!call) throw new Error(`Call not found: ${callId}`);
    return safeCall(call);
  }

  async endCall(callId) {
    const call = this.calls.get(callId);
    if (!call) throw new Error(`Call not found: ${callId}`);
    if (typeof call.realtimeCleanup === "function") {
      await call.realtimeCleanup("api-end");
    } else {
      const channelIds = [...new Set([call.primaryChannelId, call.channelId, call.externalChannelId].filter(Boolean))];
      for (const channelId of channelIds) {
        try {
          await this.ariRequest(`/channels/${encodeURIComponent(channelId)}`, { method: "DELETE" });
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
      call.status = "ended";
      this.emitCallEvent("call.ended", call.id, { requestedBy: "api" });
    }
    return safeCall(call);
  }

  normalizeAriEvent(event) {
    const channel = event.channel ?? event.channel_snapshot ?? null;
    const channelId = channel?.id ?? event.channel_id ?? null;
    const call = this.findCallByChannel(channelId);
    const channelName = channel?.name ?? "";
    const isExternalMediaChannel = channelName.startsWith("UnicastRTP/");
    if (event.type === "StasisStart") {
      const callId = event.args?.[0] || call?.id || channelId || randomUUID();
      const stored = this.calls.get(callId) ?? {
        id: callId,
        mode: event.args?.[0] === "inbound-realtime" ? "realtime" : "ari",
        endpoint: channel?.name ?? null,
        status: "started",
        channelId,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        events: [],
      };
      this.calls.set(callId, stored);
      if (channelId) {
        if (isExternalMediaChannel) {
          stored.externalChannelId = channelId;
        } else {
          stored.channelId = channelId;
          stored.primaryChannelId = channelId;
        }
        this.channelToCallId.set(channelId, callId);
      }
      this.emitCallEvent("call.active", callId, { channelId, rawType: event.type });
      if (stored.mode === "realtime" && channelId && !stored.bridgeStarted) {
        stored.bridgeStarted = true;
        this.ariRequest(`/channels/${encodeURIComponent(channelId)}/answer`, { method: "POST" })
          .catch(() => {})
          .finally(() => {
            this.startRealtimeBridge(stored, channelId).catch((error) => {
              stored.bridgeStarted = false;
              stored.status = "error";
              this.emitCallEvent("call.error", stored.id, { error: formatErrorMessage(error) });
            });
          });
      }
      return;
    }
    if (!call) return;
    if (event.type === "ChannelStateChange") {
      if (channel?.state === "Ringing") call.status = "ringing";
      if (channel?.state === "Up") call.status = "answered";
      this.emitCallEvent("call.state", call.id, { channelId, state: channel?.state ?? null });
      return;
    }
    if (event.type === "ChannelDtmfReceived") {
      this.emitCallEvent("call.dtmf", call.id, { channelId, digit: event.digit ?? null });
      return;
    }
    if (event.type === "StasisEnd" || event.type === "ChannelDestroyed" || event.type === "ChannelHangupRequest") {
      if (typeof call.realtimeCleanup === "function" && !call.realtimeCleanupStarted) {
        call.realtimeCleanup(event.type).catch((error) => {
          this.logger?.warn?.(`asterisk-voice cleanup failed: ${formatErrorMessage(error)}`);
        });
        return;
      }
      call.status = "ended";
      this.emitCallEvent("call.ended", call.id, { channelId, rawType: event.type });
    }
  }

  async startRealtimeBridge(call, channelId) {
    const udpSocket = dgram.createSocket("udp4");
    await new Promise((resolve, reject) => {
      udpSocket.once("error", reject);
      udpSocket.bind(0, "0.0.0.0", () => {
        udpSocket.removeListener("error", reject);
        resolve();
      });
    });
    const udpPort = udpSocket.address().port;
    let asteriskAddress = null;
    let asteriskPort = null;
    let externalChannelId = null;
    let bridgeId = null;
    let session = null;
    let cleaned = false;
    let outboundSequenceNumber = Math.floor(Math.random() * 0xffff);
    let outboundTimestamp = Math.floor(Math.random() * 0xffffffff) >>> 0;
    const outboundSsrc = Math.floor(Math.random() * 0xffffffff) >>> 0;
    let outboundPayloadType = 0;
    const stats = { inboundRtpPackets: 0, inboundAudioBytes: 0, outboundRtpPackets: 0, outboundAudioBytes: 0 };

    const sendAudioToAsterisk = (audio) => {
      if (!asteriskAddress || !asteriskPort) {
        this.logger?.warn?.(`asterisk-voice ${call.id} audio drop: no target address/port defined`);
        return;
      }
      for (let offset = 0; offset < audio.length; offset += 160) {
        const payload = audio.subarray(offset, Math.min(offset + 160, audio.length));
        if (payload.length === 0) continue;
        udpSocket.send(
          buildRtpPacket({
            payload,
            sequenceNumber: outboundSequenceNumber,
            timestamp: outboundTimestamp,
            ssrc: outboundSsrc,
            payloadType: outboundPayloadType,
          }),
          asteriskPort,
          asteriskAddress,
        );
        outboundSequenceNumber = (outboundSequenceNumber + 1) & 0xffff;
        outboundTimestamp = (outboundTimestamp + payload.length) >>> 0;
        stats.outboundRtpPackets += 1;
        stats.outboundAudioBytes += payload.length;
      }
    };

    const cleanup = async (reason) => {
      if (cleaned) return;
      cleaned = true;
      call.realtimeCleanupStarted = true;
      try {
        session?.close();
      } catch {}
      try {
        udpSocket.close();
      } catch {}
      const channelIds = [...new Set([call.primaryChannelId, call.channelId, channelId, call.externalChannelId, externalChannelId].filter(Boolean))];
      for (const cleanupChannelId of channelIds) {
        try {
          await this.ariRequest(`/channels/${encodeURIComponent(cleanupChannelId)}`, { method: "DELETE" });
        } catch {}
      }
      try {
        if (bridgeId) await this.ariRequest(`/bridges/${encodeURIComponent(bridgeId)}`, { method: "DELETE" });
      } catch {}
      call.status = "ended";
      call.realtimeStats = stats;
      this.emitCallEvent("call.ended", call.id, { channelId, reason, realtimeStats: stats });
    };

    call.realtimeCleanup = cleanup;

    try {
      const externalHost = `${this.config.externalMediaHost}:${udpPort}`;
      const externalMedia = await this.ariRequest("/channels/externalMedia", {
        method: "POST",
        body: JSON.stringify({
          app: this.config.ariApp,
          external_host: externalHost,
          format: "ulaw",
          data: call.id,
        }),
      });
      externalChannelId = externalMedia?.id;
      if (!externalChannelId) throw new Error("ExternalMedia did not return a channel id");
      call.externalChannelId = externalChannelId;
      this.channelToCallId.set(externalChannelId, call.id);

      const [localAddress, localPort] = await Promise.all([
        this.getChannelVariable(externalChannelId, "UNICASTRTP_LOCAL_ADDRESS").catch(() => null),
        this.getChannelVariable(externalChannelId, "UNICASTRTP_LOCAL_PORT").catch(() => null),
      ]);
      const parsedLocalPort = Number.parseInt(localPort ?? "", 10);
      if (localAddress && Number.isInteger(parsedLocalPort) && parsedLocalPort > 0) {
        asteriskAddress = localAddress;
        asteriskPort = parsedLocalPort;
        this.emitCallEvent("call.rtp.target", call.id, { address: asteriskAddress, port: asteriskPort });
      }

      const bridge = await this.ariRequest("/bridges", {
        method: "POST",
        body: JSON.stringify({ type: "mixing", name: `bridge-${call.id}` }),
      });
      bridgeId = bridge?.id;
      if (!bridgeId) throw new Error("Bridge creation did not return an id");
      await this.ariRequest(`/bridges/${encodeURIComponent(bridgeId)}/addChannel`, {
        method: "POST",
        body: JSON.stringify({ channel: channelId }),
      });
      await this.ariRequest(`/bridges/${encodeURIComponent(bridgeId)}/addChannel`, {
        method: "POST",
        body: JSON.stringify({ channel: externalChannelId }),
      });

      const resolved = resolveConfiguredRealtimeVoiceProvider({
        configuredProviderId: this.config.realtime.provider,
        providerConfigs: this.config.realtime.providers,
        cfg: this.api.config,
        cfgForResolve: this.api.config,
        noRegisteredProviderMessage: "No realtime voice provider registered",
      });
      session = createRealtimeVoiceBridgeSession({
        provider: resolved.provider,
        cfg: this.api.config,
        providerConfig: resolved.providerConfig,
        audioFormat: REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
        instructions: this.config.realtime.instructions,
        initialGreetingInstructions: this.config.realtime.greeting,
        triggerGreetingOnReady: Boolean(this.config.realtime.greeting),
        markStrategy: "ack-immediately",
        audioSink: {
          isOpen: () => !cleaned,
          sendAudio: sendAudioToAsterisk,
          clearAudio: () => {},
        },
        onTranscript: (role, text, isFinal) => {
          if (!text) return;
          if (role === "user" && isFinal) call.transcript = [call.transcript, text].filter(Boolean).join("\n");
          this.emitCallEvent(role === "assistant" ? "call.speaking" : "call.transcribed", call.id, {
            role,
            text,
            isFinal,
          });
        },
        onEvent: (event) => {
          if (event.direction === "server" && event.type === "input_audio_buffer.speech_started") {
            this.emitCallEvent("call.speech.started", call.id, { channelId });
          }
        },
        onReady: () => this.emitCallEvent("call.realtime.started", call.id, { provider: resolved.provider.id }),
        onError: (error) => {
          this.emitCallEvent("call.error", call.id, { error: formatErrorMessage(error) });
          cleanup("realtime-error").catch(() => {});
        },
        onClose: (reason) => cleanup(`realtime-close:${reason}`).catch(() => {}),
      });
      call.realtimeSession = session;
      call.status = "bridging";
      this.emitCallEvent("call.realtime.bridging", call.id, { channelId, externalChannelId, bridgeId });

      udpSocket.on("message", (packet, rinfo) => {
        const rtp = parseRtpPacket(packet);
        if (!rtp || rtp.payload.length === 0 || cleaned) return;
        if (!asteriskAddress) {
          asteriskAddress = rinfo.address;
          asteriskPort = rinfo.port;
          outboundPayloadType = rtp.payloadType;
          outboundTimestamp = (rtp.timestamp + 160) >>> 0;
          this.logger?.info?.(`asterisk-voice ${call.id} rtp target learned: ${asteriskAddress}:${asteriskPort}`);
        }
        stats.inboundRtpPackets += 1;
        stats.inboundAudioBytes += rtp.payload.length;
        session?.sendAudio(rtp.payload);
      });
      udpSocket.on("error", () => cleanup("udp-error").catch(() => {}));
      udpSocket.on("close", () => cleanup("udp-close").catch(() => {}));
      await session.connect();
    } catch (error) {
      await cleanup(`init-error:${formatErrorMessage(error)}`);
      throw error;
    }
  }

  wsUrlWithAuth() {
    const url = new URL(this.config.ariWsUrl);
    url.searchParams.set("api_key", `${this.config.ariUsername}:${this.config.ariPassword}`);
    url.searchParams.set("app", this.config.ariApp);
    return url.toString();
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectAriWebSocket();
    }, 2000);
  }

  connectAriWebSocket() {
    if (this.ariWs && (this.ariWs.readyState === WebSocket.OPEN || this.ariWs.readyState === WebSocket.CONNECTING)) return;
    this.ariWs = new WebSocket(this.wsUrlWithAuth());
    this.ariWs.on("open", () => {
      this.ariWsConnected = true;
      this.logger?.info?.("asterisk-voice ARI websocket connected");
    });
    this.ariWs.on("message", (message) => {
      try {
        this.normalizeAriEvent(JSON.parse(message.toString()));
      } catch (error) {
        this.logger?.warn?.(`asterisk-voice ARI event failed: ${formatErrorMessage(error)}`);
      }
    });
    this.ariWs.on("close", () => {
      this.ariWsConnected = false;
      this.scheduleReconnect();
    });
    this.ariWs.on("error", (error) => {
      this.ariWsConnected = false;
      this.logger?.warn?.(`asterisk-voice ARI websocket error: ${formatErrorMessage(error)}`);
    });
  }
}

function readActionParams(rawParams = {}) {
  const params = asObject(rawParams);
  return { action: String(params.action ?? "health"), params };
}

const toolParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["health", "start", "status", "end"], default: "health" },
    callId: { type: "string" },
    to: { type: "string" },
    endpoint: { type: "string" },
    realtime: { type: "boolean" },
  },
};

export default definePluginEntry({
  id: "asterisk-voice",
  name: "Asterisk Voice",
  description: "Asterisk ARI realtime voice runtime for OpenClaw.",
  register(api) {
    let runtime = null;
    const ensureRuntime = async () => {
      if (runtime) return runtime;
      runtime = new AsteriskVoiceRuntime({
        api,
        config: resolveConfig(api.pluginConfig),
        logger: api.logger,
      });
      await runtime.start();
      return runtime;
    };
    const runAction = async (rawParams = {}) => {
      const { action, params } = readActionParams(rawParams);
      const activeRuntime = await ensureRuntime();
      if (action === "health") return activeRuntime.health();
      if (action === "start") return activeRuntime.startCall(params);
      if (action === "status") return activeRuntime.getCall(params.callId);
      if (action === "end") return activeRuntime.endCall(params.callId);
      throw new Error(`Unsupported action: ${action}`);
    };
    const registerGatewayAction = (method, action) => {
      api.registerGatewayMethod(`asteriskvoice.${method}`, async ({ params, respond }) => {
        try {
          respond(true, await runAction({ ...params, action }));
        } catch (error) {
          respond(false, { error: formatErrorMessage(error) });
        }
      });
    };
    registerGatewayAction("health", "health");
    registerGatewayAction("start", "start");
    registerGatewayAction("status", "status");
    registerGatewayAction("end", "end");
    api.registerService({
      id: "asterisk-voice",
      start: async () => {
        const config = resolveConfig(api.pluginConfig);
        if (config.enabled) await ensureRuntime();
      },
      stop: async () => {
        if (runtime) await runtime.stop();
        runtime = null;
      },
    });
    api.registerTool(
      {
        name: "asterisk_voice",
        label: "Asterisk Voice",
        description: "Control Asterisk realtime voice calls through OpenClaw.",
        parameters: toolParameters,
        execute: async (_toolCallId, rawParams) => JSON.stringify(await runAction(rawParams), null, 2),
      },
      { name: "asterisk_voice" },
    );
    api.registerCommand({
      name: "asteriskvoice",
      description: "Control Asterisk realtime voice calls.",
      acceptsArgs: true,
      handler: async (context) => {
        const tokens = String(context.args ?? "").trim().split(/\s+/).filter(Boolean);
        const action = tokens[0] || "health";
        const callId = tokens[1];
        try {
          const result = await runAction({ action, callId });
          return { text: JSON.stringify(result, null, 2) };
        } catch (error) {
          return { text: `asteriskvoice failed: ${formatErrorMessage(error)}` };
        }
      },
    });
  },
});
