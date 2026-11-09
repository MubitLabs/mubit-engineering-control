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

const NO_BROWSER = 'MEC could not open your browser for the link. Try again.'

/** The link, asked for once per press, and whether the last ask could not open a browser. */
function useLinkRequest() {
  const [failed, setFailed] = useState(false)
  const ask = async (): Promise<void> => setFailed(!(await requestApprovalLink()))
  return { failed, action: { label: 'Link this browser', onClick: () => void ask() } }
}

/** What a tab with no key says, wherever the owner's word is needed. Nothing once it has one. */
export function ApprovalLink({ purpose = 'answers' }: { purpose?: keyof typeof WORDS } = {}) {
  const { failed, action } = useLinkRequest()
  if (useApprovalKey()) return null
  const words = WORDS[purpose]
  return (
    <StateNotice kind="blocked" title={words.title} body={failed ? NO_BROWSER : words.body} action={action} />
  )
}

/**
 * A keyed action this tab sent unlinked (`approval_required`): what was refused, and the link in
 * place of a dead end. Once linked it says so, and the action is the owner's to press again.
 */
export function NotLinkedNotice({ text }: { text: string }) {
  const { failed, action } = useLinkRequest()
  const linked = useApprovalKey()
  return (
    <StateNotice
      kind="error"
      title="That did not go through"
      body={
        linked
          ? 'This browser is linked now. Nothing was done before: press it again.'
          : failed
            ? NO_BROWSER
            : text
      }
      {...(!linked && { action })}
    />
  )
}
