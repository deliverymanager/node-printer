"""Evaluate the real binding condition with node-gyp's actual -D parser."""
import ast
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'node_modules/node-gyp/gyp/pylib'))
from gyp import NameValueListToDict


class ReleaseSwitchTests(unittest.TestCase):
    def test_numeric_release_switch_enables_only_the_release_marker(self):
        binding = ast.literal_eval((ROOT / 'binding.gyp').read_text())
        target = next(row for row in binding['targets'] if row['target_name'] == 'node_printer')
        conditions = [row for row in target['conditions']
                      if 'DMKIOSK_NODE_PRINTER_RELEASE_BUILD=1' in row[1].get('defines', [])]
        self.assertEqual(len(conditions), 1)
        condition = conditions[0][0]
        for flags, expected in [(['dmkiosk_release_build=1'], True),
                                (['dmkiosk_release_build=0'], False), ([], False)]:
            variables = {'OS': 'win', 'dmkiosk_release_build':
                         binding['variables']['dmkiosk_release_build%']}
            variables.update(NameValueListToDict(flags))
            self.assertEqual(eval(condition, {'__builtins__': {}}, variables), expected)


if __name__ == '__main__':
    unittest.main()
