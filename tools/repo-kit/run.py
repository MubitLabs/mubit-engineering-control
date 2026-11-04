#!/usr/bin/env python3
"""Run explicit project commands from .repo-kit/commands.json (Python 3.9+)."""

import argparse
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / ".repo-kit" / "commands.json"
NAME = re.compile(r"[a-z][a-z0-9_-]*\Z")


def load_config(area):
    try:
        data = json.loads(CONFIG.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ValueError("Missing .repo-kit/commands.json; configure the project first.") from error
    if not isinstance(data, dict) or data.get("schema_version") != 1:
        raise ValueError("commands.json must be an object with schema_version 1.")
    commands = data.get("commands")
    if not isinstance(commands, dict):
        raise ValueError("commands must be an object.")
    commands = dict(commands)
    verify = data.get("verify")
    areas = data.get("areas", {})
    if not isinstance(areas, dict):
        raise ValueError("areas must be an object.")
    if area:
        if area not in areas:
            raise ValueError("Unknown area: " + area)
        selected = areas[area]
        if not isinstance(selected, dict) or not isinstance(selected.get("commands", {}), dict):
            raise ValueError("An area must be an object with an optional commands object.")
        commands.update(selected.get("commands", {}))
        verify = selected.get("verify", verify)
    for name in commands:
        if not isinstance(name, str) or not NAME.fullmatch(name) or name in {"list", "verify"}:
            raise ValueError("Invalid or reserved command name: " + str(name))
    return commands, verify, areas


def prepare(commands, action, verify):
    if action == "verify":
        if not isinstance(verify, list) or not verify or any(not isinstance(x, str) for x in verify):
            raise ValueError("verify must be a nonempty list of real command names.")
        names = verify
    else:
        names = [action]
    steps = []
    for name in names:
        if name in {"verify", "list"} or name not in commands:
            raise ValueError("Unknown command in selection: " + name)
        group = commands[name]
        if not isinstance(group, list) or not group:
            raise ValueError("UNCONFIGURED: " + name + ". Add real project commands; empty groups do not pass.")
        for step in group:
            if not isinstance(step, dict):
                raise ValueError("Each command step must be an object.")
            argv = step.get("argv")
            if not isinstance(argv, list) or not argv or any(not isinstance(x, str) or not x for x in argv):
                raise ValueError("argv must be a nonempty array of nonempty strings.")
            directory = step.get("cwd", ".")
            if not isinstance(directory, str) or Path(directory).is_absolute():
                raise ValueError("cwd must be a repository-relative directory.")
            cwd = (ROOT / directory).resolve()
            try:
                cwd.relative_to(ROOT)
            except ValueError as error:
                raise ValueError("cwd must stay inside the repository.") from error
            if not cwd.is_dir():
                raise ValueError("Command directory does not exist: " + directory)
            timeout = step.get("timeout_seconds", 600)
            if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
                raise ValueError("timeout_seconds must be a positive number.")
            steps.append((name, argv, cwd, timeout))
    return steps


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", help="A configured command, verify, or list.")
    parser.add_argument("--area", help="Apply an explicitly configured area's overrides.")
    parser.add_argument("--dry-run", action="store_true", help="Show configured commands without executing them.")
    args = parser.parse_args()
    try:
        commands, verify, areas = load_config(args.area)
        if args.action == "list":
            for name, value in commands.items():
                print(name + ": " + ("configured" if isinstance(value, list) and value else "UNCONFIGURED"))
            print("verify:", json.dumps(verify))
            print("areas:", ", ".join(areas) or "none")
            return 0
        # Validate all selected groups before running any subprocess.
        steps = prepare(commands, args.action, verify)
        for name, argv, cwd, timeout in steps:
            print(f"[{name}] cwd={cwd.relative_to(ROOT)} timeout={timeout}s :: {shlex.join(argv)}", flush=True)
            if args.dry_run:
                continue
            try:
                result = subprocess.run(argv, cwd=cwd, timeout=timeout, check=False)
            except FileNotFoundError:
                print("ERROR: executable not found: " + argv[0], file=sys.stderr)
                return 127
            except subprocess.TimeoutExpired:
                print("ERROR: command timed out: " + name, file=sys.stderr)
                return 124
            if result.returncode:
                return result.returncode if result.returncode > 0 else 128 - result.returncode
        print("DRY RUN: no commands executed." if args.dry_run else "Selected commands passed.")
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print("ERROR:", error, file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
