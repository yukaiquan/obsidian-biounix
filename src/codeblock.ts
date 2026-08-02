/**
 * 代码块处理器 — 在 Markdown 中嵌入 BioUnix 命令
 *
 * 用法：
 * ```biounix
 * run: samtools view -c sample.bam
 * cwd: /path/to/project
 * ```
 *
 * 点击"执行"时弹出 session 选择面板：
 * - 选择已有会话 → 通过 Agent 发送命令（支持多会话切换）
 * - 选择"直接执行" → 不经 Agent，直接 runCommand
 * - 选择"新建会话" → 创建新 session 再发送
 */
import { MarkdownRenderChild } from 'obsidian';
import type BioUnixPlugin from './main';

interface ParsedBlock {
  command?: string;
  args?: string[];
  cwd?: string;
  raw: string;
}

interface SessionInfo {
  id: string;
  name?: string;
  mode?: string;
  model?: string | null;
  startedAt?: number;
  updated_at?: number;
}

function parseCodeBlock(source: string): ParsedBlock {
  const lines = source.split('\n');
  const parsed: ParsedBlock = { raw: source };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('run:')) {
      const cmdLine = trimmed.slice(4).trim();
      const parts = cmdLine.split(/\s+/);
      parsed.command = parts[0];
      parsed.args = parts.slice(1);
    } else if (trimmed.startsWith('cwd:')) {
      parsed.cwd = trimmed.slice(4).trim();
    }
  }
  return parsed;
}

export class BioUnixCodeBlock extends MarkdownRenderChild {
  private plugin: BioUnixPlugin;
  private source: string;

  constructor(containerEl: HTMLElement, source: string, plugin: BioUnixPlugin) {
    super(containerEl);
    this.source = source;
    this.plugin = plugin;
  }

  onload(): void {
    const parsed = parseCodeBlock(this.source);
    if (!parsed.command) {
      this.containerEl.createEl('div', {
        text: '⚠️ BioUnix 代码块缺少 run: 指令',
        cls: 'biounix-codeblock-error',
      });
      return;
    }

    const card = this.containerEl.createDiv({ cls: 'biounix-codeblock' });

    // 命令展示
    const cmdLine = card.createDiv({ cls: 'biounix-codeblock-cmd' });
    cmdLine.createEl('code', { text: `${parsed.command} ${(parsed.args || []).join(' ')}` });
    if (parsed.cwd) {
      cmdLine.createEl('span', { text: `📁 ${parsed.cwd}`, cls: 'biounix-codeblock-cwd' });
    }

    // 按钮行
    const btnRow = card.createDiv({ cls: 'biounix-codeblock-btnrow' });
    const execBtn = btnRow.createEl('button', { text: '▶ 执行', cls: 'biounix-codeblock-btn' });
    const resultEl = card.createDiv({ cls: 'biounix-codeblock-result is-hidden' });

    execBtn.onclick = async () => {
      execBtn.disabled = true;
      execBtn.setText('⏳ 加载会话...');

      // 加载会话列表
      let sessions: SessionInfo[] = [];
      try {
        const res = await this.plugin.api.listSessions();
        if (res.ok && res.sessions) {
          sessions = res.sessions;
        }
      } catch { /* 忽略，走直接执行 */ }

      execBtn.disabled = false;
      execBtn.setText('▶ 执行');

      // 弹出 session 选择面板
      this.showSessionPicker(card, parsed, sessions, resultEl, execBtn);
    };
  }

