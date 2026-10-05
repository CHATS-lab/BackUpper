import { expect, mock, test } from 'claude-code/testing'

const VIEW = {
  project: '/tmp/demo',
  mode: 'checker',
  scope: 'Full',
  storeBytes: 2048,
  actions: [
    { seq: 1, call: 'Edit(config.json)', tier: 3, tierName: 'snapshot', artifact: '1 file' },
    { seq: 2, call: 'Bash(rm -rf build)', tier: 1, tierName: 'command rewriting', artifact: 'trash' },
  ],
  selected: 2,
  detail: ['ACTION   #2', 'RESTORE  press r to undo #2, or run: backupper restore 2'],
}

test('the pane lists captures and asks before restoring', async ($, on) => {
  const ran: string[][] = []
  mock.clock(on)
  on('session.start', async () => ({ cwd: '/tmp/demo' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', async () => ({ value: undefined }))
  on('fs.stat', async () => ({ value: { isFile: true } }) as never)
  on('process.run', async (_$, e) => {
    ran.push([...e.argv])
    const out = e.argv.includes('watch') ? JSON.stringify(VIEW) : '[OK] restored build\n'
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/tmp/demo' } as never)
  await $.command.run({ command: 'backupper-panel', args: '' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'backupper',
      surface,
      component: 'Pane',
      requestId: 'backupper',
      props: { title: 'BackUpper', isFocused: true, bodyColumns: 50, placement: 'dock' } as never,
    })
    expect(await ui.find({ type: 'Text', text: /Tier 1 command rewriting/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /rm -rf build/ })).toBeDefined()
    await ui.press({ key: 'restore' })
    expect(await ui.find({ type: 'Text', text: /Undo #2 and every later action/ })).toBeDefined()
    await ui.press({ key: 'no' })
    expect(await ui.find({ type: 'Text', text: /Restore cancelled/ })).toBeDefined()
    await ui.unmount()
  }
  expect(ran.some(a => a.includes('watch') && a.includes('--json'))).toBe(true)
  expect(ran.some(a => a.includes('restore'))).toBe(false)
})
