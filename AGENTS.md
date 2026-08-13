# Repository Agent Instructions

## GitHub authentication and sandbox networking

- A failed `gh auth status`, GitHub API call, SSH check, fetch, push, or PR command inside the sandbox is not sufficient evidence that the user's credentials are invalid.
- This repository has already exhibited sandbox false negatives: `gh auth status` failed inside the sandbox while the same configured keyring account succeeded outside it, and SSH push plus PR creation also succeeded outside it.
- When a GitHub or Git network/authentication command fails with a credential, keyring, DNS, socket, or network-style error, retry the same read-only diagnostic outside the sandbox first using the normal approval mechanism.
- Do not ask the user to log in again, replace credentials, or change SSH keys unless the outside-sandbox check also fails.
- For known GitHub network operations in this repository, prefer the already approved or appropriately scoped outside-sandbox execution path instead of repeating a diagnostic sequence that is known to produce sandbox false negatives.
