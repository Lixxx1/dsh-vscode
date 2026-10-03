// Opt-in real-runtime contract check (no external model requests or user credentials).
// node tests/dsh-runtime-smoke.mjs /absolute/path/to/@deepseek-ai/dsh/lib/bin.js
// Add --tools to run deterministic tool/queue turns against a loopback model fixture.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'

const cli = process.argv[2]
const withTools = process.argv.includes('--tools')
assert(cli, 'Pass the absolute path to an installed DSH lib/bin.js; this test never installs or upgrades DSH.')
const version = JSON.parse(await readFile(join(dirname(resolve(cli)), '../package.json'), 'utf8')).version
const root = await mkdtemp(join(tmpdir(), 'dsh-sidebar-compat-'))
const workspace = join(root, 'workspace')
await mkdir(workspace)
const entry = join(root, 'client.cjs')
await build({ stdin: { contents: `export { DshConnection } from './src/dsh-connection.ts';
export { DshClient } from './src/dsh-client.ts'; export { redactDshSecrets } from './src/runtime-output.ts';
export { ConversationProjector } from './src/conversation.ts';`,
  resolveDir: process.cwd(), loader: 'ts' }, outfile: entry, bundle: true, platform: 'node', format: 'cjs',
  external: ['bufferutil', 'utf-8-validate'], logLevel: 'silent' })
