# Cleanup workflow

The audit input is handoff.md at baseline 421ad78. There are thirteen findings across four packages. The done predicate requires retained red/green regression evidence for all findings, documented and tested A13 isolation semantics, independently verified unit commits, passing integrated workspace checks, and pushed ready pull requests in a linear base-branch stack. Merge is outside the delivery request.

Rigor is high because the queue concerns resource release, child processes, effect type safety, and external tool replay. Each fix gets a failing behavior probe before implementation. Reviewers inspect exact commits in isolated checkouts and run the relevant package tests. The coordinator reruns the full suite on the integrated result.

The units are resource unwind, platform behavior, registry ownership, AI protocol validation, effect contracts, and AI turn ownership. Independent writers own disjoint packages in worktrees. Core contract and AI turn work follow a two-candidate design comparison. Delivery uses a linear stack even where implementation can proceed independently.

Each completed unit adds a decision row, verification artifact, commit, and local resume-store checkpoint. The checkpoint records branch heads, completed IDs, commands, live agents, and next actions. The original todo.md stays untouched. Full durable execution and process-restart recovery stay separate. Successful in-memory tool receipts must survive a model failure within this process. Unknown outcomes after a process crash remain a future contract.

GitHub CLI is the forge because Origin is unavailable. The remote baseline equals the audit baseline. There is no repository CI workflow, so delivery verification uses retained local checks and exact remote SHA inspection.
