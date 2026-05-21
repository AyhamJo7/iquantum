# Security Policy

## Supported Versions

Security updates are handled on the default branch. If release branches are
introduced, this policy should be updated with the supported version matrix.

## Reporting a Vulnerability

Please do not report security vulnerabilities in public issues.

Use GitHub private vulnerability reporting if it is enabled for this repository.
If it is not available, contact the maintainers through a private address listed
on the repository or package profile. If no private contact is available, open a
minimal public issue asking for a secure contact without including vulnerability
details.

Include as much of the following as you can:

- Affected version or commit.
- A concise description of the issue.
- Reproduction steps or proof of concept.
- Impact and likely attack scenario.
- Any known mitigations.

## Scope

Reports are especially useful for issues involving:

- Sandbox escape or host filesystem exposure.
- Unauthorized access to session history, credentials, or model provider keys.
- Permission bypasses in tool execution or host sync.
- MCP integration vulnerabilities.
- Supply chain or package distribution risks.

Out-of-scope reports include social engineering, denial-of-service without a
practical security impact, and findings that require already-compromised local
developer machines unless they expose additional project-specific risk.

## Disclosure

Maintainers will acknowledge valid reports as soon as practical, investigate the
impact, and coordinate a fix before public disclosure when appropriate.

