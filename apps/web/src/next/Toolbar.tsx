import type { RefObject } from 'react'
import { Button, CommandIcon, IconButton, MenuIcon, PanelIcon } from './primitives'

interface ToolbarProps {
  repositoryName: string
  routeLabel: string
  /** The drawer's opener, present only at drawer width. */
  menu?: { open: boolean; onOpen: () => void; ref: RefObject<HTMLButtonElement | null> }
  /** Present only when this route has something to inspect. */
  details?: { open: boolean; onToggle: () => void; ref: RefObject<HTMLButtonElement | null> }
  paletteRef: RefObject<HTMLButtonElement | null>
  onOpenPalette: () => void
}

export function Toolbar({
  repositoryName,
  routeLabel,
  menu,
  details,
  paletteRef,
  onOpenPalette,
}: ToolbarProps) {
  return (
    <header className="toolbar">
      {menu && (
        <IconButton
          ref={menu.ref}
          label="Open navigation"
          aria-haspopup="dialog"
          aria-expanded={menu.open}
          onClick={menu.onOpen}
        >
          <MenuIcon />
        </IconButton>
      )}
      <div className="breadcrumb">
        <span className="breadcrumb-repo">{repositoryName}</span>
        <span aria-hidden="true">/</span>
        <strong>{routeLabel}</strong>
      </div>
      <div className="toolbar-actions">
        {menu ? (
          <IconButton ref={paletteRef} label="Open commands" aria-haspopup="dialog" onClick={onOpenPalette}>
            <CommandIcon />
          </IconButton>
        ) : (
          <Button
            ref={paletteRef}
            variant="quiet"
            aria-label="Open commands"
            aria-haspopup="dialog"
            onClick={onOpenPalette}
          >
            <kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K'}</kbd>
          </Button>
        )}
        {details && (
          <IconButton
            ref={details.ref}
            label={details.open ? 'Close details' : 'Open details'}
            aria-expanded={details.open}
            onClick={details.onToggle}
          >
            <PanelIcon />
          </IconButton>
        )}
      </div>
    </header>
  )
}
