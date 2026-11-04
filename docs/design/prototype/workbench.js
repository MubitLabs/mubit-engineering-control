/* MEC workbench prototype — interaction model. No framework; the React port keeps the same
   behaviours (04_UI_DESIGN_SPEC.md §6): routes, the needs-you tray, two-step approval,
   question answering, the context pane, sheets, the command palette, keyboard shortcuts,
   theme, and toasts. Everything here answers a person's action; nothing moves on its own. */

(() => {
  const $ = (sel, root = document) => root.querySelector(sel)
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

  // ── Routes ─────────────────────────────────────────────────────────────────
  const routes = ['chat', 'needs', 'work', 'slots', 'setup', 'settings']
  function go(route) {
    if (!routes.includes(route)) route = 'chat'
    $$('.pane').forEach((p) => p.classList.toggle('is-active', p.id === `pane-${route}`))
    $$('.rail-item').forEach((a) => a.classList.toggle('is-active', a.dataset.route === route))
    if (location.hash !== `#${route}`) history.replaceState(null, '', `#${route}`)
    if (route === 'needs') mirrorTray()
    $('#main').scrollTop = 0
  }
  window.addEventListener('hashchange', () => go(location.hash.slice(1)))
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-route]')
    if (t) {
      e.preventDefault()
      go(t.dataset.route)
      closePalette()
    }
  })
  go(location.hash.slice(1) || 'chat')

  // The full Needs-you page shows the same cards as the tray (one source of truth).
  function mirrorTray() {
    const mirror = $('#needs-mirror')
    mirror.innerHTML = ''
    const clone = $('#tray').cloneNode(true)
    clone.id = 'tray-mirror'
    clone.querySelector('.tray-head').remove()
    clone.classList.remove('is-collapsed')
    mirror.appendChild(clone)
  }

  // ── Needs-you tray ─────────────────────────────────────────────────────────
  const tray = $('#tray')
  $('.tray-toggle').addEventListener('click', (e) => {
    const collapsed = tray.classList.toggle('is-collapsed')
    e.currentTarget.textContent = collapsed ? 'Show' : 'Collapse'
    e.currentTarget.setAttribute('aria-expanded', String(!collapsed))
  })

  function updateCounts() {
    const open = $$('#tray .decision:not(.is-resolved)').length
    $('#needs-count').textContent = String(open)
    $('.tray-count').textContent = String(open)
    $('#needs-count').classList.toggle('count-attention', open > 0)
    if (open === 0) {
      tray.querySelector('.tray-sub').textContent = 'Nothing waits for you.'
    }
  }

  // Two-step approval: the first click arms the button and names the effect; the second
  // click (or A again) performs it. Any other click, Esc, or 8 seconds disarms it.
  const armed = new Map()
  function disarm(id) {
    const btn = $(`[data-approve="${id}"]`)
    if (!btn) return
    btn.classList.remove('btn-confirm')
    btn.textContent = 'Approve'
    clearTimeout(armed.get(id))
    armed.delete(id)
  }
  function approve(id) {
    const btn = $(`[data-approve="${id}"]`)
    if (!btn) return
    if (!armed.has(id)) {
      btn.classList.add('btn-confirm')
      btn.textContent = 'Confirm: push and open PR'
      armed.set(id, setTimeout(() => disarm(id), 8000))
      return
    }
    disarm(id)
    resolve(id, 'Approved. Pushing mec/a1/release and opening the pull request.')
  }
  function deny(id) {
    resolve(id, 'Denied. The release agent was told the push was not approved.')
  }
  function resolve(id, message) {
    const card = $(`[data-decision="${id}"]`)
    card.classList.add('is-resolved')
    card.querySelectorAll('button').forEach((b) => (b.disabled = true))
    const side = card.querySelector('.expires')
    if (side) side.textContent = message.split('.')[0]
    toast(message)
    updateCounts()
    mirrorTrayIfVisible()
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-approve]')
    const d = e.target.closest('[data-deny]')
    const c = e.target.closest('[data-answer]')
    if (a) return approve(a.dataset.approve)
    if (d) return deny(d.dataset.deny)
    if (c) {
      $$(`[data-answer="${c.dataset.answer}"]`).forEach((x) => x.classList.remove('is-selected'))
      c.classList.add('is-selected')
      if (c.classList.contains('choice-other')) {
        go('chat')
        $('#composer-input').focus()
        $('#composer-input').value = 'About deleted users in the audit log: '
        return
      }
      const card = $(`[data-decision="${c.dataset.answer}"]`)
      setTimeout(() => {
        card.classList.add('is-resolved')
        card.querySelectorAll('button').forEach((b) => (b.disabled = true))
        toast(`Answered: ${c.textContent.trim()}. The console implementer continues.`)
        updateCounts()
        mirrorTrayIfVisible()
      }, 120)
      return
    }
    // any other click disarms
    for (const id of Array.from(armed.keys())) disarm(id)
  })
  function mirrorTrayIfVisible() {
    if ($('#pane-needs').classList.contains('is-active')) mirrorTray()
  }
  document.addEventListener('click', (e) => {
    const f = e.target.closest('[data-focus-decision]')
    if (f) {
      const card = $(`[data-decision="${f.dataset.focusDecision}"]`)
      tray.classList.remove('is-collapsed')
      card.focus()
      card.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  })

  // ── Context pane ───────────────────────────────────────────────────────────
  const context = $('#context')
  const CONTEXT = {
    conf_71: {
      title: 'Push and open a pull request',
      html: `
        <dl class="kv"><dt>Work item</dt><dd>Audit-log viewing</dd><dt>Operation</dt><dd class="mono">git push origin mec/a1/release<br>gh pr create</dd><dt>Head</dt><dd class="mono">4f2c9e1, bound to this card</dd><dt>Requested by</dt><dd>Release agent on max-2</dd><dt>If you approve</dt><dd>One branch is pushed, one PR opens as you. Nothing merges.</dd><dt>If you deny</dt><dd>The branch stays local; the agent is told it was not approved.</dd></dl>
        <h3>Checks on 4f2c9e1</h3>
        <ul class="checks"><li><span>lint</span><span class="state state-ok">passed in 12 s</span></li><li><span>typecheck</span><span class="state state-ok">passed in 41 s</span></li><li><span>unit</span><span class="state state-ok">passed in 2 m 03 s</span></li><li><span>integration</span><span class="state">not configured for this repo</span></li></ul>
        <h3>Findings</h3>
        <div class="finding"><b>Fixed, medium: console/AuditTable.tsx</b>Unescaped user-supplied filter rendered into the query string. Fixed in a1/repair-1, verified by the reviewer.</div>
        <div class="finding"><b>Declined, low: api/audit.ts</b>Reviewer suggested pagination by cursor. Declined: offset pagination matches the rest of the API; noted in the PR body.</div>
        <h3>Diff: 9 files, +412 −38</h3>
        <pre class="diff"><span class="add">+ api/audit.ts           +138</span>
<span class="add">+ api/audit.test.ts      +96</span>
<span class="add">+ console/AuditTable.tsx +121</span>
<span class="add">+ console/AuditPage.tsx  +41</span>
  db/migrations/0042.sql   +16 <span class="del">−0</span>
  …</pre>
        <p class="muted" style="font-size:12.5px">Full diff opens in your editor: <button class="link">Open in VS Code</button></p>`,
    },
    q_12: {
      title: 'Question from the console implementer',
      html: `
        <dl class="kv"><dt>Task</dt><dd>Console page with filters</dd><dt>Raised at</dt><dd>14:44, while working</dd><dt>What waits</dt><dd>Only the deleted-users column; everything else continues.</dd></dl>
        <h3>Evidence</h3>
        <pre class="diff">// console/AuditTable.tsx:88
const actor = row.user ?? <span class="del">???</span>
// users table rows are hard-deleted; audit rows keep user_id</pre>
        <p class="muted" style="font-size:12.5px">The API task already stores <span class="mono">user_id</span>; the question is only what the console shows.</p>`,
    },
    wi_a1: {
      title: 'Audit-log viewing',
      html: `
        <dl class="kv"><dt>Stage</dt><dd>Needs your approval</dd><dt>Started</dt><dd>14:02 from your message</dd><dt>Mandate</dt><dd>acme/console, default caps, no expiry</dd><dt>Policy</dt><dd class="mono">9c1e4b…</dd><dt>Bundle</dt><dd>revision 13</dd></dl>
        <h3>Tasks</h3>
        <ul class="checks"><li><span>Storage and API</span><span class="state state-ok">checks passed on max-2</span></li><li><span>Console page</span><span class="state state-attn">waiting on you</span></li><li><span>Tests</span><span class="state">queued for glm-1</span></li><li><span>Review</span><span class="state state-ok">accepted on glm-1</span></li><li><span>Security</span><span class="state state-ok">2 findings dispositioned on gem-1</span></li></ul>
        <h3>Handoffs</h3>
        <div class="finding"><b>14:38, max-1 → max-2</b>Five-hour window reached on max-1; continued on the same worktree under your pairing rule.</div>
        <h3>So far</h3>
        <dl class="kv"><dt>Your attention</dt><dd>2 cards, 1 question</dd><dt>Elapsed</dt><dd>1 h 51 m</dd><dt>Repairs</dt><dd>1</dd><dt>GLM credits</dt><dd>412</dd><dt>Gemini</dt><dd>$0.31</dd></dl>`,
    },
    task_api: { title: 'Storage and API for audit events', html: `<dl class="kv"><dt>Role</dt><dd>Implementer</dd><dt>Tier</dt><dd>balanced (sonnet, medium effort)</dd><dt>Slot</dt><dd>max-2 (after handoff from max-1)</dd><dt>Head</dt><dd class="mono">b71e3a0</dd><dt>State</dt><dd>Checks passed</dd></dl><h3>Report</h3><p style="font-size:12.5px">Ready: audit events table, migration 0042, GET /audit with filters and tests. Risk: offset pagination.</p>` },
    task_console: { title: 'Console page with filters', html: `<dl class="kv"><dt>Role</dt><dd>Implementer</dd><dt>Tier</dt><dd>balanced (sonnet, medium effort)</dd><dt>Slot</dt><dd>max-2</dd><dt>State</dt><dd>Waiting on your answer</dd></dl><p style="font-size:12.5px">The open question is in Needs you.</p>` },
    task_tests: { title: 'Tests for both', html: `<dl class="kv"><dt>Role</dt><dd>Test author</dd><dt>Tier</dt><dd>fast (glm-5.3-flash)</dd><dt>Slot</dt><dd>glm-1</dd><dt>State</dt><dd>Queued — starts when the console task is accepted</dd></dl>` },
    wi_b2: { title: 'Rate-limit headers on the public API', html: `<dl class="kv"><dt>Stage</dt><dd>Working</dd><dt>Tasks</dt><dd>1 of 2 running</dd><dt>Head</dt><dd class="mono">a91d0c3</dd></dl>` },
    wi_c3: { title: 'Flaky integration test in billing', html: `<dl class="kv"><dt>Stage</dt><dd>Waiting for quota</dd><dt>Parked on</dt><dd>max-1, resets 18:40</dd><dt>Worktree</dt><dd>preserved</dd></dl><p style="font-size:12.5px">Switch it to max-2 now, or let it resume at 18:40.</p>` },
    slot_codex1: { title: 'codex-1', html: `<dl class="kv"><dt>Engine</dt><dd>Codex 0.148.0</dd><dt>Account</dt><dd>ChatGPT Pro</dd><dt>State</dt><dd>Login expired since 13:20</dd><dt>Parked work</dt><dd>2 attempts</dd></dl><p style="font-size:12.5px">Sign in again opens Codex’s own login in a terminal card; parked work resumes after the next healthy probe.</p>` },
    slot_max1: { title: 'max-1', html: `<dl class="kv"><dt>Engine</dt><dd>Claude Code 2.1.317</dd><dt>Plan</dt><dd>Max</dd><dt>Five-hour</dt><dd>85%, resets 18:40</dd><dt>Weekly</dt><dd>41%</dd><dt>Pinned roles</dt><dd>meta agent, implementer</dd><dt>Pair</dt><dd>→ max-2</dd></dl>` },
    slot_max2: { title: 'max-2', html: `<dl class="kv"><dt>Engine</dt><dd>Claude Code 2.1.317</dd><dt>Plan</dt><dd>Max</dd><dt>Five-hour</dt><dd>31%</dd><dt>Weekly</dt><dd>22%</dd></dl>` },
    slot_glm1: { title: 'glm-1', html: `<dl class="kv"><dt>Engine</dt><dd>OpenCode 2.2.5</dd><dt>Provider</dt><dd>GLM Coding Plan, Pro</dd><dt>Key</dt><dd class="mono">…7f2a (fingerprint only)</dd><dt>Reading</dt><dd>no reading yet: the plan has no usage API</dd></dl>` },
    slot_gem1: { title: 'gem-1', html: `<dl class="kv"><dt>Engine</dt><dd>OpenCode 2.2.5</dd><dt>Provider</dt><dd>Gemini API, billing-linked</dd><dt>Spend today</dt><dd>$0.42 of $5.00</dd></dl>` },
  }
  function openContext(key) {
    const entry = CONTEXT[key]
    if (!entry) return
    $('#context-title').textContent = entry.title
    $('#context-body').innerHTML = entry.html
    context.hidden = false
    $('#context-close').focus({ preventScroll: true })
  }
  function closeContext() {
    context.hidden = true
  }
  $('#context-close').addEventListener('click', closeContext)
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-open-context],[data-context]')
    if (!t) return
    if (e.target.closest('button') && !e.target.closest('[data-open-context]')) return // row buttons act, not open
    openContext(t.dataset.openContext || t.dataset.context)
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-context]')) openContext(e.target.dataset.context)
  })

  // ── Sheets ─────────────────────────────────────────────────────────────────
  const scrim = $('#scrim')
  function openSheet(id) {
    $$('.sheet').forEach((s) => (s.hidden = s.id !== id))
    scrim.hidden = false
    const first = $(`#${id} input, #${id} button`)
    if (first) first.focus()
  }
  function closeSheets() {
    $$('.sheet').forEach((s) => (s.hidden = true))
    scrim.hidden = $('#palette').hidden
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-login]')) openSheet('sheet-login')
    if (e.target.closest('#open-key-form')) openSheet('sheet-key')
    if (e.target.closest('#add-slot')) openSheet('sheet-key')
    if (e.target.closest('[data-close-sheet]')) closeSheets()
  })
  scrim.addEventListener('click', () => {
    closeSheets()
    closePalette()
  })

  // ── Command palette ────────────────────────────────────────────────────────
  const palette = $('#palette')
  function openPalette() {
    palette.hidden = false
    scrim.hidden = false
    $('#palette-input').value = ''
    $('#palette-input').focus()
  }
  function closePalette() {
    palette.hidden = true
    if ($$('.sheet:not([hidden])').length === 0) scrim.hidden = true
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────
  let pendingG = false
  document.addEventListener('keydown', (e) => {
    const typing = e.target.matches('input, textarea, select')
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      palette.hidden ? openPalette() : closePalette()
      return
    }
    if (e.key === 'Escape') {
      if (!palette.hidden) return closePalette()
      if ($$('.sheet:not([hidden])').length) return closeSheets()
      for (const id of Array.from(armed.keys())) disarm(id)
      if (!context.hidden) return closeContext()
      return
    }
    if (typing) return
    if (e.key === '/') {
      e.preventDefault()
      go('chat')
      $('#composer-input').focus()
      return
    }
    if (pendingG) {
      pendingG = false
      const map = { n: 'needs', w: 'work', s: 'slots', c: 'chat' }
      if (map[e.key]) go(map[e.key])
      return
    }
    if (e.key === 'g') {
      pendingG = true
      setTimeout(() => (pendingG = false), 800)
      return
    }
    const cards = $$('.pane.is-active .decision:not(.is-resolved)')
    if (cards.length === 0) return
    const i = cards.indexOf(document.activeElement)
    if (e.key === 'j') cards[Math.min(cards.length - 1, i + 1)].focus()
    if (e.key === 'k') cards[Math.max(0, i - 1)].focus()
    const current = document.activeElement.closest('.decision')
    if (!current) return
    const id = current.dataset.decision
    if (e.key === 'a' && $(`[data-approve="${id}"]`)) approve(id)
    if (e.key === 'd' && $(`[data-deny="${id}"]`)) deny(id)
  })

  // ── Composer ───────────────────────────────────────────────────────────────
  const input = $('#composer-input')
  const grow = () => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(200, input.scrollHeight)}px`
  }
  input.addEventListener('input', grow)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      $('#composer').requestSubmit()
    }
  })
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    const li = document.createElement('li')
    li.className = 'msg msg-user'
    li.innerHTML = `<p></p><p class="msg-meta"><span>You</span><time>just now</time></p>`
    li.querySelector('p').textContent = text
    $('#conversation').appendChild(li)
    input.value = ''
    grow()
    const ack = document.createElement('li')
    ack.className = 'msg msg-agent'
    ack.innerHTML = `<p>On it.</p><p class="msg-meta"><span>Meta agent</span><time>sending…</time></p>`
    setTimeout(() => $('#conversation').appendChild(ack), 300)
    li.scrollIntoView({ block: 'end', behavior: 'smooth' })
  })
  $('#clear-context').addEventListener('click', () => ($('#composer-context').hidden = true))

  // ── Settings ───────────────────────────────────────────────────────────────
  document.addEventListener('click', (e) => {
    const s = e.target.closest('[data-settings]')
    if (!s) return
    $$('.settings-link').forEach((l) => l.classList.toggle('is-active', l === s))
    $$('.settings-section').forEach((sec) => sec.classList.toggle('is-active', sec.id === `settings-${s.dataset.settings}`))
  })
  const editor = $('.editor-text')
  const original = editor.value
  editor.addEventListener('input', () => ($('#savebar').hidden = editor.value === original))
  $('#discard').addEventListener('click', () => {
    editor.value = original
    $('#savebar').hidden = true
  })
  $('#save').addEventListener('click', () => {
    $('#savebar').hidden = true
    toast('Saved as revision 14. Running attempts keep revision 13.')
  })
  $$('.part').forEach((p) =>
    p.addEventListener('click', () => {
      $$('.part').forEach((x) => x.classList.toggle('is-active', x === p))
    }),
  )

  // ── Theme ──────────────────────────────────────────────────────────────────
  $$('.theme button').forEach((b) =>
    b.addEventListener('click', () => {
      const t = b.dataset.theme
      $$('.theme button').forEach((x) => x.classList.toggle('is-active', x === b))
      if (t === 'auto') delete document.documentElement.dataset.theme
      else document.documentElement.dataset.theme = t
    }),
  )

  // ── Toast ──────────────────────────────────────────────────────────────────
  let toastTimer
  function toast(text) {
    const el = $('#toast')
    el.textContent = text
    el.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (el.hidden = true), 3600)
  }

  // expose for screenshots
  window.__mec = { go, openContext, openSheet, openPalette, toast }
})()
