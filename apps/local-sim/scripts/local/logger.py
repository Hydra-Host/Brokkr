"""Shared console logger for local-environment tooling. Import the module-level ``log`` singleton."""

from __future__ import annotations

import sys
from typing import TextIO

from termcolor import cprint


class Logger:
    def __init__(self, stdout: TextIO | None = None, stderr: TextIO | None = None) -> None:
        self._stdout = stdout if stdout is not None else sys.stdout
        self._stderr = stderr if stderr is not None else sys.stderr

    def use_stderr_only(self) -> None:
        """Route every level to stderr so stdout stays a pure data channel (e.g. the ``sql-seed``
        generators print SQL to stdout). Mutates this singleton in place."""
        self._stdout = self._stderr

    def info(self, msg: str) -> None:
        cprint(f"==> {msg}", "green", file=self._stdout)

    def success(self, msg: str) -> None:
        print(f"  → {msg}", file=self._stdout)

    def detail(self, msg: str) -> None:
        print(f"  {msg}", file=self._stdout)

    def warn(self, msg: str) -> None:
        cprint(f"WARN: {msg}", "yellow", file=self._stdout)

    def error(self, msg: str) -> None:
        cprint(f"ERROR: {msg}", "red", file=self._stderr)

    def skip(self, msg: str) -> None:
        print(f"  skip {msg}", file=self._stderr)


log = Logger()
