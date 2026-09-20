import json
import unittest
from unittest.mock import patch

from client import CompanionClient


class CompanionClientTests(unittest.TestCase):
    @patch('client.urlopen')
    def test_prepare_call_posts_bearer_authorized_json(self, urlopen):
        urlopen.return_value.__enter__.return_value.read.return_value = b'{"id":"call-1","status":"prepared"}'
        client = CompanionClient('http://127.0.0.1:8091', 'test-token')

        result = client.prepare_call(to='700', purpose='local test')

        self.assertEqual(result['status'], 'prepared')
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, 'http://127.0.0.1:8091/v1/calls/prepare')
        self.assertEqual(request.get_header('Authorization'), 'Bearer test-token')
        self.assertEqual(json.loads(request.data), {'to': '700', 'purpose': 'local test'})

    @patch('client.urlopen')
    def test_inbound_admission_methods_use_authenticated_local_api(self, urlopen):
        urlopen.return_value.__enter__.return_value.read.return_value = b'{"admissions":[{"id":"inbound-1","status":"pending_admission"}]}'
        client = CompanionClient('http://127.0.0.1:8091', 'test-token')

        pending = client.pending_inbound_admissions()
        urlopen.return_value.__enter__.return_value.read.return_value = b'{"id":"inbound-1","status":"answered"}'
        result = client.decide_inbound_admission(call_id='inbound-1', decision='answer')

        self.assertEqual(pending['admissions'][0]['status'], 'pending_admission')
        self.assertEqual(result['id'], 'inbound-1')
        first = urlopen.call_args_list[0].args[0]
        second = urlopen.call_args_list[1].args[0]
        self.assertEqual(first.full_url, 'http://127.0.0.1:8091/v1/inbound-admissions')
        self.assertEqual(first.get_header('Authorization'), 'Bearer test-token')
        self.assertEqual(second.full_url, 'http://127.0.0.1:8091/v1/calls/inbound-1/admission')
        self.assertEqual(json.loads(second.data), {'decision': 'answer'})


if __name__ == '__main__':
    unittest.main()
