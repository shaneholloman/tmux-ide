"""Offline collector tests; no compiler, tmux server or native execution."""
import contextlib
import io
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch
from native_test_evidence import export_sanitizer_evidence


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.owned = tempfile.TemporaryDirectory(prefix="tmux-ide-evidence-test-")
        self.root = pathlib.Path(self.owned.name)
        self.fixture = self.root / "tmux-ide-fixture-abc"
        self.target = self.root / "evidence"
        self.fixture.mkdir(mode=0o700)
        self.target.mkdir(mode=0o700)
        self.env = patch.dict(os.environ, {"TMUX_IDE_NATIVE_TEST_EVIDENCE_DIR": str(self.target)})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.owned.cleanup()

    def test_exact_logs_survive_fixture_removal(self):
        (self.fixture / "asan.123").write_bytes(b"actual sanitizer error")
        (self.fixture / "unrelated").write_bytes(b"not evidence")
        export_sanitizer_evidence(str(self.fixture))
        kept = self.target / self.fixture.name
        self.assertEqual((kept / "asan.123").read_bytes(), b"actual sanitizer error")
        self.assertFalse((kept / "unrelated").exists())
        self.assertEqual(len(json.loads((kept / "manifest.json").read_text())["files"]), 1)
        self.assertEqual((kept / "asan.123").stat().st_mode & 0o777, 0o600)

    def test_reject_symlink_and_nonprivate_target(self):
        (self.fixture / "asan.123").symlink_to(self.root / "secret")
        with self.assertRaises(OSError):
            export_sanitizer_evidence(str(self.fixture))
        self.target.chmod(0o755)
        with self.assertRaises(ValueError):
            export_sanitizer_evidence(str(self.fixture))

    def test_bounded_file_and_no_overwrite(self):
        with (self.fixture / "asan.123").open("wb") as stream:
            stream.truncate(4 * 1024 * 1024 + 1)
        with self.assertRaises(ValueError):
            export_sanitizer_evidence(str(self.fixture))
        with self.assertRaises(FileExistsError):
            export_sanitizer_evidence(str(self.fixture))

    def test_original_failure_not_replaced_by_export_failure(self):
        self.target.chmod(0o755)
        with self.assertRaisesRegex(RuntimeError, "original native failure"):
            try:
                raise RuntimeError("original native failure")
            finally:
                with contextlib.redirect_stderr(io.StringIO()) as output:
                    export_sanitizer_evidence(str(self.fixture))
                self.assertIn("original failure preserved", output.getvalue())

    def test_original_failure_still_raises_after_successful_export(self):
        (self.fixture / "ubsan.456").write_bytes(b"runtime error")
        with self.assertRaisesRegex(RuntimeError, "native failure"):
            try:
                raise RuntimeError("native failure")
            finally:
                export_sanitizer_evidence(str(self.fixture))
        self.assertEqual((self.target / self.fixture.name / "ubsan.456").read_bytes(), b"runtime error")

    def test_unconfigured_does_nothing(self):
        with patch.dict(os.environ):
            os.environ.pop("TMUX_IDE_NATIVE_TEST_EVIDENCE_DIR")
            export_sanitizer_evidence("not a path")
        self.assertEqual(list(self.target.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
