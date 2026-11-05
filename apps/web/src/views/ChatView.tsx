import { useEffect, useState } from 'react'
import { api, isNotServed, type WorkItemDetail } from '../api'
import { Btn } from '../components/base'
import { Composer } from '../components/Composer'
import { Conversation } from '../components/Conversation'
import { PaneHead } from '../components/Rail'
import { Tray, type TrayCard } from '../components/Tray'
import { useWorkbench } from '../workbench'

/**
 * Chat is the home screen: the live work item's name as the title, the tray
 * pinned above the conversation so a decision is never out of sight, and the
 * composer.
 */
export function ChatView() {
  const wb = useWorkbench()
  const live = wb.work.find((item) => item.state !== 'done' && item.state !== 'stopped')
  const [detail, setDetail] = useState<WorkItemDetail | null>(null)
  const liveId = live?.id

  useEffect(() => {
    let alive = true
    if (liveId === undefined) {
      setDetail(null)
      return
    }
    api
      .workItemDetail(liveId)
      .then((d) => {
        if (alive) setDetail(d)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [liveId])

  const knownTitle = detail !== null && detail.absent !== true ? detail.title : null
  const active = live?.taskCounts.byStatus.active ?? 0
  const sub =
    live === undefined
      ? 'Nothing in flight. Ask for something; the meta agent plans it and brings you only what needs a person.'
      : `${live.stage}. ${active} of ${live.taskCounts.total} task${live.taskCounts.total === 1 ? '' : 's'} running.`

  const cards: TrayCard[] = [
    ...wb.inbox.map((item) => ({ kind: 'decision' as const, item })),
    ...wb.questions.map((question) => ({ kind: 'question' as const, question })),
  ]

  const hold = async () => {
    if (live === undefined) return
    try {
      await api.holdWorkItem(live.id)
      wb.toast('Held.')
      wb.refresh()
    } catch (error) {
      wb.toast(isNotServed(error) ? 'Hold is not served by the server yet.' : 'Hold failed — try again.')
    }
  }

  const lift = async () => {
    if (live === undefined) return
    try {
      await api.liftWorkItem(live.id)
      wb.toast('Hold lifted.')
      wb.refresh()
    } catch (error) {
      wb.toast(
        isNotServed(error) ? 'Lift is not served by the server yet.' : 'Lift refused — the hold stays.',
      )
    }
  }

  // A stop is final (§18 "destructive actions confirm"): the first click arms, the second acts.
  const stopId = `stop:${liveId}`
  const stopArmed = wb.armedId === stopId
  const stop = async () => {
    if (live === undefined) return
    if (!stopArmed) {
      wb.arm(stopId)
      return
    }
    wb.disarm()
    try {
      await api.stopWorkItem(live.id)
      wb.toast('Stopped.')
      wb.refresh()
    } catch (error) {
      wb.toast(isNotServed(error) ? 'Stop is not served by the server yet.' : 'Stop failed — try again.')
    }
  }

  return (
    <section className="pane is-active" id="pane-chat" aria-labelledby="chat-title">
      <PaneHead title={knownTitle ?? 'Chat'} sub={sub}>
        {live === undefined ? null : (
          <>
            <Btn variant="quiet" onClick={() => wb.openContext({ kind: 'work', id: live.id })}>
              Details
            </Btn>
            {live.held === true ? (
              <Btn variant="quiet" onClick={() => void lift()}>
                Lift
              </Btn>
            ) : (
              <Btn variant="quiet" onClick={() => void hold()}>
                Hold
              </Btn>
            )}
            <Btn variant={stopArmed ? 'confirm' : 'quiet'} data-approve={stopId} onClick={() => void stop()}>
              {stopArmed ? 'Confirm stop' : 'Stop'}
            </Btn>
          </>
        )}
      </PaneHead>
      {cards.length > 0 ? <Tray cards={cards} /> : null}
      <Conversation messages={wb.messages} pending={wb.pendingMessages} />
      <Composer prefill={wb.composerPrefill} />
    </section>
  )
}
