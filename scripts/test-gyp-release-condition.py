"""Exercise the real pinned GYP parser against the release-marker condition.

Run after release:setup. This does not configure or compile a native project.
"""
import ast
from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'node_modules/node-gyp/gyp/pylib'))
import gyp
import gyp.input


class ReleaseConditionTests(unittest.TestCase):
    def evaluate(self, operating_system, enabled):
        binding = ast.literal_eval((ROOT / 'binding.gyp').read_text())
        targets = [t for t in binding['targets'] if t['target_name'] == 'node_printer']
        self.assertEqual(len(targets), 1)
        conditions = [c for c in targets[0]['conditions']
                      if re.search(r'\bdmkiosk_release_build\b', c[0])]
        self.assertEqual(len(conditions), 1)
        expression, settings = conditions[0]
        self.assertIn('DMKIOSK_NODE_PRINTER_RELEASE_BUILD=1', settings['defines'])
        variables = gyp.NameValueListToDict([
            'OS=' + operating_system, 'dmkiosk_release_build=' + str(enabled)])
        self.assertIs(type(variables['dmkiosk_release_build']), int)
        return gyp.input.EvalSingleCondition(
            expression, settings, None, gyp.input.PHASE_EARLY,
            variables, str(ROOT / 'binding.gyp'))

    def test_release_flag_enables_marker_on_windows(self):
        self.assertIsNotNone(self.evaluate('win', 1))

    def test_disabled_flag_does_not_enable_marker(self):
        self.assertIsNone(self.evaluate('win', 0))

    def test_other_platform_does_not_enable_windows_marker(self):
        self.assertIsNone(self.evaluate('linux', 1))


if __name__ == '__main__':
    unittest.main()
