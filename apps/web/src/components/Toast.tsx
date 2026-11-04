import { useWorkbench } from '../workbench'

/** The toast: aria-live polite, one line, gone in 3.6 s. */
export function Toast() {
  const wb = useWorkbench()
  if (wb.toastText === null) return null
  return (
    <div className="toast" role="status" aria-live="polite">
      {wb.toastText}
    </div>
  )
}
