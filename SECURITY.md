# Security Policy

## Project Status & Disclaimer

Chrome GPT Live is an experimental, educational **example project** provided **"AS IS"** without warranty or formal support guarantees (see [LICENSE](LICENSE)). It is not an official or supported commercial product.

Anyone who builds, installs, modifies, or runs this software does so at their own risk and is solely responsible for securing their environment, supervising browser actions, protecting sensitive data, complying with applicable laws and third-party Terms of Service, and managing any Azure / Microsoft Foundry costs incurred. The author assumes no liability for how this software is used.

## Supported Versions

Because this repository is published as reference/example code, security fixes are provided on a best-effort basis on the `main` branch only.

| Version | Supported |
| --- | --- |
| `main` (latest) | Best effort |
| Older commits / forks | Not supported |

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues, discussions, or pull requests.

Instead, report suspected vulnerabilities privately using [GitHub Private Vulnerability Reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) via the **Security > Advisories > Report a vulnerability** button in this repository.

When reporting, please include:

- A clear description of the issue and its potential security impact.
- Affected files, components (`apps/extension`, `apps/server`, `packages/shared`, or `scripts`), and configuration prerequisites.
- Minimal reproduction steps or proof-of-concept details (using synthetic/non-sensitive pages and placeholder endpoints).

Reports are reviewed on a best-effort basis without a guaranteed SLA.

## Operational Security Guidance

If you run this sample locally or adapt it for your own experiments, keep the following boundaries in mind:

- **Never commit secrets or personal endpoints**: Keep `.env` files local and gitignored. Authenticate via Microsoft Entra ID (`az login` locally with least-privilege RBAC, or Managed Identity when hosted) rather than embedding static API keys in browser code.
- **Keep the local companion on loopback**: The local broker defaults to `127.0.0.1:4317` (`HOST=127.0.0.1`). Do not expose an unauthenticated companion port on shared or public networks.
- **Treat web pages and PDFs as untrusted input**: Browser agents can encounter indirect prompt injection on arbitrary web pages or documents. Always supervise active sessions, verify confirmation prompts before approving state-changing actions, and avoid activating the extension on sensitive accounts, financial portals, or confidential documents you do not intend to send to your configured model deployments.
- **Experimental modes remain operator-gated**: Leave `MD1_CLIENT_DELEGATION_VERIFIED=false` unless you have independently validated the client-delegation contract against safe test fixtures.