  /** 显示 session 选择面板 */
  private showSessionPicker(
    card: HTMLElement,
    parsed: ParsedBlock,
    sessions: SessionInfo[],
    resultEl: HTMLElement,
    execBtn: HTMLButtonElement,
  ): void {
    // 移除已有的选择面板
    card.querySelector('.biounix-session-picker')?.remove();

    const picker = card.createDiv({ cls: 'biounix-session-picker' });

    // 标题
    picker.createEl('div', {
      text: '选择执行方式 / 会话',
      cls: 'biounix-session-picker-title',
    });

    // 选项列表
    const list = picker.createDiv({ cls: 'biounix-session-list' });

    // 选项 1：直接执行（不经 Agent）
    const directItem = list.createDiv({ cls: 'biounix-session-item biounix-session-direct' });
    directItem.createEl('span', { text: '⚡ 直接执行', cls: 'biounix-session-name' });
    directItem.createEl('span', { text: '不经 Agent，直接运行命令', cls: 'biounix-session-desc' });
    directItem.onclick = () => {
      picker.remove();
      this.executeDirect(parsed, resultEl, execBtn);
    };

    // 选项 2：新建会话
    const newItem = list.createDiv({ cls: 'biounix-session-item biounix-session-new' });
    newItem.createEl('span', { text: '✨ 新建会话', cls: 'biounix-session-name' });
    newItem.createEl('span', { text: '创建新 Agent 会话并执行', cls: 'biounix-session-desc' });
    newItem.onclick = () => {
      picker.remove();
      this.executeViaNewSession(parsed, resultEl, execBtn);
    };

    // 分隔线
    if (sessions.length > 0) {
      list.createEl('div', { cls: 'biounix-session-divider' });
      list.createEl('div', {
        text: `已有会话（${sessions.length}）`,
        cls: 'biounix-session-group-label',
      });

      // 列出已有会话（最多 10 个，按更新时间倒序）
      const sorted = sessions
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
        .slice(0, 10);

      for (const sess of sorted) {
        const item = list.createDiv({ cls: 'biounix-session-item' });
        const nameEl = item.createDiv({ cls: 'biounix-session-item-header' });
        nameEl.createEl('span', {
          text: sess.name || `Session ${sess.id.slice(0, 8)}`,
          cls: 'biounix-session-name',
        });
        // 模式标签
        const modeBadge = nameEl.createEl('span', {
          text: sess.mode === 'agent' ? 'Agent' : 'Chat',
          cls: `biounix-session-mode biounix-session-mode-${sess.mode}`,
        });
        // 模型
        if (sess.model) {
          nameEl.createEl('span', {
            text: sess.model,
            cls: 'biounix-session-model',
          });
        }
        // ID
        item.createEl('span', {
          text: `ID: ${sess.id.slice(0, 8)}...`,
          cls: 'biounix-session-id',
        });

        item.onclick = () => {
          picker.remove();
          this.executeViaSession(parsed, sess, resultEl, execBtn);
        };
      }
    }

    // 取消按钮
    const cancelRow = picker.createDiv({ cls: 'biounix-session-cancel-row' });
    const cancelBtn = cancelRow.createEl('button', {
      text: '取消',
      cls: 'biounix-session-cancel-btn',
    });
    cancelBtn.onclick = () => picker.remove();
  }

  /** 直接执行（不经 Agent） */
  private async executeDirect(
    parsed: ParsedBlock,
    resultEl: HTMLElement,
    execBtn: HTMLButtonElement,
  ): Promise<void> {
    execBtn.disabled = true;
    execBtn.setText('⏳ 执行中...');
    resultEl.addClass('is-hidden');
    resultEl.empty();

    try {
      const res = await this.plugin.api.runCommand(
        parsed.command!,
        parsed.args || [],
        parsed.cwd,
      );
      execBtn.disabled = false;
      execBtn.setText('▶ 重新执行');
      resultEl.removeClass('is-hidden');
      if (res.ok) {
        const output = res.result?.stdout || res.result?.stderr || '(无输出)';
        const exitCode = res.result?.exit_code;
        const header = exitCode !== undefined ? `[exit: ${exitCode}]\n` : '';
        resultEl.createEl('pre', {
          text: header + output,
          cls: 'biounix-codeblock-output',
        });
      } else {
        resultEl.createEl('pre', { text: `❌ ${res.error}`, cls: 'biounix-codeblock-error' });
      }
    } catch (e) {
      execBtn.disabled = false;
      execBtn.setText('▶ 重试');
      resultEl.removeClass('is-hidden');
      resultEl.createEl('pre', {
        text: `❌ ${(e as Error).message}`,
        cls: 'biounix-codeblock-error',
      });
    }
  }

