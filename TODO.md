# Backlog

## Hermes decision escalation during live calls

Implement a narrow, authenticated asynchronous request/response channel between the realtime companion and Hermes.

### Goal

During a live call, the companion can request a bounded decision or factual lookup from Hermes and receive a structured instruction before a short deadline.

### Reservation latitude and bounded escalation

Do **not** require Hermes confirmation for every small choice. The trusted outbound brief should carry structured, machine-checkable decision bounds, for example:

```json
{
  "reservation": {
    "party_size": 3,
    "date": "2026-09-12",
    "time": { "earliest": "19:00", "latest": "20:00", "preferred": "19:30" },
    "seating": { "allowed": ["inside", "outside"], "preferred": "either" },
    "max_price_eur": 50,
    "forbid": ["deposit", "card_guarantee"]
  },
  "decision_policy": {
    "auto_accept_if_within_bounds": true,
    "ask_hermes_for": ["ambiguous_condition", "price_above_limit", "policy_exception", "missing_preference"]
  }
}
```

The Realtime model may negotiate and verbally accept a concrete offer only when a deterministic companion-side validator proves it satisfies every hard bound. Examples: 19:30 is valid for a 19:00–20:00 range; either indoor or outdoor is valid when both are allowed. It must escalate rather than guess for a condition not represented in the brief (e.g. a smoking terrace, a fixed menu, deposit, unclear cancellation condition, or a price outside limit).

Escalation must be a single bounded tool such as `request_decision`, with JSON-only input: `{kind: "reservation_offer", candidate: {...}, question: "..."}`. The companion validates it against the call's schema, emits the request, pauses the response, and waits at most 20–30 seconds. Hermes may return only `{decision: "accept"|"decline"|"counteroffer"|"callback", say: "..."}`; it cannot grant the model broad tools or modify the original brief. Every candidate, decision, timeout, and final spoken action is recorded in the call audit.

### Required behavior

- Companion emits `request_agent_decision(call_id, question, context, deadline)` to a local authenticated queue/API.
- Hermes runs the request as a background task tied to the initiating call/session and returns only an allowlisted action such as `say`, `confirm_booking`, `decline`, or `callback`.
- The companion polls or receives the response, speaks it, and never receives Hermes credentials, ARI credentials, shell access, browser access, payment data, or broad tool access.
- Enforce a 20–30 second maximum wait. If no response arrives, tell the counterparty that confirmation is needed and arrange a callback/end gracefully.
- Persist a concise decision/audit event in the final call report; avoid retaining full transcript content by default.
- Cover normal decision, timeout, malformed response, authentication rejection, and hangup-during-wait with tests.

### Current state

The companion has only Asterisk ARI and OpenAI Realtime connectivity. It has no Hermes decision-request tool yet. The existing watcher reports call completion only.

## RTP residual click investigation

Continuous 20 ms PCMU RTP, silence frames, and 5 ms transition fades improved the call audio, but intermittent small clicks remain at specific speech starts/pauses. They are tolerable for now but should be investigated later with captured RTP/WAV correlation, endpoint/Asterisk jitter-buffer settings, and packet-timing analysis under real calls. Do not regress the current continuous-clock implementation while investigating.
