#!/usr/bin/env python3
"""Wait for a companion call to finish and print one compact completion report."""

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

from client import CompanionClient
from server import read_env

ENV_PATH = Path('/home/anderson/apps/asterisk-voice/.env')
RECORDINGS_DIR = Path('/home/anderson/apps/asterisk-voice/recordings')


def archive_debug_report(call: dict) -> str | None:
    """Persist the full two-sided transcript/event record beside debug audio."""
    recording_name = call.get('debugRecordingName')
    if not recording_name:
        return None
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    archive_path = RECORDINGS_DIR / f'{recording_name}.json'
    archive_path.write_text(json.dumps(call, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return str(archive_path)


def compact_report(call: dict, transcript_archive_path: str | None = None) -> dict:
    events = call.get('events', [])
    first_event = lambda event_type: next((event for event in events if event.get('type') == event_type), None)
    last_end = next((event for event in reversed(events) if event.get('type') == 'call.ended'), None)
    initiated = first_event('call.initiated')
    answered = first_event('call.answered')
    errors = [event.get('error') for event in events if event.get('type') == 'call.error' and event.get('error')]
    duration_seconds = None
    if answered and last_end:
        try:
            duration_seconds = round((
                datetime.fromisoformat(last_end['at'].replace('Z', '+00:00'))
                - datetime.fromisoformat(answered['at'].replace('Z', '+00:00'))
            ).total_seconds(), 1)
        except (KeyError, ValueError):
            pass
    return {
        'call_id': call.get('id'),
        'status': call.get('status'),
        'destination': call.get('requestedTo'),
        'endpoint': call.get('endpoint'),
        'initiated_at': initiated.get('at') if initiated else None,
        'answered_at': answered.get('at') if answered else None,
        'ended_at': last_end.get('at') if last_end else None,
        'duration_seconds': duration_seconds,
        'end_reason': last_end.get('reason') if last_end else None,
        'errors': errors,
        'realtime_stats': call.get('realtimeStats'),
        'debug_recording_path': call.get('debugRecordingPath'),
        'transcript_archive_path': transcript_archive_path,
    }


def recover_journaled_call(call_id: str) -> dict | None:
    """Recover an interrupted call from the append-only companion journal."""
    journal = RECORDINGS_DIR / 'call-events' / f'{call_id}.jsonl'
    if not journal.exists():
        return None
    records = [json.loads(line) for line in journal.read_text(encoding='utf-8').splitlines() if line.strip()]
    snapshot = next((r.get('call') for r in records if r.get('type') == 'call.snapshot'), None)
    if not snapshot:
        return None
    events = [r for r in records if r.get('type') != 'call.snapshot']
    ended = any(e.get('type') == 'call.ended' for e in events)
    return {**snapshot, 'events': events, 'status': 'ended' if ended else 'interrupted',
            'recovery_reason': 'companion-restarted-before-final-report' if not ended else None}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('call_id')
    parser.add_argument('--timeout', type=int, default=7200)
    args = parser.parse_args()
    if not 1 <= args.timeout <= 7200:
        parser.error('--timeout must be between 1 and 7200 seconds')

    values = read_env(ENV_PATH)
    token = values.get('COMPANION_TOKEN', '')
    if not token:
        raise RuntimeError('COMPANION_TOKEN is not configured')

    client = CompanionClient('http://127.0.0.1:8091', token)
    deadline = time.monotonic() + args.timeout
    while True:
        try:
            report = client.call_status(call_id=args.call_id)
        except Exception:
            report = recover_journaled_call(args.call_id)
            if report is None:
                raise
            break
        if report.get('pendingDecision'):
            decision = report['pendingDecision']
            print(json.dumps({
                'call_id': args.call_id,
                'status': 'awaiting_hermes_decision',
                'decision_id': decision.get('id'),
                'deadline_at': decision.get('deadlineAt'),
                'kind': decision.get('kind'),
                'candidate': decision.get('candidate'),
                'question': decision.get('question'),
            }, ensure_ascii=False, separators=(',', ':')))
            return 0
        if report.get('status') in {'ended', 'error', 'failed'}:
            break
        if time.monotonic() >= deadline:
            raise TimeoutError(f'Call {args.call_id} did not finish within {args.timeout} seconds')
        time.sleep(1)
    transcript_archive_path = archive_debug_report(report)
    print(json.dumps(compact_report(report, transcript_archive_path), ensure_ascii=False, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f'call watcher failed: {error}', file=sys.stderr)
        raise SystemExit(1)
