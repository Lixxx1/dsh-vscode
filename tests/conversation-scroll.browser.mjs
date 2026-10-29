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
  '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
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
  await evaluate(markdown); await evaluate(scrollBundle); await evaluate(inline)
  await evaluate(`window.tick = (ms = 90) => new Promise(resolve => setTimeout(resolve, ms));
    window.ensure = (value, message) => { if (!value) throw new Error(message); };
    window.gap = () => elements.scroll.scrollHeight - elements.scroll.scrollTop - elements.scroll.clientHeight;
    window.baseline = {phase:'ready',sessionId:'a',workspaceName:'scroll-demo',cwd:'/demo',sessions:[{id:'a',title:'Auto-scroll regression'}],models:[],permissions:[],commands:[],skills:[],queue:[],changedFiles:[],messages:[{id:'reply',role:'assistant',text:'# Streaming reply\\n\\n' + 'Paragraph of output.\\n\\n'.repeat(40),streaming:true}]};
    window.showState = value => window.dispatchEvent(new MessageEvent('message', {data:{type:'state',state:value}}));
    showState(baseline);`)
  await evaluate('tick()')
  assert.equal(await evaluate('gap() <= 2 && conversationScroller.following'), true)

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
    showState({...baseline,sessionId:'tools',messages:[...baseline.messages,{id:'tool',role:'tool',text:'Read file',rawResult:'output\\n'.repeat(30)}]}); await tick();
    const tool = document.querySelector('details.tool'); tool.querySelector('summary').click(); await tick();
    ensure(!conversationScroller.following && tool.open, 'manual expansion must preserve reading');
    conversationScroller.resume(); await tick();
    showState({...state,messages:[...state.messages,{id:'auto-tool',role:'tool',text:'Running',streaming:true,rawResult:'running\\n'.repeat(20)}]}); await tick();
    ensure(conversationScroller.following && gap() <= 2, 'automatic expansion lost follow');
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
  await evaluate('conversationScroller.pause(); elements.scroll.scrollTop -= 180;')
  await evaluate('tick()')
  assert.equal(await evaluate(`(() => { const b=document.getElementById('jumpLatest').getBoundingClientRect(), s=elements.scroll.getBoundingClientRect(); return b.width>0 && b.left>=s.left && b.right<=s.right && b.bottom<=s.bottom; })()`), true)
  console.log('PASS: narrow sidebar resize and visible, in-bounds button')
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
      {id:'tool',role:'tool',text:'Read src/api.ts',detail:'Recorded tool output',failed:false}
    ]}}});
    ensure(!tasksContent.querySelector('img'), 'agent output executed as markup');
    ensure(tasksContent.textContent.includes('bounded excerpt'), 'missing truncation notice');
    tasksContent.querySelector('details').open=true;
    requestTasks(); taskReply(sent.findLast(message=>message.type==='inspect-tasks'),{inspection:taskSnapshot});
    ensure(tasksContent.querySelector('details').open, 'refresh collapsed tool output');
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
