// ==UserScript==
// @name         Chat Transcript → Markdown (Mistral Vibe + Claude + ChatGPT)
// @namespace    local.chat-transcript-export
// @version      4.5.4
// @description  Export Mistral Vibe Code/Work, Claude and ChatGPT conversations and agent activity.
// @match        https://chat.mistral.ai/*
// @match        https://claude.ai/chat/*
// @match        https://chatgpt.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const PLATFORM = location.hostname === 'chat.mistral.ai' ? 'mistral'
    : location.hostname === 'claude.ai' ? 'claude'
    : location.hostname === 'chatgpt.com' ? 'chatgpt' : null;
  if (!PLATFORM || window.TMChatExport?.version === '4.5.4') return;

  const VERSION = '4.5.4';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const all = (root, selector) => root ? [...root.querySelectorAll(selector)] : [];
  const clean = value => String(value ?? '').replace(/\r\n?/g, '\n').trim();
  const text = el => clean(el?.textContent);
  const distinct = values => [...new Set(values.filter(Boolean))];
  const compact = value => clean(value).replace(/\s+/g, ' ');
  const isElement = node => node?.nodeType === Node.ELEMENT_NODE;

  function fence(value, lang = '') {
    const body = clean(value);
    let ticks = '```';
    while (body.includes(ticks)) ticks += '`';
    return `${ticks}${lang}\n${body}\n${ticks}`;
  }

  function codeContent(node) {
    const lines = all(node, 'span.block');
    return lines.length ? lines.map(line => line.textContent).join('\n') : node.textContent || '';
  }

  function renderDom(node, {includeButtons = false} = {}) {
    if (!node) return '';
    const render = n => {
      if (n.nodeType === Node.TEXT_NODE) return n.nodeValue || '';
      if (!isElement(n)) return '';
      if (n.matches('svg, script, style, template, [aria-hidden="true"], .sr-only, [data-markdown-copy="exclude"]')) return '';
      if (n.localName === 'button' && !includeButtons) return '';

      const tag = n.localName;
      const inner = () => [...n.childNodes].map(render).join('');
      if (tag === 'br') return '\n';
      if (tag === 'button') {
        // In agent detail panels, disclosure headings may exist only inside buttons.
        if (!n.matches('[aria-controls], [aria-expanded]')) return '';
        return `\n**${compact(inner())}**\n`;
      }
      if (n.matches('[data-testid="chatgpt-citation"]')) {
        const url = n.getAttribute('href');
        const name = clean(n.getAttribute('aria-label')?.split(', https://')[0]) || text(n) || 'source';
        return url ? ` [${name}](${url})` : ` [${name}]`;
      }
      if (tag === 'pre') {
        const code = n.querySelector('code');
        const lang = [...(code?.classList || [])].find(x => /^language-[\w+-]+$/.test(x))?.slice(9) || '';
        return '\n\n' + fence(code ? codeContent(code) : n.textContent, lang) + '\n\n';
      }
      if (tag === 'code' || n.getAttribute('data-markdown-copy') === 'inline-code') {
        const value = clean(n.textContent);
        const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map(m => m[0].length));
        const ticks = '`'.repeat(longest + 1);
        return ticks + value + ticks;
      }
      if (/^h[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + inner() + '\n\n';
      if (tag === 'strong' || tag === 'b') return '**' + inner() + '**';
      if (tag === 'em' || tag === 'i') return '*' + inner() + '*';
      if (tag === 'p') return '\n\n' + inner() + '\n\n';
      if (tag === 'blockquote') return '\n\n' + clean(inner()).split('\n').map(x => '> ' + x).join('\n') + '\n\n';
      if (tag === 'a') {
        const label = clean(inner()) || n.getAttribute('href') || '';
        const url = n.getAttribute('href');
        return url ? `[${label}](${url})` : label;
      }
      if (tag === 'ul' || tag === 'ol') {
        return '\n' + [...n.children].filter(li => li.localName === 'li').map((li, i) => {
          const marker = tag === 'ol' ? `${i + Number(n.getAttribute('start') || 1)}.` : '-';
          return `${marker} ${clean([...li.childNodes].map(render).join(''))}`;
        }).join('\n') + '\n';
      }
      if (tag === 'table') {
        const rows = all(n, 'tr').map(tr => all(tr, ':scope > th, :scope > td')
          .map(cell => compact(cell.textContent).replace(/\|/g, '\\|'))).filter(x => x.length);
        if (!rows.length) return '';
        return '\n\n' + rows.map((cells, i) => '| ' + cells.join(' | ') + ' |' +
          (i === 0 ? '\n| ' + cells.map(() => '---').join(' | ') + ' |' : '')).join('\n') + '\n\n';
      }
      if (tag === 'dl') {
        return '\n' + all(n, ':scope > dt').map(dt => {
          const dd = dt.nextElementSibling;
          return `- **${text(dt)}:** ${dd?.localName === 'dd' ? clean(render(dd)) : '[missing value]'}`;
        }).join('\n') + '\n';
      }
      if (tag === 'div' || tag === 'section' || tag === 'article') return '\n' + inner() + '\n';
      return inner();
    };
    return render(node).replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n').trim();
  }

  // Find an accessible disclosure panel by its actual aria-controls relation.
  function panelFor(button) {
    if (!button) return null;
    const id = button.getAttribute('aria-controls');
    const region = id ? document.getElementById(id) : null;
    if (region) return region;
    return all(button.parentElement, '[role="region"][aria-labelledby]')
      .find(el => el.getAttribute('aria-labelledby') === button.id) || null;
  }

  function writeMarkdown(messages, warnings, plan = null, subagents = []) {
    const out = [
      '# Chat transcript', '',
      `Source: ${location.href}`, `Platform: ${PLATFORM}`,
      `Exported: ${new Date().toISOString()}`, ''
    ];
    if (warnings.length) out.push('## ⚠ Export limitations', '',
      ...distinct(warnings).map(w => `- ${w}`), '');

    if (plan) {
      out.push('## Task plan (UI snapshot)', '',
        `**Current step:** ${plan.title || 'Not specified'}`, '');
      if (plan.progress) out.push(`**Progress:** ${plan.progress}`, '');
      if (plan.summary) out.push(`**UI status:** ${plan.summary}`, '');
      for (const task of plan.tasks) {
        const mark = /^completed|done|zakończ|wykonan|ukończ/i.test(task.state) ? '[x]' : '[ ]';
        out.push(`- ${mark} **${task.state || 'Status unknown'}:** ${task.title}`);
      }
      out.push('', '_Statuses are copied from the page UI; they are not inferred from the conversation._', '');
    }

    for (const m of messages) {
      out.push('---', '', `## ${m.role === 'user' ? 'User' : 'Assistant'}`, '');
      if (m.id) out.push(`ID: \`${m.id}\``, '');
      if (m.timestamp) out.push(`Time: ${m.timestamp}`, '');
      for (const p of m.parts || []) {
        if (p.kind === 'text') out.push(p.value, '');
        else if (p.kind === 'reasoning') out.push(`### 💭 ${p.label || 'Visible reasoning'}`, '', p.value || '', '');
        else if (p.kind === 'command') {
          out.push(`### 🛠 Command${p.label ? ` — ${p.label}` : ''}`, '');
          if (p.command) out.push(fence(p.command, 'bash'), '');
          if (p.output) out.push('**Output:**', '', fence(p.output), '');
          if (p.value) out.push(p.value, '');
        } else if (p.kind === 'tool') out.push(`### 🔧 Tool activity${p.label ? ` — ${p.label}` : ''}`, '', p.value || '', '');
        else if (p.kind === 'step') out.push(`### ⚙ Agent step${p.label ? ` — ${p.label}` : ''}`, '', p.value || '', '');
        else if (p.kind === 'event') out.push(`### ◇ Event${p.label ? ` — ${p.label}` : ''}`, '', p.value || '', '');
      }
    }
    if (PLATFORM === 'chatgpt' && subagents.length) {
      out.push('---', '', '# Subagents (final responses)', '');
      for (const agent of subagents) {
        out.push('## ' + agent.name.replace(/[\r\n#]+/g, ' ').trim(), '');
        if (agent.status) out.push('Status: ' + agent.status, '');
        if (agent.answer) out.push('### Final answer', '', agent.answer, '');
        else if (agent.answerState === 'unavailable') {
          out.push('_Final answer unavailable._', '', 'UI message: ' + agent.answerNote, '');
        } else if (agent.answerState === 'timeout') {
          out.push('_Timed out waiting for the final answer._', '');
        } else out.push('_No readable final answer was available in the panel._', '');
      }
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  // The Mistral Vibe checklist is in the composer, not in the transcript rows.
  // Its task list is present in the saved HTML even when the panel is closed.
  function mistralPlan(warnings = []) {
    if (PLATFORM !== 'mistral') return null;
    const composer = document.querySelector('[data-chat-input-bar="true"]');
    if (!composer) return null;

    for (const button of all(composer, 'button[aria-controls][aria-labelledby]')) {
      const panel = panelFor(button);
      const list = panel?.querySelector('ol');
      if (!list || !all(list, ':scope > li').length) continue;

      const ids = (button.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
      const title = ids.length ? text(document.getElementById(ids[0])) : '';
      const summary = ids.length > 1 ? text(document.getElementById(ids[1])) : '';
      const progress = all(button, '[aria-hidden="true"]').map(text)
        .find(x => /^\d+\s*\/\s*\d+$/.test(x)) || '';
      const tasks = all(list, ':scope > li').map(li => {
        const stateEl = li.querySelector('.sr-only');
        const state = compact(stateEl?.textContent).replace(/:\s*$/, '');
        const value = compact(li.textContent);
        const title = compact(stateEl ? value.replace(clean(stateEl.textContent), '') : value);
        if (!state) warnings.push('Mistral: task plan item has no accessible status label.');
        return {title, state};
      }).filter(task => task.title);
      return {title, summary, progress, tasks};
    }
    return null;
  }

  const mistral = {
    // Vibe Code uses data-thread-item-key; Vibe Work uses data-message-id.
    // Keep both selectors explicit and scoped to recognized conversation layouts.
    root: () => document.querySelector('[data-chat-shell-root]')
      || document.querySelector('[data-testid="conversation-layout"]') || document,
    rows: () => [
      ...all(document, '[data-thread-item-key][data-message-author-role]'),
      ...all(document, '[data-testid="conversation-layout"] [data-message-id][data-message-author-role]')
    ].filter(row => ['user', 'assistant'].includes(row.getAttribute('data-message-author-role'))),
    key: row => row.getAttribute('data-thread-item-key') || row.getAttribute('data-message-id'),
    index: () => null,
    toggles: () => {
      const buttons = [];
      for (const row of mistral.rows()) {
        // Both Work and Code have agent-activity disclosures. Expand the group
        // before its nested steps; only target conversation controls.
        buttons.push(...all(row, '[data-testid="harness-steps-summary"]')
          .map(el => el.closest('button[aria-controls][aria-expanded="false"]')).filter(Boolean));
        buttons.push(...all(row, '[data-step-state]')
          .map(el => el.closest('[data-state]')?.querySelector('button[aria-controls][aria-expanded="false"]'))
          .filter(Boolean));
      }
      return distinct(buttons);
    },
    parse(row, warnings) {
      const role = row.getAttribute('data-message-author-role');
      if (!['user', 'assistant'].includes(role)) throw Error('Unknown Mistral role');
      const parts = [];
      const summaryNodes = all(row, '[data-testid="harness-steps-summary"]');
      const groupRegions = summaryNodes.map(el => panelFor(el.closest('button'))).filter(Boolean);
      // Work emits answer parts, whereas Code emits text parts.
      // Preserve the DOM order of responses and activity groups.
      const nodes = all(row, '[data-message-part-type="text"], [data-message-part-type="answer"], [data-message-part-type="reasoning"], [data-testid="harness-steps-summary"]');

      for (const el of nodes) {
        if (groupRegions.some(region => region.contains(el))) continue;
        if (el.matches('[data-testid="harness-steps-summary"]')) {
          const button = el.closest('button');
          const region = panelFor(button);
          const label = compact(el.textContent);
          if (!region || button?.getAttribute('aria-expanded') === 'false') {
            warnings.push(`Mistral: details still collapsed/unavailable (${label || 'unlabeled group'}).`);
            parts.push({kind: 'event', label: label || 'Agent activity', value: 'Details not available in captured UI.'});
            continue;
          }

          // Legacy Vibe panels have nested data-step-state markers; new Vibe
          // panels can have another internal structure. Preserve either one.
          const markers = all(region, '[data-step-state]');
          if (markers.length) {
            const seen = new Set();
            for (const marker of markers) {
              const wrap = marker.closest('[data-state]') || marker.parentElement;
              if (!wrap || seen.has(wrap)) continue;
              seen.add(wrap);
              const toggle = wrap.querySelector('button[aria-controls]');
              const detail = panelFor(toggle);
              const stepLabel = compact(toggle?.textContent) || label;
              if (!detail || toggle?.getAttribute('aria-expanded') === 'false') {
                warnings.push(`Mistral: nested step details unavailable (${stepLabel}).`);
                parts.push({kind: 'event', label: stepLabel, value: 'Nested details not available.'});
                continue;
              }
              const value = renderDom(detail, {includeButtons: true});
              const ansi = all(detail, '.mistral-command-execution-ansi');
              const thinking = detail.querySelector('[data-message-part-type="reasoning"]');
              if (thinking) parts.push({kind: 'reasoning', label: stepLabel, value: renderDom(thinking)});
              else if (ansi.length === 1 && !detail.querySelector('div[class*="group/table"]')) {
                const output = clean(ansi[0].textContent);
                const before = ansi[0].parentElement?.firstElementChild;
                const command = before && before !== ansi[0] ? clean(before.textContent).replace(/^>\s*/, '') : '';
                parts.push({kind: 'command', label: stepLabel, command, output,
                  value: !command && !output ? value : ''});
              } else parts.push({kind: 'tool', label: stepLabel, value});
            }
          } else {
            // Do NOT infer tool names or reasoning from unknown markup.
            // Generic rendering includes disclosure headings but excludes controls.
            const value = renderDom(region, {includeButtons: true});
            if (!value) warnings.push(`Mistral: expanded group has no readable detail (${label}).`);
            const kind = /przemyślane|thought for|thinking|reasoning/i.test(label) ? 'reasoning' : 'tool';
            parts.push({kind: value ? kind : 'event', label, value: value || 'No detailed content rendered.'});
          }
          continue;
        }
        const value = renderDom(el.querySelector('.markdown-container-style') || el);
        if (value) parts.push({kind: el.getAttribute('data-message-part-type') === 'reasoning' ? 'reasoning' : 'text', value});
      }

      if (role === 'user' && !parts.length) {
        const body = row.querySelector('[class~="group/user-message"] .select-text')
          || row.querySelector('.ProseMirror[contenteditable="false"]')
          || row.querySelector('.rich-text-editor.select-text');
        if (body) parts.push({kind: 'text', value: renderDom(body) || text(body)});
        else warnings.push('Mistral: user message body is missing.');
      }
      if (!parts.length) warnings.push(`Mistral: no recognized content in ${this.key(row)}.`);
      return {id: this.key(row), role, timestamp: row.querySelector('time[datetime]')?.getAttribute('datetime') || null, parts};
    }
  };

  const claude = {
    root: () => document.querySelector('[data-testid="transcript-list"]'),
    rows: () => all(document, '[data-testid="transcript-list"] [data-testid="transcript-row"]'),
    key: row => row.querySelector('[data-cds="UserMessage"][data-turn-key], [data-cds="AssistantMessage"][data-turn-key]')?.getAttribute('data-turn-key') || null,
    index: row => /^\d+$/.test(row.getAttribute('data-index') || '') ? Number(row.getAttribute('data-index')) : null,
    toggles: () => [
      ...all(document, '[data-cds="TurnStatus"] > div:first-child button[aria-expanded="false"]'),
      ...all(document, '[data-cds="TurnStatusStep"] [class~="group/step"] > button[aria-expanded="false"]'),
      ...all(document, '[data-testid="tool-cell-row"][aria-expanded="false"]')
    ],
    parse(row, warnings) {
      const user = row.querySelector('[data-cds="UserMessage"][data-turn-key]');
      const assistant = row.querySelector('[data-cds="AssistantMessage"][data-turn-key]');
      if (Boolean(user) === Boolean(assistant)) throw Error('Claude row has ambiguous role');
      const root = user || assistant;
      const role = user ? 'user' : 'assistant';
      const parts = [];
      if (user) {
        const body = user.querySelector('[data-testid="user-message"]');
        if (body) parts.push({kind: 'text', value: all(body, 'p.whitespace-pre-wrap').map(p => text(p)).join('\n\n') || renderDom(body)});
        else warnings.push('Claude: user message body missing.');
      } else {
        const nodes = all(assistant, '[data-cds="TurnStatus"], [data-testid="tool-cell-row"], [data-cds="Prose"]');
        for (const node of nodes) {
          if (node.closest('[data-cds="TurnStatus"]') && !node.matches('[data-cds="TurnStatus"]')) continue;
          if (node.matches('[data-cds="TurnStatus"]')) {
            const steps = all(node, '[data-cds="TurnStatusStep"]');
            if (!steps.length) parts.push({kind: 'event', label: text(node.querySelector('[id$="-text"]')) || 'Status'});
            for (const step of steps) {
              const header = step.querySelector('[class~="group/step"]');
              const label = text(header?.querySelector('[id$="-label"]')) || text(header?.querySelector('[id$="-text"]'));
              const title = header?.getAttribute('title') || '';
              const panel = step.querySelector(':scope > [data-cds-row-panel]');
              const expanded = header?.querySelector('button[aria-expanded]');
              if (expanded?.getAttribute('aria-expanded') === 'false') warnings.push(`Claude: step still collapsed (${step.getAttribute('data-step-key')}).`);
              if (panel?.querySelector('[data-testid="tool-param-truncated-note"]')) warnings.push(`Claude: tool data truncated (${step.getAttribute('data-step-key')}).`);
              const state = step.getAttribute('data-state');
              const value = [state ? `**State:** ${state}` : '', panel ? renderDom(panel) : '', title && title !== label ? `**Detail:** ${title}` : ''].filter(Boolean).join('\n\n');
              parts.push({kind: panel?.querySelector('code.language-bash') ? 'command' : expanded ? 'tool' : 'step', label, value});
            }
          } else if (node.matches('[data-testid="tool-cell-row"]')) {
            const parent = node.parentElement;
            const label = text(node.firstElementChild?.children[1]);
            parts.push({kind: 'tool', label, value: [...(parent?.children || [])].filter(el => el !== node).map(el => renderDom(el)).filter(Boolean).join('\n\n')});
          } else if (node.matches('[data-cds="Prose"]')) {
            const value = renderDom(node.querySelector('.standard-markdown') || node);
            if (value) parts.push({kind: 'text', value});
          }
        }
      }
      if (!parts.length) warnings.push(`Claude: unsupported content in message ${this.key(row)}.`);
      return {id: this.key(row), role, timestamp: root.querySelector('time[datetime]')?.getAttribute('datetime') || null, parts};
    }
  };

  const chatgpt = {
    root() {
      const active = all(document, '[data-app-shell-active-page="true"] [data-chatgpt-conversation-selection-target]');
      if (active.length === 1) return active[0];
      if (active.length > 1) throw Error('Multiple active ChatGPT conversations found.');
      const roots = all(document, '[data-chatgpt-conversation-selection-target]');
      if (roots.length === 1) return roots[0];
      if (roots.length > 1) throw Error('No single active ChatGPT conversation identified.');
      return document.querySelector('#thread');
    },
    rows() {
      const root = this.root();
      const modern = all(root, '[data-turn-key]').filter(el => !el.parentElement?.closest('[data-turn-key]'));
      return modern.length ? modern : all(root, '[data-testid^="conversation-turn-"][data-turn][data-turn-id]')
        .filter(el => ['user', 'assistant'].includes(el.getAttribute('data-turn')));
    },
    key: row => row.getAttribute('data-turn-key') || row.getAttribute('data-turn-id'),
    index(row) {
      const match = /^conversation-turn-(\d+)$/.exec(row.getAttribute('data-testid') || '');
      return match ? Number(match[1]) : null;
    },
    toggles() {
      const root = this.root();
      return distinct([
        ...all(root, '[data-turn-key] .text-size-chat.text-secondary > button[aria-expanded="false"]'),
        ...all(root, '[data-turn-key] [data-user-message-bubble="true"] button[aria-expanded="false"][data-markdown-copy="exclude"]'),
        ...all(root, '[data-turn-key] [data-local-conversation-item-target-ids] [class~="group/activity-header"] > button[aria-expanded="false"]'),
        ...all(root, '[data-testid^="conversation-turn-"][data-turn="assistant"] .relative.my-1.min-h-6 button[aria-expanded="false"]')
      ]);
    },
    activity(group, warnings) {
      const headers = all(group, '[class~="group/activity-header"]');
      if (!headers.length) {
        warnings.push('ChatGPT: activity group has no recognizable item headers.');
        return {kind: 'tool', label: 'Agent activity', value: ''};
      }
      const lines = [];
      for (const header of headers) {
        const item = header.parentElement?.parentElement;
        const depth = headers.filter(other => other !== header && other.parentElement?.parentElement?.contains(header)).length;
        const label = compact(header.textContent) || 'Unlabeled activity';
        const button = header.querySelector(':scope > button[aria-expanded]');
        const closed = button?.getAttribute('aria-expanded') === 'false';
        const indent = '  '.repeat(depth);
        lines.push(`${indent}- **${label}**${closed ? ' *(collapsed)*' : ''}`);
        if (closed) {warnings.push(`ChatGPT: activity still collapsed (${label}).`); continue;}
        const detail = header.nextElementSibling;
        if (!detail || !item?.contains(detail)) continue;
        const foreign = node => headers.some(other => other !== header && item.contains(other) && other.parentElement?.parentElement?.contains(node));
        for (const title of all(detail, '.sticky .truncate')) if (!foreign(title) && text(title)) lines.push(`${indent}  **${text(title)}**`);
        for (const pre of all(detail, 'pre')) if (!foreign(pre)) lines.push(indent + fence(pre.textContent));
        for (const md of all(detail, '[data-markdown-text-style="assistant-message"]')) if (!foreign(md)) lines.push(indent + renderDom(md));
        if (detail.querySelector('[aria-expanded="false"]:not(button)')) warnings.push(`ChatGPT: raw-result control closed in ${label}.`);
      }
      return {kind: 'tool', label: 'Agent activity', value: lines.join('\n\n')};
    },
    parse(row, warnings) {
      const id = this.key(row);
      if (!id) return [];
      if (row.hasAttribute('data-turn')) {
        const role = row.getAttribute('data-turn');
        const body = row.querySelector(`[data-message-author-role="${role}"]`);
        if (!body) return [];
        const parts = [];
        if (role === 'user') {
          const el = body.querySelector('[data-testid="collapsible-user-message-content"] .whitespace-pre-wrap, .user-message-bubble-color .whitespace-pre-wrap');
          if (el) parts.push({kind: 'text', value: renderDom(el)});
        } else {
          for (const block of all(row, '.relative.my-1.min-h-6')) {
            const label = text(block.querySelector('.text-token-text-secondary'));
            if (label) parts.push({kind: 'event', label: 'Visible reasoning status', value: label});
            const button = block.querySelector('button[aria-expanded][aria-controls]');
            if (button?.getAttribute('aria-expanded') === 'true') {
              const panel = panelFor(button);
              if (panel) parts.push({kind: 'reasoning', label: 'Visible reasoning summary', value: renderDom(panel)});
            }
          }
          for (const md of all(body, '.markdown.prose')) if (!md.parentElement?.closest('.markdown.prose'))
            parts.push({kind: 'text', value: renderDom(md)});
        }
        return parts.length ? [{id, role, parts, timestamp: row.querySelector('time[datetime]')?.getAttribute('datetime') || null}] : [];
      }

      const userParts = [], assistantParts = [];
      const blocks = all(row, '[data-user-message-bubble="true"], [data-markdown-text-style="assistant-message"], [data-local-conversation-item-target-ids]');
      for (const block of blocks) {
        if (block.closest('[data-local-conversation-item-target-ids]') && !block.matches('[data-local-conversation-item-target-ids]')) continue;
        if (block.matches('[data-user-message-bubble="true"]')) {
          const value = renderDom(block.querySelector('.whitespace-pre-wrap') || block);
          if (value) userParts.push({kind: 'text', value});
        } else if (block.matches('[data-local-conversation-item-target-ids]')) {
          assistantParts.push(this.activity(block, warnings));
        } else {
          const value = renderDom(block);
          if (value) assistantParts.push(block.closest('[data-local-conversation-final-assistant="true"]')
            ? {kind: 'text', value} : {kind: 'step', label: 'Intermediate assistant message', value});
        }
      }
      const filenames = all(row, '[class~="group/resource-card"] .truncate.font-semibold[title]')
        .map(el => el.getAttribute('title')).filter(Boolean);
      if (filenames.length) userParts.push({kind: 'event', label: 'Attachments (names only)', value: filenames.map(x => `- ${x}`).join('\n')});
      const status = row.querySelector('.text-size-chat.text-secondary > button[aria-expanded]');
      if (status) assistantParts.unshift({kind: 'event', label: 'Processing status', value: text(status)});
      const time = row.querySelector('time[datetime]')?.getAttribute('datetime') || null;
      const result = [];
      if (userParts.length) result.push({id: `${id}:user`, role: 'user', timestamp: time, parts: userParts});
      if (assistantParts.length) result.push({id: `${id}:assistant`, role: 'assistant', timestamp: null, parts: assistantParts});
      if (!result.length) warnings.push(`ChatGPT: no hydrated content in turn ${id}.`);
      return result;
    }
  };

  const adapter = PLATFORM === 'mistral' ? mistral : PLATFORM === 'claude' ? claude : chatgpt;
  const unresponsive = new WeakSet();

  async function expand(warnings, limit = 30) {
    for (let pass = 0; pass < limit; pass++) {
      const controls = adapter.toggles().filter(b => b.isConnected && !unresponsive.has(b));
      if (!controls.length) break;
      let changed = false;
      for (const button of controls) {
        if (!button.isConnected || button.getAttribute('aria-expanded') !== 'false') continue;
        // Programmatic clicks work offscreen; scrolling to every button would disrupt virtualization.
        button.click();
        await sleep(PLATFORM === 'chatgpt' ? 160 : 85);
        if (button.getAttribute('aria-expanded') === 'true') changed = true;
        else unresponsive.add(button);
      }
      if (!changed) break;
    }
    const remaining = adapter.toggles().filter(b => b.isConnected);
    if (remaining.length) warnings.push(`${PLATFORM}: ${remaining.length} known controls remain collapsed.`);
  }

  // A Document is not an Element. Never pass document to getComputedStyle.
  function scroller(anchor) {
    if (PLATFORM === 'mistral') {
      const boxes = all(document, '[data-chat-shell-scroll]');
      const active = boxes.find(el => el.querySelector('[data-thread-item-key], [data-message-id][data-message-author-role]'));
      // A saved/static DOM may contain the shell without its scroll CSS.
      // Only use it if it is an actual scroll container.
      if (active && /(auto|scroll)/.test(getComputedStyle(active).overflowY)
          && active.scrollHeight > active.clientHeight + 2) return active;
    }
    let node = anchor?.nodeType === Node.DOCUMENT_NODE ? document.documentElement : anchor;
    while (isElement(node)) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 2) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function scrollAPI(root) {
    const box = scroller(root);
    const doc = [document.documentElement, document.body, document.scrollingElement].includes(box);
    return {
      box,
      top: () => doc ? window.scrollY : box.scrollTop,
      set: value => {if (doc) window.scrollTo(0, value); else box.scrollTop = value;},
      height: () => doc ? window.innerHeight : box.clientHeight,
      maximum: () => Math.max(0, (doc ? document.documentElement.scrollHeight : box.scrollHeight) - (doc ? window.innerHeight : box.clientHeight))
    };
  }

  function score(messages) {
    return messages.reduce((total, m) => total + (m.parts || []).reduce((n, p) => n +
      (p.value?.length || 0) + (p.command?.length || 0) + (p.output?.length || 0) + 10, 0), 0);
  }

  async function captureChatGPT(warnings) {
    const root = chatgpt.root();
    if (!root) throw Error('ChatGPT conversation root not found. Open a conversation first.');
    const scroll = scrollAPI(root);
    const original = scroll.top();
    const collected = new Map(), observed = new Map();
    let stable = 0, lastMax = -1, reachedBottom = false;
    const started = Date.now();
    const harvest = () => {
      for (const row of chatgpt.rows()) {
        const key = chatgpt.key(row);
        if (!key) {warnings.push('ChatGPT: a turn has no stable key.'); continue;}
        observed.set(key, {row, index: chatgpt.index(row)});
        const localWarnings = [];
        const messages = chatgpt.parse(row, localWarnings);
        if (!messages.length) continue;
        const value = score(messages);
        if (!collected.has(key) || value > collected.get(key).score) collected.set(key,
          {messages, score: value, index: chatgpt.index(row), localWarnings});
      }
    };
    try {
      scroll.set(0);
      await sleep(350);
      for (let i = 0; i < 1000 && Date.now() - started < 120000; i++) {
        harvest();
        await expand([]);
        harvest();
        const max = scroll.maximum();
        const bottom = scroll.top() >= max - 2;
        stable = bottom && max === lastMax ? stable + 1 : 0;
        if (stable >= 4) {reachedBottom = true; break;}
        lastMax = max;
        if (!bottom) scroll.set(Math.min(max, scroll.top() + Math.max(250, scroll.height() * 0.65)));
        await sleep(bottom ? 350 : 150);
      }
      harvest();
      for (const [key, {row}] of observed) {
        if (collected.has(key) || !row.isConnected) continue;
        row.scrollIntoView({block: 'center'});
        for (let i = 0; i < 8 && !collected.has(key); i++) {await sleep(200); harvest();}
      }
    } finally {scroll.set(original);}
    if (!observed.size) throw Error('No supported ChatGPT message structure detected.');
    if (!reachedBottom) warnings.push('ChatGPT: bottom of conversation not confirmed.');
    const missing = [...observed.keys()].filter(key => !collected.has(key));
    if (missing.length) warnings.push(`ChatGPT: ${missing.length} unhydrated turn(s): ${missing.slice(0, 6).join(', ')}`);
    const indexed = [...observed.values()].every(v => v.index !== null);
    if (indexed) {
      const indices = [...observed.values()].map(v => v.index);
      const known = new Set(indices);
      for (let i = Math.min(...indices); i <= Math.max(...indices); i++)
        if (!known.has(i)) {warnings.push(`ChatGPT: missing numbered turn ${i}.`); break;}
    } else warnings.push('ChatGPT: sequential turn numbers are unavailable; completeness cannot be proven.');
    const values = [...collected.values()];
    if (indexed) values.sort((a, b) => a.index - b.index);
    for (const x of values) warnings.push(...x.localWarnings);
    if (!values.length) throw Error('ChatGPT turns found, but none had readable content.');
    return values.flatMap(x => x.messages);
  }

  async function captureOthers(warnings) {
    const root = adapter.root();
    if (!root) throw Error(`Conversation root not found for ${PLATFORM}.`);
    const scroll = scrollAPI(root);
    const original = scroll.top();
    const collected = new Map(), forwardOrder = [], ordered = new Set();
    const started = Date.now();
    let reachedTop = false, reachedBottom = false;

    function harvest(forward) {
      for (const row of adapter.rows()) {
        const key = adapter.key(row);
        if (!key) {warnings.push(`${PLATFORM}: a visible message has no stable key.`); continue;}
        if (forward && !ordered.has(key)) {ordered.add(key); forwardOrder.push(key);}
        const localWarnings = [];
        let parsed;
        try {parsed = adapter.parse(row, localWarnings);}
        catch (e) {warnings.push(`${PLATFORM}: message ${key} could not be parsed: ${e.message}`); continue;}
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        const richness = score(messages);
        if (!collected.has(key) || richness > collected.get(key).richness) {
          collected.set(key, {messages, richness, index: adapter.index(row), end: row.hasAttribute('data-last-message'), localWarnings});
        }
      }
    }

    try {
      // Capture on the way up too: virtualized messages can disappear later.
      let stable = 0, lastMax = -1;
      for (let i = 0; i < 900 && Date.now() - started < 60000; i++) {
        harvest(false);
        const current = scroll.top();
        const max = scroll.maximum();
        if (current <= 2) {
          stable = lastMax === max ? stable + 1 : 0;
          if (stable >= 5) {reachedTop = true; break;}
          await sleep(250);
        } else {
          stable = 0;
          scroll.set(Math.max(0, current - Math.max(240, scroll.height() * 0.7)));
          await sleep(130);
        }
        lastMax = max;
      }
      // Start at the oldest loaded page, then move down and expand groups.
      scroll.set(0);
      await sleep(300);
      let stableBottom = 0, lastMaxBottom = -1;
      for (let i = 0; i < 1200 && Date.now() - started < 120000; i++) {
        harvest(true);
        await expand([]);
        harvest(true);
        const max = scroll.maximum();
        const bottom = scroll.top() >= max - 2;
        stableBottom = bottom && max === lastMaxBottom ? stableBottom + 1 : 0;
        if (stableBottom >= 4) {reachedBottom = true; break;}
        lastMaxBottom = max;
        if (!bottom) scroll.set(Math.min(max, scroll.top() + Math.max(240, scroll.height() * 0.60)));
        await sleep(bottom ? 300 : 160);
      }
      harvest(true);
    } finally {scroll.set(original);}

    if (!collected.size) throw Error(`No readable ${PLATFORM} messages found.`);
    if (!reachedTop) warnings.push(`${PLATFORM}: start of conversation was not verified.`);
    if (!reachedBottom) warnings.push(`${PLATFORM}: stable end of conversation was not verified.`);
    const entries = [...collected.entries()];
    if (PLATFORM === 'claude') {
      entries.sort((a, b) => (a[1].index ?? Infinity) - (b[1].index ?? Infinity));
      const indices = entries.map(([, data]) => data.index);
      if (indices.some(x => x === null)) warnings.push('Claude: some transcript rows have no numeric data-index.');
      if (indices.length && indices.every(x => x !== null)) {
        const seen = new Set(indices);
        for (let i = 0; i <= Math.max(...indices); i++) if (!seen.has(i)) {
          warnings.push(`Claude: missing transcript row at data-index=${i}.`); break;
        }
      }
      if (!entries.some(([, data]) => data.end)) warnings.push('Claude: final-message marker not found.');
    } else {
      // Mistral IDs aren't sequential. The second (forward) pass gives DOM order.
      const positions = new Map(forwardOrder.map((key, i) => [key, i]));
      entries.sort((a, b) => (positions.get(a[0]) ?? Infinity) - (positions.get(b[0]) ?? Infinity));
      const unmatched = entries.filter(([key]) => !positions.has(key));
      if (unmatched.length) warnings.push(`Mistral: ${unmatched.length} message(s) were seen only during backward scrolling; placement is uncertain.`);
      warnings.push('Mistral: stable sequential message numbers are not exposed; complete history cannot be proven.');
    }
    for (const [, data] of entries) warnings.push(...data.localWarnings);
    return entries.flatMap(([, data]) => data.messages);
  }

  // ChatGPT subagents are exposed in the right panel, not in transcript turns.
  const subagentPanel = () => document.querySelector(
    'aside [role="tabpanel"][aria-label="Subagenci"][data-app-shell-tab-panel-controller="right"]'
  );
  const subagentButtons = () => all(
    subagentPanel(), '[data-slot="thread-summary-panel-item-group"] > button'
  );
  const subagentBack = () => subagentPanel()?.querySelector(
    'button[aria-label="Powrót do subagentów"]'
  );

  function subagentName(button) {
    const leaf = all(button, 'span').find(el =>
      !el.children.length && compact(el.textContent));
    return compact(leaf?.textContent) || compact(button.textContent) || 'Unnamed subagent';
  }

  function subagentStatus(button, name) {
    const leafTexts = all(button, 'span').filter(el => !el.children.length)
      .map(el => compact(el.textContent)).filter(Boolean);
    return leafTexts.filter(value => value !== name).pop() || '';
  }

  function subagentFinalSection() {
    return all(subagentPanel(), 'section').find(section =>
      /^(odpowiedź końcowa|final answer)$/i.test(text(section.querySelector('h2')))
    ) || null;
  }

  async function waitFor(predicate, timeout = 7000) {
    const deadline = Date.now() + timeout;
    do {
      const item = predicate();
      if (item) return item;
      await sleep(140);
    } while (Date.now() < deadline);
    return null;
  }

  // A final-answer section is created before its content is hydrated.
  // Wait for the actual answer or for a terminal UI message, not the heading.
  // A "no final answer" message can precede delayed hydration.
  // Keep watching for a real response before treating it as unavailable.
  async function waitForSubagentAnswer(timeout = 120000) {
    const deadline = Date.now() + timeout;
    let candidate = null, candidateSince = 0;
    let lastMessage = '';
    while (Date.now() < deadline) {
      const section = subagentFinalSection();
      if (section) {
        const body = section.querySelector('h2')?.nextElementSibling || section;
        const content = body.querySelector('[data-markdown-text-style="assistant-message"]');
        const contentText = compact(content?.textContent);
        const status = compact(body.textContent);
        if (status) lastMessage = status;

        // The placeholder is plain text; do not mistake it for an answer.
        const loading = /^(?:wczytywanie|ładowanie|pobieranie|loading|fetching)\b/i.test(status);
        // The exact no-answer text can vary. Only clear absence/error
        // messages are terminal; other interim messages keep us waiting.
        const unavailable = /brak|nie\s+(?:znalezion|udało|ma\b)|niedostępn|missing|unavailable|not found|not available|failed|no\s+(?:final|answer|response)/i.test(status);
        // "Brak odpowiedzi końcowej." is definitive in the ChatGPT UI.
        // Do not wait for hydration or a stability grace period in this state.
        if (!contentText && !loading && unavailable) {
          return {state: 'unavailable', answer: '', note: status};
        }

        const fingerprint = contentText && !loading ? 'answer:' + contentText : null;
        if (fingerprint !== candidate) {
          candidate = fingerprint;
          candidateSince = Date.now();
        } else if (fingerprint && Date.now() - candidateSince >= 800) {
          const answer = clean(renderDom(content));
          if (answer) return {state: 'answer', answer, note: ''};
        }
      } else {
        candidate = null;
      }
      await sleep(180);
    }
    return {state: 'timeout', answer: '', note: lastMessage};
  }

  async function captureChatGPTSubagents(warnings) {
    if (PLATFORM !== 'chatgpt') return [];
    const trigger = all(document, 'button[data-slot="thread-summary-panel-item-button"]')
      .find(button => text(button.querySelector('[data-marquee-content]')) === 'Agenty podrzędne');
    const alreadyOpen = Boolean(subagentPanel());
    if (!trigger && !alreadyOpen) return [];

    let opened = false;
    const found = [];
    const count = Number(
      text(trigger?.querySelector('[data-slot="thread-summary-panel-item-meta"]')).match(/\d+/)?.[0] || 0
    );
    try {
      if (!alreadyOpen) {
        trigger.click();
        opened = true;
      }
      if (!await waitFor(subagentPanel, 8000)) {
        warnings.push('ChatGPT: the Subagents panel did not open.');
        return found;
      }

      // Restore the list if a subagent was already selected by the user.
      const initialBack = subagentBack();
      const originalName = initialBack
        ? compact(initialBack.parentElement?.querySelector('span')?.textContent) : '';
      if (initialBack) {
        initialBack.click();
        await waitFor(() => subagentButtons().length > 0, 6000);
      }
      await waitFor(() => subagentPanel()?.querySelector('[data-app-shell-pane-content-viewport="true"]'), 5000);
      await sleep(300);
      const listed = subagentButtons();
      if (count > listed.length) warnings.push(
        'ChatGPT: summary reports ' + count + ' subagents, but only ' +
        listed.length + ' were listed.');
      if (!listed.length) return found;

      const counts = new Map();
      const tasks = listed.map((button, position) => {
        const name = subagentName(button);
        const occurrence = counts.get(name) || 0;
        counts.set(name, occurrence + 1);
        return {name, position, occurrence, status: subagentStatus(button, name)};
      });

      for (const task of tasks) {
        if (subagentBack()) {
          subagentBack().click();
          await waitFor(() => subagentButtons().length > 0, 6000);
        }
        const current = subagentButtons();
        let button = current[task.position];
        if (!button || subagentName(button) !== task.name) {
          button = current.filter(b => subagentName(b) === task.name)[task.occurrence];
        }
        if (!button) {
          warnings.push('ChatGPT: missing subagent in the list: ' + task.name);
          found.push({...task, answer: ''});
          continue;
        }

        button.click();
        if (!await waitFor(() => subagentBack() && subagentPanel(), 8000)) {
          warnings.push('ChatGPT: could not open subagent: ' + task.name);
          found.push({...task, answer: ''});
          continue;
        }
        const final = await waitForSubagentAnswer();
        if (final.state === 'timeout') {
          warnings.push('ChatGPT: timed out waiting for final answer from ' + task.name +
            (final.note ? ' (last UI message: ' + final.note + ')' : ''));
        } else if (final.state === 'unavailable') {
          warnings.push('ChatGPT: final answer unavailable for ' + task.name + ': ' + final.note);
        }
        found.push({...task, answer: final.answer, answerState: final.state, answerNote: final.note});

        const back = subagentBack();
        if (back) {
          back.click();
          if (!await waitFor(() => subagentButtons().length > 0, 7000)) {
            warnings.push('ChatGPT: could not return to list after ' + task.name);
            break;
          }
        }
      }

      if (!opened && originalName && !subagentBack()) {
        const original = subagentButtons().find(b => subagentName(b) === originalName);
        if (original) original.click();
      }
      return found;
    } finally {
      // Leave existing panels alone; close only one opened for this export.
      if (opened) {
        if (subagentBack()) {
          subagentBack().click();
          await waitFor(() => subagentButtons().length > 0, 3000);
        }
        subagentPanel()?.closest('aside')?.querySelector('button[aria-label="Zamknij panel"]')?.click();
      }
    }
  }

  function download(value) {
    const filename = `${(document.title || 'chat').replace(/[\\/:*?"<>|]/g, '').slice(0, 80)}_${PLATFORM}_${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
    const url = URL.createObjectURL(new Blob([value], {type: 'text/markdown;charset=utf-8'}));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function run(button) {
    button.disabled = true;
    button.textContent = 'Expanding and exporting…';
    try {
      const warnings = [];
      let plan = mistralPlan(warnings);
      const messages = PLATFORM === 'chatgpt' ? await captureChatGPT(warnings) : await captureOthers(warnings);
      // The main conversation must be read before opening the subagent panel.
      let subagents = [];
      if (PLATFORM === 'chatgpt') {
        try {subagents = await captureChatGPTSubagents(warnings);}
        catch (error) {warnings.push('ChatGPT: subagent capture failed: ' + error.message);}
      }
      // Re-read after scrolling in case the task statuses changed during export.
      if (PLATFORM === 'mistral') plan = mistralPlan(warnings) || plan;
      let result = writeMarkdown(messages, warnings, plan, subagents);
      try {await navigator.clipboard.writeText(result);}
      catch {warnings.push('Clipboard copy failed; the downloaded Markdown remains available.'); result = writeMarkdown(messages, warnings, plan, subagents);}
      download(result);
      button.textContent = warnings.length ? 'Exported (warnings in MD)' : 'Exported MD';
      console.info('[Chat transcript]', {version: VERSION, platform: PLATFORM, messages: messages.length, planTasks: plan?.tasks.length || 0, subagents: subagents.length, warnings: distinct(warnings)});
    } catch (error) {
      console.error('[Chat transcript] Export failed:', error);
      button.textContent = 'Export failed (console)';
    } finally {
      setTimeout(() => {button.disabled = false; button.textContent = 'Expand + Export MD';}, 4000);
    }
  }

  function init() {
    // ChatGPT can replace DOM nodes it does not own during client-side navigation.
    // Mount outside the app's body subtree and restore the host if it is removed.
    const hostId = 'tm-chat-md-export-host';
    if (document.getElementById(hostId)) return;
    const host = document.createElement('div');
    host.id = hostId;
    Object.assign(host.style, {
      position: 'fixed', right: '18px', bottom: '18px',
      zIndex: '2147483647', pointerEvents: 'none'
    });
    // Shadow DOM isolates the control from ChatGPT's changing styles.
    const shadow = host.attachShadow({mode: 'open'});
    const button = document.createElement('button');
    button.id = 'tm-chat-md-export';
    button.type = 'button';
    button.textContent = 'Expand + Export MD';
    Object.assign(button.style, {
      padding: '10px 14px', background: '#0b74de', color: '#fff', border: '0',
      borderRadius: '7px', cursor: 'pointer', font: '13px system-ui',
      pointerEvents: 'auto'
    });
    button.addEventListener('click', () => run(button));
    shadow.appendChild(button);

    const mount = () => {
      if (!host.isConnected && document.documentElement) {
        document.documentElement.appendChild(host);
      }
    };
    mount();

    // Observing the document (rather than just the old body) also survives
    // body replacement. Reinsert only when detached to avoid mutation loops.
    const observer = new MutationObserver(() => {
      if (!host.isConnected) mount();
    });
    observer.observe(document, {childList: true, subtree: true});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once: true});
  else init();

  // Read-only inspection helpers (never trigger export or clicks).
  window.TMChatExport = {
    version: VERSION, platform: PLATFORM,
    collectVisible: () => adapter.rows().flatMap(row => {
      const parsed = adapter.parse(row, []);
      return Array.isArray(parsed) ? parsed : [parsed].filter(Boolean);
    }),
    taskPlan: () => mistralPlan([]),
    toMarkdown: writeMarkdown
  };
})();