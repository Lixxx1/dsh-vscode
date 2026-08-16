import * as vscode from 'vscode'

function nonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let value = ''
  for (let index = 0; index < 32; index += 1) value += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
  return value
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function chatHtml(webview: vscode.Webview, deepseekMarkUri: vscode.Uri): string {
  const token = nonce()
  const mark = escapeHtml(deepseekMarkUri.toString(true))
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${token}';">
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body {
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font: 13px/1.5 var(--vscode-font-family);
      overflow: hidden;
    }
    button, select, textarea { font: inherit; color: inherit; }
    button { cursor: pointer; }
    #app { width: 100%; max-width: 100%; height: 100%; min-width: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; overflow: hidden; }
    .toolbar {
      width: 100%; min-width: 0; min-height: 38px; padding: 4px 8px 4px 12px; display: flex; align-items: center; gap: 6px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
    }
    .session-select {
      min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; font-weight: 600;
      text-overflow: ellipsis;
    }
    .icon-button {
      width: 28px; height: 28px; min-width: 28px; padding: 0; display: grid; place-items: center; border: 0; border-radius: 5px;
      background: transparent; color: var(--vscode-icon-foreground);
    }
    .icon-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .icon-button:focus-visible, select:focus-visible, textarea:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .scroll { width: 100%; min-width: 0; min-height: 0; overflow-x: hidden; overflow-y: auto; scrollbar-color: var(--vscode-scrollbarSlider-background) transparent; }
    .conversation { width: 100%; min-width: 0; max-width: 720px; margin: 0 auto; padding: 12px 14px 28px; overflow: hidden; }
    .empty { min-height: 55vh; display: grid; place-content: center; justify-items: center; text-align: center; padding: 28px 10px; }
    .deepseek-mark {
      background-color: #4d6bfe;
      -webkit-mask: url("${mark}") center / contain no-repeat;
      mask: url("${mark}") center / contain no-repeat;
    }
    .empty-logo { width: 38px; height: 38px; margin-bottom: 13px; }
    .empty h2 { margin: 0 0 7px; font-size: 15px; font-weight: 600; }
    .empty p { max-width: 270px; margin: 0; color: var(--vscode-descriptionForeground); }
    .message { width: 100%; min-width: 0; max-width: 100%; padding: 8px 0 16px; overflow: hidden; }
    .message + .message { margin-top: 8px; }
    .message-head { min-width: 0; display: flex; align-items: center; gap: 8px; margin-bottom: 7px; font-size: 12px; font-weight: 600; }
    .avatar {
      width: 21px; height: 21px; flex: 0 0 21px; display: grid; place-items: center; border-radius: 50%;
      background: color-mix(in srgb, #4d6bfe 78%, var(--vscode-editor-background)); color: white; font-size: 10px;
    }
    .assistant .avatar { border-radius: 0; background-color: #4d6bfe; }
    .message-body { width: 100%; min-width: 0; max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; font-size: 13px; line-height: 1.65; }
    .assistant .message-body { padding-left: 29px; }
    .user .message-body {
      width: fit-content; max-width: calc(100% - 29px); margin-left: 29px; padding: 9px 12px; border-radius: 12px;
      background: color-mix(in srgb, #4d6bfe 7%, var(--vscode-textBlockQuote-background));
    }
    .tool { margin: 5px 0; padding: 7px 9px; border: 1px solid var(--vscode-widget-border); border-radius: 6px; }
    .tool .message-head { margin: 0; }
    .tool-detail { margin-left: auto; color: var(--vscode-descriptionForeground); font-weight: 400; }
    .failed { color: var(--vscode-errorForeground); }
    .streaming::after { content: ''; display: inline-block; width: 6px; height: 13px; margin-left: 2px; vertical-align: -2px; background: var(--vscode-foreground); animation: blink 1s steps(2) infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    .status {
      margin: 10px 0; padding: 10px; border-radius: 6px; color: var(--vscode-descriptionForeground);
      background: var(--vscode-textBlockQuote-background); overflow-wrap: anywhere;
    }
    .status.error { color: var(--vscode-errorForeground); }
    .status-actions { display: flex; gap: 7px; margin-top: 9px; }
    .secondary { padding: 4px 9px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .composer-wrap { width: 100%; min-width: 0; max-width: 100%; padding: 0 10px 10px; overflow: hidden; background: linear-gradient(transparent, var(--vscode-sideBar-background) 18px); }
    .composer {
      width: 100%; min-width: 0; max-width: 720px; margin: 0 auto; overflow: hidden; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
      border-radius: 14px; background: var(--vscode-input-background); box-shadow: 0 2px 10px color-mix(in srgb, var(--vscode-widget-shadow) 75%, transparent);
    }
    textarea {
      width: 100%; min-height: 76px; max-height: 220px; resize: none; display: block; padding: 11px 12px 4px;
      border: 0; outline: 0; background: transparent; color: var(--vscode-input-foreground);
    }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    .composer-row {
      width: 100%; min-width: 0; min-height: 39px; padding: 4px 6px 6px 9px;
      display: grid; grid-template-columns: minmax(48px, .7fr) minmax(0, 1.35fr) minmax(58px, .65fr) 28px; align-items: center; gap: 7px;
    }
    .project { min-width: 0; overflow: hidden; display: flex; align-items: center; gap: 5px; color: var(--vscode-descriptionForeground); }
    .project span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .project svg { width: 15px; height: 15px; flex: 0 0 auto; }
    .model-select, .effort-select { width: 100%; min-width: 0; max-width: 100%; border: 0; outline: 0; color: var(--vscode-descriptionForeground); background: transparent; text-overflow: ellipsis; }
    .composer-row > .send { grid-column: 4; grid-row: 1; }
    .send { border-radius: 8px; color: white; background: #4d6bfe; }
    .send:hover { background: #405de6; }
    .send:disabled, textarea:disabled { opacity: .55; cursor: default; }
    .hidden { display: none !important; }
    @media (max-width: 300px) {
      .conversation { padding-inline: 10px; }
      .composer-row { grid-template-columns: 20px minmax(0, 1fr) minmax(54px, .65fr) 28px; }
      .project span { display: none; }
    }
  </style>
</head>
<body>
  <div id="app">
    <header class="toolbar">
      <select id="sessions" class="session-select" aria-label="Project conversations"></select>
      <button id="newSession" class="icon-button" title="New conversation" aria-label="New conversation">
        <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </header>
    <main id="scroll" class="scroll">
      <div id="conversation" class="conversation"></div>
    </main>
    <footer class="composer-wrap">
      <div class="composer">
        <textarea id="prompt" rows="3" placeholder="Ask DeepSeek about this project" aria-label="Message DeepSeek"></textarea>
        <div class="composer-row">
          <div class="project" title="Current VS Code workspace">
            <svg viewBox="0 0 24 24"><path d="M3 7.5h7l2 2h9v9.5H3z"/><path d="M3 7.5V5h7l2 2h5"/></svg>
            <span id="workspace">Workspace</span>
          </div>
          <select id="models" class="model-select" aria-label="Model"></select>
          <select id="efforts" class="effort-select" aria-label="Reasoning effort"></select>
          <button id="send" class="icon-button send" title="Send (Enter)" aria-label="Send">
            <svg viewBox="0 0 24 24"><path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"/></svg>
          </button>
          <button id="cancel" class="icon-button send hidden" title="Stop" aria-label="Stop">
            <svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1"/></svg>
          </button>
        </div>
      </div>
    </footer>
  </div>
  <script nonce="${token}">
    const vscode = acquireVsCodeApi();
    const elements = {
      conversation: document.getElementById('conversation'),
      scroll: document.getElementById('scroll'),
      sessions: document.getElementById('sessions'),
      newSession: document.getElementById('newSession'),
      prompt: document.getElementById('prompt'),
      workspace: document.getElementById('workspace'),
      models: document.getElementById('models'),
      efforts: document.getElementById('efforts'),
      send: document.getElementById('send'),
      cancel: document.getElementById('cancel'),
    };
    let state;

    function node(tag, className, text) {
      const value = document.createElement(tag);
      if (className) value.className = className;
      if (text !== undefined) value.textContent = text;
      return value;
    }

    function renderMessage(message) {
      if (message.role === 'tool') {
        const item = node('article', 'message tool' + (message.failed ? ' failed' : ''));
        const head = node('div', 'message-head');
        head.append(node('span', 'avatar', '›'), node('span', '', message.text));
        head.append(node('span', 'tool-detail', message.detail || ''));
        item.append(head);
        return item;
      }
      if (message.role === 'notice') return node('div', 'status' + (message.failed ? ' error' : ''), message.text);
      const item = node('article', 'message ' + message.role);
      const head = node('div', 'message-head');
      head.append(node('span', 'avatar' + (message.role === 'assistant' ? ' deepseek-mark' : ''), message.role === 'user' ? 'Y' : ''));
      head.append(node('span', '', message.role === 'user' ? 'You' : 'DeepSeek'));
      const body = node('div', 'message-body' + (message.streaming ? ' streaming' : ''), message.text);
      item.append(head, body);
      return item;
    }

    function renderStatus(current) {
      const box = node('div', 'status' + (current.phase === 'error' ? ' error' : ''), current.statusText || 'Starting DeepSeek Harness…');
      if (current.phase === 'error') {
        const actions = node('div', 'status-actions');
        const retry = node('button', 'secondary', 'Restart');
        const output = node('button', 'secondary', 'Show output');
        retry.addEventListener('click', () => vscode.postMessage({ type: 'restart' }));
        output.addEventListener('click', () => vscode.postMessage({ type: 'output' }));
        actions.append(retry, output);
        box.append(actions);
      }
      return box;
    }

    function renderEmpty(current) {
      const empty = node('div', 'empty');
      const logo = node('div', 'empty-logo deepseek-mark');
      empty.append(logo, node('h2', '', 'Build with DeepSeek'));
      empty.append(node('p', '', 'Ask questions, explore code, and make changes in ' + current.workspaceName + '.'));
      return empty;
    }

    function render(current) {
      state = current;
      elements.workspace.textContent = current.workspaceName || 'Workspace';
      elements.workspace.parentElement.title = current.cwd || 'Current VS Code workspace';

      elements.sessions.replaceChildren();
      for (const session of current.sessions || []) {
        const option = document.createElement('option');
        option.value = session.id;
        option.textContent = session.title;
        option.selected = session.id === current.sessionId;
        elements.sessions.append(option);
      }
      if (!elements.sessions.childElementCount) elements.sessions.append(new Option('New conversation', ''));

      elements.models.replaceChildren();
      for (const model of current.models || []) {
        const option = document.createElement('option');
        option.value = JSON.stringify({ provider: model.provider, model: model.model });
        option.textContent = model.label;
        option.selected = model.selected === true;
        elements.models.append(option);
      }
      if (!elements.models.childElementCount) elements.models.append(new Option('Default model', ''));
      renderEfforts((current.models || []).find(model => model.selected) || current.models?.[0]);

      elements.conversation.replaceChildren();
      if (current.phase !== 'ready') {
        elements.conversation.append(renderStatus(current));
      } else if (!current.messages || current.messages.length === 0) {
        elements.conversation.append(renderEmpty(current));
      } else {
        for (const message of current.messages) elements.conversation.append(renderMessage(message));
      }

      const enabled = current.phase === 'ready' && current.routable !== false && Boolean(current.sessionId);
      elements.prompt.disabled = !enabled;
      elements.send.disabled = !enabled || elements.prompt.value.trim() === '';
      elements.newSession.disabled = current.phase !== 'ready';
      elements.sessions.disabled = current.phase !== 'ready';
      elements.models.disabled = !enabled || (current.models || []).length === 0;
      elements.efforts.disabled = !enabled || elements.efforts.options.length === 0 || elements.efforts.value === '';
      elements.send.classList.toggle('hidden', current.running === true);
      elements.cancel.classList.toggle('hidden', current.running !== true);
      requestAnimationFrame(() => { elements.scroll.scrollTop = elements.scroll.scrollHeight; });
    }

    function resizePrompt() {
      elements.prompt.style.height = 'auto';
      elements.prompt.style.height = Math.min(elements.prompt.scrollHeight, 220) + 'px';
      elements.send.disabled = !state || state.phase !== 'ready' || elements.prompt.value.trim() === '';
    }

    function renderEfforts(model) {
      elements.efforts.replaceChildren();
      const efforts = model?.reasoningEfforts || [];
      for (const effort of efforts) {
        const option = new Option(effort.label, effort.id, false, effort.selected === true);
        elements.efforts.append(option);
      }
      if (!efforts.length) elements.efforts.append(new Option('Default', ''));
      elements.efforts.title = efforts.length ? 'Reasoning effort' : 'This model has no reasoning effort setting';
    }

    function selectionFor(model, reasoningEffort) {
      return {
        provider: model.provider,
        model: model.model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      };
    }

    function send() {
      const text = elements.prompt.value.trim();
      if (!text || !state || state.phase !== 'ready') return;
      vscode.postMessage({ type: 'send', text });
      elements.prompt.value = '';
      resizePrompt();
    }

    elements.prompt.addEventListener('input', resizePrompt);
    elements.prompt.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send();
      }
    });
    elements.send.addEventListener('click', send);
    elements.cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    elements.newSession.addEventListener('click', () => vscode.postMessage({ type: 'new-session' }));
    elements.sessions.addEventListener('change', () => vscode.postMessage({ type: 'select-session', sessionId: elements.sessions.value }));
    elements.models.addEventListener('change', () => {
      if (!elements.models.value) return;
      const selected = JSON.parse(elements.models.value);
      const model = (state.models || []).find(item => item.provider === selected.provider && item.model === selected.model);
      if (!model) return;
      renderEfforts(model);
      const effort = model.defaultReasoningEffort || model.reasoningEfforts?.[0]?.id;
      if (effort) elements.efforts.value = effort;
      elements.efforts.disabled = !model.reasoningEfforts?.length;
      vscode.postMessage({ type: 'select-model', selection: selectionFor(model, effort) });
    });
    elements.efforts.addEventListener('change', () => {
      if (!elements.models.value) return;
      const selected = JSON.parse(elements.models.value);
      const model = (state.models || []).find(item => item.provider === selected.provider && item.model === selected.model);
      if (model) vscode.postMessage({ type: 'select-model', selection: selectionFor(model, elements.efforts.value) });
    });
    window.addEventListener('message', event => {
      if (event.data?.type === 'state') render(event.data.state);
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`
}
