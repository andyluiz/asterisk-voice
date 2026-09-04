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


if __name__ == '__main__':
    unittest.main()