const { DshConnection, DshClient, redactDshSecrets, ConversationProjector } = createRequire(import.meta.url)(entry)
let modelServer, requests = 0, releaseFirst
const firstResponse = new Promise(resolveFirst => { releaseFirst = resolveFirst })
const patchArgs = []
if (withTools) {
  modelServer = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) { response.writeHead(404); response.end(); return }
    let body = ''
    for await (const chunk of request) body += chunk.toString()
    const input = JSON.parse(body)
    // The runtime can concurrently ask this route for a session title. That
    // non-tool request must not consume the scripted agent turn or its gate.
    const index = input.tools?.length ? requests++ : -1
    if (index === 0) await firstResponse
    if (response.destroyed) return
    const tools = [
      ['write', { file_path: 'smoke.txt', content: 'Runtime smoke passed\n' }],
      ['read', { file_path: 'missing.txt' }],
      ['read', { file_path: 'smoke.txt' }],
      ...(version.startsWith('0.2.') ? [['bash', { command: 'node -e "setTimeout(() => {}, 30000)"',
        description: 'Start temporary compatibility test background process', run_in_background: true }]] : []),
    ]
    const tool = tools[index]
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (delta, finish_reason) => response.write(`data: ${JSON.stringify({ id: `smoke-${index}`, object: 'chat.completion.chunk',
      created: 1, model: 'smoke', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    send(tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${index}`, type: 'function', function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] }
      : { role: 'assistant', content: 'Runtime smoke passed.' }, null)
    send({}, tool ? 'tool_calls' : 'stop')
    response.end('data: [DONE]\n\n')
  })
  await new Promise((resolveListen, reject) => { modelServer.once('error', reject); modelServer.listen(0, '127.0.0.1', resolveListen) })
  const patch = join(root, 'smoke.patch.yml')
  await writeFile(patch, `- id: llm-pi-ai\n  config:\n    providers:\n      compat-smoke:\n        displayName: Compatibility smoke\n        api: openai-completions\n        apiKeyEnv: DSH_SMOKE_API_KEY\n        baseURL: http://127.0.0.1:${modelServer.address().port}/v1\n        models:\n          - id: smoke\n            name: Smoke\n            contextWindow: 65536\n            maxTokens: 1024\n`)
  patchArgs.push('--patch', patch)
}
// DSH loads .env only from this fresh DSH_HOME and invoking workspace. Do not
// inherit provider keys, user profile paths, proxy settings or DSH overrides.
const env = { DSH_HOME: join(root, 'home'), DSH_CWD: workspace, DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1' }
if (withTools) env.DSH_SMOKE_API_KEY = 'local-smoke-only'
for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key]
const child = spawn(process.execPath, [resolve(cli), 'web', ...patchArgs, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
  cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'],
})
let diagnostics = '', exited = false, connection, client
const exit = once(child, 'exit').then(() => { exited = true })
try {
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${redactDshSecrets(diagnostics)}`)), 90_000)
    const receive = chunk => {
      diagnostics = (diagnostics + chunk.toString()).slice(-32_000)
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/.exec(diagnostics)
      if (match) { clearTimeout(timer); resolveUrl(new URL(match[1])) }
    }
    child.stdout.on('data', receive); child.stderr.on('data', receive)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`DSH exited (${code}): ${redactDshSecrets(diagnostics)}`)) })
  })
  const frames = [], errors = []
  const connect = async () => {
    connection = new DshConnection(new URL(url.origin))
    await connection.authenticate(url)
    client = new DshClient(connection)
    client.onFrame(frame => {
      frames.push(frame.payload)
      // This isolated fixture issues only the four hardcoded local tools above.
      if (withTools && frame.payload.type === 'approval/requested') {
        void client.respond(frame.rpcId, { sessionId: frame.payload.sessionId, outcome: 'allowed-once' }).catch(error => errors.push(error))
      }
    })
    client.onError(error => errors.push(error))
    await client.startStreams()
  }
  const waitFor = async predicate => {
    const deadline = Date.now() + 15_000
    while (!predicate()) {
      assert.equal(errors.length, 0, errors.map(e => e.message).join('\n'))
      if (Date.now() > deadline) throw new Error(`Timed out waiting for runtime state: ${redactDshSecrets(JSON.stringify(frames.slice(-8)))}\n${redactDshSecrets(diagnostics.slice(-4000))}`)
      await delay(25)
    }
  }
  await connect()
  const first = await client.createSession(workspace)
  const second = await client.createSession(workspace)
  assert((await client.listSessions()).items.some(item => item.sessionId === first.sessionId))
  const opening = await client.openSession(first.sessionId); opening.activate()
  assert(!opening.events.some(entry => ['user/message', 'assistant/message'].includes(entry.event.type)))
  assert(Array.isArray((await client.models(first.sessionId)).groups))
  assert(Array.isArray((await client.listAgentPresets()).presets))
  assert(Array.isArray((await client.pluginInventory()).entries))
  await client.settings()
  await client.listSkills(first.sessionId)
  const commands = await client.listCommands(first.sessionId)
  assert(commands.some(command => command.name === 'permission'))
  const options = await client.permissionOptions()
  if (version.startsWith('0.2.')) assert(options?.some(option => option.value === 'workspace-write'))
  const command = await client.executeCommand(first.sessionId, '/permission workspace-write')
  assert.equal(command.result.kind, 'success')
  await waitFor(() => frames.some(frame => frame.type === 'session/projection' && frame.sessionId === first.sessionId
    && frame.key === 'permissions' && frame.value.currentValue === 'workspace-write'))
  if (version.startsWith('0.2.')) {
    await waitFor(() => [first, second].every(session => frames.some(frame => frame.type === 'host/jobs-status'
      && frame.sessionId === session.sessionId && frame.available === true)))
  }
  if (withTools) {
    await client.selectModel(first.sessionId, { provider: 'compat-smoke', model: 'smoke' })
    await client.prompt(first.sessionId, 'Create smoke.txt containing Runtime smoke passed, then read it back.')
    await waitFor(() => requests === 1)
    const queue = () => frames.filter(frame => frame.type === 'session/queue' && frame.sessionId === first.sessionId).at(-1)?.items ?? []
    await client.prompt(first.sessionId, 'Queued follow-up')
    await waitFor(() => queue().some(item => item.placement === 'queued'))
    const queued = queue().find(item => item.placement === 'queued')
    await client.updateQueue(first.sessionId, queued.id, { kind: 'edit', content: [{ type: 'text', text: 'Updated follow-up' }] })
    await waitFor(() => queue().some(item => item.id === queued.id && item.message.content.some(part => part.text === 'Updated follow-up')))
    await client.updateQueue(first.sessionId, queued.id, { kind: 'remove' })
    await waitFor(() => !queue().some(item => item.id === queued.id))
    await client.prompt(first.sessionId, 'Keep the test focused.', [], 'steer')
    await waitFor(() => queue().some(item => item.placement === 'steering') || frames.some(frame => frame.type === 'session/event'
      && frame.event.type === 'user/message' && frame.event.data.content?.some(part => part.text === 'Keep the test focused.')))
    releaseFirst()
    await waitFor(() => frames.some(frame => frame.type === 'session/event' && frame.sessionId === first.sessionId && frame.event.type === 'turn/end'))
    assert.equal(await readFile(join(workspace, 'smoke.txt'), 'utf8'), 'Runtime smoke passed\n')
    const live = new ConversationProjector()
    for (const frame of frames) if (frame.type === 'session/event' && frame.sessionId === first.sessionId) live.apply(frame.event)
    const tools = live.messages().filter(message => message.role === 'tool')
    assert.equal(tools.length, version.startsWith('0.2.') ? 4 : 3)
    assert.equal(tools.filter(message => message.failed).length, 1, tools.filter(message => message.failed).map(message => message.rawResult).join('\n'))
    assert(tools.every(message => message.rawResult?.length > 0))
    const replay = new ConversationProjector()
    const history = await client.openSession(first.sessionId); history.activate()
    replay.reset(history.events)
    assert.deepEqual(replay.messages().filter(message => message.role === 'tool'), tools)
    if (version.startsWith('0.2.')) {
      const jobs = () => frames.filter(frame => frame.type === 'session/jobs' && frame.sessionId === first.sessionId).at(-1)?.jobs ?? []
      await waitFor(() => jobs().some(job => job.status === 'running'))
      const job = jobs().find(job => job.status === 'running')
      await connection.call('job/kill', { request: { sessionId: first.sessionId, jobId: job.id } })
      await waitFor(() => jobs().some(item => item.id === job.id && ['killed', 'completed', 'failed'].includes(item.status)))
      console.log(`PASS ${version}: real background job running and kill settlement via job/list`)
    }
    console.log(`PASS ${version}: real streamed turn, Write/Read/failure results, queue edit/remove/steer and history replay`)
  }
  await client.renameSession(first.sessionId, 'Compatibility smoke')
  const other = await client.openSession(second.sessionId); other.activate()
  client.dispose(); connection.dispose()
  await connect()
  const restored = await client.openSession(first.sessionId); restored.activate()
  assert.equal(restored.projections.permissions.currentValue, 'workspace-write')
  await client.history(first.sessionId, 1)
  await client.archiveSession(second.sessionId)
  assert((await client.listWorkspaces()).archivedSessionIds.includes(second.sessionId))
  assert.equal(errors.length, 0, errors.map(e => e.message).join('\n'))
  console.log(JSON.stringify({ version, result: 'passed', checks: ['auth', 'control', 'create/list', 'follow', 'models',
    'presets', 'plugins', 'settings', 'skills', 'commands', 'permissions', 'switch', 'reconnect', 'history', 'archive',
    ...(version.startsWith('0.2.') ? ['permission catalog', 'job streams'] : [])], isolatedDirectory: root }))
} finally {
  client?.dispose(); connection?.dispose()
  releaseFirst()
  if (!exited) {
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    await exit.finally(() => clearTimeout(timer))
  }
  if (modelServer) {
    modelServer.closeAllConnections()
    await new Promise(resolveClose => modelServer.close(resolveClose))
  }
}
