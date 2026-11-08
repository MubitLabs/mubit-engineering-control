import { useState, useSyncExternalStore } from 'react'
import { approvalKey, onApprovalChange, requestApprovalLink } from '../approval'
import { StateNotice } from '../next/states'

export const useApprovalKey = (): boolean =>
  useSyncExternalStore(onApprovalChange, () => approvalKey() !== null)

const WORDS = {
  answers: {
    title: 'This browser cannot answer yet',
    body: 'Answers need a key that MEC gives only to a browser it opens itself, and a restart makes a new one. MEC opens a tab, and this one is then linked too.',
  },
  // Owner ruling, 8 November 2026: a chat message is the owner's word too.
  chat: {
    title: 'This browser cannot send yet',
    body: 'Messages need a key that MEC gives only to a browser it opens itself, and a restart makes a new one. Your draft stays here. MEC opens a tab, and this one is then linked too.',
  },
} as const

/** What a tab with no key says, wherever the owner's word is needed. Nothing once it has one. */
export function ApprovalLink({ purpose = 'answers' }: { purpose?: keyof typeof WORDS } = {}) {
  const [failed, setFailed] = useState(false)
  if (useApprovalKey()) return null
  const ask = async (): Promise<void> => setFailed(!(await requestApprovalLink()))
  const words = WORDS[purpose]
  return (
    <StateNotice
      kind="blocked"
      title={words.title}
      body={failed ? 'MEC could not open your browser for the link. Try again.' : words.body}
      action={{ label: 'Link this browser', onClick: () => void ask() }}
    />
  )
}
