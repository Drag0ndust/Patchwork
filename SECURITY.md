# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, use [GitHub's private vulnerability reporting](https://github.com/Drag0ndust/Patchwork/security/advisories/new) to report the issue confidentially. You'll receive a response within 7 days.

## Scope

Patchwork manages files and creates symlinks on your local machine. Relevant security concerns include:

- Path traversal or unintended symlink targets
- Malicious content in Skills or Agent Definitions installed from untrusted sources
- Privilege escalation via the CLI

## Out of scope

- Bugs without a security impact
- Issues in third-party dependencies (report those upstream)
