"""Bounded retirement of fixture-owned children without waiting for pipe EOF."""
import json
import sys


def retire_pipe_child(child):
    # tmux passes control descriptors to the server. Killing the client does
    # not imply pipe EOF, so communicate() can wait on a still-live server.
    primary = None
    try:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=3)
    except Exception as error:
        primary = error
        raise
    finally:
        run_owned_cleanup(
            [(name, stream.close) for name, stream in
             (("stdin", child.stdin), ("stdout", child.stdout), ("stderr", child.stderr))
             if stream is not None],
            primary,
        )


def run_owned_cleanup(actions, primary=None):
    errors = []
    for name, action in actions:
        try:
            action()
        except Exception as error:
            errors.append({"stage": name, "error": str(error)[:2048]})
    if errors:
        message = "Owned fixture cleanup failed: " + json.dumps(errors)
        print(message, file=sys.stderr)
        if primary is None:
            raise RuntimeError(message)
        if hasattr(primary, "add_note"):
            primary.add_note(message)
    return not errors
