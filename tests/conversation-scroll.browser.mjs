// Real Chromium layout/event-order regression tests. Run after `pnpm build`.
// Set DSH_TEST_BROWSER if Chrome/Chromium is installed at a nonstandard path.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import WebSocket from 'ws'

const candidates = [process.env.DSH_TEST_BROWSER,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
    .filter(Boolean).map(root => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
]
const browser = candidates.find(path => path && existsSync(path))
assert.ok(browser, 'Set DSH_TEST_BROWSER to a Chrome/Chromium executable.')
const root = new URL('../', import.meta.url)
const [{ outputFiles }, markdown, scrollBundle] = await Promise.all([
  build({ entryPoints: [fileURLToPath(new URL('src/webview.ts', root))], bundle: true, platform: 'node', format: 'cjs', write: false }),
  readFile(new URL('dist/webview/markdown.js', root), 'utf8'),
  readFile(new URL('dist/webview/scroll.js', root), 'utf8'),
])
const module = { exports: {} }
new Function('module', 'exports', outputFiles[0].text)(module, module.exports)
const uri = name => ({ toString: () => `https://assets.invalid/${name}` })
const html = module.exports.chatHtml({ cspSource: 'https://assets.invalid' }, uri('mark.svg'), {
  script: uri('markdown.js'), style: uri('katex.css'), scroll: uri('scroll.js'),
})
const inline = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1]
// Load the same built scripts explicitly; no external network or VS Code API.
const shell = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '')
const profile = await mkdtemp(join(tmpdir(), 'dsh-scroll-browser-'))
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--remote-debugging-port=0', ...(process.env.DSH_TEST_BROWSER_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), `--user-data-dir=${profile}`, 'about:blank'],
{ stdio: ['ignore', 'ignore', 'pipe'] })
const exited = once(child, 'exit')
let socket
const timeout = setTimeout(() => { console.error('Browser scroll test timed out'); socket?.terminate(); child.kill(); process.exitCode = 1 }, 60_000)
try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    child.stderr.on('data', chunk => {
      output += chunk
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) resolve(match[1])
    })
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`Browser exited: ${code}`)))
  })
  socket = new WebSocket(endpoint)
  await once(socket, 'open')
  const pending = new Map()
  let id = 0
  socket.on('message', raw => {
    const response = JSON.parse(raw)
    const request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    if (response.error) request.reject(new Error(JSON.stringify(response.error)))
    else request.resolve(response.result)
  })
  socket.on('close', () => { for (const request of pending.values()) request.reject(new Error('Browser disconnected')); pending.clear() })
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params, sessionId }))
  })
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
  const page = (method, params) => call(method, params, sessionId)
  const evaluate = async expression => {
    const result = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await page('Emulation.setDeviceMetricsOverride', { width: 410, height: 720, deviceScaleFactor: 1, mobile: false })
  await page('Page.enable')
  await page('Page.bringToFront')
  const { frameTree } = await page('Page.getFrameTree')
  await page('Page.setDocumentContent', { frameId: frameTree.frame.id, html: shell })
  await evaluate(`window.sent = []; window.acquireVsCodeApi = () => ({postMessage: message => sent.push(message)});
    document.documentElement.style.cssText = '--vscode-foreground:#cccccc;--vscode-sideBar-background:#181818;--vscode-editor-background:#202020;--vscode-font-family:Arial;--vscode-editor-font-family:monospace;--vscode-descriptionForeground:#999;--vscode-widget-border:#454545;--vscode-focusBorder:#4d6bfe;--vscode-button-secondaryBackground:#333;--vscode-button-secondaryForeground:#fff;--vscode-button-secondaryHoverBackground:#454545;--vscode-widget-shadow:#0006;--vscode-textLink-foreground:#65aaff';`)
  await evaluate(`document.documentElement.style.setProperty('--vscode-menu-background', '#252526'); document.documentElement.style.setProperty('--vscode-toolbar-hoverBackground', '#ffffff12');`)
  await evaluate(markdown); await evaluate(scrollBundle); await evaluate(inline)
  await evaluate(`window.tick = (ms = 90) => new Promise(resolve => setTimeout(resolve, ms));
    window.ensure = (value, message) => { if (!value) throw new Error(message); };
    window.gap = () => elements.scroll.scrollHeight - elements.scroll.scrollTop - elements.scroll.clientHeight;
    window.baseline = {phase:'ready',sessionId:'a',workspaceName:'scroll-demo',cwd:'/demo',sessions:[{id:'a',title:'Auto-scroll regression'}],models:[],permissions:[],commands:[],skills:[],queue:[],changedFiles:[],messages:[{id:'reply',role:'assistant',text:'# Streaming reply\\n\\n' + 'Paragraph of output.\\n\\n'.repeat(40),streaming:true}]};
    window.showState = value => window.dispatchEvent(new MessageEvent('message', {data:{type:'state',state:value}}));
    showState(baseline);`)
  await evaluate('tick()')
  assert.equal(await evaluate('gap() <= 2 && conversationScroller.following'), true)

  for (const width of [180, 260, 300, 410]) {
    await page('Emulation.setDeviceMetricsOverride', { width, height: 720, deviceScaleFactor: 1, mobile: false })
    await evaluate(`(async () => {
      showState({...baseline,sessionId:'usage-layout'}); await tick();
      const composerHeight = document.querySelector('.composer').getBoundingClientRect().height;
      const usage = {available:true,percent:19,usedTokens:199790,contextWindow:1048576,
        breakdown:{systemTokens:16,toolsTokens:397,messageTokens:148918},
        sessionStats:{turns:9999,steps:99999,llmMs:1000,toolMs:1000,ttftMs:13000,ttftSteps:1,decodeMs:1000,decodeTokens:188},
        tokenUsage:{uncachedInputTokens:100000,cacheReadTokens:98000000,cacheWriteTokens:200000,outputTokens:1000000}};
      showState({...state,usage}); await tick();
      ensure(!document.getElementById('usageStats'), 'metrics strip still exists');
      ensure(document.querySelector('.composer').getBoundingClientRect().height === composerHeight, 'usage adds composer rows');
      ensure(elements.usagePanel.classList.contains('hidden'), 'usage opened without interaction');
      elements.usageTrigger.click(); await tick();
      const panel = elements.usagePanel, details = panel.querySelector('.usage-details'), summary = details.querySelector('summary');
      ensure(!details.open, 'advanced statistics should start collapsed');
      ensure(panel.textContent.includes('Input tokens98M') && panel.textContent.includes('Output tokens1M'), 'cumulative counts missing');
      ensure(!panel.textContent.includes('Reference cost'), 'reference cost still displayed');
      details.open = true; await tick();
      summary.focus(); panel.scrollTop = 30;
      const scrollTop = panel.scrollTop;
      showState({...state,usage:{...usage,tokenUsage:{...usage.tokenUsage,outputTokens:1200000}}}); await tick();
      ensure(panel.querySelector('.usage-details') === details && details.open, 'streaming replaced or collapsed details');
      ensure(document.activeElement === summary, 'streaming lost detail focus');
      ensure(panel.scrollTop === scrollTop, 'streaming reset usage scroll');
      const bounds = panel.getBoundingClientRect();
      ensure(bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight, 'usage escaped viewport');
      ensure(panel.scrollWidth <= panel.clientWidth + 1, 'usage overflowed horizontally');
      elements.usageTrigger.click(); await tick();
      showState({...baseline,sessionId:'usage-next'}); await tick();
      elements.usageTrigger.click(); await tick();
      ensure(!details.open && details.classList.contains('hidden'), 'new session retained advanced statistics');
      ensure(panel.querySelector('.usage-session .usage-rows').textContent === '', 'new session retained token counts');
      elements.usageTrigger.click(); showState(baseline); await tick();
    })()`)
  }
  console.log('PASS: compact composer and on-demand session usage at 180, 260, 300, and 410px')
  await page('Emulation.setDeviceMetricsOverride', { width: 410, height: 720, deviceScaleFactor: 1, mobile: false })
  if (process.env.DSH_USAGE_SCREENSHOT) {
    await evaluate(`(async () => {
      showState({...baseline,usage:{available:true,percent:19,usedTokens:199790,contextWindow:1048576,
        sessionStats:{decodeMs:1000,decodeTokens:188,ttftMs:748,ttftSteps:1},
        tokenUsage:{uncachedInputTokens:10000,cacheReadTokens:118000,cacheWriteTokens:0,outputTokens:3000}}});
      elements.usageTrigger.click(); await tick();
    })()`)
    const { data } = await page('Page.captureScreenshot', { format: 'png' })
    await writeFile(process.env.DSH_USAGE_SCREENSHOT, Buffer.from(data, 'base64'))
    await evaluate('elements.usageTrigger.click(); showState(baseline); tick()')
  }

  // The actual production controller, with two renders bracketing its rAF write.
  await evaluate(`(async () => {
    const append = () => { const row = document.createElement('div'); row.style.height='160px'; elements.messages.append(row); };
    await new Promise(resolve => requestAnimationFrame(() => {
      append(); conversationScroller.changed();
      requestAnimationFrame(() => { append(); conversationScroller.changed(); resolve(); });
    }));
    await tick(); ensure(conversationScroller.following && gap() <= 2, 'issue #30: lost follow intent');
  })()`)
  console.log('PASS: programmatic scroll + overlapping streamed layout (#30)')

  // Browser-dispatched wheel input, not a synthetic scroll callback.
  await page('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 220, deltaX: 0, deltaY: -220 })
  await evaluate('tick()')
  assert.equal(await evaluate('!conversationScroller.following && gap() > 100'), true)
  await evaluate(`window.readingTop = elements.scroll.scrollTop; showState({...baseline,messages:[...baseline.messages,{id:'table',role:'assistant',text:'| Item | Value |\\n| --- | --- |\\n' + '| Result | 123 |\\n'.repeat(30)}]});`)
  await evaluate('tick()')
  assert.equal(await evaluate('!conversationScroller.following && Math.abs(elements.scroll.scrollTop-readingTop)<2 && !document.getElementById("jumpLatest").hidden'), true)
  console.log('PASS: native upward wheel + large Markdown table keeps the reader in place')

  await evaluate(`document.getElementById('jumpLatest').focus()`)
  await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 })
  await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await evaluate('tick()')
  assert.deepEqual(await evaluate('({following:conversationScroller.following, atBottom:gap()<=2, focus:document.activeElement.id})'), {following:true,atBottom:true,focus:'scroll'})
  console.log('PASS: keyboard-activated Jump to latest restores following and focus')

  await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 })
  await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 })
  await evaluate('tick(200)')
  assert.equal(await evaluate('!conversationScroller.following && gap() > 20'), true)
  console.log('PASS: native keyboard navigation pauses following')

  await evaluate(`(async () => {
    const first = {id:'t1',role:'tool',text:'First',streaming:true,callView:{title:'first command'},deferredBody:true};
    const second = {id:'t2',role:'tool',text:'Second',streaming:true,callView:{title:'latest command'},resultView:{title:'result preview'},deferredBody:true};
    const separator = {id:'separator',role:'assistant',text:'Between groups'};
    showState({...baseline,sessionId:'grouping',messages:[...baseline.messages,first,second,separator,{id:'t3',role:'tool',text:'Third',failed:true}]}); await tick();
    const groups = [...document.querySelectorAll('details.tool-group')];
    ensure(groups.length===2 && groups.every(group=>!group.open), 'contiguous chronology or default group state');
    ensure(groups[0].querySelector(':scope > summary .tool-title').textContent==='latest command', 'latest call title');
    ensure(groups[1].querySelector(':scope > summary .tool-title').textContent==='Called 1 tool', 'failed group summary');
    ensure(groups[1].querySelector(':scope > summary .tool-icon').getAttribute('aria-label')==='One or more tools failed', 'failed group status');
    groups[1].querySelector(':scope > summary').click(); await tick();
    ensure(!groups[1].querySelector('details.tool').open, 'failed call opened automatically');
    groups[1].querySelector(':scope > summary').click(); await tick();
    ensure(!sent.some(message=>message.type==='load-tool-output'), 'closed groups requested output');
    showState({...state,messages:[...baseline.messages,first,{...second,streaming:false},separator,{id:'t3',role:'tool',text:'Third',failed:true}]}); await tick();
    ensure(groups[0].querySelector(':scope > summary .tool-title').textContent==='latest command', 'parallel completion changed latest call');
    showState({...state,messages:[...baseline.messages,{...first,streaming:false},{...second,streaming:false},separator,{id:'t3',role:'tool',text:'Third',failed:true}]}); await tick();
    ensure(!groups[0].open && groups[0].querySelector(':scope > summary .tool-title').textContent==='Called 2 tools', 'completed group did not stay closed');
    groups[0].querySelector(':scope > summary').click(); await tick();
    ensure(!conversationScroller.following && groups[0].open, 'group expansion must pause following');
    const calls = [...groups[0].querySelectorAll('details.tool')];
    ensure(calls.length===2 && calls.every(call=>!call.open), 'individual calls opened automatically');
    ensure(!sent.some(message=>message.type==='load-tool-output'), 'group expansion requested output');
    calls[0].querySelector(':scope > summary').click(); await tick();
    ensure(sent.filter(message=>message.type==='load-tool-output').length===1 && sent.find(message=>message.type==='load-tool-output').messageId==='t1', 'individual expansion did not request its output');
    calls[0].querySelector(':scope > summary').click();
    groups[0].querySelector(':scope > summary').click();
    showState({...state,messages:state.messages.map(message=>message.id==='t1'?{...message,detail:'updated'}:message)}); await tick();
    ensure(!groups[0].open && !groups[0].querySelector('details.tool').open, 'explicit collapse lost on update');
    groups[0].querySelector(':scope > summary').click(); await tick();
    ensure(!groups[0].querySelector('details.tool').open, 'individual collapse did not persist');
    showState({...state,hasMoreHistory:true}); await tick();
    groups[0].querySelector(':scope > summary').scrollIntoView(); await tick();
    document.querySelector('.history-button').click();
    const summary = groups[0].querySelector(':scope > summary'); const before = summary.getBoundingClientRect().top;
    showState({...state,hasMoreHistory:false,loadingHistory:false,messages:[...baseline.messages,{id:'older-tool',role:'tool',text:'Older'},...state.messages.slice(1)]}); await tick();
    ensure(document.querySelector('details.tool-group')===groups[0] && groups[0].open, 'history prepend replaced group or lost expansion');
    ensure(Math.abs(summary.getBoundingClientRect().top-before)<2, 'group history anchor drifted');
    showState({...baseline,sessionId:'group-reset',messages:[{...first,streaming:false}]}); await tick();
    ensure(!document.querySelector('details.tool-group').open && !document.querySelector('details.tool').open, 'session switch retained expansion');
  })()`)
  console.log('PASS: tool grouping, parallel status, disclosure, deferred output, history, and session reset')

  await evaluate(`(async () => {
    const tool = {id:'race-tool',role:'tool',text:'Deferred',deferredBody:true};
    const requests = () => sent.filter(message=>message.type==='load-tool-output' && message.messageId==='race-tool').length;
    sent.length = 0;
    render({...baseline,sessionId:'race',messages:[tool]});
    let current = document.querySelector('details.tool');
    current.open = true;
    render({...state,messages:[{...tool,detail:'first replacement'}]});
    current = document.querySelector('details.tool');
    ensure(current.open, 'replacement lost open state before toggle');
    render({...state,messages:[{...tool,detail:'second replacement'}]});
    ensure(document.querySelector('details.tool').open, 'repeated replacement lost open state');
    await tick();
    ensure(requests()===1, 'open replacements requested output more than once');
    current = document.querySelector('details.tool'); current.open = false;
    render({...state,messages:[{...tool,detail:'collapsed replacement'}]});
    ensure(!document.querySelector('details.tool').open, 'replacement lost collapsed state before toggle');
    await tick();
    ensure(requests()===1, 'collapsed replacement requested output');
    render({...state,messages:[]});
    render({...state,messages:[tool]});
    ensure(!document.querySelector('details.tool').open, 'reintroduced tool did not default closed');
    sent.length = 0;
    current = document.querySelector('details.tool'); current.open = true; current.open = false;
    render({...state,messages:[{...tool,detail:'rapid collapse'}]});
    ensure(!document.querySelector('details.tool').open, 'rapid collapse lost on replacement');
    await tick();
    ensure(requests()===0, 'rapid collapse requested output');
    document.querySelector('details.tool').open = true;
    render({...state,messages:[]});
    await tick();
    ensure(requests()===0, 'removed tool requested output from stale toggle');
    render({...state,messages:[tool]});
    document.querySelector('details.tool').open = true;
    render({...baseline,sessionId:'race-next',messages:[]});
    await tick();
    ensure(requests()===0, 'previous session tool requested output from stale toggle');
  })()`)
  console.log('PASS: tool disclosure replacement and stale toggle races')

  await evaluate(`(async () => {
    const reasoning = {text:'Initial <img src=x onerror=alert(1)>\\n',active:true,tokens:5,estimated:true};
    const reply = {id:'thinking',role:'assistant',text:'',streaming:true,reasoning};
    showState({...baseline,sessionId:'reasoning',messages:[...baseline.messages,reply]}); await tick();
    const details = document.querySelector('[data-scroll-id="thinking"] .reasoning');
    const viewport = details.querySelector('.reasoning-viewport');
    ensure(details.open && viewport.clientHeight > 0 && viewport.clientHeight < 96, 'short reasoning viewport did not shrink to its content');
    ensure(!viewport.querySelector('img'), 'reasoning was rendered as HTML');
    ensure(document.querySelector('[data-scroll-id="thinking"] .message-body').hidden, 'reasoning-only message has an empty answer');
    conversationScroller.pause(); elements.scroll.scrollTop = 100; await tick(); const reading = elements.scroll.scrollTop;
    const delta = ('reasoning line\\n').repeat(3134);
    window.dispatchEvent(new MessageEvent('message',{data:{type:'state-update',update:{messages:{appends:[{id:'thinking',text:'',streaming:true,reasoning:{text:delta,active:true,tokens:500,estimated:true}}]}}}})); await tick();
    ensure(state.messages.at(-1).reasoning.text.length > 47000, 'reasoning delta not accumulated');
    ensure(viewport.clientHeight === 144 && viewport.lastChild.length === 20000 && !viewport.querySelector('.reasoning-omitted').hidden, 'live reasoning height or tail not bounded');
    ensure(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 2, 'live reasoning did not scroll to newest');
    ensure(Math.abs(elements.scroll.scrollTop-reading)<2 && !conversationScroller.following, 'reasoning update stole conversation scroll');
    window.dispatchEvent(new MessageEvent('message',{data:{type:'state-update',update:{messages:{appends:[{id:'thinking',text:'',streaming:true,reasoning:{text:'',active:false,durationMs:3200,tokens:501,estimated:true}}]}}}})); await tick();
    ensure(!details.open && details.querySelector('summary').textContent === 'Thought for 3.2s · about 501 tokens', 'reasoning completion did not collapse or update statistics');
    ensure(state.messages.at(-1).streaming, 'answer should still be streaming');
    details.querySelector('summary').click(); await tick();
    ensure(details.open && viewport.lastChild.data === state.messages.at(-1).reasoning.text, 'completed expansion lost full reasoning');
    window.dispatchEvent(new MessageEvent('message',{data:{type:'state-update',update:{messages:{appends:[{id:'thinking',text:'Answer',streaming:true}]}}}})); await tick();
    ensure(details.open && !document.querySelector('[data-scroll-id="thinking"] .message-body').hidden, 'answer append lost expansion or stayed hidden');
    showState({...state,messages:state.messages.map(m => m.id === 'thinking' ? {...m,text:'Updated answer'} : m)}); await tick();
    ensure(document.querySelector('[data-scroll-id="thinking"] .reasoning') === details && details.open, 'redraw lost reasoning expansion');
    showState({...baseline,sessionId:'reasoning-history',messages:[{...reply,streaming:false,reasoning:{text:'History',active:false,tokens:3,estimated:false}}]}); await tick();
    ensure(!document.querySelector('.reasoning').open && document.querySelector('.reasoning summary').textContent === 'Thinking time unknown · 3 tokens', 'history did not start collapsed or unknown duration mislabeled');
    showState({...baseline,sessionId:'reasoning',messages:[{...reply,streaming:false,reasoning:{text:'History',active:false,tokens:3,estimated:false}}]}); await tick();
    ensure(!document.querySelector('.reasoning').open, 'session switch retained reasoning expansion');
    ensure(!sent.some(message => message.type==='webview-error'), JSON.stringify(sent.filter(message => message.type==='webview-error')));
  })()`)
  console.log('PASS: reasoning stream, bounded viewport, completion, disclosure, and session reset')

  await evaluate(`(async () => {
    const message = text => ({id:'batch',role:'assistant',text,streaming:true,reasoning:{text,active:true,tokens:1,estimated:true}});
    const append = text => window.dispatchEvent(new MessageEvent('message',{data:{type:'state-update',update:{messages:{appends:[{id:'batch',text,streaming:true,reasoning:{text,active:true,tokens:1,estimated:true}}]}}}}));
    const update = messages => window.dispatchEvent(new MessageEvent('message',{data:{type:'state-update',update:{messages}}}));
    for (const replacement of ['reset', 'state', 'upsert']) {
      showState({...baseline,sessionId:'batch-'+replacement,messages:[message('A')]}); await tick();
      append('B');
      if (replacement === 'state') showState({...state,messages:[message('AB')]});
      else update(replacement === 'reset' ? {reset:[message('AB')]} : {upserts:[message('AB')]});
      append('C'); await tick();
      const item = document.querySelector('[data-scroll-id="batch"]');
      ensure(state.messages[0].text === 'ABC' && state.messages[0].reasoning.text === 'ABC', replacement + ' state lost a delta');
      ensure(item.querySelector('.message-body').textContent === 'ABC', replacement + ' answer DOM lost a delta');
      ensure(item.querySelector('.reasoning-viewport').lastChild.data === 'ABC', replacement + ' reasoning DOM lost a delta');
    }
  })()`)
  console.log('PASS: batched reset, full-state and upsert preserve answer and reasoning deltas')

  await evaluate(`(async () => {
    const reason = (text, active, durationMs, tokens) => ({text,active,...(durationMs === undefined ? {} : {durationMs}),tokens,estimated:true});
    const first = {id:'step1',role:'assistant',turn:7,text:'First answer',streaming:false,reasoning:reason('First thought',false,1200,10)};
    const tool = {id:'turn-tool',role:'tool',turn:7,text:'Read',failed:true,deferredBody:true};
    const notice = {id:'notice',role:'notice',text:'A notice'};
    const second = {id:'step2',role:'assistant',turn:7,text:'',streaming:true,reasoning:reason('start\\n'.repeat(300),true,undefined,20)};
    showState({...baseline,sessionId:'turn-activity',running:true,messages:[...baseline.messages,first]}); await tick();
    const activity = document.querySelector('.turn-activity'); const details = activity.querySelector(':scope > details');
    const preview = activity.querySelector('.turn-activity-preview');
    showState({...state,messages:[...state.messages,tool,notice,second]}); await tick();
    ensure(document.querySelector('.turn-activity-preview')===preview, 'next step replaced the live viewport');
    ensure(document.querySelectorAll('.turn-activity').length===1 && !details.open && !preview.hidden && preview.clientHeight===144, 'turn activity did not start with one live viewport');
    ensure(!document.querySelector('[data-scroll-id="step2"]') && !document.querySelector('.turn-activity-log .tool'), 'reasoning-only header or eager tool log rendered');
    ensure(document.querySelector('[data-scroll-id="step1"] .message-body').textContent.trim()==='First answer' && document.querySelector('[data-scroll-id="notice"]'), 'answer or notice missing outside activity');
    conversationScroller.pause(); elements.scroll.scrollTop=100; await tick(); const reading=elements.scroll.scrollTop;
    const update = messages => window.dispatchEvent(new MessageEvent('message',{data:{type:'state-update',update:{messages}}}));
    update({appends:[{id:'step2',text:'',streaming:true,reasoning:reason('next\\n'.repeat(5000),true,undefined,22)}]}); await tick();
    ensure(activity.querySelector('.turn-activity-preview')===preview && preview.lastChild.length===20000 && preview.scrollHeight-preview.scrollTop-preview.clientHeight<2, 'live preview was replaced, unbounded, or did not follow');
    ensure(Math.abs(elements.scroll.scrollTop-reading)<2, 'live preview changed conversation scroll');
    const durable = {...state.messages.at(-1),id:'step2-durable'};
    showState({...state,messages:[...state.messages.slice(0,-1),durable]}); await tick();
    ensure(activity.querySelector('.turn-activity-preview')===preview, 'live-to-durable id replacement replaced viewport');
    sent.length=0; details.querySelector('summary').click(); await tick();
    ensure(details.open && preview.hidden && activity.querySelectorAll('.reasoning').length===2 && activity.querySelectorAll('.tool').length===1, 'expanded activity missing details or duplicated preview');
    ensure(!sent.some(m=>m.type==='load-tool-output'), 'closed tool loaded deferred output');
    const toolNode = activity.querySelector('.tool'); toolNode.querySelector('summary').click(); await tick();
    ensure(sent.some(m=>m.type==='load-tool-output' && m.messageId==='turn-tool'), 'open tool did not load deferred output');
    details.querySelector('summary').click(); await tick();
    update({appends:[{id:'step2-durable',text:'',streaming:true,reasoning:reason('missed B',true,undefined,22)}]}); await tick();
    details.querySelector('summary').click();
    update({appends:[{id:'step2-durable',text:'',streaming:true,reasoning:reason('pending C',true,undefined,22)}]}); await tick();
    const stepViews = activity.querySelectorAll('.reasoning-viewport');
    ensure(stepViews[1].lastChild.data === state.messages.at(-1).reasoning.text.slice(-20000), 'reopened log lost a closed-period reasoning delta');
    update({appends:[{id:'step2-durable',text:'Answer',streaming:true,reasoning:reason('',false,2300,22)}]}); await tick();
    ensure(details.open && preview.hidden, 'reasoning completion collapsed an ongoing turn');
    const last = state.messages.at(-1); update({upserts:[{...last,turnEnded:true}]}); await tick();
    ensure(!details.open && preview.hidden && details.querySelector('.tool-title').textContent==='Thought for 3.5s · about 32 tokens · 1 tool', 'turn completion summary or collapse incorrect');
    ensure(details.querySelector('.tool-icon').getAttribute('aria-label')==='One or more tools failed', 'failed tool status lost');
    details.querySelector('summary').click(); await tick();
    ensure(details.open && activity.querySelector('.tool')===toolNode && toolNode.open, 'reopening activity lost tool state');
    update({appends:[{id:'step2-durable',text:' more',streaming:true}]}); await tick();
    ensure(details.open && preview.hidden, 'answer update reopened a settled turn or lost expansion');
    showState({...state,running:true}); await tick();
    ensure(details.open && preview.hidden, 'running state reactivated a settled turn');
    const older = {id:'older-turn',role:'assistant',turn:6,text:'Older',reasoning:reason('Unknown',false,undefined,4)};
    showState({...state,messages:[older,...state.messages]}); await tick();
    ensure(document.querySelectorAll('.turn-activity').length===2 && document.querySelector('[data-scroll-id="turn-activity-7"]')===activity && details.open, 'history prepend replaced activity or expansion');
    ensure(document.querySelector('[data-scroll-id="turn-activity-6"] .tool-title').textContent==='Thinking time unknown · about 4 tokens · 0 tools', 'unknown duration summary incorrect');
    showState({...baseline,sessionId:'activity-reset',running:false,messages:[{id:'only-tool',role:'tool',turn:7,text:'Only'}]}); await tick();
    ensure(document.querySelector('.turn-activity')!==activity && !document.querySelector('.turn-activity details').open && document.querySelector('.turn-activity .tool-title').textContent==='Thought for 0s · 0 tokens · 1 tool', 'session reset or tool-only summary incorrect');
    showState({...baseline,sessionId:'activity-lifecycle',running:false,messages:[second]}); await tick();
    const lifecycle = document.querySelector('.turn-activity');
    ensure(!lifecycle.querySelector('.turn-activity-preview').hidden, 'stale initial runtime state prematurely settled live turn');
    showState({...state,running:true}); await tick();
    showState({...state,running:false}); await tick();
    ensure(lifecycle.querySelector('.turn-activity-preview').hidden, 'runtime stop did not settle stale streaming message');
    showState({...state,running:true}); await tick();
    ensure(lifecycle.querySelector('.turn-activity-preview').hidden, 'runtime restart reactivated settled turn');
  })()`)
  console.log('PASS: turn activity grouping, live preview, deferred tools, completion, history, and session reset')

  await evaluate(`(async () => {
    const text = 'thought'.repeat(3572) + 'xx';
    for (const end of ['runtime', 'marker']) {
      const message = {id:'stale-active',role:'assistant',turn:4,text:'',streaming:true,reasoning:{text,active:true,tokens:10,estimated:true}};
      showState({...baseline,sessionId:'stale-'+end,running:true,messages:[message]}); await tick();
      const activity = document.querySelector('.turn-activity'); const details = activity.querySelector(':scope > details');
      details.querySelector('summary').click(); await tick();
      ensure(activity.querySelector('.reasoning').open && activity.querySelector('.reasoning-viewport').lastChild.length===20000, 'active log not bounded');
      if (end === 'runtime') showState({...state,running:false});
      else showState({...state,messages:[{...message,turnEnded:true}]});
      await tick();
      ensure(!details.open, end + ' did not collapse activity');
      details.querySelector('summary').click(); await tick();
      const reasoning = activity.querySelector('.reasoning');
      ensure(!reasoning.open && reasoning.querySelector('summary').textContent.startsWith('Thinking time unknown'), end + ' retained active reasoning display');
      reasoning.querySelector('summary').click(); await tick();
      ensure(reasoning.querySelector('.reasoning-viewport').lastChild.data===text && state.messages[0].reasoning.active===true, end + ' lost full text or mutated transport state');
    }
  })()`)
  console.log('PASS: settled turns restore full stale-active reasoning')

  await evaluate(`(async () => {
    const part = {id:'partial-end',role:'assistant',turn:3,text:'Last answer',turnEnded:true,reasoning:{text:'Later',active:false,durationMs:2000,tokens:20,estimated:true}};
    const earlier = {id:'partial-start',role:'assistant',turn:3,turnStarted:true,text:'Earlier answer',reasoning:{text:'Earlier',active:false,durationMs:1000,tokens:10,estimated:true}};
    showState({...baseline,sessionId:'partial-turn',running:false,hasMoreHistory:true,messages:[part]}); await tick();
    const group = document.querySelector('.turn-activity'); const details = group.querySelector(':scope > details');
    ensure(details.querySelector('.tool-title').textContent==='Thought for 2s · about 20 tokens · 0 tools (loaded portion only)', 'partial turn totals not qualified');
    details.querySelector('summary').click(); await tick();
    showState({...state,messages:[earlier,{...part,turnStarted:true}]}); await tick();
    ensure(document.querySelectorAll('.turn-activity').length===1 && document.querySelector('.turn-activity')===group && details.open, 'history prepend replaced activity or lost expansion');
    ensure(details.querySelector('.tool-title').textContent==='Thought for 3s · about 30 tokens · 0 tools', 'full turn totals stayed qualified or incorrect');
    showState({...state,sessionId:'partial-no-more',hasMoreHistory:false,messages:[part]}); await tick();
    ensure(!document.querySelector('.turn-activity .tool-title').textContent.includes('loaded portion only'), 'fully loaded history incorrectly qualified');
  })()`)
  console.log('PASS: paginated turn totals are qualified until the turn start is loaded')

  await evaluate(`(async () => {
    showState({...baseline,sessionId:'tools',messages:[...baseline.messages,{id:'tool',role:'tool',text:'Read file',rawResult:'output\\n'.repeat(30)}]}); await tick();
    document.querySelector('details.tool-group > summary').click(); await tick();
    const tool = document.querySelector('details.tool'); tool.querySelector('summary').click(); await tick();
    ensure(!conversationScroller.following && tool.open, 'manual expansion must preserve reading');
    conversationScroller.resume(); await tick();
    showState({...state,messages:[...state.messages,{id:'auto-tool',role:'tool',text:'Running',streaming:true,rawResult:'running\\n'.repeat(20)}]}); await tick();
    ensure(conversationScroller.following && gap() <= 2, 'passive tool update lost follow');
    const canvas = document.createElement('canvas'); canvas.width=100; canvas.height=240;
    const image = new Image(); const loaded = new Promise(resolve => { image.onload=resolve; });
    elements.messages.append(image); image.src=canvas.toDataURL(); await loaded; await tick();
    ensure(conversationScroller.following && gap() <= 2, 'image decode lost follow');
    elements.prompt.style.height='200px'; await tick();
    ensure(conversationScroller.following && gap() <= 2, 'composer resize lost follow');
    elements.prompt.style.height='';
    elements.prompt.value = 'A new message'; send('queue'); const request = sent.findLast(message => message.type === 'send');
    conversationScroller.pause();
    window.dispatchEvent(new MessageEvent('message',{data:{type:'draft-sent',requestId:request.requestId,sessionId:state.sessionId}})); await tick();
    ensure(!conversationScroller.following, 'late send receipt overrode user intent');
    elements.prompt.value = 'Follow this reply'; send('queue'); const next = sent.findLast(message => message.type === 'send');
    window.dispatchEvent(new MessageEvent('message',{data:{type:'draft-sent',requestId:next.requestId,sessionId:state.sessionId}})); await tick();
    ensure(conversationScroller.following && gap() <= 2, 'accepted send did not resume following');
    conversationScroller.pause(); elements.scroll.scrollTop -= 200; await tick(); const reading = elements.scroll.scrollTop;
    showState({...state,approval:{rpcId:'approval',approvalId:'one',toolName:'Write',reason:'Review this change'},question:{rpcId:'question',questions:[{id:'q',question:'Continue?'}]}}); await tick();
    showState({...state,usage:{available:false}}); await tick();
    ensure(!conversationScroller.following && Math.abs(elements.scroll.scrollTop-reading)<2, 'approval/question refresh stole scroll position');
    showState({...baseline,sessionId:'history',hasMoreHistory:true}); await tick();
    elements.scroll.scrollTop=150; await tick(); document.querySelector('.history-button').click();
    const before = document.querySelector('[data-scroll-id="reply"]').getBoundingClientRect().top;
    showState({...state,hasMoreHistory:false,loadingHistory:false,messages:[{id:'older',role:'assistant',text:'Older message\\n\\n'.repeat(20)},...state.messages,{id:'new-tail',role:'assistant',text:'New output\\n\\n'.repeat(10)}]}); await tick();
    ensure(Math.abs(document.querySelector('[data-scroll-id="reply"]').getBoundingClientRect().top-before)<2, 'history anchor drifted');
    ensure(!conversationScroller.following, 'history restore resumed following');
    showState({...baseline,sessionId:'final'}); await tick(); ensure(conversationScroller.following && gap()<=2, 'session reset failed');
    ensure(!sent.some(message => message.type==='webview-error'), JSON.stringify(sent.filter(message => message.type==='webview-error')));
  })()`)
  console.log('PASS: tools, image decode, composer resize, send receipts, approvals, history and session switching')
  await page('Emulation.setDeviceMetricsOverride', { width: 300, height: 550, deviceScaleFactor: 1, mobile: false })
  await evaluate('tick()')
  assert.equal(await evaluate('conversationScroller.following && gap() <= 2'), true)
  await evaluate(`(async () => {
    showState({...baseline,sessionId:'narrow',messages:[...baseline.messages,{id:'long-tool',role:'tool',streaming:true,callView:{title:'long-command-'.repeat(80)}}]}); await tick();
    const title=document.querySelector('.tool-group > summary .tool-title');
    const summary=title.closest('summary'); const style=getComputedStyle(title);
    ensure(title.scrollWidth>title.clientWidth && style.textOverflow==='ellipsis' && title.getBoundingClientRect().right<=summary.getBoundingClientRect().right, 'long tool title did not ellipsize within narrow sidebar');
  })()`)
  await evaluate('conversationScroller.pause(); elements.scroll.scrollTop -= 180;')
  await evaluate('tick()')
  assert.equal(await evaluate(`(() => { const b=document.getElementById('jumpLatest').getBoundingClientRect(), s=elements.scroll.getBoundingClientRect(); return b.width>0 && b.left>=s.left && b.right<=s.right && b.bottom<=s.bottom; })()`), true)
  console.log('PASS: narrow sidebar resize and visible, in-bounds button')
  await evaluate(`window.layoutSnapshot = () => {
    const names = ['#app', '#app > header', '.conversation', '.composer', '#prompt', '#send'];
    const rects = Object.fromEntries(names.map(name => {
      const r = document.querySelector(name).getBoundingClientRect();
      return [name, {left:r.left, right:r.right, top:r.top, bottom:r.bottom}];
    }));
    return {rects, scroll: [document.documentElement, document.body, document.querySelector('#app'),
      document.querySelector('#app > header'), document.querySelector('.conversation'), document.querySelector('.composer')].map(el => el.scrollLeft)};
  };
  window.checkHistoryBounds = () => {
    const snapshot = layoutSnapshot(); const {rects} = snapshot;
    for (const [name, rect] of Object.entries(rects)) ensure(rect.left >= 0 && rect.right <= innerWidth, name + ' outside viewport: ' + JSON.stringify(rect));
    ensure(rects['#send'].left >= rects['.composer'].left + 6 && rects['#send'].right <= rects['.composer'].right - 6, 'send outside composer padding');
    ensure(document.querySelector('#app').scrollWidth === document.querySelector('#app').clientWidth, 'app has horizontal overflow');
    ensure(!elements.policyTrigger.classList.contains('hidden') && !elements.usageControl.classList.contains('hidden') && !elements.cancel.classList.contains('hidden'), 'busy controls not visible');
    return snapshot;
  };`)
  const clickAt = async selector => {
    const point = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`)
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  for (const width of [260, 300, 410]) {
    await page('Emulation.setDeviceMetricsOverride', { width, height: 550, deviceScaleFactor: 1, mobile: false })
    for (const longTitle of [false, true]) {
      await evaluate(`(async () => {
        const title = ${longTitle} ? 'UnbrokenSessionTitle'.repeat(45) : 'Ordinary session';
        showState({...baseline, sessionId:'layout', running:true,
          sessions:Array.from({length:30}, (_, i) => ({id:i ? 'layout-' + i : 'layout', title:i ? title + i : title})),
          models:[{provider:'test',model:'long',label:'LongModelLabel'.repeat(20),selected:true,reasoningEfforts:[{id:'high',label:'LongEffortLabel'.repeat(20),selected:true}]}],
          permissions:[{id:'policy',label:'Policy',selected:true}], usage:{available:true,percent:25,usedTokens:25,contextWindow:100}});
        await tick();
      })()`)
      const before = await evaluate('checkHistoryBounds()')
      await clickAt('#sessionTrigger')
      await evaluate(`(async () => { await tick();
        ensure(document.activeElement === elements.sessionSearch, 'history search did not receive focus');
        const menu = elements.sessionMenu.getBoundingClientRect();
        ensure(menu.left >= 0 && menu.right <= innerWidth, 'history menu outside viewport');
        ensure(elements.sessionList.scrollHeight > elements.sessionList.clientHeight, 'history list did not overflow internally');
        elements.sessionList.scrollTop = 100; ensure(elements.sessionList.scrollTop > 0, 'history list did not scroll');
      })()`)
      assert.deepEqual(await evaluate('checkHistoryBounds()'), before, `layout changed on open at ${width}px`)
      await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await evaluate(`(async () => { await tick(); ensure(document.activeElement === elements.sessionTrigger, 'history trigger focus not restored'); ensure(elements.sessionMenu.classList.contains('hidden'), 'history menu did not close'); })()`)
      assert.deepEqual(await evaluate('checkHistoryBounds()'), before, `layout changed on close at ${width}px`)
    }
  }
  await clickAt('#sessionTrigger')
  await evaluate('tick()')
  await page('Emulation.setDeviceMetricsOverride', { width: 260, height: 550, deviceScaleFactor: 1, mobile: false })
  await evaluate(`(async () => { await tick(); checkHistoryBounds(); const r = elements.sessionMenu.getBoundingClientRect(); ensure(r.left >= 0 && r.right <= innerWidth, 'open history menu outside viewport after resize'); ensure(document.activeElement === elements.sessionSearch, 'resize lost search focus'); })()`)
  console.log('PASS: responsive history focus, geometry, internal scrolling, busy composer and open-menu resize')
  await evaluate(`(() => {
    const menu = elements.sessionMenu.getBoundingClientRect();
    const originalSize = document.body.style.fontSize;
    for (const size of [13, 20, 24]) {
      document.body.style.fontSize = size + 'px';
      const search = elements.sessionSearch.getBoundingClientRect();
      ensure(search.left >= menu.left + 6 && search.right <= menu.right - 6, 'search input escaped menu padding');
      ensure(Math.abs((search.left - menu.left) - (menu.right - search.right)) < 1, 'search input margins differ');
    }
    document.body.style.fontSize = originalSize;
    const color = getComputedStyle(elements.sessionSearch).borderRightColor;
    ensure(color === 'rgb(77, 107, 254)', 'focused search border is not visible: ' + color);
    elements.sessionTrigger.focus({preventScroll:true});
    const idleColor = getComputedStyle(elements.sessionSearch).borderRightColor;
    ensure(idleColor === 'rgb(69, 69, 69)', 'search border has no visible theme fallback: ' + idleColor);
    elements.sessionSearch.focus({preventScroll:true});
  })()`)
  console.log('PASS: search input padding, responsive font sizes, visible border and focus border')


  await page('Emulation.setDeviceMetricsOverride', { width: 640, height: 550, deviceScaleFactor: 1, mobile: false })
  for (const width of [180, 220, 300]) {
    await evaluate(`(async () => {
      const app = document.querySelector('#app'); app.style.width = '${width}px'; await tick();
      const parent = document.querySelector('.toolbar').getBoundingClientRect();
      const menu = elements.sessionMenu.getBoundingClientRect();
      const search = elements.sessionSearch.getBoundingClientRect();
      ensure(menu.left >= parent.left && menu.right <= parent.right, 'history menu exceeds actual sidebar width: ' + JSON.stringify({width:${width},parentRight:parent.right,menuRight:menu.right}));
      ensure(search.left >= menu.left + 6 && search.right <= menu.right - 6, 'search input exceeds sidebar popup');
      ensure(document.activeElement === elements.sessionSearch, 'container resize lost search focus');
    })()`)
  }
  await evaluate(`document.querySelector('#app').style.width = '';`)
  console.log('PASS: history popup fits narrow sidebar container independently of viewport width')
  await evaluate(`(async () => {
    elements.sessionTrigger.click();
    showState({...baseline, usage:{available:true,percent:25,usedTokens:2048,contextWindow:9999999999999,
      breakdown:{systemTokens:12345,toolsTokens:54321,messageTokens:149000}}});
    await tick();
    window.usageLayout = () => {
      const panel = elements.usagePanel.getBoundingClientRect();
      const row = document.querySelector('.composer-row').getBoundingClientRect();
      const app = document.querySelector('#app').getBoundingClientRect();
      ensure(!elements.usagePanel.classList.contains('hidden'), 'usage popup unexpectedly closed');
      ensure(panel.left >= row.left && panel.right <= row.right && panel.left >= app.left && panel.right <= app.right, 'usage popup escaped sidebar');
      ensure(panel.top >= 0 && panel.bottom <= innerHeight, 'usage popup escaped viewport');
      const hit = document.elementFromPoint(panel.left + panel.width / 2, panel.top + 8);
      ensure(hit && elements.usagePanel.contains(hit), 'usage popup is clipped or obscured');
      ensure(elements.usagePanel.textContent.includes('2,048 tokens') && elements.usagePanel.textContent.includes('9,999,999,999,999 tokens'), 'full context counts missing');
      for (const item of elements.usagePanel.querySelectorAll('.usage-header, .usage-header span, .usage-breakdown-title, .usage-row, .usage-row dt, .usage-row dd')) {
        if (!item.checkVisibility()) continue;
        const rect = item.getBoundingClientRect();
        ensure(rect.left >= panel.left && rect.right <= panel.right && rect.top >= panel.top && rect.bottom <= panel.bottom, 'usage content escaped popup: ' + item.textContent);
        ensure(item.scrollWidth <= item.clientWidth + 1, 'usage content clipped: ' + item.textContent);
      }
      for (const item of elements.usagePanel.querySelectorAll('.usage-row')) {
        if (!item.checkVisibility()) continue;
        const [term, value] = [...item.children].map(child => child.getBoundingClientRect());
        ensure(term.right <= value.left || value.right <= term.left || term.bottom <= value.top || value.bottom <= term.top, 'usage row overlaps');
      }
    };
    const before = {scrollTop:elements.scroll.scrollTop, scrollHeight:elements.scroll.scrollHeight, bodyHeight:document.body.scrollHeight};
    elements.usageTrigger.click(); await tick();
    ensure(elements.usageTrigger.getAttribute('aria-expanded') === 'true', 'usage trigger not expanded');
    ensure(JSON.stringify(before) === JSON.stringify({scrollTop:elements.scroll.scrollTop, scrollHeight:elements.scroll.scrollHeight, bodyHeight:document.body.scrollHeight}), 'opening usage popup moved the page');
  })()`)
  for (const width of [180, 220, 300, 410]) {
    await evaluate(`(async () => { document.querySelector('#app').style.width = '${width}px'; await tick(); usageLayout(); })()`)
  }
  await evaluate(`(async () => {
    document.querySelector('#app').style.width = ''; await tick();
    document.body.click(); await tick();
    ensure(elements.usagePanel.classList.contains('hidden') && elements.usageTrigger.getAttribute('aria-expanded') === 'false', 'outside click did not dismiss usage popup');
    elements.usageTrigger.click(); await tick();
  })()`)
  await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await evaluate(`(async () => { await tick(); ensure(elements.usagePanel.classList.contains('hidden') && elements.usageTrigger.getAttribute('aria-expanded') === 'false', 'Escape did not dismiss usage popup'); })()`)
  for (const width of [180, 220, 300, 410]) {
    await page('Emulation.setDeviceMetricsOverride', { width, height: 550, deviceScaleFactor: 1, mobile: false })
    await evaluate(`(async () => { elements.usageTrigger.click(); await tick(); usageLayout(); elements.usageTrigger.click(); })()`)
  }
  console.log('PASS: usage popup bounds, paint, resize, wrapping and dismissal')
  await page('Emulation.setDeviceMetricsOverride', { width: 180, height: 370, deviceScaleFactor: 1, mobile: false })
  await evaluate(`(async () => {
    const usage = {available:true,percent:19,usedTokens:199790,contextWindow:1048576,
      breakdown:{systemTokens:16,toolsTokens:397,messageTokens:148918},
      sessionStats:{turns:2,steps:4,llmMs:2000,toolMs:300,ttftMs:900,ttftSteps:2,decodeMs:2000,decodeTokens:75},
      tokenUsage:{uncachedInputTokens:100,cacheReadTokens:300,cacheWriteTokens:100,outputTokens:500}};
    showState({...baseline,usage}); await tick();
    elements.usageTrigger.click(); await tick();
    elements.usagePanel.querySelector('.usage-details').open = true; await tick();
    window.checkShortUsage = (requireScroll = true) => {
      const panel = elements.usagePanel;
      const bounds = panel.getBoundingClientRect();
      ensure(bounds.top >= 0 && bounds.bottom <= innerHeight, 'short viewport clipped usage popup');
      if (requireScroll) ensure(panel.scrollHeight > panel.clientHeight, 'short viewport popup should scroll');
      const checkVisible = item => {
        const r = item.getBoundingClientRect();
        ensure(r.top >= bounds.top && r.bottom <= bounds.bottom, 'usage content not visible after scrolling');
        const hit = document.elementFromPoint(r.left + Math.min(r.width / 2, 10), r.top + r.height / 2);
        ensure(hit && (item === hit || item.contains(hit)), 'usage content not painted after scrolling');
      };
      panel.scrollTop = 0; checkVisible(panel.querySelector('.usage-header'));
      panel.scrollTop = panel.scrollHeight; checkVisible([...panel.querySelectorAll('.usage-row dd')].at(-1));
    };
    checkShortUsage();
    elements.usagePanel.scrollTop = 0; elements.usagePanel.focus();
  })()`)
  await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 })
  await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 })
  await evaluate(`(async () => { await tick(200); ensure(document.activeElement === elements.usagePanel && elements.usagePanel.scrollTop > 0, 'keyboard scrolling unavailable in usage popup'); })()`)
  await page('Emulation.setDeviceMetricsOverride', { width: 180, height: 340, deviceScaleFactor: 1, mobile: false })
  await evaluate(`(async () => { await tick(); checkShortUsage();
    elements.prompt.value = 'A long prompt\\n'.repeat(12); elements.prompt.dispatchEvent(new Event('input', {bubbles:true}));
    await tick(); checkShortUsage();
    elements.prompt.value = ''; elements.prompt.dispatchEvent(new Event('input', {bubbles:true}));
    await tick(); checkShortUsage();
  })()`)
  await page('Emulation.setDeviceMetricsOverride', { width: 180, height: 300, deviceScaleFactor: 1, mobile: false })
  // Simulate a row near the top to exercise the fallback; the natural grid can overflow instead.
  await evaluate(`(async () => { elements.prompt.value = 'A long prompt\\n'.repeat(12); elements.prompt.dispatchEvent(new Event('input', {bubbles:true}));
    await tick(); checkShortUsage(false);
    document.querySelector('.composer-row').style.transform = 'translateY(-230px)'; updateUsagePanelHeight();
    ensure(elements.usagePanel.style.bottom === 'auto', 'usage fallback not activated'); checkShortUsage(false);
  })()`)
  await page('Emulation.setDeviceMetricsOverride', { width: 180, height: 240, deviceScaleFactor: 1, mobile: false })
  await evaluate(`(async () => { await tick(); checkShortUsage(); })()`)
  await page('Emulation.setDeviceMetricsOverride', { width: 180, height: 450, deviceScaleFactor: 1, mobile: false })
  await evaluate(`(async () => { document.querySelector('.composer-row').style.transform = ''; elements.prompt.value = ''; elements.prompt.dispatchEvent(new Event('input', {bubbles:true}));
    await tick(); ensure(elements.usagePanel.style.top === '' && elements.usagePanel.style.bottom === '', 'usage fallback did not reset'); checkShortUsage(false); elements.usageTrigger.click();
  })()`)
  console.log('PASS: short viewport usage popup scrolling and composer resize')
  await page('Emulation.setDeviceMetricsOverride', { width: 180, height: 240, deviceScaleFactor: 1, mobile: false })
  await evaluate(`(async () => {
    showState({...baseline,usage:{available:false}}); await tick();
    ensure(!elements.usageControl.classList.contains('hidden'), 'missing inspector trigger without usage estimates');
    elements.usageTrigger.click(); await tick();
    const panel=elements.usagePanel, box=panel.getBoundingClientRect(), action=panel.querySelector('.inspect-action');
    ensure(box.top>=0 && box.bottom<=innerHeight && box.left>=0 && box.right<=innerWidth, 'no-estimate popup out of bounds');
    ensure(panel.textContent.includes('Usage not available yet') && action && !action.disabled, 'no-estimate inspector action unavailable');
    panel.scrollTop=panel.scrollHeight; action.click();
    ensure(elements.inspector.open && sent.findLast(message=>message.type==='inspect-context'), 'no-estimate inspector did not open');
    elements.inspector.close(); await tick();
  })()`)
  console.log('PASS: context inspector remains accessible without estimates in a short narrow viewport')
  await page('Emulation.setDeviceMetricsOverride', { width: 300, height: 550, deviceScaleFactor: 1, mobile: false })
  if (process.env.DSH_SCROLL_SCREENSHOT) {
    const { data } = await page('Page.captureScreenshot', { format: 'png' })
    await writeFile(process.env.DSH_SCROLL_SCREENSHOT, Buffer.from(data, 'base64'))
  }
  // The context inspector must stay isolated from streaming, session switches,
  // and the conversation scroller. Exercise the real HTML/dialog in Chromium.
  await evaluate(`(async () => {
    showState({...baseline,usage:{available:true,percent:24,usedTokens:24000,contextWindow:100000}}); await tick();
    elements.usageTrigger.click(); document.querySelector('.inspect-action').click();
    ensure(elements.inspector.open, 'inspector did not open');
    const request = sent.findLast(message => message.type==='inspect-context');
    window.inspectorFixture = {sessionId:state.sessionId,capturedAt:Date.now(),throughSeq:42,usage:state.usage,warnings:[],groups:[
      {id:'system',label:'System prompt',description:'Recorded system messages.',total:1,entries:[{id:'1',label:'System prompt',source:'Event 1',characters:16,content:'You are helpful.',truncated:false}]},
      {id:'tools',label:'Tools',description:'Schemas in the latest recorded request.',total:2,entries:[{id:'read',label:'read',source:'Request header · event 3',characters:35,content:'Read a workspace file.',truncated:false},{id:'write',label:'write',source:'Request header · event 3',characters:60,content:'Write a workspace file. <img src=x onerror="alert(1)">',truncated:false}]},
      {id:'instructions',label:'Project rules',description:'Recorded instructions, not files on disk.',total:1,entries:[{id:'2',label:'AGENTS.md',source:'agent-instructions · event 2',characters:60,content:'Use pnpm. Keep changes small. Run tests before finishing.',truncated:false}]},
      {id:'skills',label:'Loaded skill content',description:'Actually loaded instructions.',total:0,entries:[]},
      {id:'available',label:'Available skills',description:'Available does not mean loaded.',total:2,entries:[{id:'review',label:'review',source:'Model-callable skill',characters:12,content:'Review code.',truncated:false}]},
      {id:'compaction',label:'Recent compactions',description:'Recorded results.',total:0,entries:[]},
    ]};
    window.inspectorReply = (request, extra = {}) => window.dispatchEvent(new MessageEvent('message',{data:{type:'context-inspection',sessionId:request.sessionId,requestId:request.requestId,inspection:inspectorFixture,...extra}}));
    inspectorReply({...request,requestId:request.requestId-1}); ensure(!inspection, 'accepted stale request');
    inspectorReply(request); ensure(inspection && document.querySelectorAll('.inspector-group').length===6, 'missing context groups');
    ensure(elements.inspectorStatus.textContent.includes('24K / 100K'), 'context totals were formatted incorrectly');
    elements.prompt.focus(); ensure(elements.inspector.contains(document.activeElement), 'focus escaped modal');
    const box=elements.inspector.getBoundingClientRect();
    ensure(box.left>=0 && box.right<=innerWidth && box.top>=0 && box.bottom<=innerHeight, 'dialog out of bounds');
    elements.inspectorSearch.value='workspace'; elements.inspectorSearch.dispatchEvent(new Event('input'));
    elements.inspectorSort.value='size'; elements.inspectorSort.dispatchEvent(new Event('change'));
    ensure(document.querySelectorAll('.inspector-entry').length===2 && document.querySelector('.inspector-entry summary').textContent==='write', 'search/size order failed');
    document.querySelector('.inspector-entry').open=true;
    ensure(!elements.inspector.querySelector('img'), 'context was rendered as HTML');
    showState({...state,usage:{...state.usage,percent:25}}); await tick();
    ensure(document.querySelector('.inspector-entry').open && elements.inspectorStatus.textContent.includes('24%'), 'streaming changed the captured snapshot');
    elements.inspectorSearch.value=''; elements.inspectorSearch.dispatchEvent(new Event('input'));
    document.querySelectorAll('.inspector-group')[2].open=true; document.querySelectorAll('.inspector-group')[2].querySelector('details').open=true;
  })()`)
  if (process.env.DSH_CONTEXT_SCREENSHOT) {
    const { data } = await page('Page.captureScreenshot', { format: 'png' })
    await writeFile(process.env.DSH_CONTEXT_SCREENSHOT, Buffer.from(data, 'base64'))
  }
  await page('Emulation.setDeviceMetricsOverride', { width: 410, height: 720, deviceScaleFactor: 1, mobile: false })
  await evaluate(`Object.entries({'--vscode-foreground':'#333333','--vscode-descriptionForeground':'#616161','--vscode-sideBar-background':'#f3f3f3','--vscode-editor-background':'#ffffff','--vscode-widget-border':'#cccccc','--vscode-input-background':'#ffffff','--vscode-input-foreground':'#333333','--vscode-textLink-foreground':'#005fb8'}).forEach(([key,value]) => document.documentElement.style.setProperty(key,value)); tick();`)
  assert.equal(await evaluate('elements.inspector.scrollWidth <= elements.inspector.clientWidth'), true)
  if (process.env.DSH_CONTEXT_LIGHT_SCREENSHOT) {
    const { data } = await page('Page.captureScreenshot', { format: 'png' })
    await writeFile(process.env.DSH_CONTEXT_LIGHT_SCREENSHOT, Buffer.from(data, 'base64'))
  }
  await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await evaluate('tick()')
  assert.equal(await evaluate('!elements.inspector.open && document.activeElement.id === "usageTrigger"'), true)
  await evaluate(`(async () => {
    elements.usageTrigger.click(); document.querySelector('.inspect-action').click();
    const old = sent.findLast(message => message.type==='inspect-context');
    showState({...state,sessionId:'other'}); await tick(); inspectorReply(old);
    ensure(!elements.inspector.open && !inspection, 'late result reopened old session');
    elements.usageTrigger.click(); document.querySelector('.inspect-action').click();
    const request = sent.findLast(message => message.type==='inspect-context');
    inspectorReply(request,{error:'Connection unavailable'});
    ensure(!elements.inspectorRefresh.disabled && elements.inspectorStatus.textContent==='Connection unavailable', 'error did not allow retry');
    elements.inspectorRefresh.click(); const retry = sent.findLast(message => message.type==='inspect-context');
    ensure(retry.requestId > request.requestId, 'refresh reused request');
    inspectorReply(request); ensure(!inspection, 'late result replaced refresh');
    showState({...state,phase:'connecting'}); await tick(); inspectorReply(retry);
    ensure(!elements.inspector.open && !inspection, 'reconnect kept an old snapshot');
    ensure(!sent.some(message => message.type==='webview-error'), JSON.stringify(sent.filter(message => message.type==='webview-error')));
  })()`)
  console.log('PASS: context inspector, search/sort, safe rendering, snapshot stability, Escape, retry and session isolation at 300px')
  await page('Emulation.setDeviceMetricsOverride', { width: 300, height: 550, deviceScaleFactor: 1, mobile: false })
  await evaluate(`(async () => {
    showState({...baseline,subagentCount:2,jobs:[{id:'job',kind:'shell',label:'Development server',status:'running',startedAt:Date.now()}]}); await tick();
    elements.prompt.value='Keep this draft'; elements.jobsTrigger.click();
    ensure(tasksPanel.open, 'tasks did not open');
    window.taskFixture={sessionId:state.sessionId,truncated:false,tasks:[
      {address:{kind:'subagent',parentSessionId:state.sessionId,childSessionId:'child-a',mode:'continuable'},label:'Inspect API error handling',depth:0,status:'running',elapsedMs:1200},
      {address:{kind:'subagent',parentSessionId:'child-a',childSessionId:'child-b',mode:'one-shot'},label:'Review authentication edge cases',depth:1,status:'completed',elapsedMs:3450}
    ]};
    window.taskReply=(request,extra={})=>window.dispatchEvent(new MessageEvent('message',{data:{type:'task-inspection',sessionId:request.sessionId,requestId:request.requestId,inspection:taskFixture,...extra}}));
    const request=sent.findLast(message=>message.type==='inspect-tasks');
    taskReply({...request,requestId:request.requestId-1}); ensure(!taskSnapshot, 'accepted old task snapshot');
    taskReply(request);
    ensure(tasksContent.querySelectorAll('.task-row').length===2 && tasksContent.textContent.includes('Development server'), 'missing agent/job rows');
    const box=tasksPanel.getBoundingClientRect(); ensure(box.left>=0 && box.right<=innerWidth && box.top>=0 && box.bottom<=innerHeight, 'tasks out of bounds');
    ensure(tasksPanel.scrollWidth<=tasksPanel.clientWidth, 'tasks overflow narrow sidebar');
    tasksContent.querySelector('button').focus(); requestTasks(); taskReply(sent.findLast(message=>message.type==='inspect-tasks'));
    ensure(document.activeElement.dataset.taskId==='child-a', 'refresh stole task focus');
  })()`)
  if (process.env.DSH_TASKS_SCREENSHOT) {
    const { data } = await page('Page.captureScreenshot', { format: 'png' })
    await writeFile(process.env.DSH_TASKS_SCREENSHOT, Buffer.from(data, 'base64'))
  }
  await evaluate(`Object.entries({'--vscode-foreground':'#cccccc','--vscode-descriptionForeground':'#999999','--vscode-sideBar-background':'#181818','--vscode-editor-background':'#1f1f1f','--vscode-widget-border':'#454545','--vscode-input-background':'#313131','--vscode-input-foreground':'#cccccc','--vscode-textLink-foreground':'#4daafc'}).forEach(([key,value]) => document.documentElement.style.setProperty(key,value)); tick();`)
  if (process.env.DSH_TASKS_DARK_SCREENSHOT) {
    const { data } = await page('Page.captureScreenshot', { format: 'png' })
    await writeFile(process.env.DSH_TASKS_DARK_SCREENSHOT, Buffer.from(data, 'base64'))
  }
  await evaluate(`(async () => {
    tasksContent.querySelector('button').click();
    const request=sent.findLast(message=>message.type==='inspect-tasks');
    ensure(request.childId==='child-a', 'child address not sent');
    taskReply(request,{inspection:{...taskFixture,detail:{childSessionId:'child-a',truncated:true,messages:[
      {id:'reply',role:'assistant',text:'Found the cause. <img src=x onerror="alert(1)">',detail:'',failed:false},
      {id:'tool',role:'tool',text:'Read',detail:'Completed',failed:false,rawInput:'{"path":"src/api.ts"}',rawResult:'export const html = "<img src=x onerror=alert(1)>";'},
      {id:'failed-tool',role:'tool',text:'Bash',detail:'Failed',failed:true,rawInput:'{"command":"node debug-demo.js"}',rawResult:'Error: ENOENT: no such file, invoice.json'}
    ]}}});
    ensure(!tasksContent.querySelector('img'), 'agent output executed as markup');
    ensure(tasksContent.textContent.includes('bounded excerpt'), 'missing truncation notice');
    const records=tasksContent.querySelectorAll('details');
    records.forEach(record=>{record.open=true;});
    ensure(JSON.stringify([...records[0].querySelectorAll('pre')].map(pre=>pre.textContent))===JSON.stringify(['Completed','{"path":"src/api.ts"}','export const html = "<img src=x onerror=alert(1)>";']), 'missing or changed tool input/output');
    ensure(records[0].querySelectorAll('.task-meta')[0].textContent==='Input' && records[0].querySelectorAll('.task-meta')[1].textContent==='Output', 'missing tool section labels');
    ensure(records[1].querySelector('summary').textContent==='Failed · Bash' && records[1].textContent.includes('Error / Output'), 'failed tool was not labeled');
    ensure(records[1].querySelector('pre:last-child').textContent==='Error: ENOENT: no such file, invoice.json', 'failure reason was lost');
    ensure(!tasksContent.querySelector('img, a'), 'tool input/output was rendered as markup');
    ensure(tasksPanel.scrollWidth<=tasksPanel.clientWidth, 'tool output overflows narrow sidebar');
    records[1].querySelector('summary').focus();
    requestTasks(); taskReply(sent.findLast(message=>message.type==='inspect-tasks'),{inspection:taskSnapshot});
    ensure([...tasksContent.querySelectorAll('details')].every(record=>record.open), 'refresh collapsed tool output');
    ensure(document.activeElement.closest('.task-record')?.dataset.recordId==='failed-tool', 'refresh stole tool focus');
    ensure(elements.prompt.value==='Keep this draft' && state.sessionId===taskSession, 'inspection changed parent draft/session');
    tasksBack.click(); taskReply(sent.findLast(message=>message.type==='inspect-tasks'));
    ensure(!taskChild && tasksContent.querySelectorAll('.task-row').length===2, 'back navigation failed');
  })()`)
  await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await evaluate(`(async () => {
    await tick(); ensure(!tasksPanel.open && document.activeElement.id==='jobsTrigger', 'Escape/focus restoration failed');
    elements.jobsTrigger.click(); const old=sent.findLast(message=>message.type==='inspect-tasks');
    showState({...state,sessionId:'another'}); await tick(); taskReply(old);
    ensure(!tasksPanel.open && !taskSnapshot, 'late result leaked into next conversation');
    elements.jobsTrigger.click(); taskReply(sent.findLast(message=>message.type==='inspect-tasks'),{error:'Runtime unavailable'});
    ensure(!tasksRefresh.disabled && tasksStatus.textContent.includes('Runtime unavailable'), 'task error cannot retry');
    tasksRefresh.click(); const retry=sent.findLast(message=>message.type==='inspect-tasks');
    showState({...state,phase:'loading'}); await tick(); taskReply(retry);
    ensure(!tasksPanel.open && !taskSnapshot, 'reconnect kept old task panel');
    ensure(!sent.some(message=>message.type==='webview-error'), JSON.stringify(sent.filter(message=>message.type==='webview-error')));
  })()`)
  console.log('PASS: task tree, read-only child output, background jobs, draft/focus preservation, errors, Escape and session isolation at 300px')
  // Search results are host snapshots; selecting one reveals a real chat node.
  // Keep both state-before-ack and ack-before-render delivery orders covered.
  await evaluate(`(async () => {
    showState({...baseline,messages:[{id:'question',role:'user',text:'Investigate the invoice'},...baseline.messages]}); await tick();
    elements.prompt.value='Unsent draft'; elements.prompt.focus();
    window.navigationFixture={sessionId:state.sessionId,query:'',total:1,indexedMessages:2,hasMore:true,limited:false,matches:[{id:'question',role:'user',label:'You',snippet:'Investigate the invoice'}]};
    window.navigationReply=(request,extra={})=>window.dispatchEvent(new MessageEvent('message',{data:{type:'conversation-search',sessionId:request.sessionId,requestId:request.requestId,result:{...navigationFixture,query:request.query.trim()},...extra}}));
    window.navigationAck=request=>window.dispatchEvent(new MessageEvent('message',{data:{type:'conversation-revealed',sessionId:request.sessionId,requestId:request.requestId,messageId:request.messageId}}));
  })()`)
  await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', modifiers: 2, windowsVirtualKeyCode: 70 })
  await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70 })
  await evaluate(`(async () => {
    ensure(navigationPanel.open && document.activeElement===navigationQuery, 'Ctrl+F did not focus search');
    const request=sent.findLast(message=>message.type==='search-conversation');
    navigationReply({...request,requestId:request.requestId-1}); ensure(!navigationResult, 'accepted stale search');
    navigationReply(request);
    ensure(navigationResults.querySelectorAll('button').length===1 && !navigationOlder.classList.contains('hidden'), 'missing outline/history button');
    const originalMessages=state.messages;
    navigationOlder.click(); const older=sent.findLast(message=>message.type==='search-conversation');
    ensure(older.older===true, 'earlier history was not requested');
    navigationReply(older); ensure(state.messages===originalMessages, 'search modified conversation');
    navigationQuery.value='invoice'; navigationQuery.dispatchEvent(new Event('input')); await tick(220);
    const query=sent.findLast(message=>message.type==='search-conversation');
    navigationReply(older); ensure(!navigationResults.children.length, 'old query replaced current results');
    navigationFixture={...navigationFixture,query:'invoice',total:2,matches:[
      {id:'older-question',role:'user',label:'You',snippet:'Check invoice totals <img src=x>',matchStart:6,matchLength:7},
      {id:'older-tool',role:'tool',label:'Tool · Read invoice.log',snippet:'Invoice total: 12; expected 36.',matchStart:0,matchLength:7}
    ]}; navigationReply(query);
    ensure(navigationResults.querySelectorAll('mark').length===2 && !navigationPanel.querySelector('img'), 'unsafe/missing highlighted text');
    const box=navigationPanel.getBoundingClientRect();
    ensure(box.left>=0 && box.right<=innerWidth && box.top>=0 && box.bottom<=innerHeight && navigationPanel.scrollWidth<=navigationPanel.clientWidth, 'search overflow at 300px');
    ensure(elements.prompt.value==='Unsent draft', 'search erased draft');
  })()`)
  if (process.env.DSH_NAVIGATION_SCREENSHOT) {
    const { data } = await page('Page.captureScreenshot', { format: 'png' })
    await writeFile(process.env.DSH_NAVIGATION_SCREENSHOT, Buffer.from(data, 'base64'))
  }
  await evaluate(`navigationQuery.focus(); navigationQuery.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
    ensure(document.activeElement===navigationResults.querySelector('button'), 'ArrowDown did not enter results');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));
    ensure(document.activeElement===navigationQuery, 'ArrowUp did not return to query');
    Object.entries({'--vscode-foreground':'#333333','--vscode-descriptionForeground':'#616161','--vscode-sideBar-background':'#f3f3f3','--vscode-editor-background':'#ffffff','--vscode-widget-border':'#cccccc','--vscode-input-background':'#ffffff','--vscode-input-foreground':'#333333','--vscode-textLink-foreground':'#005fb8'}).forEach(([key,value]) => document.documentElement.style.setProperty(key,value)); tick();`)
  if (process.env.DSH_NAVIGATION_LIGHT_SCREENSHOT) {
    const { data } = await page('Page.captureScreenshot', { format: 'png' })
    await writeFile(process.env.DSH_NAVIGATION_LIGHT_SCREENSHOT, Buffer.from(data, 'base64'))
  }
  await evaluate(`(async () => {
    navigationResults.querySelector('button').click(); const reveal=sent.findLast(message=>message.type==='reveal-conversation-message');
    navigationAck(reveal); await tick(); ensure(navigationPanel.open, 'closed before target was rendered');
    showState({...state,messages:[{id:'older-question',role:'user',text:'Check invoice totals <img src=x>'},...state.messages]}); await tick();
    const target=renderedMessages.get('older-question').node;
    ensure(!navigationPanel.open && !conversationScroller.following && target===document.activeElement, 'jump/focus/paused intent failed');
    ensure(target.querySelector('mark').textContent==='invoice' && !target.querySelector('img'), 'match excerpt was unsafe or missing');
    ensure(Math.abs(target.getBoundingClientRect().top-elements.scroll.getBoundingClientRect().top-12)<3, 'jump landed at wrong position');
    const top=elements.scroll.scrollTop;
    showState({...state,messages:[...state.messages,{id:'stream-tail',role:'assistant',text:'More streamed content\\n\\n'.repeat(30),streaming:true}]}); await tick();
    ensure(!conversationScroller.following && Math.abs(elements.scroll.scrollTop-top)<2, 'streaming stole navigation position');
    // Jump to a collapsed tool near the bottom, after full state arrives first.
    navigationTrigger.click(); navigationFixture={...navigationFixture,query:'',total:1,matches:[{id:'last-tool',role:'tool',label:'Tool',snippet:'Final output'}]};
    navigationReply(sent.findLast(message=>message.type==='search-conversation'));
    navigationResults.querySelector('button').click(); const next=sent.findLast(message=>message.type==='reveal-conversation-message');
    showState({...state,messages:[...state.messages,{id:'last-tool',role:'tool',text:'Read file',rawResult:'Final output',detail:'Completed'}]}); await tick();
    navigationAck(next); await tick();
    const tool=renderedMessages.get('last-tool').node;
    ensure(tool.open && !conversationScroller.following && gap()<=2, 'near-bottom reveal must expand tool without resuming follow: '+JSON.stringify({open:tool.open,following:conversationScroller.following,gap:gap(),tag:tool.tagName}));
    showState({...state,messages:[...state.messages,{id:'next-chunk',role:'assistant',text:'New paragraph\\n\\n'.repeat(20)}]}); await tick();
    ensure(!conversationScroller.following && gap()>100 && !document.getElementById('jumpLatest').hidden, 'jump was lost on next chunk');
    document.getElementById('jumpLatest').click(); await tick(); ensure(conversationScroller.following && gap()<=2, 'cannot resume after navigation');
    navigationTrigger.click(); navigationReply(sent.findLast(message=>message.type==='search-conversation'));
  })()`)
  await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await evaluate(`(async () => {
    await tick(); ensure(!navigationPanel.open && document.activeElement===navigationTrigger, 'Escape did not restore search trigger focus');
    navigationTrigger.click(); const request=sent.findLast(message=>message.type==='search-conversation');
    navigationReply(request,{error:'History unavailable'});
    ensure(!navigationRefresh.disabled && navigationStatus.textContent==='History unavailable', 'cannot retry failed search');
    navigationRefresh.click(); const retry=sent.findLast(message=>message.type==='search-conversation');
    navigationReply(request); ensure(!navigationResults.children.length, 'late result replaced retry');
    showState({...state,sessionId:'new-conversation'}); await tick(); navigationReply(retry);
    ensure(!navigationPanel.open && !navigationResult, 'search survived session switch');
    navigationTrigger.click(); const old=sent.findLast(message=>message.type==='search-conversation');
    showState({...state,phase:'connecting'}); await tick(); navigationReply(old);
    ensure(!navigationPanel.open && navigationTrigger.disabled, 'search survived reconnect');
    ensure(!sent.some(message=>message.type==='webview-error'), JSON.stringify(sent.filter(message=>message.type==='webview-error')));
  })()`)
  console.log('PASS: search/outline, older pages, literal highlights, stale replies, keyboard, draft isolation and jump without auto-follow at 300px')

  // Native webviews can stop delivering animation frames while the display is
  // asleep. Host messages still arrive: navigation must not wait for a paint.
  await evaluate(`(async () => {
    window.holdRenderFrames=()=>{
      const raf=window.requestAnimationFrame, cancel=window.cancelAnimationFrame;
      const held=new Map(); let id=1000000;
      window.requestAnimationFrame=callback=>{held.set(++id,callback);return id;};
      window.cancelAnimationFrame=value=>{if(!held.delete(value)) cancel(value);};
      return ()=>{
        window.requestAnimationFrame=raf; window.cancelAnimationFrame=cancel;
        for(const callback of held.values()) raf(callback);
      };
    };
    window.openNavigationFixture=(id)=>{
      navigationTrigger.click();
      navigationFixture={sessionId:state.sessionId,query:'',total:1,indexedMessages:2,hasMore:false,limited:false,matches:[{id,role:'user',label:'You',snippet:'hi'}]};
      navigationReply(sent.findLast(message=>message.type==='search-conversation'));
      navigationResults.querySelector('button').click();
      return sent.findLast(message=>message.type==='reveal-conversation-message');
    };
    showState({...baseline,sessionId:'paused-paint',messages:[{id:'first',role:'user',text:'hi'},...baseline.messages]}); await tick();
    elements.prompt.value='Keep this draft';
    const request=openNavigationFixture('first');
    const restore=holdRenderFrames();
    try {
      showState(JSON.parse(JSON.stringify({...state,messages:[{id:'first',role:'user',text:'hi, updated'},...baseline.messages]})));
      navigationAck(request); await tick();
      const target=renderedMessages.get('first').node;
      ensure(!navigationPanel.open && target===document.activeElement, 'jump waited for a suspended animation frame');
      ensure(target.textContent.includes('hi, updated') && target.classList.contains('navigation-target'), 'jump used stale content');
      ensure(!navigationJump && pendingRenderState===undefined && renderFrame===undefined, 'jump left a pending render');
      ensure(!conversationScroller.following && elements.prompt.value==='Keep this draft', 'jump changed follow intent or draft');
      ensure(Math.abs(target.getBoundingClientRect().top-elements.scroll.getBoundingClientRect().top-12)<3, 'paused-frame jump landed incorrectly');
    } finally { restore(); }
    await tick();
    ensure(document.activeElement===renderedMessages.get('first').node, 'resuming paints replaced the focused target');

    // ACK before the older message arrives must wait for data, not for rAF.
    const older=openNavigationFixture('older-paused');
    const restoreOlder=holdRenderFrames();
    try {
      navigationAck(older); await tick();
      ensure(navigationPanel.open && navigationStatus.textContent==='Waiting for message content…', 'ACK/data wait was not distinguished');
      showState({...state,messages:[{id:'older-paused',role:'user',text:'Older prompt'},...state.messages]}); await tick();
      ensure(!navigationPanel.open && document.activeElement===renderedMessages.get('older-paused').node, 'late content waited for a suspended animation frame');
      ensure(!conversationScroller.following, 'late content resumed following');
    } finally { restoreOlder(); }
    await tick();
    ensure(!sent.some(message=>message.type==='webview-error'), JSON.stringify(sent.filter(message=>message.type==='webview-error')));
  })()`)
  console.log('PASS: paused animation frames, full-state flush, ACK before content, focus/draft preservation and resumed paint')
  await evaluate(`(async () => {
    const turnTool={id:'turn-hidden',role:'tool',turn:7,text:'Read',detail:'Complete',deferredBody:true,deferredBodyRevision:1};
    const legacyTool={id:'legacy-hidden',role:'tool',text:'Read',detail:'Complete',deferredBody:true,deferredBodyRevision:1};
    const messages=[{id:'intro',role:'user',text:'Intro'},turnTool,{id:'answer',role:'assistant',turn:7,text:'Answer',turnEnded:true},legacyTool,{id:'legacy-other',role:'tool',text:'Write'}];
    showState({...baseline,sessionId:'collapsed-navigation',running:false,messages}); await tick();
    ensure(!document.querySelector('.turn-activity > details').open && !renderedMessages.has(turnTool.id), 'turn fixture was not lazy and closed');
    ensure(!document.querySelector('.tool-group').open, 'legacy fixture was not closed');
    const turnRequest=openNavigationFixture(turnTool.id), restore=holdRenderFrames();
    try {
      navigationAck(turnRequest); await tick();
      const target=renderedMessages.get(turnTool.id).node;
      ensure(!navigationPanel.open && target===document.activeElement && target.open && target.closest('.turn-activity > details').open, 'turn target was not visible and focused');
      ensure(target.getBoundingClientRect().height>0 && !conversationScroller.following, 'turn reveal did not preserve paused scrolling');
      ensure(sent.some(message=>message.type==='load-tool-output' && message.messageId===turnTool.id), 'turn deferred output was not initialized synchronously');
    } finally { restore(); }
    await tick();
    const legacyRequest=openNavigationFixture(legacyTool.id);
    navigationAck(legacyRequest); await tick();
    const legacy=renderedMessages.get(legacyTool.id).node;
    ensure(!navigationPanel.open && legacy===document.activeElement && legacy.open && legacy.closest('.tool-group').open, 'legacy target was not visible and focused');
    ensure(legacy.getBoundingClientRect().height>0 && !conversationScroller.following, 'legacy reveal resumed following or hid target');
    ensure(sent.some(message=>message.type==='load-tool-output' && message.messageId===legacyTool.id), 'legacy deferred output was not initialized');
    showState({...state,messages:[...state.messages,{id:'reasoning-only',role:'assistant',turn:9,text:'Temporary answer',reasoning:{text:'Thinking',active:false,tokens:2}}]}); await tick();
    showState({...state,messages:state.messages.map(message=>message.id==='reasoning-only' ? {...message,text:''} : message)}); await tick();
    const reasoningRequest=openNavigationFixture('reasoning-only'); navigationAck(reasoningRequest); await tick();
    ensure(!navigationPanel.open && document.activeElement.classList.contains('reasoning') && document.activeElement.isConnected, 'reasoning-only fallback remained detached');
    const pending=openNavigationFixture('missing-turn');
    navigationAck(pending); await tick();
    showState({...state,sessionId:'switched-during-jump'}); await tick();
    showState({...state,messages:[...state.messages,{id:'missing-turn',role:'tool',turn:8,text:'Late'}]}); await tick();
    ensure(!navigationPanel.open && !navigationJump && !document.querySelector('[data-scroll-id="missing-turn"]'), 'cancelled jump leaked into another session');
    ensure(!sent.some(message=>message.type==='webview-error'), JSON.stringify(sent.filter(message=>message.type==='webview-error')));
    const runningTool={id:'changed-tool',role:'tool',turn:11,text:'Read',detail:'Running',streaming:true};
    const answer={id:'turn-answer',role:'assistant',turn:11,text:'Answer'};
    showState({...baseline,sessionId:'reconcile-navigation',running:true,messages:[runningTool,answer]}); await tick();
    const activity=document.querySelector('.turn-activity > details'); activity.open=true; await tick();
    const stale=renderedMessages.get(runningTool.id).node;
    activity.open=false; await tick();
    const finished={...runningTool,detail:'Complete',streaming:false,turnEnded:true,deferredBody:true,deferredBodyRevision:1};
    showState({...state,running:false,messages:[finished,answer]}); await tick();
    ensure(stale.isConnected && renderedMessages.get(runningTool.id).node===stale, 'fixture did not retain the stale connected node');
    const changedRequest=openNavigationFixture(runningTool.id); navigationAck(changedRequest);
    const current=renderedMessages.get(runningTool.id).node;
    ensure(current!==stale && current.isConnected && current.open && activity.open, 'reveal did not reconcile the completed tool');
    ensure(sent.some(message=>message.type==='load-tool-output' && message.messageId===runningTool.id), 'completed deferred output was not initialized');
    await tick();
    ensure(renderedMessages.get(runningTool.id).node===current && document.activeElement===current && current.classList.contains('navigation-target') && current.getBoundingClientRect().height>0, 'native toggle replaced the focused navigation target');
    ensure(!conversationScroller.following, 'completed tool reveal resumed following');
    activity.open=false; await tick();
    const answerRequest=openNavigationFixture(answer.id); navigationAck(answerRequest); await tick();
    ensure(!activity.open && document.activeElement===renderedMessages.get(answer.id).node, 'answer navigation unnecessarily opened activity');
    showState({...baseline,sessionId:'paused-paint'}); await tick(); elements.prompt.value='Keep this draft';
  })()`)
  console.log('PASS: collapsed turn and legacy tool navigation, deferred output, paused frames and session cancellation')
  await evaluate(`(async () => {
    // Explicit Jump to latest must work even when automatic layout work is
    // waiting for a paint. Keep subsequent streaming batched as before.
    conversationScroller.pause(); elements.scroll.scrollTop=100; await tick();
    const restore=holdRenderFrames();
    try {
      conversationScroller.resume(); // Queue a follow frame before the click.
      ensure(gap()>100, 'fixture must start away from the tail');
      document.getElementById('jumpLatest').click();
      ensure(gap()<=2 && conversationScroller.following, 'Jump to latest waited for a suspended animation frame');
      ensure(document.getElementById('jumpLatest').hidden && document.activeElement===elements.scroll, 'jump did not hide its button or transfer focus');
      ensure(elements.prompt.value==='Keep this draft', 'jump changed the draft');
      await tick();
      const before=elements.scroll.scrollTop;
      const row=document.createElement('div'); row.style.height='200px'; elements.messages.append(row);
      conversationScroller.changed(); conversationScroller.changed();
      ensure(elements.scroll.scrollTop===before && gap()>100, 'automatic follow stopped batching');
    } finally { restore(); }
    await tick();
    ensure(gap()<=2 && conversationScroller.following, 'following did not recover after paints resumed');
  })()`)
  console.log('PASS: immediate Jump to latest with paused frames, focus/draft preservation and batched streaming')
} finally {
  clearTimeout(timeout)
  socket?.terminate()
  child.kill()
  await exited
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
