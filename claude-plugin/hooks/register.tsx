/**
 * BackUpper side panel for Claude Code. `/backupper-panel` toggles a pane beside the transcript
 * that lists what each tool call captured, and restores the selected one on `r` then `y`.
 *
 * The data comes from the BackUpper CLI this plugin ships with (`../dist/cli.js`, or
 * `backupper` on PATH), as `backupper watch --json`; the pane only draws it.
 */
import type { EngineInterface, Register } from 'claude-code'

const PANE = 'backupper'
const TIER_COLOR: Record<number, string> = { 1: 'green', 2: 'cyan', 3: 'yellow', 4: 'magenta' }

type Row = { seq: number; call: string; tier: number | null; tierName: string | null; artifact: string | null }
type View = {
  project: string
  mode: string
  scope: string
  storeBytes: number
  actions: Row[]
  selected: number | null
  detail: string[]
}

// What the pane shows; rebuilt from the CLI on every refresh.
let view: View | null = null
let error = ''
let selected: number | null = null
let followTail = true
let confirm = false
let busy = false
let message: string[] = []
let diff: string[] | null = null
let cli: string[] | null = null
let paneOpen = false
let paneWidth = 54

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** The CLI to run: the copy beside this plugin, else `backupper` on PATH. */
async function findCli($: EngineInterface): Promise<string[]> {
  if (cli) return cli
  const local = `${$.plugin.root}/../dist/cli.js`
  try {
    await $.fs.stat(local)
    cli = ['node', local]
  } catch {
    cli = ['backupper']
  }
  return cli
}

async function runCli($: EngineInterface, args: string[], timeoutMs = 30_000) {
  return $.process.run([...(await findCli($)), ...args], { timeoutMs })
}

async function refresh($: EngineInterface): Promise<void> {
  try {
    const args = ['watch', '--json', '--width', String(paneWidth)]
    if (!followTail && selected !== null) args.push('--select', String(selected))
    const r = await runCli($, args)
    if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n')[0] || `exit ${r.exitCode}`)
    view = JSON.parse(r.stdout) as View
    error = ''
    if (followTail || !view.actions.some(a => a.seq === selected)) selected = view.selected
  } catch (e) {
    error = `BackUpper: ${(e as Error).message}`
  }
  $.ui.invalidate('ui.render')
}

function move($: EngineInterface, d: number): void {
  const list = view?.actions ?? []
  if (!list.length) return
  const i = Math.max(0, list.findIndex(a => a.seq === selected))
  const j = Math.max(0, Math.min(list.length - 1, i + d))
  selected = list[j]?.seq ?? selected
  followTail = j === list.length - 1
  confirm = false
  message = []
  diff = null
  void refresh($)
}

async function restore($: EngineInterface): Promise<void> {
  if (selected === null) return
  confirm = false
  busy = true
  message = [`Restoring #${selected}…`]
  $.ui.invalidate('ui.render')
  try {
    const r = await runCli($, ['restore', String(selected)], 120_000)
    message = (r.stdout + r.stderr).split('\n').filter(l => /\[(OK|FAIL)\]|Nothing|needs an agent/.test(l)).slice(-6)
    if (!message.length) message = [r.exitCode === 0 ? `Restored #${selected}.` : `Restore of #${selected} failed.`]
  } catch (e) {
    message = [`[FAIL] restore #${selected}: ${(e as Error).message}`]
  }
  busy = false
  followTail = true
  await refresh($)
}

