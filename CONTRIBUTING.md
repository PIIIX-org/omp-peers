# Contributing

Use a branch and pull request for every change, including documentation, CI, and releases. Do not push to `main` directly.

## Branches and pull requests

Start from current `main`. Name branches `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, or `chore/<topic>`. Keep each PR to one logical change. Use normal commits and pushes; do not rebase, squash, force-push, or rewrite published history. Merge current `main` into a branch if it needs updating.

The PR template asks for a summary, verification evidence, and risks. Describe the behavior you exercised and the observed result. Automated checks alone do not prove interactive behavior. Use isolated test homes so tests cannot message or control real sessions.

## Checks and independent review

Run the commands in `.github/workflows/ci.yml` before proposing a merge. Run the leak scanner before every push. Never commit provider tokens, auth files, transcripts, watcher state/logs, real session IDs, personal paths, private hostnames, or non-loopback IPs. Use synthetic fixtures and generic home-relative paths.

Every PR must receive an independent review from a `reviewer` subagent running Claude Opus 5.5. The reviewer examines the exact PR head, reports a verdict with evidence-backed findings, and submits a GitHub review through the authorized **wafa-khairi-1020** account. Use `APPROVE` or `REQUEST_CHANGES`; a standalone issue comment is not approval. Keep review credentials outside the repository and never switch the machine-global GitHub identity to publish a review.

Taha-Mahmoodi authors changes. Wafa reviews independently. The account separation enforces review identity; the reviewer must also be independent of the implementation. Address blocking findings, resolve review conversations, then obtain a fresh approval for the final head after any pushes. Do not approve or merge unexamined code.

## Merge requirements

`main` requires:

- A pull request with one independent approval, including approval after the most recent push. New commits dismiss stale approvals.
- The required `ci` check passing on the current head, with the branch up to date against `main`.
- All review conversations resolved.

Only merge when the independent review approves, GitHub reports approval of the exact head, and CI is green. Merge using `gh pr merge --merge --match-head-commit <reviewed-head>` or GitHub's **Create a merge commit** option. Never use squash/rebase merges, force pushes, bypass flags, or direct writes to `main`. Linear history is intentionally not required. Keep the original commits and PR boundary.

If a guardrail rejects a merge, stop and address the failure; do not weaken protection to get the change through. A second approved person/account can replace the current reviewer only through an explicit owner decision.

## License

Contributions use the repository's `MIT OR Apache-2.0` terms. Preserve existing copyright and license notices.
