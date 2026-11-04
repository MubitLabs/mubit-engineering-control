# Security policy

MEC is local-first: your credentials never leave your machine. Keys enter only through the
workbench Slots form or the keystore API, are stored encrypted under `~/.mec`, and are read only
at launch into the engine's own environment. No telemetry, no remote credential store.

## Reporting a vulnerability

Please use **private** channels only — never a public issue:

1. **GitHub private vulnerability reporting** (preferred): the *Security* tab of this repository →
   *Report a vulnerability*.
2. Or email **security@mubit.dev**.

Include what you would include in any bug report — it is safe by construction (see below):

- the `mec doctor` bundle (`mec doctor --json` on current builds; plain `mec doctor` on builds
  before the flag existed). The doctor report is redacted before it exists: secret-named
  environment entries are skipped, non-allowlisted values are omitted, and anything secret-shaped
  is masked. If you ever see a real secret-shaped string in its output, that is itself a
  reportable bug — redact it manually and say so.
- your engine and its version, OS and arch, and the steps to reproduce.

A report never needs a credential, a token or a key. Do not paste one; do not put one in a
screenshot.

Response is best effort — usually within a week, no SLA (see [SUPPORT.md](SUPPORT.md)).

## Scope

In scope: anything in this repository — the launcher and composition server, the slot homes and
keystore, the local HTTP surface, the bundled native modules, the release artifacts.

Out of scope: the engines themselves (report Claude Code, Codex CLI and OpenCode bugs to their
vendors), your infrastructure, and volumetric attacks on a service that does not exist (MEC binds
to 127.0.0.1 by design).

The full threat model — the six threats of the plan §7.4 plus the surfaces this repo adds, every
control cited to a test, every gap stated honestly — is [`docs/security/threat-model.md`](../docs/security/threat-model.md).
Read it before reporting; known residual risks are listed there and already tracked.

## Supported versions

The latest release tag only. There are no backports; update first, then report.
