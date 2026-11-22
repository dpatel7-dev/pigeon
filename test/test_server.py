"""Server-only checks (run by test/pigeon3.test.js, or: python3 test/test_server.py)."""
import calendar
import os
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'server'))
import pigeon_server as S  # noqa: E402


class Presign(unittest.TestCase):
    def test_matches_aws_example(self):
        # the presigned GET example from AWS's Signature Version 4 documentation
        when = calendar.timegm((2013, 5, 24, 0, 0, 0))
        url = S.presign('GET', 'https', 'examplebucket.s3.amazonaws.com', '/test.txt', 'us-east-1',
                        'AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', expires=86400, when=when)
        self.assertTrue(url.endswith('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'))

    def test_barn_endpoints(self):
        self.assertEqual(S.barn_parts('b2', 's3.us-east-005.backblazeb2.com', ''), ('https', 's3.us-east-005.backblazeb2.com', 'us-east-005'))
        self.assertEqual(S.barn_parts('r2', 'a' * 32, ''), ('https', 'a' * 32 + '.r2.cloudflarestorage.com', 'auto'))
        with self.assertRaises(S.Err):
            S.barn_parts('s3', 'http://example.com', '')


class Sweep(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.p = S.Pigeon(self.dir)
        self.p.signup({'nest': 'dhruv', 'salt': 'AAAAAAAAAAAAAAAAAAAAAA==', 'proof': 'a' * 64, 'did': '1' * 16}, '1.2.3.4')
        self.p.signup({'nest': 'dhruv2', 'salt': 'AAAAAAAAAAAAAAAAAAAAAA==', 'proof': 'b' * 64, 'did': '2' * 16}, '1.2.3.4')

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def _file(self, **kw):
        m = dict({'size': 10, 'chunks': 1, 'meta': 'A' * 40, 'wrapped': 'A' * 80}, **kw)
        r = self.p.start('dhruv', '1' * 16, m)
        self.p.put_piece('dhruv', r['id'], 0, b'x' * 40)
        self.p.finish('dhruv', '1' * 16, {'id': r['id']})
        return r['id']

    def test_unclaimed_deliveries_expire(self):
        keep = self._file(to='2' * 16, hours=0.06)
        gone = self._file(to='2' * 16, hours=0.06, drop=True)
        self.p.q('UPDATE files SET ttl = 1')  # long ago
        self.p._swept = 0
        self.p.sweep()
        self.assertIsNone(self.p.one('SELECT to_did FROM files WHERE id = ?', keep)['to_did'], 'stays in the nest, no longer on its way')
        self.assertIsNone(self.p.one('SELECT id FROM files WHERE id = ?', gone), 'a drop-off that never landed is gone')
        self.assertEqual(self.p.one("SELECT COUNT(*) AS n FROM receipts WHERE gone = 'expired'")['n'], 2)

    def test_versions_are_capped(self):
        first = self._file()
        cur = first
        for _ in range(S.KEEP_VERSIONS + 3):
            cur = self._file(replaces=cur)
        olds = self.p.q('SELECT id FROM files WHERE old > 0')
        self.assertEqual(len(olds), S.KEEP_VERSIONS)
        self.assertIsNone(self.p.one('SELECT id FROM files WHERE id = ?', first), 'the oldest went')
        self.assertTrue(os.path.isdir(os.path.join(self.dir, 'files', cur)))

    def test_the_old_console_is_cleared_away(self):
        # pigeon 3.0 and 3.1 had a developer console; a site that had one loses its table, password and log
        self.p.q("INSERT OR REPLACE INTO settings VALUES ('console_hash', 'x')")
        self.p.db.execute('CREATE TABLE IF NOT EXISTS consoles (hash TEXT PRIMARY KEY, made INTEGER, seen INTEGER)')
        open(os.path.join(self.dir, 'console.jsonl'), 'w').write('{}\n')
        p2 = S.Pigeon(self.dir)
        self.assertIsNone(p2._setting('console_hash'))
        self.assertEqual(p2.q("SELECT name FROM sqlite_master WHERE name = 'consoles'"), [])
        self.assertFalse(os.path.exists(os.path.join(self.dir, 'console.jsonl')))


if __name__ == '__main__':
    unittest.main(verbosity=1)
