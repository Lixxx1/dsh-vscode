import type * as vscode from 'vscode'

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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${token}';">
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font: 13px/1.5 var(--vscode-font-family); }
    button, select, textarea, input { font: inherit; color: inherit; }
    button { cursor: pointer; }
    #app { width: 100%; height: 100%; min-width: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; overflow: hidden; }
    .toolbar { min-width: 0; min-height: 38px; padding: 4px 8px 4px 12px; display: flex; align-items: center; gap: 6px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent); }
    .session-select { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; font-weight: 600; text-overflow: ellipsis; }
    .icon-button { width: 28px; height: 28px; min-width: 28px; padding: 0; display: grid; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--vscode-icon-foreground); }
    .icon-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .jobs-control { position: relative; flex: 0 0 auto; }
    .jobs-trigger { width: auto; min-width: 28px; padding: 0 7px; display: flex; gap: 5px; font-size: 11px; }
    .jobs-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
    .jobs-trigger.live .jobs-dot { background: var(--vscode-charts-blue, #4d6bfe); box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-charts-blue, #4d6bfe) 20%, transparent); }
    .jobs-menu { position: absolute; z-index: 20; top: calc(100% + 5px); right: 0; width: min(340px, calc(100vw - 20px)); max-height: min(420px, 70vh); padding: 6px; overflow: auto; border: 1px solid var(--vscode-widget-border); border-radius: 8px; background: var(--vscode-menu-background, var(--vscode-editor-background)); box-shadow: 0 5px 18px var(--vscode-widget-shadow); }
    .jobs-title { padding: 5px 7px 7px; font-size: 11px; font-weight: 600; }
    .job-row { min-width: 0; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 2px 7px; padding: 7px; border-radius: 5px; }
    .job-row + .job-row { border-top: 1px solid color-mix(in srgb, var(--vscode-widget-border) 50%, transparent); }
    .job-kind { grid-row: 1 / 3; align-self: start; padding: 1px 5px; border-radius: 999px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: 9px; text-transform: uppercase; }
    .job-label { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; }
    .job-status { color: var(--vscode-descriptionForeground); font-size: 10px; }
    .job-detail { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .job-duration { grid-column: 3; grid-row: 1 / 3; align-self: center; color: var(--vscode-descriptionForeground); font: 10px var(--vscode-editor-font-family); }
    .icon-button:focus-visible, select:focus-visible, textarea:focus-visible, input:focus-visible, button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .scroll { min-width: 0; min-height: 0; overflow-x: hidden; overflow-y: auto; scrollbar-color: var(--vscode-scrollbarSlider-background) transparent; }
    .conversation { width: 100%; min-width: 0; max-width: 760px; margin: 0 auto; padding: 12px 14px 30px; overflow: hidden; }
    .conversation-slot, .messages { display: contents; }
    .history-loader { display: flex; justify-content: center; padding: 1px 0 9px; }
    .history-button { padding: 3px 9px; border: 0; border-radius: 5px; color: var(--vscode-textLink-foreground); background: transparent; font-size: 11px; }
    .history-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .empty { min-height: 55vh; display: grid; place-content: center; justify-items: center; text-align: center; padding: 28px 10px; }
    .deepseek-mark { background-color: #4d6bfe; -webkit-mask: url("${mark}") center / contain no-repeat; mask: url("${mark}") center / contain no-repeat; }
    .empty-logo { width: 38px; height: 38px; margin-bottom: 13px; }
    .empty h2 { margin: 0 0 7px; font-size: 15px; font-weight: 600; }
    .empty p { max-width: 280px; margin: 0; color: var(--vscode-descriptionForeground); }
    .message { width: 100%; min-width: 0; padding: 8px 0 16px; overflow: hidden; }
    .message + .message { margin-top: 8px; }
    .message-head { min-width: 0; display: flex; align-items: center; gap: 8px; margin-bottom: 7px; font-size: 12px; font-weight: 600; }
    .avatar { width: 21px; height: 21px; flex: 0 0 21px; display: grid; place-items: center; border-radius: 50%; background: color-mix(in srgb, #4d6bfe 78%, var(--vscode-editor-background)); color: white; font-size: 10px; }
    .assistant .avatar { border-radius: 0; background-color: #4d6bfe; }
    .message-body { width: 100%; min-width: 0; max-width: 100%; overflow-wrap: anywhere; word-break: break-word; font-size: 13px; line-height: 1.65; }
    .assistant .message-body { padding-left: 29px; }
    .message.user { display: flex; flex-direction: column; align-items: flex-end; padding-top: 6px; }
    .user .message-head { display: none; }
    .user .message-body { width: fit-content; max-width: 82%; margin-left: auto; padding: 8px 12px; white-space: pre-wrap; border-radius: 16px; background: color-mix(in srgb, var(--vscode-foreground) 8%, var(--vscode-editor-background)); }
    .message-images { width: 100%; display: grid; gap: 7px; margin-top: 8px; }
    .message-image { display: block; max-width: 100%; max-height: 380px; border: 1px solid var(--vscode-widget-border); border-radius: 8px; object-fit: contain; background: var(--vscode-editor-background); }
    .message-image-status { padding: 8px 10px; border: 1px dashed var(--vscode-widget-border); border-radius: 7px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .message-image-status.failed { color: var(--vscode-errorForeground); }
    .pending-steering { opacity: .82; }
    .pending-steering .message-body::after { content: 'Steering…'; display: block; margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .markdown > :first-child { margin-top: 0; }
    .markdown > :last-child { margin-bottom: 0; }
    .markdown p { margin: 0 0 9px; }
    .markdown h1, .markdown h2, .markdown h3 { margin: 14px 0 7px; line-height: 1.3; }
    .markdown h1 { font-size: 17px; } .markdown h2 { font-size: 15px; } .markdown h3 { font-size: 13px; }
    .markdown ul, .markdown ol { margin: 5px 0 10px; padding-left: 22px; }
    .markdown blockquote { margin: 8px 0; padding: 2px 10px; border-left: 2px solid var(--vscode-textBlockQuote-border); color: var(--vscode-descriptionForeground); background: var(--vscode-textBlockQuote-background); }
    code { padding: 1px 4px; border-radius: 4px; font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); }
    pre { max-width: 100%; margin: 7px 0; padding: 9px 10px; overflow: auto; white-space: pre; border-radius: 6px; color: var(--vscode-editor-foreground); background: var(--vscode-textCodeBlock-background); font: 12px/1.55 var(--vscode-editor-font-family); }
    pre code { padding: 0; background: transparent; }
    a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
    a:hover { text-decoration: underline; }
    .file-link { min-width: 0; padding: 0; border: 0; color: var(--vscode-textLink-foreground); background: transparent; text-align: left; font-family: var(--vscode-editor-font-family); cursor: pointer; overflow-wrap: anywhere; }
    .file-link:hover { text-decoration: underline; }
    .code-link { padding: 1px 4px; border-radius: 4px; color: var(--vscode-textPreformat-foreground); background: var(--vscode-textCodeBlock-background); }
    .tool { margin: 7px 0 10px; border: 1px solid var(--vscode-widget-border); border-radius: 8px; overflow: hidden; background: color-mix(in srgb, var(--vscode-editor-background) 72%, transparent); }
    .tool.failed { border-color: var(--vscode-errorForeground); }
    .tool summary { min-height: 35px; padding: 7px 9px; display: flex; align-items: center; gap: 7px; cursor: pointer; list-style: none; }
    .tool summary::-webkit-details-marker { display: none; }
    .tool-icon { width: 18px; color: var(--vscode-descriptionForeground); text-align: center; font-family: var(--vscode-editor-font-family); }
    .tool-title { min-width: 0; flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 600; }
    .tool-detail { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .tool-body { padding: 0 10px 9px 34px; min-width: 0; overflow: hidden; color: var(--vscode-descriptionForeground); }
    .tool-body pre { color: var(--vscode-foreground); }
    .tool-output-more { margin: 5px 0 0; padding: 2px 7px; border: 1px solid var(--vscode-widget-border); border-radius: 5px; color: var(--vscode-textLink-foreground); background: transparent; font-size: 11px; }
    .tool-output-more:hover { background: var(--vscode-toolbar-hoverBackground); }
    .command-card { margin: 7px 0 10px; padding: 8px 10px; border: 1px solid var(--vscode-widget-border); border-radius: 8px; background: color-mix(in srgb, var(--vscode-editor-background) 72%, transparent); }
    .command-card.failed { border-color: var(--vscode-errorForeground); }
    .command-head { min-width: 0; display: flex; align-items: center; gap: 7px; }
    .command-name { min-width: 0; flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-family: var(--vscode-editor-font-family); font-weight: 600; }
    .command-result { margin: 5px 0 0 25px; color: var(--vscode-descriptionForeground); white-space: pre-wrap; overflow-wrap: anywhere; }
    .diff-path, .result-title { margin: 7px 0 4px; font-weight: 600; color: var(--vscode-foreground); }
    .diff-old { border-left: 2px solid var(--vscode-gitDecoration-deletedResourceForeground); }
    .diff-new { border-left: 2px solid var(--vscode-gitDecoration-addedResourceForeground); }
    .source { display: block; margin: 4px 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .source-line { white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); font-size: 11px; }
    .tool-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 2px; }
    .tool-action { min-height: 24px; padding: 2px 7px; border: 1px solid var(--vscode-widget-border); border-radius: 5px; color: var(--vscode-foreground); background: transparent; font-size: 11px; }
    .tool-action:hover { background: var(--vscode-toolbar-hoverBackground); }
    .changed-files { margin: 14px 0 4px; padding: 10px; border: 1px solid var(--vscode-widget-border); border-radius: 8px; background: color-mix(in srgb, var(--vscode-editor-background) 72%, transparent); }
    .changed-files-head { min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 7px; font-weight: 600; }
    .changed-files-title { min-width: 0; flex: 1; }
    .changed-files-actions, .changed-file-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 3px; }
    .changed-turn + .changed-turn { margin-top: 9px; }
    .changed-turn-title { padding: 4px 0; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
    .changed-file { min-width: 0; padding: 6px 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 5px 8px; border-top: 1px solid color-mix(in srgb, var(--vscode-widget-border) 55%, transparent); }
    .changed-file .file-link { min-width: 0; flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .changed-file-stats { display: flex; gap: 5px; font-family: var(--vscode-editor-font-family); font-size: 10px; }
    .change-additions { color: var(--vscode-gitDecoration-addedResourceForeground); }
    .change-deletions { color: var(--vscode-gitDecoration-deletedResourceForeground); }
    .changed-file-actions { grid-column: 1 / -1; }
    .changed-action { min-height: 21px; padding: 1px 5px; border: 0; border-radius: 4px; color: var(--vscode-descriptionForeground); background: transparent; font-size: 10px; }
    .changed-action:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .changed-action.danger { color: var(--vscode-errorForeground); }
    .failed, .error-text { color: var(--vscode-errorForeground); }
    .streaming::after { content: ''; display: inline-block; width: 6px; height: 13px; margin-left: 2px; vertical-align: -2px; background: var(--vscode-foreground); animation: blink 1s steps(2) infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    .status, .interaction { margin: 10px 0; padding: 11px; border: 1px solid var(--vscode-widget-border); border-radius: 8px; overflow-wrap: anywhere; background: var(--vscode-editor-background); }
    .status { color: var(--vscode-descriptionForeground); border: 0; background: var(--vscode-textBlockQuote-background); }
    .status.error { color: var(--vscode-errorForeground); }
    .interaction-title { margin-bottom: 4px; font-weight: 600; }
    .interaction-detail, .question-detail { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
    .primary, .secondary { min-height: 28px; padding: 4px 10px; border-radius: 5px; }
    .primary { border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .primary:hover { background: var(--vscode-button-hoverBackground); }
    .secondary { border: 1px solid var(--vscode-button-border, var(--vscode-widget-border)); color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .question-item + .question-item { margin-top: 13px; padding-top: 12px; border-top: 1px solid var(--vscode-widget-border); }
    .question-label { margin-bottom: 7px; font-weight: 600; }
    .option { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px; margin: 6px 0; align-items: start; }
    .option input { margin: 3px 0 0; }
    .option-description { display: block; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .custom-answer { width: 100%; margin-top: 7px; padding: 6px 8px; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); outline: 0; border-radius: 4px; background: var(--vscode-input-background); }
    .composer-wrap { width: 100%; min-width: 0; padding: 0 10px 10px; overflow: hidden; background: linear-gradient(transparent, var(--vscode-sideBar-background) 18px); }
    .queue-dock { width: 100%; min-width: 0; max-width: 760px; margin: 0 auto 6px; padding: 7px 8px; border: 1px solid var(--vscode-widget-border); border-radius: 9px; background: var(--vscode-editor-background); }
    .queue-head { min-width: 0; display: flex; align-items: center; gap: 6px; margin-bottom: 4px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .queue-title { min-width: 0; flex: 1; font-weight: 600; }
    .queue-row { min-width: 0; min-height: 30px; display: flex; align-items: center; gap: 6px; }
    .queue-row + .queue-row { border-top: 1px solid color-mix(in srgb, var(--vscode-widget-border) 55%, transparent); }
    .queue-preview { min-width: 0; flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .queue-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 3px; }
    .queue-action { min-height: 23px; padding: 1px 5px; border: 0; border-radius: 4px; color: var(--vscode-descriptionForeground); background: transparent; font-size: 10px; }
    .queue-action:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .queue-editor { width: 100%; min-width: 0; min-height: 30px; height: 30px; padding: 4px 6px; resize: none; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 4px; background: var(--vscode-input-background); }
    .composer { width: 100%; min-width: 0; max-width: 760px; margin: 0 auto; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 14px; background: var(--vscode-input-background); box-shadow: 0 2px 10px color-mix(in srgb, var(--vscode-widget-shadow) 75%, transparent); }
    .command-menu { max-height: 210px; padding: 5px; overflow-y: auto; border-bottom: 1px solid var(--vscode-widget-border); }
    .command-option { width: 100%; min-width: 0; padding: 7px 8px; display: block; border: 0; border-radius: 6px; text-align: left; background: transparent; }
    .command-option:hover, .command-option.selected { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
    .command-option-line { min-width: 0; display: flex; align-items: baseline; gap: 7px; }
    .command-option-name { flex: 0 0 auto; font-family: var(--vscode-editor-font-family); font-weight: 600; }
    .command-option-hint { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; opacity: .72; }
    .command-option-current { margin-left: auto; padding: 1px 5px; border-radius: 999px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-family: var(--vscode-font-family); font-size: 10px; font-weight: 500; }
    .command-option-description { margin-top: 2px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .command-option:hover .command-option-description, .command-option.selected .command-option-description { color: inherit; opacity: .82; }
    .command-section-label { padding: 6px 8px 3px; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
    .policy-menu { max-height: 260px; }
    .policy-section-label { padding: 7px 8px 3px; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
    .context-chips, .attachments { display: flex; flex-wrap: wrap; gap: 5px; padding: 8px 10px 0; }
    .context-chip, .attachment-chip { min-width: 0; max-width: 100%; display: flex; align-items: center; gap: 5px; padding: 3px 5px 3px 8px; border: 1px solid var(--vscode-widget-border); border-radius: 6px; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); }
    .context-chip.selection { color: var(--vscode-foreground); border-color: color-mix(in srgb, #4d6bfe 55%, var(--vscode-widget-border)); }
    .context-icon { flex: 0 0 auto; font-size: 12px; }
    .context-name, .attachment-name { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .context-remove, .attachment-remove { width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px; background: transparent; }
    .context-remove:hover, .attachment-remove:hover { background: var(--vscode-toolbar-hoverBackground); }
    .mode-chips { display: flex; flex-wrap: wrap; gap: 5px; padding: 8px 10px 0; }
    .preset-chip { min-width: 0; max-width: 100%; min-height: 25px; padding: 2px 6px; display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--vscode-widget-border); border-radius: 6px; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); }
    .preset-chip.locked { opacity: .72; }
    .preset-icon, .preset-lock { flex: 0 0 auto; font-size: 10px; }
    .preset-select { min-width: 0; max-width: 210px; border: 0; outline: 0; color: var(--vscode-foreground); background: transparent; font-weight: 600; text-overflow: ellipsis; }
    .preset-select:disabled { color: var(--vscode-descriptionForeground); opacity: 1; }
    .plan-chip { min-height: 25px; padding: 2px 5px 2px 8px; display: inline-flex; align-items: center; gap: 5px; border: 1px solid color-mix(in srgb, #4d6bfe 58%, var(--vscode-widget-border)); border-radius: 6px; color: var(--vscode-foreground); background: color-mix(in srgb, #4d6bfe 12%, var(--vscode-editor-background)); font-weight: 600; }
    .plan-chip-close { width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px; background: transparent; line-height: 1; }
    .plan-chip-close:hover { background: var(--vscode-toolbar-hoverBackground); }
    textarea { width: 100%; min-height: 72px; max-height: 220px; resize: none; display: block; padding: 11px 12px 4px; border: 0; outline: 0; background: transparent; color: var(--vscode-input-foreground); }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    .composer-row { width: 100%; min-width: 0; min-height: 39px; padding: 4px 6px 6px; display: grid; grid-template-columns: 28px 28px minmax(28px, .5fr) minmax(0, 1.2fr) minmax(46px, .55fr) auto; align-items: center; gap: 5px; }
    .run-actions { display: flex; align-items: center; justify-content: flex-end; gap: 4px; }
    .usage-control { position: relative; flex: 0 0 auto; }
    .usage-trigger { color: var(--vscode-descriptionForeground); }
    .usage-trigger:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .usage-track, .usage-fill { fill: none; stroke-width: 2; }
    .usage-track { stroke: var(--vscode-widget-border); }
    .usage-fill { stroke: var(--vscode-descriptionForeground); stroke-linecap: round; }
    .usage-trigger.warning .usage-fill { stroke: var(--vscode-editorWarning-foreground); }
    .usage-trigger.danger .usage-fill { stroke: var(--vscode-errorForeground); }
    .usage-panel { position: absolute; z-index: 30; right: -36px; bottom: calc(100% + 8px); width: min(264px, calc(100vw - 34px)); padding: 12px; border: 1px solid var(--vscode-widget-border); border-radius: 10px; color: var(--vscode-descriptionForeground); background: var(--vscode-menu-background); box-shadow: 0 7px 22px var(--vscode-widget-shadow); font-size: 11px; line-height: 18px; }
    .usage-header { display: flex; align-items: baseline; gap: 5px; }
    .usage-percent, .usage-figures { color: var(--vscode-foreground); font-weight: 600; }
    .usage-figures { margin-left: auto; font-variant-numeric: tabular-nums; }
    .usage-bar { height: 4px; margin: 10px 0 8px; display: flex; gap: 1px; overflow: hidden; border-radius: 999px; background: var(--vscode-toolbar-hoverBackground); }
    .usage-segment { min-width: 2px; height: 100%; border-radius: 1px; }
    .usage-system { background: var(--vscode-descriptionForeground); }
    .usage-tools { background: #a78bfa; }
    .usage-messages { background: #4d6bfe; }
    .usage-rows { margin: 0; }
    .usage-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 2px 0; }
    .usage-row dt, .usage-row dd { margin: 0; }
    .usage-row dd { color: var(--vscode-foreground); font-variant-numeric: tabular-nums; }
    .usage-swatch { width: 7px; height: 7px; margin-right: 6px; display: inline-block; border-radius: 2px; }
    .usage-stats { min-width: 0; padding: 0 12px 8px; overflow: hidden; color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 14px; text-overflow: ellipsis; white-space: nowrap; }
    .project { width: 100%; min-width: 0; height: 28px; padding: 0 4px; overflow: hidden; display: flex; align-items: center; gap: 5px; border: 0; border-radius: 6px; color: var(--vscode-descriptionForeground); background: transparent; }
    .project:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .project span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .project svg { width: 15px; height: 15px; flex: 0 0 auto; }
    .model-select, .effort-select { width: 100%; min-width: 0; max-width: 100%; border: 0; outline: 0; color: var(--vscode-descriptionForeground); background: transparent; text-overflow: ellipsis; }
    .policy-trigger.active { color: #4d6bfe; background: color-mix(in srgb, #4d6bfe 12%, transparent); }
    .policy-trigger.full-access { color: var(--vscode-editorWarning-foreground); }
    .send { border-radius: 8px; color: white; background: #4d6bfe; }
    .send:hover { background: #405de6; }
    .cancel { color: var(--vscode-errorForeground); }
    .cancel:hover { background: var(--vscode-toolbar-hoverBackground); }
    .send:disabled, textarea:disabled, button:disabled { opacity: .55; cursor: default; }
    .hidden { display: none !important; }
    @media (max-width: 330px) { .conversation { padding-inline: 10px; } .composer-row { grid-template-columns: 28px 28px 20px minmax(0, 1fr) minmax(40px, .5fr) auto; } .project span { display: none; } }
  </style>
</head>
<body>
  <div id="app">
    <header class="toolbar">
      <select id="sessions" class="session-select" aria-label="Project conversations"></select>
      <div id="jobsControl" class="jobs-control hidden">
        <button id="jobsTrigger" class="icon-button jobs-trigger" title="Background jobs" aria-label="Background jobs" aria-haspopup="menu" aria-expanded="false"><span class="jobs-dot"></span><span id="jobsCount">0</span></button>
        <div id="jobsMenu" class="jobs-menu hidden" role="menu" aria-label="Background jobs"></div>
      </div>
      <button id="newSession" class="icon-button" title="New conversation" aria-label="New conversation"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
    </header>
    <main id="scroll" class="scroll"><div id="conversation" class="conversation"><div id="conversationStatus" class="conversation-slot"></div><div id="conversationHistory" class="conversation-slot"></div><div id="messages" class="messages"></div><div id="conversationTail" class="conversation-slot"></div></div></main>
    <footer class="composer-wrap">
      <div id="queueDock" class="queue-dock hidden" aria-label="Queued messages"></div>
      <div class="composer">
        <div id="modeChips" class="mode-chips hidden" aria-label="Active collaboration modes"></div>
        <div id="contextChips" class="context-chips hidden" aria-label="Editor context"></div>
        <div id="attachments" class="attachments hidden"></div>
        <div id="mentionMenu" class="command-menu hidden" role="listbox" aria-label="Files and folders"></div>
        <div id="commandMenu" class="command-menu hidden" role="listbox" aria-label="DeepSeek commands"></div>
        <div id="policyMenu" class="command-menu policy-menu hidden" role="menu" aria-label="Mode and permissions"></div>
        <textarea id="prompt" rows="3" placeholder="Ask DeepSeek about this project" aria-label="Message DeepSeek"></textarea>
        <div class="composer-row">
          <button id="attach" class="icon-button" title="Attach image" aria-label="Attach image"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
          <button id="policyTrigger" class="icon-button policy-trigger hidden" title="Mode and permissions" aria-label="Mode and permissions" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.7 2.8 8 7 10 4.2-2 7-5.3 7-10V6z"/><path d="m9.5 12 1.6 1.6 3.5-3.6"/></svg></button>
          <button id="project" class="project" title="Choose DeepSeek project" aria-label="Choose DeepSeek project"><svg viewBox="0 0 24 24"><path d="M3 7.5h7l2 2h9v9.5H3z"/><path d="M3 7.5V5h7l2 2h5"/></svg><span id="workspace">Workspace</span></button>
          <select id="models" class="model-select" aria-label="Model"></select>
          <select id="efforts" class="effort-select" aria-label="Reasoning effort"></select>
          <div class="run-actions">
            <div id="usageControl" class="usage-control hidden">
              <button id="usageTrigger" class="icon-button usage-trigger" title="Context usage" aria-label="Context usage" aria-haspopup="dialog" aria-expanded="false"><svg viewBox="0 0 14 14"><circle class="usage-track" cx="7" cy="7" r="5.5"/><circle id="usageFill" class="usage-fill" cx="7" cy="7" r="5.5" transform="rotate(-90 7 7)"/></svg></button>
              <div id="usagePanel" class="usage-panel hidden" role="dialog" aria-label="Context usage details"></div>
            </div>
            <button id="cancel" class="icon-button cancel hidden" title="Stop" aria-label="Stop"><svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1"/></svg></button>
            <button id="send" class="icon-button send" title="Send (Enter)" aria-label="Send"><svg viewBox="0 0 24 24"><path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"/></svg></button>
          </div>
        </div>
        <div id="usageStats" class="usage-stats hidden"></div>
      </div>
    </footer>
  </div>
  <script nonce="${token}">
    const vscode = acquireVsCodeApi();
    window.addEventListener('error', event => {
      vscode.postMessage({ type: 'webview-error', message: event.message || 'Unknown webview error' });
    });
    window.addEventListener('unhandledrejection', event => {
      const reason = event.reason instanceof Error ? event.reason.message : String(event.reason || 'Unknown promise rejection');
      vscode.postMessage({ type: 'webview-error', message: reason });
    });
    const elements = {
      conversation: document.getElementById('conversation'), scroll: document.getElementById('scroll'),
      conversationStatus: document.getElementById('conversationStatus'), conversationHistory: document.getElementById('conversationHistory'), messages: document.getElementById('messages'), conversationTail: document.getElementById('conversationTail'),
      sessions: document.getElementById('sessions'), newSession: document.getElementById('newSession'), jobsControl: document.getElementById('jobsControl'), jobsTrigger: document.getElementById('jobsTrigger'), jobsCount: document.getElementById('jobsCount'), jobsMenu: document.getElementById('jobsMenu'),
      prompt: document.getElementById('prompt'), project: document.getElementById('project'), workspace: document.getElementById('workspace'),
      models: document.getElementById('models'), efforts: document.getElementById('efforts'),
      policyTrigger: document.getElementById('policyTrigger'), policyMenu: document.getElementById('policyMenu'),
      send: document.getElementById('send'), cancel: document.getElementById('cancel'),
      usageControl: document.getElementById('usageControl'), usageTrigger: document.getElementById('usageTrigger'), usageFill: document.getElementById('usageFill'), usagePanel: document.getElementById('usagePanel'), usageStats: document.getElementById('usageStats'),
      attach: document.getElementById('attach'), attachments: document.getElementById('attachments'),
      queueDock: document.getElementById('queueDock'),
      modeChips: document.getElementById('modeChips'), contextChips: document.getElementById('contextChips'), mentionMenu: document.getElementById('mentionMenu'), commandMenu: document.getElementById('commandMenu'),
    };
    let state;
    let draftImages = [];
    let ideContext = { pinned: [] };
    let commandIndex = 0;
    let mentionIndex = 0;
    let mentionRequestId = 0;
    let mentionCandidates = [];
    let queueEditing = null;
    let queueRenderSignature = '';
    let policyMenuOpen = false;
    let usageOpen = false;
    let jobsOpen = false;
    let jobsTimer;
    let historyAnchor;
    let renderFrame;
    let pendingRenderState;
    let renderedSessionId;
    let renderedStatusKey = '';
    let renderedHistoryKey = '';
    let renderedTail = {};
    let renderedChrome = {};
    const renderedMessages = new Map();
    const expandedToolIds = new Set();
    const loadingToolIds = new Set();
    const toolOutputChunkSize = 20000;

    function node(tag, className, text) {
      const value = document.createElement(tag);
      if (className) value.className = className;
      if (text !== undefined) value.textContent = text;
      return value;
    }

    function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined; }
    function array(value) { return Array.isArray(value) ? value : []; }
    function string(value, fallback) { return typeof value === 'string' ? value : (fallback || ''); }
    function pretty(value) {
      if (typeof value === 'string') {
        try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
      }
      try { return JSON.stringify(value, null, 2); } catch { return String(value); }
    }
    function contentText(content) {
      return array(content).map(part => {
        const item = record(part);
        if (!item) return '';
        if (typeof item.text === 'string') return item.text;
        if (typeof item.content === 'string') return item.content;
        if (Array.isArray(item.content)) return contentText(item.content);
        return '';
      }).filter(Boolean).join('\\n');
    }
    function link(href, label) {
      const anchor = node('a', '', label || href);
      anchor.href = href;
      anchor.addEventListener('click', event => { event.preventDefault(); vscode.postMessage({ type: 'open-link', href }); });
      return anchor;
    }

    function fileReference(value) {
      const match = /^((?:[A-Za-z]:[\\\\/]|\\/)?(?:[A-Za-z0-9_@.+~-]+[\\\\/])*[A-Za-z0-9_@.+~-]+\\.[A-Za-z][A-Za-z0-9]{0,9})(?::(\\d+))?(?::\\d+)?$/.exec(value);
      if (!match) return undefined;
      return { path: match[1], ...(match[2] ? { line: Number(match[2]) } : {}) };
    }
    function fileButton(path, line, label, className) {
      const button = node('button', 'file-link' + (className ? ' ' + className : ''), label || path);
      button.type = 'button'; button.title = 'Open ' + path + (line ? ':' + String(line) : '');
      button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); vscode.postMessage({ type: 'open-file', path, ...(line ? { line } : {}) }); });
      return button;
    }
    function appendFileText(parent, text) {
      const pattern = /(?:[A-Za-z]:[\\\\/]|\\/)?(?:[A-Za-z0-9_@.+~-]+[\\\\/])*[A-Za-z0-9_@.+~-]+\\.[A-Za-z][A-Za-z0-9]{0,9}(?::\\d+)?(?::\\d+)?/g;
      let last = 0;
      for (const match of text.matchAll(pattern)) {
        const index = match.index || 0;
        const reference = fileReference(match[0]);
        if (!reference) continue;
        if (index > last) parent.append(document.createTextNode(text.slice(last, index)));
        parent.append(fileButton(reference.path, reference.line, match[0]));
        last = index + match[0].length;
      }
      if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
    }

    function appendInline(parent, text) {
      const pattern = /(\\*\\*[^*]+\\*\\*|\\*[^*]+\\*|\\[[^\\]]+\\]\\(https?:\\/\\/[^)\\s]+\\)|\\x60[^\\x60]+\\x60)/g;
      let last = 0;
      for (const match of text.matchAll(pattern)) {
        const index = match.index || 0;
        if (index > last) appendFileText(parent, text.slice(last, index));
        const token = match[0];
        if (token.startsWith('**')) { const strong = node('strong'); appendFileText(strong, token.slice(2, -2)); parent.append(strong); }
        else if (token.startsWith('*')) { const em = node('em'); appendFileText(em, token.slice(1, -1)); parent.append(em); }
        else if (token.charCodeAt(0) === 96) {
          const value = token.slice(1, -1); const reference = fileReference(value);
          parent.append(reference ? fileButton(reference.path, reference.line, value, 'code-link') : node('code', '', value));
        }
        else {
          const split = token.indexOf('](');
          parent.append(link(token.slice(split + 2, -1), token.slice(1, split)));
        }
        last = index + token.length;
      }
      if (last < text.length) appendFileText(parent, text.slice(last));
    }

    function renderMarkdown(text) {
      const root = node('div', 'markdown');
      const lines = String(text || '').replace(/\\r/g, '').split('\\n');
      let index = 0;
      while (index < lines.length) {
        const lineValue = lines[index];
        if (!lineValue.trim()) { index += 1; continue; }
        if (lineValue.startsWith(String.fromCharCode(96).repeat(3))) {
          const language = lineValue.slice(3).trim();
          const body = [];
          index += 1;
          while (index < lines.length && !lines[index].startsWith(String.fromCharCode(96).repeat(3))) body.push(lines[index++]);
          if (index < lines.length) index += 1;
          const pre = node('pre');
          const code = node('code', language ? 'language-' + language : '', body.join('\\n'));
          pre.append(code); root.append(pre); continue;
        }
        const heading = /^(#{1,3})\\s+(.+)$/.exec(lineValue);
        if (heading) { const h = node('h' + heading[1].length); appendInline(h, heading[2]); root.append(h); index += 1; continue; }
        if (/^>\\s?/.test(lineValue)) {
          const quote = node('blockquote'); appendInline(quote, lineValue.replace(/^>\\s?/, '')); root.append(quote); index += 1; continue;
        }
        if (/^[-*]\\s+/.test(lineValue) || /^\\d+\\.\\s+/.test(lineValue)) {
          const ordered = /^\\d+\\./.test(lineValue);
          const list = node(ordered ? 'ol' : 'ul');
          while (index < lines.length && (ordered ? /^\\d+\\.\\s+/.test(lines[index]) : /^[-*]\\s+/.test(lines[index]))) {
            const item = node('li'); appendInline(item, lines[index].replace(ordered ? /^\\d+\\.\\s+/ : /^[-*]\\s+/, '')); list.append(item); index += 1;
          }
          root.append(list); continue;
        }
        const paragraph = [];
        while (index < lines.length && lines[index].trim() && !lines[index].startsWith(String.fromCharCode(96).repeat(3)) && !/^(#{1,3})\\s+/.test(lines[index]) && !/^>\\s?/.test(lines[index]) && !/^[-*]\\s+/.test(lines[index]) && !/^\\d+\\.\\s+/.test(lines[index])) paragraph.push(lines[index++]);
        const p = node('p'); appendInline(p, paragraph.join('\\n')); root.append(p);
      }
      return root;
    }

    function createMarkdownStream(text) {
      const stream = {
        root: node('div', 'markdown'), text: '', committedOffset: 0, scanOffset: 0,
        safeBoundary: 0, fenced: false, linePrefix: '', lineHasContent: false, tailNodes: [], marker: document.createComment('stream-end'),
      };
      stream.root.append(stream.marker);
      updateMarkdownStream(stream, text, true);
      return stream;
    }
    function scanMarkdownStream(stream, text) {
      for (let index = stream.scanOffset; index < text.length; index += 1) {
        const character = text[index];
        if (character === '\\n') {
          if (stream.linePrefix === String.fromCharCode(96).repeat(3)) stream.fenced = !stream.fenced;
          else if (!stream.lineHasContent && !stream.fenced) stream.safeBoundary = index + 1;
          stream.linePrefix = ''; stream.lineHasContent = false;
        } else {
          if (stream.linePrefix.length < 3) stream.linePrefix += character;
          if (!/\\s/.test(character)) stream.lineHasContent = true;
        }
      }
      stream.scanOffset = text.length;
    }
    function appendMarkdownNodes(parent, text, before) {
      if (!text) return [];
      const parsed = renderMarkdown(text); const children = [...parsed.childNodes];
      for (const child of children) parent.insertBefore(child, before || null);
      return children;
    }
    function updateMarkdownStream(stream, text, streaming) {
      const value = String(text || '');
      if (!value.startsWith(stream.text)) return false;
      scanMarkdownStream(stream, value);
      for (const child of stream.tailNodes) child.remove();
      stream.tailNodes = [];
      const boundary = streaming ? stream.safeBoundary : value.length;
      if (boundary > stream.committedOffset) {
        appendMarkdownNodes(stream.root, value.slice(stream.committedOffset, boundary), stream.marker);
        stream.committedOffset = boundary;
      }
      if (streaming && boundary < value.length) {
        const tail = value.slice(boundary);
        stream.tailNodes = tail.length > toolOutputChunkSize
          ? [node('p', 'streaming-plain', tail)]
          : appendMarkdownNodes(stream.root, tail, stream.marker);
        if (stream.tailNodes.length === 1 && !stream.tailNodes[0].isConnected) stream.root.insertBefore(stream.tailNodes[0], stream.marker);
      }
      stream.text = value;
      return true;
    }

    function toolTitle(message, callView, resultView) {
      return string(resultView && resultView.title) || string(callView && callView.title) || message.text || 'Tool';
    }
    function appendImages(parent, images) {
      if (!Array.isArray(images) || !images.length) return;
      const gallery = node('div', 'message-images');
      for (const value of images) {
        const image = record(value); if (!image) continue;
        if (typeof image.data === 'string' && typeof image.mediaType === 'string') {
          const element = document.createElement('img');
          element.className = 'message-image'; element.alt = string(image.name, 'DeepSeek image');
          element.width = Number(image.width) || 0; element.height = Number(image.height) || 0;
          element.src = 'data:' + image.mediaType + ';base64,' + image.data; gallery.append(element);
        } else {
          gallery.append(node('div', 'message-image-status' + (image.error ? ' failed' : ''), image.error || 'Loading image…'));
        }
      }
      if (gallery.childNodes.length) parent.append(gallery);
    }
    function appendPre(parent, text, className) {
      if (!text) return;
      const value = String(text); let visible = Math.min(value.length, toolOutputChunkSize);
      const pre = node('pre', className || '', value.slice(0, visible)); parent.append(pre);
      if (visible >= value.length) return;
      const more = node('button', 'tool-output-more'); more.type = 'button';
      const updateLabel = () => { more.textContent = 'Show more · ' + String(visible) + ' / ' + String(value.length) + ' characters'; };
      updateLabel();
      more.addEventListener('click', () => {
        visible = Math.min(value.length, visible + toolOutputChunkSize); pre.textContent = value.slice(0, visible);
        if (visible >= value.length) more.remove(); else updateLabel();
      });
      parent.append(more);
    }
    function appendPrefixedPre(parent, text, prefix, className) {
      const value = String(text || '');
      if (!value) return;
      let visible = Math.min(value.length, toolOutputChunkSize);
      const format = () => prefix + value.slice(0, visible).replace(/\\n/g, '\\n' + prefix);
      const pre = node('pre', className || '', format()); parent.append(pre);
      if (visible >= value.length) return;
      const more = node('button', 'tool-output-more'); more.type = 'button';
      const updateLabel = () => { more.textContent = 'Show more · ' + String(visible) + ' / ' + String(value.length) + ' characters'; };
      updateLabel();
      more.addEventListener('click', () => {
        visible = Math.min(value.length, visible + toolOutputChunkSize); pre.textContent = format();
        if (visible >= value.length) more.remove(); else updateLabel();
      });
      parent.append(more);
    }
    function appendMarkdownPage(parent, text) {
      const value = String(text || '');
      if (!value) return;
      let visible = Math.min(value.length, toolOutputChunkSize);
      const content = node('div'); const more = node('button', 'tool-output-more'); more.type = 'button';
      const renderPage = () => {
        content.replaceChildren(renderMarkdown(value.slice(0, visible)));
        more.textContent = 'Show more · ' + String(visible) + ' / ' + String(value.length) + ' characters';
      };
      renderPage(); parent.append(content);
      if (visible < value.length) {
        more.addEventListener('click', () => {
          visible = Math.min(value.length, visible + toolOutputChunkSize); renderPage();
          if (visible >= value.length) more.remove();
        });
        parent.append(more);
      }
    }
    function appendPagedItems(parent, values, appendItem, pageSize) {
      if (!values.length) return;
      const container = node('div'); const more = node('button', 'tool-output-more'); more.type = 'button';
      let visible = 0; const size = pageSize || 100;
      const reveal = () => {
        const end = Math.min(values.length, visible + size);
        for (let index = visible; index < end; index += 1) appendItem(container, values[index]);
        visible = end;
        more.textContent = 'Show more · ' + String(visible) + ' / ' + String(values.length) + ' results';
        if (visible >= values.length) more.remove();
      };
      parent.append(container); reveal();
      if (visible < values.length) { more.addEventListener('click', reveal); parent.append(more); }
    }
    function renderToolBody(message, callView, resultView) {
      const body = node('div', 'tool-body');
      const view = resultView || callView;
      const card = string(view && view.card, 'generic');
      if (card === 'terminal') {
        const cwd = string(callView && callView.cwd);
        if (cwd) body.append(node('div', 'result-title', cwd));
        appendPre(body, string(resultView && resultView.output) || message.rawResult || string(callView && callView.title));
        if (resultView && (typeof resultView.exitCode === 'number' || resultView.signal)) body.append(node('div', '', resultView.signal ? 'Signal ' + resultView.signal : 'Exit ' + resultView.exitCode));
      } else if (card === 'diff') {
        const paths = [];
        for (const diffValue of array(view.diffs)) {
          const diff = record(diffValue); if (!diff) continue;
          const filePath = string(diff.path, 'File change');
          if (filePath !== 'File change' && !paths.includes(filePath)) paths.push(filePath);
          const pathRow = node('div', 'diff-path');
          pathRow.append(filePath === 'File change' ? document.createTextNode(filePath) : fileButton(filePath, undefined, filePath));
          body.append(pathRow);
          if (typeof diff.oldText === 'string') appendPrefixedPre(body, diff.oldText, '- ', 'diff-old');
          appendPrefixedPre(body, string(diff.newText), '+ ', 'diff-new');
        }
        for (const filePath of paths) {
          const actions = node('div', 'tool-actions');
          const open = node('button', 'tool-action', paths.length === 1 ? 'Open File' : 'Open ' + filePath);
          open.type = 'button'; open.addEventListener('click', () => vscode.postMessage({ type: 'open-file', path: filePath })); actions.append(open);
          if (!message.streaming && !message.failed) {
            const review = node('button', 'tool-action', paths.length === 1 ? 'Review Changes' : 'Review ' + filePath);
            review.type = 'button'; review.addEventListener('click', () => vscode.postMessage({ type: 'review-file', path: filePath })); actions.append(review);
          }
          body.append(actions);
        }
      } else if (card === 'read') {
        const filePath = string(view.path, 'File'); const title = node('div', 'result-title');
        title.append(filePath === 'File' ? document.createTextNode(filePath) : fileButton(filePath, Number(view.offset) || undefined, filePath)); body.append(title);
        const lines = array(view.lines);
        if (lines.length) appendPagedItems(body, lines, (container, value) => {
          const line = record(value); if (line) container.append(node('div', 'source-line', String(line.number).padStart(4, ' ') + '  ' + string(line.text)));
        }, 200);
        else appendPre(body, message.rawResult);
      } else if (card === 'search') {
        if (view.shape === 'paths') appendPagedItems(body, array(view.paths), (container, pathValue) => {
          const filePath = string(pathValue); const row = node('div', 'source'); if (filePath) row.append(fileButton(filePath, undefined, filePath)); container.append(row);
        }, 100);
        if (view.shape === 'matches') {
          const matches = [];
          for (const fileValue of array(view.files)) {
            const file = record(fileValue); if (!file) continue; const filePath = string(file.path);
            matches.push({ kind: 'file', path: filePath });
            for (const matchValue of array(file.matches)) matches.push({ kind: 'match', path: filePath, value: matchValue });
          }
          appendPagedItems(body, matches, (container, entry) => {
            if (entry.kind === 'file') { const title = node('div', 'result-title'); if (entry.path) title.append(fileButton(entry.path, undefined, entry.path)); container.append(title); return; }
            const match = record(entry.value); if (!match) return; const line = Number(match.lineNumber) || undefined; const row = node('div', 'source');
            if (entry.path) row.append(fileButton(entry.path, line, String(match.lineNumber) + ': ' + string(match.line))); container.append(row);
          }, 100);
        }
        if (view.truncated === true) body.append(node('div', '', 'Showing a limited result set (' + String(view.total || '') + ' total).'));
      } else if (card === 'web') {
        if (typeof view.answer === 'string') appendMarkdownPage(body, view.answer);
        appendPagedItems(body, array(view.sources), (container, sourceValue) => { const source = record(sourceValue); if (source && typeof source.url === 'string') container.append(link(source.url, string(source.title) || source.url)); }, 50);
        if (typeof view.url === 'string') body.append(link(view.url, view.url));
      } else {
        const presented = contentText(view && view.content);
        const raw = presented || message.rawResult || message.rawInput || (view && view.rawInput !== undefined ? view.rawInput : '');
        if (raw) appendPre(body, typeof raw === 'string' && raw.length > toolOutputChunkSize ? raw : pretty(raw));
        for (const locationValue of array(callView && callView.locations)) {
          const location = record(locationValue); if (!location) continue; const filePath = string(location.path); const line = Number(location.line) || undefined; const row = node('div', 'source');
          if (filePath) row.append(fileButton(filePath, line, filePath + (line ? ':' + String(line) : ''))); body.append(row);
        }
      }
      appendImages(body, message.images);
      return body;
    }
    function renderTool(message) {
      const callView = record(message.callView);
      const resultView = record(message.resultView);
      const item = document.createElement('details');
      item.className = 'tool' + (message.failed ? ' failed' : '');
      item.open = message.streaming === true || message.failed === true || expandedToolIds.has(message.id);
      const summary = document.createElement('summary');
      summary.append(node('span', 'tool-icon', message.streaming ? '●' : (message.failed ? '!' : '✓')));
      summary.append(node('span', 'tool-title', toolTitle(message, callView, resultView)));
      summary.append(node('span', 'tool-detail', message.detail || ''));
      item.append(summary);
      let contentInitialized = false;
      const initializeContent = () => {
        if (contentInitialized) return;
        contentInitialized = true;
        if (message.deferredBody === true) {
          item.append(node('div', 'tool-body', 'Loading tool output…'));
          if (!loadingToolIds.has(message.id)) {
            loadingToolIds.add(message.id); vscode.postMessage({ type: 'load-tool-output', messageId: message.id });
          }
        } else item.append(renderToolBody(message, callView, resultView));
      };
      if (item.open) initializeContent();
      item.addEventListener('toggle', () => {
        if (item.open) { expandedToolIds.add(message.id); initializeContent(); }
        else expandedToolIds.delete(message.id);
      });
      return item;
    }
    function renderCommand(message) {
      const item = node('div', 'command-card' + (message.failed ? ' failed' : ''));
      const head = node('div', 'command-head');
      head.append(node('span', 'tool-icon', message.streaming ? '●' : (message.failed ? '!' : '✓')));
      head.append(node('span', 'command-name', message.text));
      head.append(node('span', 'tool-detail', message.detail || ''));
      item.append(head);
      if (message.rawResult) { const result = node('div', 'command-result'); appendPre(result, message.rawResult); item.append(result); }
      return item;
    }
    function renderChangedFiles(groups) {
      const box = node('section', 'changed-files'); const head = node('div', 'changed-files-head');
      head.append(node('span', 'changed-files-title', 'Changed Files'));
      const allFiles = groups.flatMap(group => group.files || []); const allRevertible = allFiles.length > 0 && allFiles.every(file => file.canRevert === true);
      const actions = node('div', 'changed-files-actions');
      const reviewAll = node('button', 'changed-action', 'Open All'); reviewAll.type = 'button'; reviewAll.addEventListener('click', () => vscode.postMessage({ type: 'review-all' })); actions.append(reviewAll);
      const keepAll = node('button', 'changed-action', 'Keep All'); keepAll.type = 'button'; keepAll.addEventListener('click', () => vscode.postMessage({ type: 'keep-all' })); actions.append(keepAll);
      const revertAll = node('button', 'changed-action danger', 'Revert All'); revertAll.type = 'button'; revertAll.disabled = !allRevertible; if (!allRevertible) revertAll.title = 'Full snapshots are unavailable for one or more files'; revertAll.addEventListener('click', () => vscode.postMessage({ type: 'revert-all' })); actions.append(revertAll); head.append(actions); box.append(head);
      for (const group of groups) {
        const section = node('div', 'changed-turn'); section.append(node('div', 'changed-turn-title', group.turn > 0 ? 'Turn ' + String(group.turn) : 'Earlier changes'));
        for (const file of group.files || []) {
          const row = node('div', 'changed-file'); row.append(fileButton(file.path, undefined, file.path));
          const stats = node('span', 'changed-file-stats'); stats.append(node('span', 'change-additions', '+' + String(file.additions || 0)), node('span', 'change-deletions', '−' + String(file.deletions || 0))); row.append(stats);
          const fileActions = node('div', 'changed-file-actions');
          const review = node('button', 'changed-action', 'Open Diff'); review.type = 'button'; review.addEventListener('click', () => vscode.postMessage({ type: 'review-file', path: file.path, turn: group.turn })); fileActions.append(review);
          const keep = node('button', 'changed-action', 'Keep'); keep.type = 'button'; keep.addEventListener('click', () => vscode.postMessage({ type: 'keep-file', path: file.path, turn: group.turn })); fileActions.append(keep);
          const revert = node('button', 'changed-action danger', 'Revert'); revert.type = 'button'; revert.disabled = file.canRevert !== true; if (revert.disabled) revert.title = 'Full snapshot unavailable after reloading this session'; revert.addEventListener('click', () => vscode.postMessage({ type: 'revert-file', path: file.path, turn: group.turn })); fileActions.append(revert); row.append(fileActions); section.append(row);
        }
        box.append(section);
      }
      return box;
    }
    function renderPendingSteering(item) {
      const bubble = node('article', 'message user pending-steering');
      const body = node('div', 'message-body', item.preview || 'Steering message');
      bubble.append(body); return bubble;
    }
    function renderMessage(message) {
      if (message.role === 'tool') return { message, node: renderTool(message) };
      if (message.role === 'command') return { message, node: renderCommand(message) };
      if (message.role === 'notice') return { message, node: node('div', 'status' + (message.failed ? ' error' : ''), message.text) };
      const item = node('article', 'message ' + message.role);
      const head = node('div', 'message-head');
      head.append(node('span', 'avatar' + (message.role === 'assistant' ? ' deepseek-mark' : ''), message.role === 'user' ? 'Y' : ''));
      head.append(node('span', '', message.role === 'user' ? 'You' : 'DeepSeek'));
      const markdown = message.role === 'assistant' && message.streaming === true ? createMarkdownStream(message.text) : undefined;
      const body = message.role === 'assistant' ? (markdown ? markdown.root : renderMarkdown(message.text)) : node('div', '', message.text);
      body.classList.add('message-body');
      if (message.streaming) body.classList.add('streaming');
      appendImages(body, message.images);
      item.append(head, body); return { message, node: item, ...(markdown ? { markdown } : {}) };
    }
    function messageNode(message) {
      const rendered = renderedMessages.get(message.id);
      if (rendered && rendered.message === message) return rendered.node;
      if (rendered && rendered.markdown && message.role === 'assistant' && message.images === rendered.message.images && updateMarkdownStream(rendered.markdown, message.text, message.streaming === true)) {
        rendered.message = message;
        rendered.markdown.root.classList.toggle('streaming', message.streaming === true);
        return rendered.node;
      }
      const next = renderMessage(message);
      if (rendered && rendered.node.isConnected) rendered.node.replaceWith(next.node);
      renderedMessages.set(message.id, next);
      return next.node;
    }
    function reconcileMessages(messages, current) {
      if (!messages.length) {
        renderedMessages.clear(); elements.messages.replaceChildren(renderEmpty(current)); return;
      }
      const ids = new Set(messages.map(message => message.id));
      for (const [id, rendered] of renderedMessages) {
        if (!ids.has(id)) { rendered.node.remove(); renderedMessages.delete(id); }
      }
      let cursor = elements.messages.firstChild;
      for (const message of messages) {
        const desired = messageNode(message);
        if (desired === cursor) cursor = cursor.nextSibling;
        else elements.messages.insertBefore(desired, cursor);
      }
      while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
    }
    function renderStatus(current) {
      const box = node('div', 'status' + (current.phase === 'error' ? ' error' : ''), current.statusText || 'Starting DeepSeek Harness…');
      if (current.phase === 'error') {
        const actions = node('div', 'actions');
        const retry = node('button', 'secondary', 'Reconnect'); const output = node('button', 'secondary', 'Show output');
        retry.addEventListener('click', () => vscode.postMessage({ type: 'restart' })); output.addEventListener('click', () => vscode.postMessage({ type: 'output' }));
        actions.append(retry, output); box.append(actions);
      }
      return box;
    }
    function renderEmpty(current) {
      const empty = node('div', 'empty'); empty.append(node('div', 'empty-logo deepseek-mark'), node('h2', '', 'Build with DeepSeek'));
      empty.append(node('p', '', 'Ask questions, explore code, and make changes in ' + current.workspaceName + '.')); return empty;
    }
    function renderApproval(approval) {
      const box = node('section', 'interaction approval');
      box.append(node('div', 'interaction-title', 'Allow ' + approval.toolName + '?'));
      if (approval.reason) box.append(node('div', 'interaction-detail', approval.reason));
      const actions = node('div', 'actions');
      const allow = node('button', 'primary', 'Allow once'); const reject = node('button', 'secondary', 'Reject');
      allow.addEventListener('click', () => vscode.postMessage({ type: 'approval', rpcId: approval.rpcId, approvalId: approval.approvalId, outcome: 'allowed-once' }));
      reject.addEventListener('click', () => vscode.postMessage({ type: 'approval', rpcId: approval.rpcId, approvalId: approval.approvalId, outcome: 'rejected' }));
      actions.append(allow, reject); box.append(actions); return box;
    }
    function renderQuestions(request) {
      const box = node('form', 'interaction question'); box.append(node('div', 'interaction-title', 'DeepSeek needs your input'));
      for (const question of request.questions) {
        const item = node('div', 'question-item'); item.dataset.questionId = question.id;
        item.append(node('div', 'question-label', question.header || question.question));
        if (question.header) item.append(node('div', 'question-detail', question.question));
        if (question.detail) item.append(node('div', 'question-detail', question.detail));
        for (const option of question.options || []) {
          const label = node('label', 'option');
          const input = document.createElement('input'); input.type = question.multiSelect ? 'checkbox' : 'radio'; input.name = 'question-' + question.id; input.value = option.label;
          const copy = node('span', '', option.label); if (option.description) copy.append(node('span', 'option-description', option.description));
          label.append(input, copy); item.append(label);
        }
        const custom = document.createElement('input'); custom.className = 'custom-answer'; custom.placeholder = question.options && question.options.length ? 'Other answer (optional)' : 'Type your answer'; custom.dataset.custom = 'true';
        item.append(custom); box.append(item);
      }
      const submit = node('button', 'primary', 'Submit'); submit.type = 'submit';
      const actions = node('div', 'actions'); actions.append(submit); box.append(actions);
      box.addEventListener('submit', event => {
        event.preventDefault(); const answers = []; let valid = true;
        for (const question of request.questions) {
          const item = box.querySelector('[data-question-id="' + CSS.escape(question.id) + '"]');
          const selected = Array.from(item.querySelectorAll('input[type=radio]:checked,input[type=checkbox]:checked')).map(input => input.value);
          const custom = item.querySelector('[data-custom=true]').value.trim();
          if (!selected.length && !custom) { item.classList.add('error-text'); valid = false; } else item.classList.remove('error-text');
          answers.push({ id: question.id, selected, ...(custom ? { custom } : {}) });
        }
        if (valid) vscode.postMessage({ type: 'question', rpcId: request.rpcId, answers });
      });
      return box;
    }
    function renderEfforts(model) {
      elements.efforts.replaceChildren(); const efforts = model && model.reasoningEfforts || [];
      for (const effort of efforts) elements.efforts.append(new Option(effort.label, effort.id, false, effort.selected === true));
      if (!efforts.length) elements.efforts.append(new Option('Default', ''));
      elements.efforts.title = efforts.length ? 'Reasoning effort' : 'This model has no reasoning effort setting';
    }
    function renderAttachments() {
      elements.attachments.replaceChildren(); elements.attachments.classList.toggle('hidden', draftImages.length === 0);
      for (const image of draftImages) {
        const chip = node('div', 'attachment-chip'); chip.append(node('span', '', '▧'), node('span', 'attachment-name', image.name || 'Image'));
        const remove = node('button', 'attachment-remove', '×'); remove.title = 'Remove attachment'; remove.addEventListener('click', () => vscode.postMessage({ type: 'remove-attachment', id: image.id }));
        chip.append(remove); elements.attachments.append(chip);
      }
      updateSend();
    }
    function effectivePlanMode(plan) { return Boolean(plan && (plan.pending ? !plan.active : plan.active)); }
    function policyMenuOption(label, description, selected, disabled, onSelect) {
      const option = node('button', 'command-option' + (selected ? ' selected' : ''));
      option.type = 'button'; option.setAttribute('role', 'menuitemradio'); option.setAttribute('aria-checked', String(selected)); option.disabled = disabled;
      const line = node('span', 'command-option-line'); line.append(node('span', 'command-option-name', label));
      if (selected) line.append(node('span', 'command-option-current', 'Current'));
      option.append(line, node('span', 'command-option-description', description));
      option.addEventListener('click', () => { if (selected) return; policyMenuOpen = false; elements.policyMenu.classList.add('hidden'); elements.policyTrigger.setAttribute('aria-expanded', 'false'); onSelect(); });
      return option;
    }
    function renderPolicyState(current) {
      const plan = current.plan || { available: false, active: false, pending: false };
      const planActive = effectivePlanMode(plan);
      const permissions = current.permissions || [];
      const selectedPermission = permissions.find(permission => permission.selected) || permissions[0];
      const available = plan.available === true || permissions.length > 0;
      elements.modeChips.replaceChildren();
      const preset = current.agentPreset || { available: false, current: '', locked: true, busy: false, options: [] };
      if (preset.available && preset.options.length) {
        const selectedPreset = preset.options.find(option => option.selected) || preset.options[0];
        const chip = node('div', 'preset-chip' + (preset.locked ? ' locked' : ''));
        chip.append(node('span', 'preset-icon', '◇'));
        const select = node('select', 'preset-select'); select.setAttribute('aria-label', 'Agent preset');
        for (const option of preset.options) {
          const label = option.label + (option.trust === 'user' ? ' · User' : '');
          select.append(new Option(label, option.id, false, option.selected === true));
        }
        select.disabled = preset.locked || preset.busy || current.running === true || current.phase !== 'ready';
        select.title = preset.locked
          ? 'Agent preset is fixed after the first turn'
          : ((selectedPreset && selectedPreset.description) || 'Choose the agent composition for this new conversation');
        select.addEventListener('change', () => vscode.postMessage({ type: 'select-agent-preset', agentPreset: select.value }));
        chip.append(select);
        if (preset.locked) chip.append(node('span', 'preset-lock', 'Locked'));
        elements.modeChips.append(chip);
      }
      if (planActive) {
        const chip = node('span', 'plan-chip');
        chip.append(node('span', '', plan.pending ? 'Plan…' : 'Plan'));
        const close = node('button', 'plan-chip-close', '×'); close.type = 'button'; close.title = 'Exit Plan mode'; close.setAttribute('aria-label', 'Exit Plan mode'); close.disabled = current.running === true || plan.pending === true;
        close.addEventListener('click', () => vscode.postMessage({ type: 'select-mode', mode: 'normal' })); chip.append(close); elements.modeChips.append(chip);
      }
      elements.modeChips.classList.toggle('hidden', elements.modeChips.childElementCount === 0);
      elements.policyTrigger.classList.toggle('hidden', !available);
      elements.policyTrigger.classList.toggle('active', planActive);
      elements.policyTrigger.classList.toggle('full-access', selectedPermission && selectedPermission.value === 'danger-full-access');
      elements.policyTrigger.disabled = current.phase !== 'ready';
      const status = (plan.available === true ? (planActive ? 'Plan' : 'Normal') : '') + (selectedPermission ? (plan.available === true ? ' · ' : '') + selectedPermission.label : '');
      elements.policyTrigger.title = status ? 'Mode and permissions: ' + status : 'Mode and permissions';
      elements.policyTrigger.setAttribute('aria-label', elements.policyTrigger.title);
      elements.policyTrigger.setAttribute('aria-expanded', String(policyMenuOpen && available));

      elements.policyMenu.replaceChildren();
      if (plan.available === true) {
        elements.policyMenu.append(node('div', 'policy-section-label', 'Mode'));
        elements.policyMenu.append(
          policyMenuOption('Normal', 'Work normally with the selected permission.', !planActive, current.running === true || plan.pending === true, () => vscode.postMessage({ type: 'select-mode', mode: 'normal' })),
          policyMenuOption('Plan', 'Research and plan before making changes.', planActive, current.running === true || plan.pending === true, () => vscode.postMessage({ type: 'select-mode', mode: 'plan' })),
        );
      }
      if (permissions.length > 0) {
        elements.policyMenu.append(node('div', 'policy-section-label', 'Permissions'));
        for (const permission of permissions) {
          elements.policyMenu.append(policyMenuOption(
            permission.label,
            permission.description || permission.label,
            permission.selected === true,
            current.running === true,
            () => vscode.postMessage({ type: 'select-permission', permission: permission.value }),
          ));
        }
      }
      if (!available) policyMenuOpen = false;
      elements.policyMenu.classList.toggle('hidden', !policyMenuOpen || !available);
    }
    function formatTokens(value) {
      if (!Number.isFinite(value)) return '0';
      if (value < 1000) return String(Math.round(value));
      if (value < 1000000) return (value / 1000).toFixed(value < 10000 ? 1 : 0).replace(/\.0$/, '') + 'K';
      return (value / 1000000).toFixed(value < 10000000 ? 1 : 0).replace(/\.0$/, '') + 'M';
    }
    function formatDuration(value) {
      if (!Number.isFinite(value) || value <= 0) return '0ms';
      if (value < 1000) return Math.round(value) + 'ms';
      if (value < 60000) return (value / 1000).toFixed(value < 10000 ? 1 : 0) + 's';
      return (value / 60000).toFixed(1) + 'm';
    }
    function usageStatsLine(usage) {
      const groups = [];
      const stats = usage && usage.sessionStats;
      if (stats && stats.steps > 0) {
        groups.push(stats.turns + (stats.turns === 1 ? ' turn' : ' turns') + ' · ' + stats.steps + (stats.steps === 1 ? ' step' : ' steps'));
        const durations = [];
        if (stats.llmMs > 0) durations.push('LLM ' + formatDuration(stats.llmMs));
        if (stats.toolMs > 0) durations.push('tools ' + formatDuration(stats.toolMs));
        if (durations.length) groups.push(durations.join(' · '));
        const speeds = [];
        if (stats.ttftSteps > 0) speeds.push('TTFT avg ' + formatDuration(stats.ttftMs / stats.ttftSteps));
        if (stats.decodeMs > 0) speeds.push((stats.decodeTokens / (stats.decodeMs / 1000)).toFixed(1) + ' tok/s');
        if (speeds.length) groups.push(speeds.join(' · '));
      }
      const tokens = usage && usage.tokenUsage;
      if (tokens) {
        const input = tokens.uncachedInputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;
        if (input > 0 || tokens.outputTokens > 0) {
          if (input > 0) groups.push('cache ' + Math.round(tokens.cacheReadTokens / input * 100) + '%');
          groups.push('in ' + formatTokens(input) + ' · out ' + formatTokens(tokens.outputTokens));
        }
      }
      return groups.join('  |  ');
    }
    function usageStatsSummary(usage) {
      const groups = [];
      const stats = usage && usage.sessionStats;
      if (stats && stats.steps > 0) {
        groups.push(stats.turns + (stats.turns === 1 ? ' turn' : ' turns'));
        groups.push(stats.steps + (stats.steps === 1 ? ' step' : ' steps'));
      }
      const tokens = usage && usage.tokenUsage;
      if (tokens) {
        const total = tokens.uncachedInputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens + tokens.outputTokens;
        if (total > 0) groups.push(formatTokens(total) + ' tokens');
      }
      return groups.join(' · ');
    }
    function renderUsage(current) {
      const usage = current.usage || { available: false, percent: 0, usedTokens: 0, contextWindow: 0 };
      const stats = usageStatsSummary(usage);
      elements.usageStats.textContent = stats;
      elements.usageStats.title = usageStatsLine(usage);
      elements.usageStats.classList.toggle('hidden', stats === '');
      elements.usageControl.classList.toggle('hidden', usage.available !== true);
      if (usage.available !== true) {
        usageOpen = false;
        elements.usagePanel.classList.add('hidden');
        elements.usageTrigger.setAttribute('aria-expanded', 'false');
        return;
      }
      const percent = Math.max(0, Math.min(100, Number(usage.percent) || 0));
      const circumference = 2 * Math.PI * 5.5;
      elements.usageFill.setAttribute('stroke-dasharray', (circumference * percent / 100) + ' ' + circumference);
      elements.usageTrigger.classList.toggle('warning', percent >= 75 && percent < 90);
      elements.usageTrigger.classList.toggle('danger', percent >= 90);
      elements.usageTrigger.title = 'Context ' + percent + '% used';
      elements.usageTrigger.setAttribute('aria-label', elements.usageTrigger.title);
      elements.usageTrigger.setAttribute('aria-expanded', String(usageOpen));
      elements.usagePanel.replaceChildren();
      if (usageOpen) {
        const header = node('div', 'usage-header');
        header.append(node('span', '', 'Context'), node('span', 'usage-percent', percent + '% used'), node('span', 'usage-figures', '~' + formatTokens(usage.usedTokens) + ' / ' + formatTokens(usage.contextWindow)));
        const bar = node('div', 'usage-bar');
        const breakdown = usage.breakdown;
        const parts = breakdown ? [
          { key: 'systemTokens', label: 'System prompt', className: 'usage-system' },
          { key: 'toolsTokens', label: 'Tools', className: 'usage-tools' },
          { key: 'messageTokens', label: 'Messages', className: 'usage-messages' },
        ] : [];
        const total = parts.reduce((sum, part) => sum + Number(breakdown[part.key] || 0), 0);
        if (total > 0) {
          for (const part of parts) {
            const width = percent * Number(breakdown[part.key] || 0) / total;
            if (width <= 0) continue;
            const segment = node('span', 'usage-segment ' + part.className); segment.style.width = width + '%'; bar.append(segment);
          }
        } else {
          const segment = node('span', 'usage-segment usage-messages'); segment.style.width = percent + '%'; bar.append(segment);
        }
        elements.usagePanel.append(header, bar);
        if (breakdown) {
          const rows = node('dl', 'usage-rows');
          for (const part of parts) {
            const row = node('div', 'usage-row');
            const term = node('dt', ''); term.append(node('span', 'usage-swatch ' + part.className), document.createTextNode(part.label));
            row.append(term, node('dd', '', '~' + formatTokens(breakdown[part.key]))); rows.append(row);
          }
          elements.usagePanel.append(rows);
        }
      }
      elements.usagePanel.classList.toggle('hidden', !usageOpen);
    }
    function sameSelection(left, right) {
      return left && right && left.path === right.path && left.startLine === right.startLine && left.endLine === right.endLine;
    }
    function contextLabel(reference) {
      if (reference.kind !== 'selection') return reference.path;
      const lines = reference.startLine === reference.endLine ? 'L' + reference.startLine : 'L' + reference.startLine + '–' + reference.endLine;
      return reference.path + ' ' + lines + (reference.truncated ? ' (truncated)' : '');
    }
    function renderIdeContext() {
      elements.contextChips.replaceChildren();
      const pinned = ideContext.pinned || [];
      const references = [];
      if (ideContext.activeFile) references.push(ideContext.activeFile);
      if (ideContext.selection && !pinned.some(item => sameSelection(item, ideContext.selection))) references.push(ideContext.selection);
      references.push(...pinned);
      elements.contextChips.classList.toggle('hidden', references.length === 0);
      for (const reference of references) {
        const chip = node('div', 'context-chip' + (reference.kind === 'selection' ? ' selection' : ''));
        chip.title = reference.kind === 'selection' ? 'Selected editor lines included with this prompt' : 'Current editor file included with this prompt';
        chip.append(node('span', 'context-icon', reference.kind === 'selection' ? '§' : '▧'), node('span', 'context-name', contextLabel(reference)));
        if (reference.id) {
          const remove = node('button', 'context-remove', '×'); remove.title = 'Remove pinned context';
          remove.addEventListener('click', () => vscode.postMessage({ type: 'remove-context', id: reference.id })); chip.append(remove);
        }
        elements.contextChips.append(chip);
      }
    }
    function currentMentionQuery() {
      const cursor = elements.prompt.selectionStart || 0;
      const prefix = elements.prompt.value.slice(0, cursor);
      const match = /(?:^|[\\s(])@(?:\\{([^}]*)|([^\\s@{}]*))$/.exec(prefix);
      if (!match) return undefined;
      const start = prefix.lastIndexOf('@');
      return start < 0 ? undefined : { start, cursor, query: match[1] || match[2] || '' };
    }
    function requestMentions() {
      const mention = currentMentionQuery();
      if (!mention) { mentionCandidates = []; elements.mentionMenu.classList.add('hidden'); return; }
      const requestId = ++mentionRequestId;
      vscode.postMessage({ type: 'request-mentions', requestId, query: mention.query });
    }
    function renderMentionMenu() {
      const mention = currentMentionQuery();
      elements.mentionMenu.replaceChildren();
      if (!mention || !mentionCandidates.length) { elements.mentionMenu.classList.add('hidden'); return; }
      elements.commandMenu.classList.add('hidden');
      mentionIndex = Math.min(mentionIndex, mentionCandidates.length - 1);
      elements.mentionMenu.classList.remove('hidden');
      mentionCandidates.forEach((candidate, index) => {
        const option = node('button', 'command-option' + (index === mentionIndex ? ' selected' : ''));
        option.type = 'button'; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(index === mentionIndex));
        const line = node('div', 'command-option-line');
        if (candidate.kind === 'problems') {
          line.append(node('span', 'command-option-name', '@problems'), node('span', 'command-option-hint', 'Workspace diagnostics'));
          option.append(line, node('div', 'command-option-description', 'Include all current errors and warnings'));
        } else if (candidate.kind === 'problem') {
          const location = candidate.path + ':' + candidate.startLine + ':' + candidate.startCharacter;
          line.append(node('span', 'command-option-name', location), node('span', 'command-option-hint', candidate.severity === 'error' ? 'Error' : 'Warning'));
          option.append(line, node('div', 'command-option-description', (candidate.source ? candidate.source + ' · ' : '') + candidate.message));
        } else {
          line.append(node('span', 'command-option-name', candidate.path + (candidate.kind === 'folder' ? '/' : '')));
          line.append(node('span', 'command-option-hint', candidate.kind === 'folder' ? 'Folder' : 'File'));
          option.append(line);
        }
        option.addEventListener('mousedown', event => { event.preventDefault(); pickMention(candidate); });
        elements.mentionMenu.append(option);
      });
    }
    function pickMention(candidate) {
      const mention = currentMentionQuery(); if (!mention) return;
      const path = candidate.kind === 'problem'
        ? candidate.path + ':' + candidate.startLine + ':' + candidate.startCharacter
        : candidate.path + (candidate.kind === 'folder' ? '/' : '');
      const encoded = candidate.kind === 'problems' ? '@problems' : (path.includes(' ') || candidate.kind === 'problem' ? '@{' + path + '}' : '@' + path);
      const suffix = elements.prompt.value.slice(mention.cursor);
      const insertion = encoded + (suffix.startsWith(' ') ? '' : ' ');
      elements.prompt.value = elements.prompt.value.slice(0, mention.start) + insertion + suffix;
      const cursor = mention.start + insertion.length;
      elements.prompt.setSelectionRange(cursor, cursor);
      mentionCandidates = []; mentionIndex = 0; elements.mentionMenu.classList.add('hidden');
      resizePrompt(); elements.prompt.focus();
    }
    function menuCandidates() {
      if (!state) return [];
      const raw = elements.prompt.value;
      if (raw.includes('\\n')) return [];
      if (raw.toLowerCase().startsWith('/permission ')) {
        const query = raw.slice('/permission '.length).trim().toLowerCase();
        if (query.includes(' ')) return [];
        return (state.permissions || [])
          .filter(permission => permission.value.toLowerCase().includes(query) || permission.label.toLowerCase().includes(query))
          .map(permission => ({ kind: 'permission', permission }));
      }
      const text = raw.trim();
      if (!text.startsWith('/') || text.includes(' ')) return [];
      const query = text.slice(1).toLowerCase();
      const commands = (state.commands || [])
        .filter(command => command.name.toLowerCase().includes(query))
        .map(command => ({ kind: 'command', command }));
      const commandNames = new Set((state.commands || []).map(command => command.name));
      const skills = (state.skills || [])
        .filter(skill => !commandNames.has(skill.name) && skill.name.toLowerCase().includes(query))
        .map(skill => ({ kind: 'skill', skill }));
      return [...commands, ...skills];
    }
    function renderCommandMenu() {
      const candidates = menuCandidates();
      elements.commandMenu.replaceChildren();
      if (!candidates.length) { elements.commandMenu.classList.add('hidden'); return; }
      elements.mentionMenu.classList.add('hidden');
      commandIndex = Math.min(commandIndex, candidates.length - 1);
      elements.commandMenu.classList.remove('hidden');
      let section = '';
      candidates.forEach((candidate, index) => {
        const nextSection = candidate.kind === 'permission' ? '' : (candidate.kind === 'command' ? 'Commands' : 'Skills');
        if (nextSection && nextSection !== section) {
          elements.commandMenu.append(node('div', 'command-section-label', nextSection)); section = nextSection;
        }
        const option = node('button', 'command-option' + (index === commandIndex ? ' selected' : ''));
        option.type = 'button'; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(index === commandIndex));
        const line = node('div', 'command-option-line');
        if (candidate.kind === 'permission') {
          const permission = candidate.permission;
          line.append(node('span', 'command-option-name', permission.label));
          if (permission.label !== permission.value) line.append(node('span', 'command-option-hint', permission.value));
          if (permission.selected) line.append(node('span', 'command-option-current', 'Current'));
          option.append(line, node('div', 'command-option-description', permission.description || 'Use this permission preset'));
        } else if (candidate.kind === 'command') {
          const command = candidate.command;
          line.append(node('span', 'command-option-name', '/' + command.name));
          if (command.input && command.input.hint) line.append(node('span', 'command-option-hint', command.input.hint));
          option.append(line, node('div', 'command-option-description', command.description));
        } else {
          const skill = candidate.skill;
          line.append(node('span', 'command-option-name', '/' + skill.name));
          line.append(node('span', 'command-option-hint', skill.modelInvocable ? 'Skill' : 'User only'));
          const description = skill.whenToUse ? skill.description + ' · ' + skill.whenToUse : skill.description;
          option.append(line, node('div', 'command-option-description', description)); option.title = description;
        }
        option.addEventListener('mousedown', event => { event.preventDefault(); pickCandidate(candidate); });
        elements.commandMenu.append(option);
      });
    }
    function pickCandidate(candidate) {
      if (candidate.kind === 'permission') {
        vscode.postMessage({ type: 'send', text: '/permission ' + candidate.permission.value });
        elements.prompt.value = ''; commandIndex = 0; resetPrompt(); return;
      }
      if (candidate.kind === 'skill') {
        elements.prompt.value = '/' + candidate.skill.name + ' ';
        elements.prompt.placeholder = candidate.skill.whenToUse || candidate.skill.description || 'Skill instructions';
        commandIndex = 0; resizePrompt(); renderCommandMenu(); elements.prompt.focus(); return;
      }
      pickCommand(candidate.command);
    }
    function pickCommand(command) {
      if (command.input) {
        elements.prompt.value = '/' + command.name + ' ';
        elements.prompt.placeholder = command.input.hint || 'Command arguments';
        commandIndex = 0; resizePrompt(); renderCommandMenu(); elements.prompt.focus(); return;
      }
      vscode.postMessage({ type: 'send', text: '/' + command.name });
      elements.prompt.value = ''; commandIndex = 0; resetPrompt();
    }
    function resetPrompt() { elements.prompt.placeholder = 'Ask DeepSeek about this project'; resizePrompt(); renderCommandMenu(); renderMentionMenu(); }
    function postQueueAction(itemId, action, text) {
      vscode.postMessage({ type: 'queue-action', itemId, action, ...(text === undefined ? {} : { text }) });
    }
    function renderQueue(force) {
      const queue = (state && state.queue || []).filter(item => item.placement === 'queued');
      if (queueEditing && !queue.some(item => item.id === queueEditing.id)) queueEditing = null;
      const signature = JSON.stringify({ queue, running: state && state.running, editing: queueEditing });
      if (!force && signature === queueRenderSignature) return;
      queueRenderSignature = signature; elements.queueDock.replaceChildren(); elements.queueDock.classList.toggle('hidden', queue.length === 0);
      if (!queue.length) return;
      const head = node('div', 'queue-head'); head.append(node('span', '', '≡'), node('span', 'queue-title', queue.length === 1 ? '1 queued message' : queue.length + ' queued messages')); elements.queueDock.append(head);
      for (const item of queue) {
        const row = node('div', 'queue-row');
        if (queueEditing && queueEditing.id === item.id) {
          const editor = node('textarea', 'queue-editor'); editor.value = queueEditing.text; editor.rows = 1; editor.setAttribute('aria-label', 'Edit queued message');
          editor.addEventListener('input', () => {
            queueEditing = { id: item.id, text: editor.value };
            queueRenderSignature = JSON.stringify({ queue, running: state && state.running, editing: queueEditing });
            save.disabled = editor.value.trim() === '';
          });
          editor.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); queueEditing = null; renderQueue(true); return; }
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
              event.preventDefault(); const text = editor.value.trim(); if (!text) return; queueEditing = null; postQueueAction(item.id, 'edit', text); renderQueue(true);
            }
          });
          const actions = node('div', 'queue-actions'); const save = node('button', 'queue-action', 'Save'); const cancelEdit = node('button', 'queue-action', 'Cancel');
          save.type = cancelEdit.type = 'button'; save.disabled = queueEditing.text.trim() === ''; save.addEventListener('click', () => { const text = editor.value.trim(); if (!text) return; queueEditing = null; postQueueAction(item.id, 'edit', text); renderQueue(true); });
          cancelEdit.addEventListener('click', () => { queueEditing = null; renderQueue(true); }); actions.append(save, cancelEdit); row.append(editor, actions);
          requestAnimationFrame(() => { editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length); });
        } else {
          row.append(node('span', 'queue-preview', item.preview || 'Queued message'));
          const actions = node('div', 'queue-actions');
          const edit = node('button', 'queue-action', 'Edit'); edit.type = 'button'; edit.disabled = item.text === null; edit.title = item.text === null ? 'Messages with attachments cannot be edited' : 'Edit queued message'; edit.addEventListener('click', () => { if (item.text !== null) { queueEditing = { id: item.id, text: item.text }; renderQueue(true); } });
          const remove = node('button', 'queue-action', 'Delete'); remove.type = 'button'; remove.addEventListener('click', () => postQueueAction(item.id, 'remove'));
          const steer = node('button', 'queue-action', 'Steer'); steer.type = 'button'; steer.disabled = !state.running; steer.title = state.running ? 'Apply this message to the current task now' : 'Steering is available only while DeepSeek is running'; steer.addEventListener('click', () => postQueueAction(item.id, 'steer'));
          actions.append(edit, remove, steer); row.append(actions);
        }
        elements.queueDock.append(row);
      }
    }
    function liveJob(job) { return job.status === 'running' || job.status === 'stopping'; }
    function jobDuration(job) {
      const end = liveJob(job) ? Date.now() : (Number(job.finishedAt) || Number(job.startedAt));
      const seconds = Math.max(0, Math.floor((end - Number(job.startedAt)) / 1000));
      if (seconds < 60) return seconds + 's';
      const minutes = Math.floor(seconds / 60); if (minutes < 60) return minutes + 'm ' + (seconds % 60) + 's';
      return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
    }
    function renderJobs() {
      const jobs = array(state && state.jobs);
      const live = jobs.filter(liveJob).length;
      elements.jobsControl.classList.toggle('hidden', jobs.length === 0);
      elements.jobsTrigger.classList.toggle('live', live > 0);
      elements.jobsCount.textContent = String(live || jobs.length);
      elements.jobsTrigger.title = live > 0 ? live + ' background ' + (live === 1 ? 'job' : 'jobs') + ' running' : jobs.length + ' background ' + (jobs.length === 1 ? 'job' : 'jobs');
      if (!jobs.length) { jobsOpen = false; elements.jobsMenu.classList.add('hidden'); elements.jobsTrigger.setAttribute('aria-expanded', 'false'); }
      elements.jobsMenu.replaceChildren();
      if (jobs.length) {
        elements.jobsMenu.append(node('div', 'jobs-title', live > 0 ? 'Background jobs · ' + live + ' running' : 'Background jobs'));
        const ordered = [...jobs].sort((a, b) => liveJob(a) !== liveJob(b) ? (liveJob(a) ? -1 : 1) : (liveJob(a) ? Number(a.startedAt) - Number(b.startedAt) : Number(b.finishedAt || b.startedAt) - Number(a.finishedAt || a.startedAt)));
        for (const job of ordered) {
          const row = node('div', 'job-row'); const status = string(job.detail) || string(job.status);
          row.title = status; row.append(node('span', 'job-kind', string(job.kind, 'job')), node('span', 'job-label', string(job.label, 'Background job')), node('span', 'job-detail', status), node('span', 'job-duration', jobDuration(job))); elements.jobsMenu.append(row);
        }
      }
      if (jobsTimer) { clearInterval(jobsTimer); jobsTimer = undefined; }
      if (jobsOpen && live > 0) jobsTimer = setInterval(renderJobs, 1000);
    }
    function renderConversation(current) {
      if (renderedSessionId !== current.sessionId) {
        renderedSessionId = current.sessionId; renderedMessages.clear(); elements.messages.replaceChildren();
        renderedHistoryKey = ''; renderedTail = {}; expandedToolIds.clear(); loadingToolIds.clear();
      }
      const statusKey = current.phase + '::' + current.statusText;
      if (statusKey !== renderedStatusKey) {
        renderedStatusKey = statusKey;
        elements.conversationStatus.replaceChildren();
        if (current.phase !== 'ready') elements.conversationStatus.append(renderStatus(current));
      }
      if (current.phase !== 'ready') {
        elements.conversationHistory.replaceChildren(); elements.messages.replaceChildren(); elements.conversationTail.replaceChildren();
        renderedHistoryKey = ''; renderedTail = {};
        return;
      }

      const historyKey = String(current.hasMoreHistory) + '::' + String(current.loadingHistory);
      if (historyKey !== renderedHistoryKey) {
        renderedHistoryKey = historyKey; elements.conversationHistory.replaceChildren();
        if (current.hasMoreHistory || current.loadingHistory) {
          const loader = node('div', 'history-loader'); const button = node('button', 'history-button', current.loadingHistory ? 'Loading earlier messages…' : 'Load earlier messages'); button.type = 'button'; button.disabled = current.loadingHistory === true;
          button.addEventListener('click', () => { historyAnchor = { sessionId: current.sessionId, height: elements.scroll.scrollHeight, top: elements.scroll.scrollTop }; button.disabled = true; button.textContent = 'Loading earlier messages…'; vscode.postMessage({ type: 'load-history' }); }); loader.append(button); elements.conversationHistory.append(loader);
        }
      }
      reconcileMessages(array(current.messages), current);

      if (renderedTail.queue !== current.queue || renderedTail.changedFiles !== current.changedFiles || renderedTail.approval !== current.approval || renderedTail.question !== current.question) {
        renderedTail = { queue: current.queue, changedFiles: current.changedFiles, approval: current.approval, question: current.question };
        elements.conversationTail.replaceChildren();
        for (const item of current.queue || []) if (item.placement === 'steering') elements.conversationTail.append(renderPendingSteering(item));
        if (current.changedFiles && current.changedFiles.length) elements.conversationTail.append(renderChangedFiles(current.changedFiles));
        if (current.approval) elements.conversationTail.append(renderApproval(current.approval));
        if (current.question) elements.conversationTail.append(renderQuestions(current.question));
      }
    }
    function render(current) {
      const nearBottom = elements.scroll.scrollHeight - elements.scroll.scrollTop - elements.scroll.clientHeight < 80;
      const preservingHistory = historyAnchor && historyAnchor.sessionId === current.sessionId;
      state = current;
      if (renderedChrome.workspaceName !== current.workspaceName || renderedChrome.cwd !== current.cwd) {
        elements.workspace.textContent = current.workspaceName || 'Workspace'; elements.project.title = current.cwd ? 'DeepSeek project: ' + current.cwd : 'Choose DeepSeek project';
      }
      if (renderedChrome.sessions !== current.sessions) {
        elements.sessions.replaceChildren();
        for (const session of current.sessions || []) { const option = new Option(session.title, session.id, false, session.id === current.sessionId); elements.sessions.append(option); }
        if (!elements.sessions.childElementCount) elements.sessions.append(new Option('New conversation', ''));
      } else if (elements.sessions.value !== current.sessionId) elements.sessions.value = current.sessionId;
      if (renderedChrome.models !== current.models) {
        elements.models.replaceChildren();
        for (const model of current.models || []) { const option = new Option(model.label, JSON.stringify({ provider: model.provider, model: model.model }), false, model.selected === true); elements.models.append(option); }
        if (!elements.models.childElementCount) elements.models.append(new Option('Default model', ''));
        renderEfforts((current.models || []).find(model => model.selected) || (current.models || [])[0]);
      }
      const policyChanged = renderedChrome.agentPreset !== current.agentPreset || renderedChrome.permissions !== current.permissions || renderedChrome.plan !== current.plan || renderedChrome.running !== current.running || renderedChrome.phase !== current.phase;
      if (policyChanged) renderPolicyState(current);
      if (renderedChrome.usage !== current.usage) renderUsage(current);
      if (renderedChrome.jobs !== current.jobs) renderJobs();
      renderConversation(current);
      const enabled = current.phase === 'ready' && current.routable !== false && Boolean(current.sessionId);
      elements.prompt.disabled = !enabled; elements.attach.disabled = !enabled; elements.project.disabled = current.running === true; elements.newSession.disabled = current.phase !== 'ready'; elements.sessions.disabled = current.phase !== 'ready';
      elements.models.disabled = !enabled || !(current.models || []).length; elements.efforts.disabled = !enabled || !elements.efforts.options.length || elements.efforts.value === '';
      elements.cancel.classList.toggle('hidden', current.running !== true); elements.send.title = current.running ? 'Queue message (Enter) · Steer now (Cmd/Ctrl+Enter)' : 'Send (Enter)'; updateSend(); renderQueue();
      if (renderedChrome.commands !== current.commands || renderedChrome.skills !== current.skills || renderedChrome.permissions !== current.permissions) renderCommandMenu();
      renderedChrome = {
        workspaceName: current.workspaceName, cwd: current.cwd, sessions: current.sessions, models: current.models,
        agentPreset: current.agentPreset, permissions: current.permissions, plan: current.plan, running: current.running,
        phase: current.phase, usage: current.usage, jobs: current.jobs, commands: current.commands, skills: current.skills,
      };
      if (preservingHistory && current.loadingHistory !== true) {
        const anchor = historyAnchor; historyAnchor = undefined;
        requestAnimationFrame(() => { elements.scroll.scrollTop = anchor.top + elements.scroll.scrollHeight - anchor.height; });
      } else if (!preservingHistory && (nearBottom || current.approval || current.question)) requestAnimationFrame(() => { elements.scroll.scrollTop = elements.scroll.scrollHeight; });
    }
    function scheduleRender(current) {
      state = current; pendingRenderState = current;
      if (renderFrame !== undefined) return;
      renderFrame = requestAnimationFrame(() => {
        renderFrame = undefined;
        const pending = pendingRenderState; pendingRenderState = undefined;
        if (pending) render(pending);
      });
    }
    function applyMessagesPatch(current, patch) {
      if (Array.isArray(patch && patch.reset)) return patch.reset;
      const messages = Array.isArray(current) ? [...current] : [];
      const indexes = new Map(messages.map((message, index) => [message.id, index]));
      for (const message of array(patch && patch.upserts)) {
        const index = indexes.get(message.id);
        if (index === undefined) { indexes.set(message.id, messages.length); messages.push(message); }
        else messages[index] = message;
      }
      for (const append of array(patch && patch.appends)) {
        const index = indexes.get(append.id); const message = index === undefined ? undefined : messages[index];
        if (!message || message.role !== 'assistant') continue;
        messages[index] = { ...message, text: message.text + string(append.text), streaming: append.streaming === true };
      }
      return messages;
    }
    function applyStateUpdate(update) {
      if (!state) return;
      const patch = record(update && update.patch) || {};
      const messages = update && update.messages
        ? applyMessagesPatch(state.messages, update.messages)
        : state.messages;
      scheduleRender({ ...state, ...patch, messages });
    }
    function updateSend() { elements.send.disabled = !state || state.phase !== 'ready' || (elements.prompt.value.trim() === '' && draftImages.length === 0); }
    function resizePrompt() { elements.prompt.style.height = 'auto'; elements.prompt.style.height = Math.min(elements.prompt.scrollHeight, 220) + 'px'; updateSend(); }
    function selectionFor(model, reasoningEffort) { return { provider: model.provider, model: model.model, ...(reasoningEffort ? { reasoningEffort } : {}) }; }
    function send(mode) {
      const text = elements.prompt.value.trim(); if ((!text && !draftImages.length) || !state || state.phase !== 'ready') return;
      vscode.postMessage({ type: 'send', text, mode: mode || 'queue' }); elements.prompt.value = ''; commandIndex = 0; resetPrompt();
    }
    elements.prompt.addEventListener('input', () => { policyMenuOpen = false; elements.policyMenu.classList.add('hidden'); elements.policyTrigger.setAttribute('aria-expanded', 'false'); commandIndex = 0; mentionIndex = 0; elements.prompt.placeholder = 'Ask DeepSeek about this project'; resizePrompt(); renderCommandMenu(); requestMentions(); });
    elements.prompt.addEventListener('click', () => { policyMenuOpen = false; elements.policyMenu.classList.add('hidden'); elements.policyTrigger.setAttribute('aria-expanded', 'false'); requestMentions(); });
    elements.prompt.addEventListener('keydown', event => {
      if (policyMenuOpen && event.key === 'Escape') { event.preventDefault(); policyMenuOpen = false; elements.policyMenu.classList.add('hidden'); elements.policyTrigger.setAttribute('aria-expanded', 'false'); return; }
      const mentionOpen = !elements.mentionMenu.classList.contains('hidden') && mentionCandidates.length > 0;
      if (mentionOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault(); mentionIndex = (mentionIndex + (event.key === 'ArrowDown' ? 1 : mentionCandidates.length - 1)) % mentionCandidates.length; renderMentionMenu(); return;
      }
      if (mentionOpen && event.key === 'Escape') { event.preventDefault(); mentionCandidates = []; elements.mentionMenu.classList.add('hidden'); return; }
      if (mentionOpen && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.isComposing))) { event.preventDefault(); pickMention(mentionCandidates[mentionIndex]); return; }
      const candidates = menuCandidates(); const menuOpen = !elements.commandMenu.classList.contains('hidden') && candidates.length > 0;
      if (menuOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault(); commandIndex = (commandIndex + (event.key === 'ArrowDown' ? 1 : candidates.length - 1)) % candidates.length; renderCommandMenu(); return;
      }
      if (menuOpen && event.key === 'Escape') { event.preventDefault(); elements.commandMenu.classList.add('hidden'); return; }
      if (menuOpen && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.isComposing))) { event.preventDefault(); pickCandidate(candidates[commandIndex]); return; }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(state && state.running && (event.metaKey || event.ctrlKey) ? 'steer' : 'queue'); }
    });
    elements.send.addEventListener('click', () => send('queue')); elements.cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' })); elements.attach.addEventListener('click', () => vscode.postMessage({ type: 'attach' }));
    elements.usageTrigger.addEventListener('click', event => {
      event.stopPropagation(); usageOpen = !usageOpen; policyMenuOpen = false; elements.policyMenu.classList.add('hidden'); elements.policyTrigger.setAttribute('aria-expanded', 'false'); if (state) renderUsage(state);
    });
    elements.policyTrigger.addEventListener('click', event => {
      event.stopPropagation(); policyMenuOpen = !policyMenuOpen; usageOpen = false; elements.usagePanel.classList.add('hidden'); elements.usageTrigger.setAttribute('aria-expanded', 'false'); elements.commandMenu.classList.add('hidden'); elements.mentionMenu.classList.add('hidden'); if (state) renderPolicyState(state);
    });
    elements.jobsTrigger.addEventListener('click', event => {
      event.stopPropagation(); jobsOpen = !jobsOpen; elements.jobsMenu.classList.toggle('hidden', !jobsOpen); elements.jobsTrigger.setAttribute('aria-expanded', String(jobsOpen)); renderJobs();
    });
    elements.project.addEventListener('click', () => vscode.postMessage({ type: 'choose-workspace' }));
    elements.newSession.addEventListener('click', () => vscode.postMessage({ type: 'new-session' })); elements.sessions.addEventListener('change', () => vscode.postMessage({ type: 'select-session', sessionId: elements.sessions.value }));
    elements.models.addEventListener('change', () => {
      if (!elements.models.value) return; const selected = JSON.parse(elements.models.value); const model = (state.models || []).find(item => item.provider === selected.provider && item.model === selected.model); if (!model) return;
      renderEfforts(model); const effort = model.defaultReasoningEffort || (model.reasoningEfforts && model.reasoningEfforts[0] && model.reasoningEfforts[0].id); if (effort) elements.efforts.value = effort;
      elements.efforts.disabled = !model.reasoningEfforts || !model.reasoningEfforts.length; vscode.postMessage({ type: 'select-model', selection: selectionFor(model, effort) });
    });
    elements.efforts.addEventListener('change', () => { if (!elements.models.value) return; const selected = JSON.parse(elements.models.value); const model = (state.models || []).find(item => item.provider === selected.provider && item.model === selected.model); if (model) vscode.postMessage({ type: 'select-model', selection: selectionFor(model, elements.efforts.value) }); });
    document.addEventListener('click', event => {
      if (policyMenuOpen && !elements.policyMenu.contains(event.target) && !elements.policyTrigger.contains(event.target)) {
        policyMenuOpen = false; elements.policyMenu.classList.add('hidden'); elements.policyTrigger.setAttribute('aria-expanded', 'false');
      }
      if (usageOpen && !elements.usagePanel.contains(event.target) && !elements.usageTrigger.contains(event.target)) {
        usageOpen = false; elements.usagePanel.classList.add('hidden'); elements.usageTrigger.setAttribute('aria-expanded', 'false');
      }
      if (jobsOpen && !elements.jobsMenu.contains(event.target) && !elements.jobsTrigger.contains(event.target)) {
        jobsOpen = false; elements.jobsMenu.classList.add('hidden'); elements.jobsTrigger.setAttribute('aria-expanded', 'false'); renderJobs();
      }
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && usageOpen) {
        usageOpen = false; elements.usagePanel.classList.add('hidden'); elements.usageTrigger.setAttribute('aria-expanded', 'false'); elements.usageTrigger.focus();
      }
    });
    window.addEventListener('message', event => {
      if (!event.data) return;
      if (event.data.type === 'state') scheduleRender(event.data.state);
      if (event.data.type === 'state-update') applyStateUpdate(event.data.update);
      if (event.data.type === 'tool-output' && state && event.data.sessionId === state.sessionId && event.data.message) {
        loadingToolIds.delete(event.data.message.id);
        scheduleRender({ ...state, messages: applyMessagesPatch(state.messages, { upserts: [event.data.message] }) });
      }
      if (event.data.type === 'draft-images') { draftImages = event.data.images || []; renderAttachments(); }
      if (event.data.type === 'ide-context') { ideContext = event.data.state || { pinned: [] }; renderIdeContext(); }
      if (event.data.type === 'mention-suggestions' && event.data.requestId === mentionRequestId) {
        const mention = currentMentionQuery();
        if (mention && mention.query === event.data.query) { mentionCandidates = event.data.candidates || []; mentionIndex = 0; renderMentionMenu(); }
      }
      if (event.data.type === 'focus-prompt') elements.prompt.focus();
      if (event.data.type === 'set-prompt' && typeof event.data.text === 'string') {
        elements.prompt.value = event.data.text; resizePrompt(); requestMentions(); renderCommandMenu(); elements.prompt.focus();
        const cursor = elements.prompt.value.length; elements.prompt.setSelectionRange(cursor, cursor);
      }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`
}
