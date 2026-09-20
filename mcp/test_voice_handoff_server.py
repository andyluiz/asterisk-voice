#!/usr/bin/env python3
"""Regression coverage for the profile-local Hermes voice-handoff bridge.

Set VOICE_HANDOFF_SERVER_PATH when the bridge script is installed elsewhere.
The test is kept in asterisk-voice so bridge prompt regressions are not lost
with a Hermes profile cleanup.
"""
import importlib.util
import os
import unittest
from pathlib import Path


BRIDGE_PATH = Path(os.environ.get(
    'VOICE_HANDOFF_SERVER_PATH',
    '/home/anderson/.hermes/profiles/hal/scripts/voice_handoff_server.py',
))


@unittest.skipUnless(BRIDGE_PATH.is_file(), f'Voice handoff bridge not installed: {BRIDGE_PATH}')
class VoiceHandoffPromptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('voice_handoff_server', BRIDGE_PATH)
        if spec is None or spec.loader is None:
            raise RuntimeError(f'Cannot load voice handoff bridge: {BRIDGE_PATH}')
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def test_chronological_context_resolves_a_caller_correction(self):
        prompt = self.module.build_handoff_prompt({
            'question': 'Caller utterances (verbatim, chronological):\n1. Verifica com o Raul qual que é a placa do carro Corolla.\n2. Não, você está com a Wiki. Faça isso, por favor.',
            'context': {
                'recent_conversation': 'Conversation context (chronological):\nCaller: Verifica com o Raul qual que é a placa do carro Corolla.\nHal: Eu não consigo consultar placas.\nCaller: Não, você está com a Wiki. Faça isso, por favor.',
            },
        })

        self.assertIn('most recent unresolved caller request', prompt)
        self.assertIn('explicit caller correction overrides', prompt)
        self.assertIn('Conversation context (chronological)', prompt)
        self.assertNotIn('Question: ', prompt)


if __name__ == '__main__':
    unittest.main()
