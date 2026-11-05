#!/usr/bin/env python3
"""Run a PR's source mutants against its tests (Python 3.9+, stdlib only).

    python3 tools/mutants/run.py tools/mutants/<pr>.json
    python3 tools/mutants/run.py --self-check tools/mutants/<pr>.json

A spec is a JSON array of {name, file, find, replace, tests[]}. `find` must occur exactly
once in `file`, which must be clean in git, and the unmutated tests must be green. Each
mutant is applied, its tests run, and the file restored in a `finally`. Verdicts:

    KILLED    at least one test failed
    SURVIVED  the tests ran and all passed: the tests do not see this change
    INVALID   no test verdict: a suite failed to load, nothing ran, or no report

Only KILLED passes; the exit status is non-zero on any SURVIVED or INVALID. A broken
mutant must never read as a killed one, which is why a failed suite with no failed test
is INVALID. `--self-check` proves that on the spec's first mutant: a no-op must report
SURVIVED and a syntax error INVALID.
"""

import argparse
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
TIMEOUT_SECONDS = 300
KILLED, SURVIVED, INVALID = "KILLED", "SURVIVED", "INVALID"
FIELDS = ("name", "file", "find", "replace", "tests")


def load_spec(path):
    spec = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(spec, list) or not spec:
        raise ValueError(f"{path}: a spec is a non-empty JSON array of mutants.")
    for index, mutant in enumerate(spec):
        missing = [field for field in FIELDS if field not in mutant]
        if missing:
            raise ValueError(f"{path}[{index}]: missing {', '.join(missing)}.")
        if not isinstance(mutant["tests"], list) or not mutant["tests"]:
            raise ValueError(f"{path}[{index}]: tests must be a non-empty array.")
    names = [mutant["name"] for mutant in spec]
    if len(set(names)) != len(names):
        raise ValueError(f"{path}: mutant names must be unique.")
    return spec


def check_target(mutant):
    """A dirty file or an ambiguous `find` would corrupt the run; refuse before touching it."""
    target = ROOT / mutant["file"]
    status = subprocess.run(
        ["git", "status", "--porcelain", "--", mutant["file"]],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    if status.stdout.strip():
        raise ValueError(f"{mutant['name']}: {mutant['file']} has uncommitted changes.")
    count = target.read_text(encoding="utf-8").count(mutant["find"])
    if count != 1:
        raise ValueError(f"{mutant['name']}: find occurs {count} times in {mutant['file']}, not once.")


def run_tests(tests):
    """One vitest run; returns (verdict counts, or None when there is no usable report)."""
    with tempfile.TemporaryDirectory(prefix="mec-mutants-") as scratch:
        report = Path(scratch) / "report.json"
        command = [
            "pnpm",
            "exec",
            "vitest",
            "run",
            *tests,
            "--reporter=json",
            f"--outputFile={report}",
        ]
        try:
            subprocess.run(
                command,
                cwd=ROOT,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            return None
        try:
            return json.loads(report.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None


def verdict_of(report):
    if report is None:
        return INVALID
    failed = report.get("numFailedTests", 0)
    total = report.get("numTotalTests", 0)
    if failed > 0:
        return KILLED
    if total == 0 or report.get("numFailedTestSuites", 0) > 0:
        return INVALID
    return SURVIVED


def run_mutant(mutant):
    target = ROOT / mutant["file"]
    original = target.read_bytes()
    text = original.decode("utf-8")
    try:
        target.write_bytes(text.replace(mutant["find"], mutant["replace"], 1).encode("utf-8"))
        return verdict_of(run_tests(mutant["tests"]))
    finally:
        target.write_bytes(original)


def baseline_green(spec):
    """Every distinct test set, unmutated: a red baseline would make every mutant look killed."""
    for tests in sorted({tuple(mutant["tests"]) for mutant in spec}):
        report = run_tests(list(tests))
        if verdict_of(report) != SURVIVED:
            print(f"baseline is not green for: {' '.join(tests)}", file=sys.stderr)
            return False
    return True


def self_check(spec):
    """The runner's own mutants: an undetectable change must SURVIVE, a broken file must be INVALID."""
    first = spec[0]
    cases = [
        ("no-op", first["find"] + " ", SURVIVED),
        ("syntax error", first["find"] + " ((((", INVALID),
    ]
    good = True
    for label, replace, expected in cases:
        got = run_mutant({**first, "replace": replace})
        print(f"{got:<9} self-check {label} (expected {expected})")
        good = good and got == expected
    return good


def main():
    parser = argparse.ArgumentParser(description="Run a PR's source mutants against its tests.")
    parser.add_argument("spec", help="tools/mutants/<pr>.json")
    parser.add_argument("--self-check", action="store_true", help="prove the runner's own verdicts")
    parser.add_argument("--only", action="append", default=[], help="run only this mutant (repeatable)")
    args = parser.parse_args()

    # SIGTERM must unwind through run_mutant's finally, or a killed run leaves a mutant behind.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))

    try:
        spec = load_spec(args.spec)
        if args.only:
            spec = [mutant for mutant in spec if mutant["name"] in args.only]
            if not spec:
                raise ValueError("--only matched no mutant.")
        for mutant in spec:
            check_target(mutant)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    if not baseline_green(spec):
        return 2
    if args.self_check:
        return 0 if self_check(spec) else 1

    results = [(mutant["name"], run_mutant(mutant)) for mutant in spec]
    for name, verdict in results:
        print(f"{verdict:<9} {name}")
    bad = sum(1 for _, verdict in results if verdict != KILLED)
    print(f"{len(results) - bad} of {len(results)} killed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
