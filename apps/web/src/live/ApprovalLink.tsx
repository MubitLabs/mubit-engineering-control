import { useSyncExternalStore } from 'react'
import { approvalKey, onApprovalChange, requestApprovalLink } from '../approval'
import { StateNotice } from '../next/states'

export const useApprovalKey = (): boolean =>
  useSyncExternalStore(onApprovalChange, () => approvalKey() !== null)

/** What a tab with no key says, wherever the owner's word is needed. Nothing once it has one. */
export function ApprovalLink() {
  if (useApprovalKey()) return null
  return (
    <StateNotice
      kind="blocked"
      title="This browser cannot answer yet"
      body="Answers need a key that MEC gives only to a browser it opens itself, and a restart makes a new one. MEC opens a tab, and this one is then linked too."
      action={{ label: 'Link this browser', onClick: () => void requestApprovalLink() }}
    />
  )
}
