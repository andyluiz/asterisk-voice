import json
import time
from urllib.request import Request, urlopen


class CompanionClient:
    def __init__(self, base_url: str, token: str):
        self.base_url = base_url.rstrip('/')
        self.token = token

    def request(self, method: str, path: str, payload: dict[str, object] | None = None) -> dict:
        data = json.dumps(payload).encode() if payload is not None else None
        request = Request(
            f'{self.base_url}{path}',
            data=data,
            method=method,
            headers={
                'Authorization': f'Bearer {self.token}',
                'Content-Type': 'application/json',
            },
        )
        with urlopen(request, timeout=30) as response:
            return json.loads(response.read())

    def health(self) -> dict:
        request = Request(f'{self.base_url}/health', method='GET')
        with urlopen(request, timeout=10) as response:
            return json.loads(response.read())

    def prepare_call(self, *, to: str, purpose: str, brief: dict | None = None) -> dict:
        payload: dict[str, object] = {'to': to, 'purpose': purpose}
        if brief is not None:
            payload['brief'] = brief
        return self.request('POST', '/v1/calls/prepare', payload)

    def start_call(self, *, call_id: str, approved: bool) -> dict:
        return self.request('POST', f'/v1/calls/{call_id}/start', {'approved': approved})

    def call_status(self, *, call_id: str) -> dict:
        return self.request('GET', f'/v1/calls/{call_id}')

    def respond_to_call_decision(self, *, call_id: str, decision_id: str, decision: str, say: str) -> dict:
        return self.request('POST', f'/v1/calls/{call_id}/decisions/{decision_id}/respond', {
            'decision': decision,
            'say': say,
        })

    def hangup_call(self, *, call_id: str) -> dict:
        return self.request('POST', f'/v1/calls/{call_id}/hangup', {})

    def wait_for_call_completion(
        self,
        *,
        call_id: str,
        timeout_seconds: int = 3600,
        poll_interval_seconds: float = 1.0,
    ) -> dict:
        """Wait for a call's terminal state and return its final report."""
        deadline = time.monotonic() + timeout_seconds
        while True:
            call = self.call_status(call_id=call_id)
            if call.get('status') in {'ended', 'error', 'failed'}:
                return call
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f'Call {call_id} did not finish within {timeout_seconds} seconds')
            time.sleep(min(poll_interval_seconds, remaining))
