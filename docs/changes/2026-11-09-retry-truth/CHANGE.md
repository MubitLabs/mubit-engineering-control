# Retry truth: a second A never denies, and no retry is offered that is certain to be refused

Branch `fix/retry-truth`, base a2c2d7b (the tip of `fix/integration-retry`, PR #58).

## 1. A second A on an armed card pressed Deny

**Cause.** `apps/web/src/next/keyboard.ts` `armFocusedCard` found the button to press with `button[data-armed="false"]`, meaning "the first unarmed button in the card". Before PR #54 only Approve carried `data-armed`. PR #54 gave Deny a two-step and `data-armed` too. Now, once Approve is armed, the first unarmed button is Deny. A second A clicked Deny:

- On a card whose Deny is one step, that denied the card. The screens test's first card in the `needs` harness is one of those, so it went to `resolved` (`Expected "open"`, `Received "resolved"`).
- On a release card, it armed Deny and disarmed Approve.

**The code was wrong, not the test.** The test's expectation (A arms Approve, and a second A changes nothing) is the shortcut's documented contract ("A card that is already armed … is left alone: A never confirms"). For a person, pressing A twice denied the request. The test is unchanged.

**Change.** `Decision.tsx` marks the Approve button with `data-approve`. `armFocusedCard` selects that button by its marker and does nothing unless its `data-armed` is `"false"`. A disabled button and `aria-disabled` are still refused as before.

## 2. "Retry integration" was offered on work whose commands had changed

**Cause.** `apps/desktop/src/delivery.ts` `retryOffer` checked the block's kind, the agreement, an open repair and the tasks. It never compared the work's `pin.profileHash` with the repository's current profile. Every retry of such work is refused later:

- An integration retry or a push or PR ask: `Delivery.#work` blocks it with `repo_profile_changed` on the next pass.
- A repair ("Try again"): `AttemptLauncher.#load` refuses its launch with `repo_profile_changed`.

Both gates computed the current hash inline through `repoFields(store, repoId, policyText).pin.profileHash`. That needs the policy text, which the inspection layer does not have.

**Change.**

- `packages/meta/src/admission.ts`: new exported `profileChanged(store, repoId, work)`, which answers whether the work was pinned to a profile and the repository's current profile hash differs from it. `pinRepo` and `profileChanged` share `profileHashOf` and `registeredRepo`, so the pin and the comparison hash the same fields. An unregistered repository still throws `unknown_repo`.
- `Delivery.#work` and `AttemptLauncher.#load` now ask `profileChanged` instead of comparing inline. Their refusal text is unchanged.
- `delivery.ts`: `admittedUnderOtherCommands(store, work)` calls the same function. It returns false for work with no repository, and for an unregistered repository, because that refusal belongs to the gates. `retryOffer` offers nothing when it is true, whatever the kind. `Delivery.retry` refuses such a press with `repo_profile_changed` instead of `nothing_to_retry`.
- `inspection.ts` `#reasonAndAction`, `person/blocked`: when `admittedUnderOtherCommands` is true, the row reads `Blocked: ` followed by the `repo_profile_changed` words from `reason-words.ts`, and the Next line reads *Stop this work and ask again*. This happens whatever the stored reason says, including a delivery that stopped short. The detail's `retry` is `null` through `retryOffer`.

The offer, the integration step and the launch gate all ask `profileChanged`, so the offer cannot promise what a gate refuses.

**Spec.** §14 says the checks are the ones pinned at admission. Decision #41 says admitted work is refused after an edit, never rerun. §12.5 says stopping it and asking again is the way forward. This change adds no new behaviour beyond those. It only stops the UI from offering an action those rules refuse.

## Risk

- The two gates no longer call `loadPolicy(policyText)` as a side effect of hashing (`pinRepo` did). A policy text that does not parse used to throw there. The server already parses the same text at start (`composition.ts` `loadPolicy(policyText)`), so a bad policy never gets that far. Still, this changes what can throw at that line.