  /** 通过已有会话发送命令 */
  private async executeViaSession(
    parsed: ParsedBlock,
    session: SessionInfo,
    resultEl: HTMLElement,
    execBtn: HTMLButtonElement,
  ): Promise<void> {
    execBtn.disabled = true;
    execBtn.setText(`⏳ 发送到 ${session.name?.slice(0, 20) || session.id.slice(0, 8)}...`);
    resultEl.addClass('is-hidden');
    resultEl.empty();

    try {
      const cmdText = `${parsed.command} ${(parsed.args || []).join(' ')}`;
      const cwdHint = parsed.cwd ? `\n\n工作目录: ${parsed.cwd}` : '';
      const message = `请执行以下命令：\n\n\`\`\`bash\n${cmdText}\n\`\`\`${cwdHint}`;

      const res = await this.plugin.api.sendMessage(session.id, message);
      execBtn.disabled = false;
      execBtn.setText('▶ 重新执行');
      resultEl.removeClass('is-hidden');

      if (res.ok) {
        resultEl.createEl('div', {
          text: `✅ 已发送到会话「${session.name || session.id.slice(0, 8)}」`,
          cls: 'biounix-codeblock-sent',
        });
        resultEl.createEl('div', {
          text: '💡 结果将通过 WebSocket 实时推送，请查看 BioUnix 侧边栏',
          cls: 'biounix-codeblock-hint',
        });
      } else {
        resultEl.createEl('pre', { text: `❌ ${res.error}`, cls: 'biounix-codeblock-error' });
      }
    } catch (e) {
      execBtn.disabled = false;
      execBtn.setText('▶ 重试');
      resultEl.removeClass('is-hidden');
      resultEl.createEl('pre', {
        text: `❌ ${(e as Error).message}`,
        cls: 'biounix-codeblock-error',
      });
    }
  }

  /** 新建会话并发送命令 */
  private async executeViaNewSession(
    parsed: ParsedBlock,
    resultEl: HTMLElement,
    execBtn: HTMLButtonElement,
  ): Promise<void> {
    execBtn.disabled = true;
    execBtn.setText('⏳ 创建会话...');
    resultEl.addClass('is-hidden');
    resultEl.empty();

    try {
      const cmdText = `${parsed.command} ${(parsed.args || []).join(' ')}`;
      const sessionName = `CMD: ${cmdText.slice(0, 40)}`;
      const workspace = parsed.cwd ? { kind: 'local' as const, path: parsed.cwd } : undefined;

      const createRes = await this.plugin.api.createSession({
        name: sessionName,
        mode: this.plugin.settings.defaultMode,
        workspace,
      });

      if (!createRes.ok || !createRes.session) {
        resultEl.removeClass('is-hidden');
        resultEl.createEl('pre', {
          text: `❌ 创建会话失败: ${createRes.error}`,
          cls: 'biounix-codeblock-error',
        });
        execBtn.disabled = false;
        execBtn.setText('▶ 重试');
        return;
      }

      const sessionId = createRes.session.id;
      const cwdHint = parsed.cwd ? `\n\n工作目录: ${parsed.cwd}` : '';
      const message = `请执行以下命令：\n\n\`\`\`bash\n${cmdText}\n\`\`\`${cwdHint}`;

      const sendRes = await this.plugin.api.sendMessage(sessionId, message);
      execBtn.disabled = false;
      execBtn.setText('▶ 重新执行');
      resultEl.removeClass('is-hidden');

      if (sendRes.ok) {
        resultEl.createEl('div', {
          text: `✅ 已创建新会话并执行`,
          cls: 'biounix-codeblock-sent',
        });
        resultEl.createEl('div', {
          text: `会话: ${sessionName} (${sessionId.slice(0, 8)})`,
          cls: 'biounix-codeblock-hint',
        });
        resultEl.createEl('div', {
          text: '💡 结果将通过 WebSocket 实时推送，请查看 BioUnix 侧边栏',
          cls: 'biounix-codeblock-hint',
        });
      } else {
        resultEl.createEl('pre', { text: `❌ ${sendRes.error}`, cls: 'biounix-codeblock-error' });
      }
    } catch (e) {
      execBtn.disabled = false;
      execBtn.setText('▶ 重试');
      resultEl.removeClass('is-hidden');
      resultEl.createEl('pre', {
        text: `❌ ${(e as Error).message}`,
        cls: 'biounix-codeblock-error',
      });
    }
  }
}
