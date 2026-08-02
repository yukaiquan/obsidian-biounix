/**
 * 侧边栏视图 — BioUnix Agent 聊天界面
 */
import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type BioUnixPlugin from './main';

export const BIOUNIX_CHAT_VIEW_TYPE = 'biounix-chat-view';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export class BioUnixChatView extends ItemView {
  private plugin: BioUnixPlugin;
  private messages: ChatMessage[] = [];
  private messageEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private sessionId: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: BioUnixPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return BIOUNIX_CHAT_VIEW_TYPE; }
  getDisplayText(): string { return 'BioUnix Agent'; }
  getIcon(): string { return 'flask-conical'; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('biounix-chat-view');

    // 标题栏
    const header = container.createDiv({ cls: 'biounix-chat-header' });
    header.createEl('span', { text: '🧬 BioUnix Agent' });

    // 会话选择按钮
    const sessionBtn = header.createEl('button', { text: '新建会话', cls: 'biounix-chat-new-btn' });
    sessionBtn.onclick = () => this.createSession();

    // 消息列表
    this.messageEl = container.createDiv({ cls: 'biounix-chat-messages' });
    this.renderMessages();

    // 输入区域
    const inputArea = container.createDiv({ cls: 'biounix-chat-input-area' });
    this.inputEl = inputArea.createEl('textarea', {
      cls: 'biounix-chat-input',
      attr: { placeholder: '输入消息，Enter 发送，Shift+Enter 换行...', rows: '3' },
    });

    const sendBtn = inputArea.createEl('button', { text: '发送', cls: 'biounix-chat-send-btn' });
    sendBtn.onclick = () => this.sendMessage();

    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    // 自动创建会话
    if (this.plugin.settings.autoConnect) {
      await this.createSession();
    }
  }

  private async createSession(): Promise<void> {
    try {
      const res = await this.plugin.api.createSession({
        mode: this.plugin.settings.defaultMode,
      });
      if (res.ok && res.session) {
        this.sessionId = res.session.id;
        this.messages = [];
        this.renderMessages();
        this.messageEl?.createEl('div', {
          text: `✅ 会话已创建 (${this.sessionId!.slice(0, 8)})`,
          cls: 'biounix-chat-notice',
        });
      }
    } catch (e) {
      this.messageEl?.createEl('div', {
        text: `❌ 创建会话失败: ${(e as Error).message}`,
        cls: 'biounix-chat-error',
      });
    }
  }

  private async sendMessage(): Promise<void> {
    if (!this.inputEl || !this.sessionId) {
      new Notice('请先创建会话');
      return;
    }
    const text = this.inputEl.value.trim();
    if (!text) return;

    this.messages.push({ role: 'user', content: text, timestamp: Date.now() });
    this.inputEl.value = '';
    this.renderMessages();

    // 添加占位的 assistant 消息
    const assistantMsg: ChatMessage = { role: 'assistant', content: '⏳ 思考中...', timestamp: Date.now() };
    this.messages.push(assistantMsg);
    this.renderMessages();

    try {
      await this.plugin.api.sendMessage(this.sessionId, text);
      // 结果通过 WebSocket 流式推送，这里不等待
      // assistantMsg.content 会在 WS 事件中更新
    } catch (e) {
      assistantMsg.content = `❌ 发送失败: ${(e as Error).message}`;
      this.renderMessages();
    }
  }

  /** WebSocket 回调：更新最后一条 assistant 消息 */
  onStreamChunk(content: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'assistant') {
      last.content = content;
      this.renderMessages();
    }
  }

  onStreamDone(): void {
    // 流式结束，可选加载完整消息
    if (this.sessionId) {
      this.plugin.api.getMessages(this.sessionId).then(res => {
        if (res.ok && res.messages) {
          this.messages = res.messages.map((m: any) => ({
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
          }));
          this.renderMessages();
        }
      }).catch(() => { /* ignore */ });
    }
  }

  private renderMessages(): void {
    if (!this.messageEl) return;
    this.messageEl.empty();

    for (const msg of this.messages) {
      const bubble = this.messageEl.createDiv({
        cls: `biounix-chat-bubble biounix-chat-${msg.role}`,
      });
      bubble.createEl('div', {
        text: msg.content,
        cls: 'biounix-chat-content',
      });
      const time = new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
      bubble.createEl('div', { text: time, cls: 'biounix-chat-time' });
    }

    // 滚动到底部
    this.messageEl.scrollTop = this.messageEl.scrollHeight;
  }

  async onClose(): Promise<void> {
    // 清理
  }
}
