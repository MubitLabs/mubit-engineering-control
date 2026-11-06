// What a test that plays the owner holds. The key is the one a starter hands in, so these tests stand
// where a script with `--approval-key-fd` stands; the route's refusal is `approval-key.test.ts`.
import { APPROVAL_HEADER, ApprovalKey } from '../src/approval'

export const TEST_KEY = 'a-test-owner-key-'.padEnd(64, '0')

/** For `buildServer`. */
export const ownerApproval = (): { key: ApprovalKey; link: (code: string) => void } => ({
  key: new ApprovalKey(TEST_KEY),
  link: () => {},
})

/** For a request that says the owner's word. */
export const ownerHeaders = { [APPROVAL_HEADER]: TEST_KEY }
