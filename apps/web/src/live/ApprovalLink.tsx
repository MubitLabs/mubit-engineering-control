import { useState, useSyncExternalStore } from 'react'
import { approvalKey, onApprovalChange, requestApprovalLink } from '../approval'
import { StateNotice } from '../next/states'

export const useApprovalKey = (): boolean =>
  useSyncExternalStore(onApprovalChange, () => approvalKey() !== null)

/** What a tab with no key says, wherever the owner's word is needed. Nothing once it has one. */
export function ApprovalLink() {
  const [failed, setFailed] = useState(false)
  if (useApprovalKey()) return null
  const ask = async (): Promise<void> => setFailed(!(await requestApprovalLink()))
  return (
    <StateNotice
      kind="blocked"
      title="This browser cannot answer yet"
      body={
        failed
          ? 'MEC could not open your browser for the link. Try again.'
          : 'Answers need a key that MEC gives only to a browser it opens itself, and a restart makes a new one. MEC opens a tab, and this one is then linked too.'
      }
      action={{ label: 'Link this browser', onClick: () => void ask() }}
    />
  )
}
