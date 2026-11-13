## Summary

Describe the single change and why it is needed.

## Verification evidence

List commands/scenarios and their observed results. Include isolated runtime evidence for behavioral changes and the pre-push leak scan result. Do not paste credentials or private session data.

## Risk and rollback

Describe compatibility, security, or operational risks and how to undo the change.

## Independent review and merge

Record the independent reviewer subagent's verdict, actual owner-configured reviewer model, wafa review URL, and exact reviewed head. Resolve blocking findings and all conversations; obtain fresh approval after new pushes. Require green `ci` before a merge commit. No direct main push, squash/rebase merge, force push, or protection bypass.
