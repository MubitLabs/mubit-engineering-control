# Scope — when to keep going, when to stop with a draft

A focused change goes through implementation, the relevant checks and self-review without asking. File counts, failing tests and layout defects are reasons to fix, not to stop. There is no fixed line-count allowance.

Stop and report `blocked` when the work would:

- break existing caller expectations
- change a module's responsibilities
- need a coordinated redesign across independent modules
- require a product or design decision the request did not settle
- repeatedly fail to progress across genuinely different approaches

Name the specific interface, the caller impact or the missing prerequisite in the report — a stop without a reason is not a stop, it is a drop.

Partial work is preserved as an explicitly incomplete draft: the branch, the checks that ran, and exactly what remains. Never fabricate a deliverable. A stop by the user holds until the user lifts it; no check, timer or event overrides it.

When feasible approaches disagree, pick the one the request supports and say so in the report; do not ask the user to arbitrate engineering preferences that the request already settled.
