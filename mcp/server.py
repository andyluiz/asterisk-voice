#!/usr/bin/env python3
"""Trusted stdio MCP facade for the local Asterisk Hermes companion."""

from pathlib import Path

from mcp.server.fastmcp import FastMCP

from client import CompanionClient

ENV_PATH = Path('/home/anderson/apps/asterisk-voice/.env')


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        values[key] = value
    return values


def companion() -> CompanionClient:
    values = read_env(ENV_PATH)
    token = values.get('COMPANION_TOKEN', '')
    if not token:
        raise RuntimeError('COMPANION_TOKEN is not configured')
    return CompanionClient('http://127.0.0.1:8091', token)


mcp = FastMCP('asterisk-hermes', instructions=(
    'Controls a local-only Asterisk realtime companion. '
    'It accepts only allowlisted internal extensions. '
    'Never start a call unless the user explicitly approved the exact call.'
))


@mcp.tool()
def companion_health() -> dict:
    """Return local Asterisk/companion health. Does not start a call."""
    return companion().health()


@mcp.tool()
def prepare_local_call(to: str, purpose: str, brief: dict | None = None) -> dict:
    """Prepare an allowlisted internal call with an immutable, bounded task brief.

    The brief may define task, introduction, objective, constraints,
    allowed_actions, and requires_final_confirmation. It grants no tools.
    """
    return companion().prepare_call(to=to, purpose=purpose, brief=brief)


@mcp.tool()
def start_approved_call(call_id: str, user_confirmed: bool) -> dict:
    """Start a prepared call only after explicit user confirmation in this conversation."""
    return companion().start_call(call_id=call_id, approved=user_confirmed)


@mcp.tool()
def get_call_status(call_id: str) -> dict:
    """Get state and summarized events for a prepared or active call."""
    return companion().call_status(call_id=call_id)


@mcp.tool()
def respond_to_call_decision(call_id: str, decision_id: str, decision: str, say: str) -> dict:
    """Resolve one pending call decision. Only accept, decline, counteroffer, or callback are allowed."""
    if decision not in {'accept', 'decline', 'counteroffer', 'callback'}:
        raise ValueError('decision must be accept, decline, counteroffer, or callback')
    return companion().respond_to_call_decision(call_id=call_id, decision_id=decision_id, decision=decision, say=say)


@mcp.tool()
def hangup_call(call_id: str) -> dict:
    """End a prepared or active local call."""
    return companion().hangup_call(call_id=call_id)


@mcp.tool()
def wait_for_call_completion(call_id: str, timeout_seconds: int = 3600) -> dict:
    """Wait for a local call to end and return its final status and events.

    Run this as a background task after starting a call so its completion report
    returns to the initiating Hermes session.
    """
    if not 1 <= timeout_seconds <= 7200:
        raise ValueError('timeout_seconds must be between 1 and 7200')
    return companion().wait_for_call_completion(
        call_id=call_id,
        timeout_seconds=timeout_seconds,
    )


if __name__ == '__main__':
    mcp.run(transport='stdio')
