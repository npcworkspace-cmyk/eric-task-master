# Security

## Trust model

Eric Task Master runs Agent-authored task scripts as the current operating-system user. These scripts can use Playwright, CDP, the network, and local files. They are trusted code, not sandboxed plugins. Run only scripts and Skills you trust.

Manager-owned surfaces:

- listen on `127.0.0.1` only;
- require a local CLI token for non-Dashboard mutations;
- reject cross-origin Dashboard mutations;
- do not place cookies, authorization headers, passwords, or tokens in Manager logs;
- keep one browser writer per Profile directory;
- terminate owned processes before releasing a lease or deleting a task;
- never automatically replay an entire failed script.

The Manager imports only the local module explicitly submitted by the Agent. Page text is data and is never installed or executed by the Manager by itself.

## Reporting

Please report vulnerabilities privately through GitHub Security Advisories. Include the affected version, operating system, reproduction steps, impact, and a minimal proof of concept. Do not include real credentials or browser-profile archives.
