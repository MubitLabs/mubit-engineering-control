/**
 * The proposal area, plan §16.4: agents may propose bundle edits; only the user applies them.
 *
 * This class is the API boundary where a human decision enters the system: apply() simulates the
 * user accepting a proposal. The server layer enforces the human — apply() may run only as the
 * direct result of a user action (an accepted card), never from an agent path, and the component
 * it returns still passes through compileBundle's validation before it becomes bundle text.
 */

import type { BundleComponent } from './bundles'
import { componentHash } from './bundles'

type Proposal = {
  id: string
  author: string
  component: BundleComponent
  status: 'proposed'
}

export class ProposalArea {
  #next = 1
  #proposals = new Map<string, Proposal>()

  /** An agent files a candidate edit. It never touches bundle text until the user applies it. */
  propose(author: string, component: BundleComponent): { id: string } {
    if (author === '') {
      throw new Error('A proposal must name its author')
    }
    const part = `${component.layer}/${component.name}`
    if (component.hash !== componentHash(component.text)) {
      throw new Error(`Proposal for '${part}' does not hash to its own text`)
    }
    if (component.origin === 'user_override' && component.defaultBaseHash === undefined) {
      throw new Error(`Proposal for '${part}' overrides a default but names no defaultBaseHash`)
    }
    const id = `prop_${this.#next++}`
    this.#proposals.set(id, { id, author, component, status: 'proposed' })
    return { id }
  }

  /** Every open proposal, in the order they arrived. */
  list(): Proposal[] {
    return [...this.#proposals.values()]
  }

  /** The user accepts; the proposal leaves the list and its component is handed to the bundle. */
  apply(id: string): BundleComponent | { error: 'unknown' } {
    const proposal = this.#proposals.get(id)
    if (proposal === undefined) {
      return { error: 'unknown' }
    }
    this.#proposals.delete(id)
    return proposal.component
  }
}
