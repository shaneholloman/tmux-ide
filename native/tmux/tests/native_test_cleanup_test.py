import contextlib
import io
import os
import subprocess
import sys
import time
import unittest
from unittest.mock import Mock, patch
from native_test_cleanup import retire_pipe_child, run_owned_cleanup
from native_test_evidence import export_sanitizer_evidence


class CleanupTests(unittest.TestCase):
    def test_close_failure_is_not_hidden_by_callers_active_exception(self):
        child = Mock()
        child.poll.return_value = 0
        child.stdin.close.side_effect = RuntimeError("close failed")
        try:
            raise AssertionError("caller failure")
        except AssertionError:
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, "close failed"):
                    retire_pipe_child(child)
        child.stdout.close.assert_called_once()
        child.stderr.close.assert_called_once()

    def test_strict_export_reports_failure_to_outer_cleanup(self):
        with patch.dict(os.environ, {"TMUX_IDE_NATIVE_TEST_EVIDENCE_DIR": "/private/proof"}):
            with patch("native_test_evidence._export", side_effect=ValueError("export failed")):
                try:
                    raise AssertionError("primary")
                except AssertionError:
                    with self.assertRaisesRegex(ValueError, "export failed"):
                        export_sanitizer_evidence("/private/source", strict=True)

    def test_failure_does_not_skip_later_owned_cleanup(self):
        called = []
        def failed():
            raise RuntimeError("control timeout")
        primary = AssertionError("original snapshot failure")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(run_owned_cleanup([
                ("control", failed), ("server", lambda: called.append("server")),
                ("evidence", lambda: called.append("evidence")),
            ], primary))
        self.assertEqual(called, ["server", "evidence"])
        self.assertEqual(str(primary), "original snapshot failure")

    def test_cleanup_failure_cannot_pass_successful_test(self):
        def failed():
            raise RuntimeError("retirement failed")
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, "retirement failed"):
                run_owned_cleanup([("server", failed)])

    def test_inherited_output_pipe_does_not_block_client_retirement(self):
        # A separate owned process retains a duplicate stdout, as the tmux
        # server does. Client retirement must not wait for that process's EOF.
        read_fd, write_fd = os.pipe()
        client = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"],
                                  stdin=subprocess.PIPE, stdout=write_fd,
                                  stderr=subprocess.PIPE)
        holder = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"],
                                  stdout=write_fd,
                                  stderr=subprocess.DEVNULL)
        os.close(write_fd)
        client.stdout = os.fdopen(read_fd, "rb")
        try:
            started = time.monotonic()
            retire_pipe_child(client)
            self.assertLess(time.monotonic() - started, 3)
            self.assertIsNotNone(client.returncode)
            self.assertIsNone(holder.poll())
        finally:
            for child in (client, holder):
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=3)


if __name__ == "__main__":
    unittest.main()
