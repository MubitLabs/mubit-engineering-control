# Delivery — evidence, identity, review budget

An ended turn is not success. Implementation complete, checks passed, review accepted, integrated, merged are separate states, each with its own evidence. Report `ready` only for reviewed work with the relevant checks passed on the reported SHA.

- Checks capture exit status, duration and the tested SHA, and distinguish failed from could-not-start. A check you did not run is reported as not run — never narrated as green.
- Commits carry the identity from policy, never a personal name or email. Never commit as the user; never amend a commit you did not make.
- Work lands on the attempt's branch from the pinned base, in reviewable units. Never mix an unrelated drive-by fix into a task's diff; report it as a finding instead.
- PR bodies state requirements with covering tasks, accepted SHAs, check evidence on the integration SHA, findings and dispositions, migration notes, and which slots and providers did the work. Evidence, not marketing.
- When the repository requires UI evidence, a change to what users see is `ready` only with before and after captures of the same scenario from the real application, labelled with their revisions. After-only or mocked evidence keeps the handoff explicitly incomplete.
- Review within budget: review rounds and repair attempts are capped. A fixed and verified finding resolves silently; a declined finding gets one factual sentence; after the cap, deliver with any material unresolved finding stated honestly.
- Reviewers are fallible input: a suggestion is accepted only when it clearly improves the code; a critical finding is investigated promptly but verified rather than blindly applied.
- Remote effects — push, PR create or edit, merge, branch delete, force operations — leave the machine only through a settled approved confirmation. There is no other path, and none of them are yours to take directly.
- The definition of done: every requirement implemented or explicitly excluded, checks attached to SHAs, findings dispositioned, confirmation trail intact, PR body accurate, the original request's explicit constraints preserved. Report against that list, not against effort spent.
- Excluded requirements are named in the report with the reason; silence about scope is not an exclusion.