async function toggleDiff($: EngineInterface): Promise<void> {
  if (diff) {
    diff = null
    $.ui.invalidate('ui.render')
    return
  }
  if (selected === null) return
  const r = await runCli($, ['diff', String(selected)])
  diff = (r.stdout || r.stderr).replace(/\x1b\[[0-9;]*m/g, '').split('\n')
  $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'backupper-panel',
      description: 'Toggle the BackUpper side panel (what each tool call captured, with restore)',
      immediate: true,
    })
    // Refresh while the pane is open; tool calls refresh it sooner.
    $.clock.every(5_000, () => {
      if (paneOpen && !busy) void refresh($)
    })
    // `backupper config set panel true`: open the pane with the session (it docks from 144 columns).
    void (async () => {
      try {
        if (JSON.parse(await $.fs.read('.backupper/config.json')).panel !== true) return
        await refresh($)
        await $.ui.open({ id: PANE, title: 'BackUpper', columns: 56 })
        paneOpen = true
      } catch { /* no project config: stay closed */ }
    })()
    return next(e)
  })

  on('command.run', { command: 'backupper-panel' }, async ($, e) => {
    if (paneOpen) {
      await $.ui.close({ id: PANE })
      return {}
    }
    await refresh($)
    const opened = await $.ui.open({ id: PANE, title: 'BackUpper', columns: 56 })
    paneOpen = true
    if (!opened.isPlaced) {
      paneOpen = false
      // Nothing draws here (the VS Code chat panel, -p): answer with the list instead.
      const r = await runCli($, ['list', '--limit', '10'])
      return { text: r.stdout.trim() || error || 'No actions recorded yet.' }
    }
    return {}
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    // BackUpper's PreToolUse hook has written the action by now.
    if (paneOpen && !busy) void refresh($)
    return result
  })

  on('ui.close', async ($, e, next) => {
    // However the pane closes (our x, the person's close mark, ctrl+x x), stop refreshing.
    if (e.id === PANE) paneOpen = false
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(e.props.bodyColumns, 20)
    paneWidth = width
    const rows: JSX.Element[] = []

    if (view) {
      rows.push(
        <Text bold>{`${view.project.split('/').pop() || view.project}`}</Text>,
        <Text dimColor wrap="truncate-end">{`mode ${view.mode} · ${view.scope} · ${formatBytes(view.storeBytes)}`}</Text>,
        <Text> </Text>,
      )
    }
    if (error) rows.push(<Text color="red" wrap="wrap">{error}</Text>)

    if (diff) {
      for (const l of diff.slice(0, 200)) {
        const color = l.startsWith('+') && !l.startsWith('+++') ? 'green'
          : l.startsWith('-') && !l.startsWith('---') ? 'red'
          : l.startsWith('@@') ? 'cyan' : undefined
        rows.push(<Text color={color} wrap="truncate-end">{l || ' '}</Text>)
      }
    } else if (view && !view.actions.length) {
      rows.push(<Text dimColor wrap="wrap">No actions recorded yet. Captures appear here as the agent works.</Text>)
    } else if (view) {
      for (const a of view.actions) {
        const isSel = a.seq === selected
        rows.push(
          <Box flexDirection="row">
            <Text inverse={isSel} bold>{`${isSel ? '›' : ' '} #${a.seq} `}</Text>
            {a.tier !== null
              ? <Text color={TIER_COLOR[a.tier]} wrap="truncate-end">{`Tier ${a.tier} ${a.tierName}`}</Text>
              : <Text dimColor>no capture</Text>}
            {a.artifact ? <Text wrap="truncate-end">{` · ${a.artifact}`}</Text> : null}
          </Box>,
          <Text dimColor wrap="truncate-end">{`    ${a.call.replace(/\s+/g, ' ')}`}</Text>,
        )
      }
      if (view.detail.length) {
        rows.push(<Text dimColor>{'─'.repeat(width)}</Text>)
        for (const l of view.detail) {
          rows.push(
            <Box flexDirection="row">
              <Text bold>{l.slice(0, 9)}</Text>
              <Text wrap="truncate-end">{l.slice(9)}</Text>
            </Box>,
          )
        }
      }
    }

    for (const m of message) rows.push(<Text wrap="truncate-end">{m}</Text>)

    const controls = confirm
      ? [
          <Text color="yellow" bold>{`Undo #${selected} and every later action?`}</Text>,
          <Button key="yes" label="yes" hotkey="y" plain onPress={() => void restore($)} />,
          <Button key="no" label="no" hotkey="n" plain onPress={() => { confirm = false; message = ['Restore cancelled.']; $.ui.invalidate('ui.render') }} />,
        ]
      : busy
        ? [<Text dimColor>working…</Text>]
        : [
            <Button key="prev" label="up" hotkey="k" plain onPress={() => move($, -1)} />,
            <Button key="next" label="down" hotkey="j" plain onPress={() => move($, 1)} />,
            <Button key="restore" label="restore" hotkey="r" plain onPress={() => { if (selected !== null) { confirm = true; diff = null; $.ui.invalidate('ui.render') } }} />,
            <Button key="diff" label={diff ? 'back' : 'diff'} hotkey="d" plain onPress={() => void toggleDiff($)} />,
            <Button key="close" label="close" hotkey="x" plain onPress={() => void $.ui.close({ id: PANE })} />,
          ]

    return (
      <Box flexDirection="column">
        {rows}
        <Text> </Text>
        <Box flexDirection="row" columnGap={2} flexWrap="wrap">{controls}</Box>
        {e.props.isFocused ? null : <Text dimColor>ctrl+x tab to use these keys · esc back to the prompt</Text>}
      </Box>
    )
  })
}
