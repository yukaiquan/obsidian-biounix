/**
 * 侧边栏视图 — BioUnix Agent 聊天界面
 */
import { ItemView, Notice, WorkspaceLeaf, MarkdownRenderer, Component, setIcon, Modal } from 'obsidian';
import type BioUnixPlugin from './main';
import type { BioUnixMessage, BioUnixSession } from './api';
import { CreateSessionModal, type CreateSessionInput } from './create-session-modal';
import { NoteBrowserModal } from './note-browser-modal';
import { InteractionModal, type InteractionRequest } from './interaction-modal';

// Obsidian 桌面端运行在 Electron，可用 Node.js API（isDesktopOnly: true）
import * as nodeOs from 'os';

/** 格式化字节数为人类可读 */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 格式化运行时长（秒）为人类可读 */
function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  return `${m}分`;
}

export const BIOUNIX_CHAT_VIEW_TYPE = 'biounix-chat-view';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  /** 关联的工具调用（assistant 消息可附带多个工具调用卡片） */
  toolCalls?: ToolCallInfo[];
  /** 模型思维链（可选，折叠展示） */
  reasoning?: string;
}

/** 工具调用信息（用于渲染文件改动卡片） */
interface ToolCallInfo {
  toolCallId: string;
  toolName: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  args?: string;      // JSON 字符串
  result?: string;    // JSON 字符串
  timestamp: number;
  startTime?: number;  // F5 时间线：开始时间
  duration?: number;   // F5 时间线：耗时(ms)
}

/** 文件编辑类工具集合 */
const FILE_EDIT_TOOLS = new Set(['edit_file', 'write_file']);

export class BioUnixChatView extends ItemView {
  private plugin: BioUnixPlugin;
  private messages: ChatMessage[] = [];
  private messageEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private sessionId: string | null = null;
  /** 当前会话的显示信息（provider/model/mode/workspaceKind） */
  private sessionInfo: { provider: string; model: string; mode: string; workspaceKind: 'local' | 'remote' | 'wsl' } | null = null;
  private sessionName: string = '';
  private slashMenu: SlashMenu | null = null;
  /** 会话列表面板元素 */
  private sessionPanelEl: HTMLElement | null = null;
  /** 消息搜索状态 */
  private searchMode = false;
  private searchQuery = '';
  private searchMatches: number[] = [];
  private searchCursor = -1;
  private statusEl: HTMLElement | null = null;
  /** 用于 MarkdownRenderer 的组件生命周期管理 */
  private mdComponent: Component | null = null;
  /** 是否正在流式接收 */
  private streaming = false;
  /** 正在显示的交互请求 tool_call_id 集合（防止重复弹窗） */
  private activeInteractionIds: Set<string> = new Set();
  /** 发送按钮元素（streaming 时切换为“停止”按钮） */
  private sendBtnEl: HTMLButtonElement | null = null;
  /** rAF 节流句柄（流式渲染时合并同帧多次 chunk） */
  private renderRaf: number | null = null;
  /** 流式时最后一条 assistant 消息的内容容器（增量更新用，避免全量重建） */
  private streamingContentEl: HTMLElement | null = null;
  /** 流式时最后一条 assistant 消息的思维链容器 */
  private streamingReasonEl: HTMLElement | null = null;
  /** 流式时最后一条 assistant 的 markdown 渲染容器（流式结束后才做 MarkdownRenderer） */
  private streamingMdEl: HTMLElement | null = null;
  /** 全量渲染后每条消息 bubble 的 DOM 引用（增量更新/搜索定位用） */
  private bubbleEls: HTMLElement[] = [];

  constructor(leaf: WorkspaceLeaf, plugin: BioUnixPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return BIOUNIX_CHAT_VIEW_TYPE; }
  getDisplayText(): string { return 'BioUnix'; }
  getIcon(): string { return 'flask-conical'; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('biounix-chat-view');

    // 初始化 Markdown 渲染组件
    this.mdComponent = new Component();
    this.mdComponent.load();

    // 标题栏
    const header = container.createDiv({ cls: 'biounix-chat-header' });
    const headerLeft = header.createDiv({ cls: 'biounix-chat-header-left' });
    const headerIcon = headerLeft.createEl('span', { cls: 'biounix-chat-logo' });
    setIcon(headerIcon, 'flask-conical');
    headerLeft.createEl('span', { text: 'BioUnix', cls: 'biounix-chat-title' });

    const headerRight = header.createDiv({ cls: 'biounix-chat-header-right' });
    // 清空对话按钮
    const clearBtn = headerRight.createEl('button', { cls: 'biounix-chat-icon-btn', attr: { title: '清空对话' } });
    setIcon(clearBtn, 'trash');
    clearBtn.onclick = async () => {
      if (this.messages.length === 0) return;
      if (this.streaming) { new Notice('正在生成中，请先停止'); return; }
      try {
        if (this.sessionId) await this.plugin.api.clearSession(this.sessionId);
        this.messages = [];
        this.renderMessages();
        new Notice('已清空对话（会话仍保留）');
      } catch (e) {
        new Notice(`清空失败: ${(e as Error).message}`);
      }
    };
    // Obsidian 笔记浏览器按钮
    const noteBtn = headerRight.createEl('button', { cls: 'biounix-chat-icon-btn', attr: { title: '预览 Obsidian 笔记' } });
    setIcon(noteBtn, 'file-text');
    noteBtn.onclick = () => this.openNoteBrowser();
    // 会话列表按钮
    const listBtn = headerRight.createEl('button', { cls: 'biounix-chat-icon-btn', attr: { title: '会话列表' } });
    setIcon(listBtn, 'list');
    listBtn.onclick = () => this.toggleSessionPanel();
    // 搜索按钮
    const searchBtn = headerRight.createEl('button', { cls: 'biounix-chat-icon-btn', attr: { title: '搜索消息' } });
    setIcon(searchBtn, 'search');
    searchBtn.onclick = () => this.toggleSearch();
    // 时间线按钮
    const timelineBtn = headerRight.createEl('button', { cls: 'biounix-chat-icon-btn', attr: { title: 'Agent 执行时间线' } });
    setIcon(timelineBtn, 'activity');
    timelineBtn.onclick = () => this.showTimeline();
    // 计算资源按钮
    const resBtn = headerRight.createEl('button', { cls: 'biounix-chat-icon-btn', attr: { title: '查看可调用计算资源' } });
    setIcon(resBtn, 'server');
    resBtn.onclick = () => this.showResources();
    // 会话配置按钮
    const cfgBtn = headerRight.createEl('button', { cls: 'biounix-chat-icon-btn', attr: { title: '查看会话配置' } });
    setIcon(cfgBtn, 'settings');
    cfgBtn.onclick = () => this.showConfig();
    // 新建会话按钮
    const sessionBtn = headerRight.createEl('button', { text: '＋ 新建', cls: 'biounix-chat-new-btn' });
    sessionBtn.onclick = () => this.openCreateSessionModal();

    // 状态栏（显示当前会话信息）
    this.statusEl = container.createDiv({ cls: 'biounix-chat-status' });
    this.updateStatus();

    // 消息列表
    this.messageEl = container.createDiv({ cls: 'biounix-chat-messages' });
    this.renderMessages();

    // 输入区域
    const inputArea = container.createDiv({ cls: 'biounix-chat-input-area' });
    // 挂载笔记标签条（输入框上方）
    this.mountedNotesEl = inputArea.createDiv({ cls: 'biounix-mounted-notes' });
    this.mountedNotesEl.setCssProps({ display: 'none' });
    const inputWrap = inputArea.createDiv({ cls: 'biounix-chat-input-wrap' });
    this.inputEl = inputWrap.createEl('textarea', {
      cls: 'biounix-chat-input',
      attr: { placeholder: '输入消息，Enter 发送，Shift+Enter 换行...', rows: '3' },
    });

    // 工具栏（输入框上方）
    const toolbar = inputArea.createDiv({ cls: 'biounix-chat-toolbar' });
    // 插入当前笔记
    const insertNoteBtn = toolbar.createEl('button', { cls: 'biounix-chat-tool-btn', attr: { title: '插入当前打开的笔记', 'aria-label': '插入当前笔记' } });
    setIcon(insertNoteBtn, 'file-text');
    insertNoteBtn.onclick = () => this.insertActiveNote();
    // 挂载上下文笔记（每轮自动注入）
    const mountBtn = toolbar.createEl('button', { cls: 'biounix-chat-tool-btn', attr: { title: '挂载笔记作为持久上下文', 'aria-label': '挂载笔记' } });
    setIcon(mountBtn, 'paperclip');
    mountBtn.onclick = () => this.openNoteMountPicker();
    // 清空输入
    const clearInputBtn = toolbar.createEl('button', { cls: 'biounix-chat-tool-btn', attr: { title: '清空输入', 'aria-label': '清空输入' } });
    setIcon(clearInputBtn, 'eraser');
    clearInputBtn.onclick = () => { if (this.inputEl) { this.inputEl.value = ''; this.inputEl.focus(); this.updateCharCount(); } };
    // 重新生成（重发最后一条 user 消息）
    const regenBtn = toolbar.createEl('button', { cls: 'biounix-chat-tool-btn', attr: { title: '重新生成上一条回复', 'aria-label': '重新生成' } });
    setIcon(regenBtn, 'rotate-cw');
    regenBtn.onclick = () => this.regenerate();
    // 导出对话
    const exportBtn = toolbar.createEl('button', { cls: 'biounix-chat-tool-btn', attr: { title: '导出对话为 Markdown', 'aria-label': '导出对话' } });
    setIcon(exportBtn, 'download');
    exportBtn.onclick = () => this.exportConversation();
    // 字数统计
    const charCount = toolbar.createDiv({ cls: 'biounix-chat-char-count', attr: { 'data-count': '0' } });
    charCount.setText('0 字');

    // 发送 / 停止 按钮
    const sendBtn = inputArea.createEl('button', { text: '发送', cls: 'biounix-chat-send-btn' });
    sendBtn.onclick = () => this.sendMessage();
    this.sendBtnEl = sendBtn;

    this.inputEl.addEventListener('input', () => this.updateCharCount());
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // 若快捷指令面板打开，回车选择当前项
        if (this.slashMenu && this.slashMenu.isOpen) {
          e.preventDefault();
          this.slashMenu.selectCurrent();
          return;
        }
        this.sendMessage();
      } else if (e.key === 'ArrowDown' && this.slashMenu && this.slashMenu.isOpen) {
        e.preventDefault();
        this.slashMenu.moveCursor(1);
      } else if (e.key === 'ArrowUp' && this.slashMenu && this.slashMenu.isOpen) {
        e.preventDefault();
        this.slashMenu.moveCursor(-1);
      } else if (e.key === 'Escape' && this.slashMenu && this.slashMenu.isOpen) {
        e.preventDefault();
        this.slashMenu.close();
      }
    });
    this.inputEl.addEventListener('input', () => {
      const val = this.inputEl?.value ?? '';
      if (val === '/' || (val.startsWith('/') && !val.includes('\n') && val.length <= 20)) {
        this.showSlashMenu();
      } else if (this.slashMenu && this.slashMenu.isOpen) {
        this.slashMenu.close();
      }
    });

    // 自动创建会话
    if (this.plugin.settings.autoConnect) {
      await this.openCreateSessionModal();
    }
  }

  /** 打开 Obsidian 笔记浏览器，可预览/插入/发送笔记内容 */
  private openNoteBrowser(): void {
    new NoteBrowserModal(
      this.app,
      // 插入到输入框
      (text) => {
        if (this.inputEl) {
          this.inputEl.value = this.inputEl.value
            ? `${this.inputEl.value}\n\n${text}`
            : text;
          this.inputEl.focus();
          new Notice('已插入笔记到输入框');
        }
      },
      // 作为上下文发送
      (text) => {
        if (this.inputEl) {
          this.inputEl.value = text;
        }
        this.sendMessage();
        new Notice('已发送笔记作为上下文');
      },
    ).open();
  }

  /** 打开"新建会话"模态框，收集完整配置后创建会话 */
  private openCreateSessionModal(): void {
    new CreateSessionModal(this.app, this.plugin, (input) => {
      void this.createSessionWithConfig(input);
    }).open();
  }

  /** 用模态框收集的完整配置创建会话（含 API 配置、工作区、安全级别） */
  private async createSessionWithConfig(input: CreateSessionInput): Promise<void> {
    try {
      // 1) 创建会话（带基本信息）
      const apiConfig = {
        provider: input.provider,
        apiKey: input.apiKey,
        model: input.model,
        customEndpoint: input.provider === 'local'
          ? (input.customEndpoint || 'http://localhost:1234/v1')
          : (input.customEndpoint || undefined),
        language: 'zh' as const,
      };
      // ★ 根据 workspaceKind 构造完整 WorkspaceTarget
      let ws: import('./api').CreateSessionWorkspace | undefined;
      if (input.mode === 'agent') {
        if (input.workspaceKind === 'local') {
          ws = input.workspaceDir ? { kind: 'local', path: input.workspaceDir } : undefined;
        } else if (input.workspaceKind === 'remote') {
          const s = input.ssh;
          if (s.host && s.username) {
            ws = {
              kind: 'remote',
              path: input.workspaceDir || undefined,
              ssh: {
                host: s.host,
                port: s.port || 22,
                username: s.username,
                auth_type: s.auth_type,
                password: s.auth_type === 'password' ? (s.password || null) : null,
                key_path: s.auth_type === 'key' ? (s.key_path || null) : null,
                passphrase: s.passphrase || null,
              },
            };
          }
        } else if (input.workspaceKind === 'wsl') {
          if (!input.wslDist) {
            throw new Error('请选择 WSL 发行版');
          }
          ws = {
            kind: 'wsl',
            path: input.workspaceDir || undefined,
            wsl: { dist: input.wslDist },
          };
        }
      }
      const createRes = await this.plugin.api.createSession({
        name: input.name || undefined,
        model: input.model,
        mode: input.mode,
        workspace: ws,
        workspaceDir: ws?.path,
        apiConfig,
      });
      if (!createRes.ok || !createRes.session) {
        throw new Error(createRes.error || '后端未返回会话');
      }
      const session = createRes.session;
      this.sessionId = session.id;
      this.messages = [];

      // 2) 补全会话配置（apiConfig 通过 PUT 写回，保证后端持久化与主程序一致）
      await this.plugin.api.updateSession(session.id, {
        apiConfig,
        workspace: ws || null,
        workspaceDir: ws?.path || null,
        mode: input.mode,
        model: input.model,
      });

      // 3) 设置安全级别（best-effort，失败不影响会话使用）
      void this.plugin.api.setSessionSecurity(session.id, input.securityLevel).catch(() => { /* 旧版后端无此路由时忽略 */ });

      // 4) 连接 WebSocket 接收流式输出
      this.connectWS();

      // 记录会话信息并更新状态栏
      this.sessionInfo = { provider: input.provider, model: input.model, mode: input.mode, workspaceKind: input.workspaceKind };
      this.sessionName = input.name || `会话 ${session.id.slice(0, 8)}`;
      this.updateStatus();

      this.renderMessages();
      this.messageEl?.createEl('div', {
        text: `✅ 会话已创建 (${this.sessionId.slice(0, 8)}) · ${input.provider}/${input.model} · ${input.mode === 'agent' ? 'Agent' : 'Chat'}`,
        cls: 'biounix-chat-notice',
      });
    } catch (e) {
      this.messageEl?.createEl('div', {
        text: `❌ 创建会话失败: ${(e as Error).message}`,
        cls: 'biounix-chat-error',
      });
    }
  }

  /** 连接 WebSocket 接收当前会话的流式输出 */
  private connectWS(): void {
    this.plugin.api.connectWS((data) => {
      // ★ 调试日志：确认 WS 事件到达插件
      console.log('[biounix-ws] recv', data.type, 'sid=', (data as { sessionId?: string }).sessionId, 'cur=', this.sessionId);
      if (!this.sessionId) return;
      // 只处理当前会话的事件
      const sid = (data as { sessionId?: string }).sessionId;
      if (sid && sid !== this.sessionId) {
        console.log('[biounix-ws] 过滤: 事件 sid != 当前 sessionId');
        return;
      }
      if (data.type === 'agent:chunk' && data.content) {
        this.onStreamChunk(data.content);
      } else if (data.type === 'agent:done') {
        this.onStreamDone();
      } else if (data.type === 'agent:error') {
        const last = this.messages[this.messages.length - 1];
        if (last && last.role === 'assistant') {
          last.content = `❌ ${data.error || '生成失败'}`;
          this.renderMessages();
        }
      } else if (data.type === 'tool:call') {
        this.onToolCall(data as unknown as {
          toolCallId: string; toolName: string;
          status: 'running' | 'done' | 'error' | 'cancelled';
          args?: string; result?: string;
        });
      } else if (data.type === 'agent:reasoning' && data.content) {
        this.onReasoningChunk(data.content);
      } else if (data.type === 'interaction:request') {
        // AI 需要用户确认/选择：在 Obsidian 中弹出原生 Modal
        this.onInteractionRequest(data as unknown as InteractionRequest);
      }
    });
  }

  /** 处理 AI 的确认/选择请求：弹出 Obsidian 原生 Modal */
  private onInteractionRequest(req: InteractionRequest): void {
    // 会话过滤：只处理当前会话的交互请求
    if (req.session_id && this.sessionId && req.session_id !== this.sessionId) {
      console.log('[biounix-ws] interaction 过滤: 事件 sid != 当前 sessionId');
      return;
    }
    // 防止重复弹出（同一 tool_call_id 多次广播）
    if (this.activeInteractionIds.has(req.tool_call_id)) return;
    this.activeInteractionIds.add(req.tool_call_id);
    // 清理标记（5 分钟超时后允许再次弹出，与后端 5min 超时对齐）
    window.setTimeout(() => this.activeInteractionIds.delete(req.tool_call_id), 5 * 60 * 1000);

    const modal = new InteractionModal(this.app, this.plugin, req);
    modal.open();
    new Notice(`AI 请求${this.interactionLabel(req.tool_name)}`);
  }

  /** 交互类型的中文名称（用于 Notice 提示） */
  private interactionLabel(toolName: string): string {
    const map: Record<string, string> = {
      confirm_dialog: '确认',
      select_option: '选择',
      select_file: '选择文件',
      select_directory: '选择目录',
    };
    return map[toolName] || '交互';
  }

  private async sendMessage(): Promise<void> {
    if (!this.inputEl || !this.sessionId) {
      new Notice('请先创建会话');
      return;
    }
    if (this.streaming) { new Notice('正在生成中，请先停止或等待完成'); return; }
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = '';
    this.updateCharCount();
    await this.sendRaw(text);
  }

  /** 停止当前会话的生成 */
  private async stopGeneration(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.plugin.api.stopSession(this.sessionId);
      this.streaming = false;
      this.updateStatus();
      this.updateSendButton();
      new Notice('已停止生成');
    } catch (e) {
      new Notice(`停止失败: ${(e as Error).message}`);
    }
  }

  /** 重新生成：移除最后一条 assistant 回复，重发上一条 user 消息 */
  private async regenerate(): Promise<void> {
    if (!this.inputEl || !this.sessionId) {
      new Notice('请先创建会话');
      return;
    }
    if (this.streaming) {
      new Notice('正在生成中，请先停止');
      return;
    }
    // 找到最后一条 user 消息
    let lastUserIdx = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) {
      new Notice('没有可重新生成的消息');
      return;
    }
    const lastUser = this.messages[lastUserIdx];
    // 移除该 user 消息之后的所有消息（含 assistant 回复）
    this.messages = this.messages.slice(0, lastUserIdx);
    // 重发
    this.inputEl.value = lastUser.content;
    await this.sendMessage();
  }

  /** 插入当前活动笔记内容到输入框 */
  private async insertActiveNote(): Promise<void> {
    const af = this.app.workspace.getActiveFile();
    if (!af || af.extension !== 'md') {
      new Notice('当前没有打开的 Markdown 笔记');
      return;
    }
    try {
      const content = await this.app.vault.read(af);
      const text = `> 📖 笔记: [[${af.path}]]\n\n${content}`;
      if (this.inputEl) {
        this.inputEl.value = this.inputEl.value
          ? `${this.inputEl.value}\n\n${text}`
          : text;
        this.updateCharCount();
        this.inputEl.focus();
      }
      new Notice('已插入当前笔记');
    } catch (e) {
      new Notice(`读取笔记失败: ${(e as Error).message}`);
    }
  }

  /** 导出当前对话为 Markdown 文件 */
  private async exportConversation(): Promise<void> {
    if (this.messages.length === 0) {
      new Notice('没有可导出的对话');
      return;
    }
    const lines: string[] = [
      `# BioUnix 对话导出`,
      ``,
      `> 导出时间: ${new Date().toLocaleString('zh-CN')}`,
      `> 会话: ${this.sessionId?.slice(0, 8) || '未知'}`,
      this.sessionInfo ? `> 模型: ${this.sessionInfo.provider}/${this.sessionInfo.model} · ${this.sessionInfo.mode}` : '',
      ``,
      `---`,
      ``,
    ];
    for (const msg of this.messages) {
      const role = msg.role === 'user' ? '🧑 你' : msg.role === 'assistant' ? '🤖 Agent' : 'ℹ️ 系统';
      const time = new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
      lines.push(`## ${role}  ·  ${time}`);
      lines.push('');
      lines.push(msg.content);
      lines.push('');
    }
    const md = lines.join('\n');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `biounix-chat-${stamp}.md`;
    try {
      const path = await this.app.vault.create(filename, md);
      new Notice(`已导出到 vault: ${path.path}`);
      // 在 Obsidian 中打开导出的文件
      this.app.workspace.openLinkText(path.path, '', false);
    } catch (e) {
      new Notice(`导出失败: ${(e as Error).message}`);
    }
  }

  /** 更新字数统计 */
  private updateCharCount(): void {
    const n = this.inputEl?.value.length || 0;
    const el = this.containerEl.querySelector('.biounix-chat-char-count');
    if (el) {
      el.setAttribute('data-count', String(n));
      el.setText(`${n} 字`);
    }
  }

  /** 更新发送按钮状态：streaming 时显示“停止” */
  private updateSendButton(): void {
    if (!this.sendBtnEl) return;
    if (this.streaming) {
      this.sendBtnEl.setText('停止');
      this.sendBtnEl.addClass('is-stop');
      this.sendBtnEl.onclick = () => this.stopGeneration();
    } else {
      this.sendBtnEl.setText('发送');
      this.sendBtnEl.removeClass('is-stop');
      this.sendBtnEl.onclick = () => this.sendMessage();
    }
  }

  /** WebSocket 回调：更新最后一条 assistant 消息（rAF 节流 + 增量 DOM 更新） */
  onStreamChunk(content: string): void {
    if (!this.streaming) {
      this.streaming = true;
      this.updateStatus();
      this.updateSendButton();
    }
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'assistant') {
      // 首次 chunk：覆盖占位文本（"⏳ 思考中..."）；后续 chunk：追加
      if (last.content === '⏳ 思考中...' || !last.content) {
        last.content = content;
      } else {
        last.content += content;
      }
      // 流式首帧：确保流式 bubble 已创建（sendRaw 已 renderMessages 标记 is-streaming）
      if (!this.streamingMdEl) this.renderMessages();
      this.scheduleStreamingRender();
    }
  }

  /** WebSocket 回调：思维链流式更新（rAF 节流 + 增量更新） */
  onReasoningChunk(content: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'assistant') {
      last.reasoning = (last.reasoning || '') + content;
      this.scheduleStreamingRender();
    }
  }

  /** rAF 节流：同帧多次 chunk 合并为一次增量更新 */
  private scheduleStreamingRender(): void {
    if (this.renderRaf !== null) return;
    this.renderRaf = window.requestAnimationFrame(() => {
      this.renderRaf = null;
      this.updateStreamingDom();
    });
  }

  /** 增量更新流式消息的 DOM（不重建整个消息列表） */
  private updateStreamingDom(): void {
    const last = this.messages[this.messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    // 正文：纯文本（流式期间不做 Markdown 渲染，避免卡顿）
    if (this.streamingMdEl) {
      this.streamingMdEl.setText(last.content);
      const cursor = this.streamingMdEl.createEl('span', { cls: 'biounix-streaming-cursor' });
      cursor.setText('▋');
    }
    // 思维链：纯文本追加
    if (this.streamingReasonEl && last.reasoning) {
      this.streamingReasonEl.setText(last.reasoning);
    }
    // 滚动到底部
    if (this.messageEl) this.messageEl.scrollTop = this.messageEl.scrollHeight;
  }

  onStreamDone(): void {
    this.streaming = false;
    // 取消待执行的 rAF（避免流式结束后还跑增量更新）
    if (this.renderRaf !== null) {
      cancelAnimationFrame(this.renderRaf);
      this.renderRaf = null;
    }
    this.updateStatus();
    this.updateSendButton();
    // 流式结束，加载完整消息
    if (this.sessionId) {
      // 先收集本地已累积的 toolCalls（按 toolCallId 索引），避免被 getMessages 覆盖丢失
      const localToolCallMap = new Map<string, ToolCallInfo>();
      for (const m of this.messages) {
        if (m.toolCalls) {
          for (const tc of m.toolCalls) {
            localToolCallMap.set(tc.toolCallId, tc);
          }
        }
      }
      void this.plugin.api.getMessages(this.sessionId).then(res => {
        // 竞态保护：若已开始新一轮流式，不覆盖（避免丢失用户刚发的新消息）
        if (this.streaming) return;
        if (res.ok && res.messages) {
          this.messages = res.messages.map((m: BioUnixMessage) => {
            const msg: ChatMessage = {
              role: m.role,
              content: m.content,
              timestamp: m.timestamp,
              reasoning: m.reasoning,
            };
            // 从后端 tool_calls 重建工具卡片基础信息（OpenAI 格式 → 插件 ToolCallInfo）
            if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
              msg.toolCalls = m.tool_calls.map((tc) => {
                const local = localToolCallMap.get(tc.id);
                return {
                  toolCallId: tc.id,
                  toolName: tc.function.name,
                  status: local?.status || ('done' as const),
                  args: tc.function.arguments,
                  // 本地有 result（含 undo_state 等实时状态）则优先用本地
                  result: local?.result,
                  timestamp: m.timestamp,
                  // F5: 保留本地记录的 startTime/duration（后端不存这些）
                  startTime: local?.startTime,
                  duration: local?.duration,
                };
              });
            }
            return msg;
          });
          this.renderMessages();
        }
      }).catch(() => { /* ignore */ });
    }
  }

  /** WebSocket 回调：工具调用事件 */
  onToolCall(info: {
    toolCallId: string; toolName: string;
    status: 'running' | 'done' | 'error' | 'cancelled';
    args?: string; result?: string;
  }): void {
    // 找到最后一条 assistant 消息作为载体
    let last = this.messages[this.messages.length - 1];
    if (!last || last.role !== 'assistant') {
      // 没有 assistant 消息时创建一个占位
      last = { role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [] };
      this.messages.push(last);
    }
    if (!last.toolCalls) last.toolCalls = [];
    // 更新或插入
    const existing = last.toolCalls.find(t => t.toolCallId === info.toolCallId);
    const ts = Date.now();
    if (existing) {
      existing.status = info.status;
      if (info.args !== undefined) existing.args = info.args;
      if (info.result !== undefined) existing.result = info.result;
      existing.timestamp = ts;
      // F5: 计算 duration
      if (info.status === 'running' && !existing.startTime) existing.startTime = ts;
      if ((info.status === 'done' || info.status === 'error' || info.status === 'cancelled') && existing.startTime) {
        existing.duration = ts - existing.startTime;
      }
    } else {
      last.toolCalls.push({
        toolCallId: info.toolCallId,
        toolName: info.toolName,
        status: info.status,
        args: info.args,
        result: info.result,
        timestamp: ts,
        startTime: info.status === 'running' ? ts : undefined,
        duration: undefined,
      });
    }
    this.renderMessages();
  }

  private renderMessages(): void {
    if (!this.messageEl) return;
    this.messageEl.empty();
    this.bubbleEls = [];
    // 清除流式增量引用（全量重建后失效）
    this.streamingContentEl = null;
    this.streamingReasonEl = null;
    this.streamingMdEl = null;

    if (this.messages.length === 0 && !this.streaming) {
      const empty = this.messageEl.createDiv({ cls: 'biounix-chat-empty' });
      const emptyIcon = empty.createEl('div', { cls: 'biounix-chat-empty-icon' });
      setIcon(emptyIcon, 'flask-conical');
      empty.createEl('div', { text: 'BioUnix 已就绪', cls: 'biounix-chat-empty-title' });
      empty.createEl('div', { text: '点击右上角「新建」开始对话', cls: 'biounix-chat-empty-desc' });
      return;
    }

    const lastIdx = this.messages.length - 1;
    this.messages.forEach((msg, idx) => {
      const isCurrentMatch = this.searchMode && this.searchMatches[this.searchCursor] === idx;
      const isStreamingLast = this.streaming && idx === lastIdx && msg.role === 'assistant';
      const bubble = this.messageEl!.createDiv({
        cls: `biounix-chat-bubble biounix-chat-${msg.role}${isCurrentMatch ? ' is-search-current' : ''}${isStreamingLast ? ' is-streaming' : ''}`,
      });
      this.bubbleEls.push(bubble);

      // 角色标识行
      const roleRow = bubble.createDiv({ cls: 'biounix-chat-role-row' });
      const roleIcon = roleRow.createEl('span', { cls: 'biounix-chat-role-icon' });
      if (msg.role === 'user') {
        roleIcon.setText('🧑');
      } else if (msg.role === 'assistant') {
        roleIcon.setText('🤖');
      } else {
        roleIcon.setText('ℹ️');
      }
      roleRow.createEl('span', {
        text: msg.role === 'user' ? '你' : msg.role === 'assistant' ? 'Agent' : '系统',
        cls: 'biounix-chat-role-name',
      });

      // 内容区：assistant 用 Markdown 渲染，user/system 用纯文本
      const contentEl = bubble.createDiv({ cls: 'biounix-chat-content' });
      if (msg.role === 'assistant') {
        // 思维链折叠展示（在正文之前）
        if (msg.reasoning) {
          const reasonWrap = contentEl.createDiv({ cls: 'biounix-chat-reasoning' });
          const reasonHead = reasonWrap.createDiv({ cls: 'biounix-chat-reasoning-head' });
          const reasonIcon = reasonHead.createEl('span', { cls: 'biounix-chat-reasoning-icon' });
          setIcon(reasonIcon, 'brain');
          reasonHead.createEl('span', { text: '思维链', cls: 'biounix-chat-reasoning-label' });
          const reasonToggle = reasonHead.createEl('span', { text: '展开', cls: 'biounix-chat-reasoning-toggle' });
          const reasonBody = reasonWrap.createDiv({ cls: 'biounix-chat-reasoning-body' });
          reasonBody.setCssProps({ display: 'none' });
          // 流式时思维链用纯文本（避免每个 chunk 都 MarkdownRenderer）；结束后再渲染
          if (!isStreamingLast && this.mdComponent) {
            void MarkdownRenderer.renderMarkdown(msg.reasoning, reasonBody, '', this.mdComponent);
          } else {
            reasonBody.setText(msg.reasoning);
          }
          let expanded = false;
          reasonHead.onclick = () => {
            expanded = !expanded;
            reasonBody.setCssProps({ display: expanded ? 'block' : 'none' });
            reasonToggle.setText(expanded ? '收起' : '展开');
          };
          // 流式时缓存思维链容器引用
          if (isStreamingLast) this.streamingReasonEl = reasonBody;
        }
        // 正文：流式时用纯文本 + 闪烁光标（避免每个 chunk 都调 MarkdownRenderer），结束后再 Markdown 渲染
        if (isStreamingLast) {
          const mdEl = contentEl.createDiv({ cls: 'biounix-chat-streaming-text' });
          mdEl.setText(msg.content);
          // 光标
          const cursor = mdEl.createEl('span', { cls: 'biounix-streaming-cursor' });
          cursor.setText('▋');
          this.streamingContentEl = contentEl;
          this.streamingMdEl = mdEl;
        } else if (this.mdComponent) {
          void MarkdownRenderer.renderMarkdown(msg.content, contentEl, '', this.mdComponent).then(() => {
            this.enhanceCodeBlocks(contentEl);
          });
        } else {
          contentEl.setText(msg.content);
        }
        // 渲染关联的工具调用卡片
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const cardsWrap = bubble.createDiv({ cls: 'biounix-tool-cards' });
          for (const tc of msg.toolCalls) {
            this.renderToolCallCard(cardsWrap, tc);
          }
        }
      } else {
        if (this.searchMode && this.searchQuery.trim()) {
          this.appendHighlighted(contentEl, msg.content);
        } else {
          contentEl.setText(msg.content);
        }
      }

      // 底部行：时间 + 操作按钮组
      const footerRow = bubble.createDiv({ cls: 'biounix-chat-footer' });
      const time = new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
      footerRow.createEl('span', { text: time, cls: 'biounix-chat-time' });
      // 复制
      const copyBtn = footerRow.createEl('button', { cls: 'biounix-chat-action-btn', attr: { title: '复制' } });
      setIcon(copyBtn, 'copy');
      copyBtn.onclick = (e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(msg.content).then(() => new Notice('已复制'));
      };
      // 引用（插入到输入框）
      const quoteBtn = footerRow.createEl('button', { cls: 'biounix-chat-action-btn', attr: { title: '引用到输入框' } });
      setIcon(quoteBtn, 'quote');
      quoteBtn.onclick = (e) => {
        e.stopPropagation();
        if (this.inputEl) {
          const quote = msg.content.split('\n').map(l => `> ${l}`).join('\n');
          this.inputEl.value = this.inputEl.value
            ? `${this.inputEl.value}\n\n${quote}`
            : quote;
          this.updateCharCount();
          this.inputEl.focus();
          new Notice('已引用到输入框');
        }
      };
      // 编辑（仅 user 消息）+ 重新生成（仅 assistant 消息）+ 分支（所有消息）
      if (msg.role === 'user') {
        const editBtn = footerRow.createEl('button', { cls: 'biounix-chat-action-btn', attr: { title: '编辑并重发' } });
        setIcon(editBtn, 'pencil');
        editBtn.onclick = (e) => {
          e.stopPropagation();
          this.editMessage(idx);
        };
      } else if (msg.role === 'assistant') {
        const regenBtn = footerRow.createEl('button', { cls: 'biounix-chat-action-btn', attr: { title: '重新生成' } });
        setIcon(regenBtn, 'rotate-cw');
        regenBtn.onclick = (e) => {
          e.stopPropagation();
          this.regenerateFrom(idx);
        };
      }
      // 分支对话：从此处分叉
      const forkBtn = footerRow.createEl('button', { cls: 'biounix-chat-action-btn', attr: { title: '从此处分叉新会话' } });
      setIcon(forkBtn, 'git-branch');
      forkBtn.onclick = (e) => {
        e.stopPropagation();
        this.forkFromMessage(idx);
      };
    });

    // 滚动到底部
    this.messageEl.scrollTop = this.messageEl.scrollHeight;
  }

  /** 增强代码块：加语言标签 + 一键复制 */
  private enhanceCodeBlocks(container: HTMLElement): void {
    container.querySelectorAll('pre > code').forEach((codeEl) => {
      const pre = codeEl.parentElement;
      if (!pre || pre.querySelector('.biounix-code-toolbar')) return;
      const toolbar = pre.createDiv({ cls: 'biounix-code-toolbar' });
      // 语言标签
      const langClass = codeEl.className || '';
      const langMatch = langClass.match(/language-([\w-]+)/);
      if (langMatch) {
        toolbar.createEl('span', { text: langMatch[1], cls: 'biounix-code-lang' });
      }
      // 复制按钮
      const btn = toolbar.createEl('button', { cls: 'biounix-code-copy', attr: { title: '复制代码' } });
      setIcon(btn, 'copy');
      btn.onclick = (e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(codeEl.textContent || '').then(() => new Notice('代码已复制'));
      };
      pre.classList.add('biounix-code-pre');
    });
  }

  /** 编辑 user 消息并重发 */
  private editMessage(idx: number): void {
    const msg = this.messages[idx];
    if (!msg || msg.role !== 'user') return;
    if (!this.inputEl) return;
    if (this.streaming) { new Notice('正在生成中，请先停止'); return; }
    // 删除该消息及之后的所有消息
    this.messages = this.messages.slice(0, idx);
    this.inputEl.value = msg.content;
    this.updateCharCount();
    this.inputEl.focus();
    this.renderMessages();
    new Notice('已加载到输入框，修改后发送即可');
  }

  /** 从指定 assistant 消息处重新生成 */
  private async regenerateFrom(idx: number): Promise<void> {
    const msg = this.messages[idx];
    if (!msg || msg.role !== 'assistant') return;
    if (this.streaming) { new Notice('正在生成中，请先停止'); return; }
    // 找到前一条 user 消息
    let userIdx = idx - 1;
    while (userIdx >= 0 && this.messages[userIdx].role !== 'user') userIdx--;
    if (userIdx < 0) { new Notice('找不到对应的用户消息'); return; }
    const userContent = this.messages[userIdx].content;
    // 截断到 user 消息之前（移除 user 及其后的 assistant，sendMessage 会重新 push user）
    this.messages = this.messages.slice(0, userIdx);
    this.renderMessages();
    // 直接发送（不走输入框，避免输入框被污染）
    await this.sendRaw(userContent);
  }

  /** 直接发送文本（不经过输入框，用于重新生成/分支等内部调用） */
  private async sendRaw(text: string): Promise<void> {
    if (!this.sessionId) { new Notice('请先创建会话'); return; }
    if (!text.trim()) return;
    this.messages.push({ role: 'user', content: text, timestamp: Date.now() });
    const assistantMsg: ChatMessage = { role: 'assistant', content: '⏳ 思考中...', timestamp: Date.now() };
    this.messages.push(assistantMsg);
    this.streaming = true;
    this.updateStatus();
    this.renderMessages();
    try {
      const fullText = await this.buildContextPrefix() + text;
      await this.plugin.api.sendMessage(this.sessionId, fullText);
      this.updateSendButton();
    } catch (e) {
      assistantMsg.content = `❌ 发送失败: ${(e as Error).message}`;
      this.renderMessages();
      this.streaming = false;
      this.updateSendButton();
    }
  }

  /** F4 从指定消息处分叉新会话（保留该消息及之前的所有消息） */
  private async forkFromMessage(idx: number): Promise<void> {
    if (!this.sessionId) return;
    if (this.streaming) { new Notice('正在生成中，请先停止后再分叉'); return; }
    try {
      // 分叉点：保留 idx+1 条消息（0..idx）
      const beforeIndex = idx + 1;
      const result = await this.plugin.api.forkSession(this.sessionId, beforeIndex);
      if (result.ok && (result as any).session) {
        const newSession = (result as any).session;
        new Notice(`已创建分支会话: ${newSession.name}`);
        // 切换到新会话
        await this.switchSession(newSession.id);
      } else {
        new Notice(`分叉失败: ${(result as any).error || '未知错误'}`);
      }
    } catch (e) {
      new Notice(`分叉失败: ${(e as Error).message}`);
    }
  }

  /** F5 显示 Agent 执行时间线 */
  private showTimeline(): void {
    // 收集所有工具调用
    const events: Array<{ msgIdx: number; tc: ToolCallInfo }> = [];
    this.messages.forEach((m, i) => {
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          events.push({ msgIdx: i, tc });
        }
      }
    });
    if (events.length === 0) {
      new Notice('当前会话无工具调用记录');
      return;
    }
    const modal = new Modal(this.app);
    modal.setTitle(`Agent 执行时间线（${events.length} 个工具调用）`);
    modal.setContent('');

    const wrap = modal.contentEl.createDiv({ cls: 'biounix-timeline' });
    // 统计信息
    const stats = wrap.createDiv({ cls: 'biounix-timeline-stats' });
    const doneCount = events.filter(e => e.tc.status === 'done').length;
    const errCount = events.filter(e => e.tc.status === 'error').length;
    const runningCount = events.filter(e => e.tc.status === 'running').length;
    const totalDuration = events.reduce((sum, e) => sum + (e.tc.duration || 0), 0);
    stats.createEl('span', { text: `✓ ${doneCount} 完成`, cls: 'biounix-timeline-stat-ok' });
    stats.createEl('span', { text: `✗ ${errCount} 失败`, cls: 'biounix-timeline-stat-err' });
    if (runningCount > 0) stats.createEl('span', { text: `⏳ ${runningCount} 进行中`, cls: 'biounix-timeline-stat-run' });
    stats.createEl('span', { text: `⏱ 总耗时 ${(totalDuration / 1000).toFixed(1)}s`, cls: 'biounix-timeline-stat-time' });

    // 时间线条目
    const list = wrap.createDiv({ cls: 'biounix-timeline-list' });
    // 计算最大耗时用于条形图比例
    const maxDuration = Math.max(...events.map(e => e.tc.duration || 0), 1);
    events.forEach((e, idx) => {
      const item = list.createDiv({ cls: `biounix-timeline-item biounix-timeline-${e.tc.status}` });
      // 序号
      item.createEl('span', { cls: 'biounix-timeline-idx', text: String(idx + 1) });
      // 工具名
      item.createEl('span', { cls: 'biounix-timeline-tool', text: e.tc.toolName, attr: { title: e.tc.toolName } });
      // 耗时条
      const barWrap = item.createDiv({ cls: 'biounix-timeline-bar-wrap' });
      const dur = e.tc.duration || 0;
      const pct = Math.max(2, (dur / maxDuration) * 100);
      const bar = barWrap.createDiv({ cls: 'biounix-timeline-bar' });
      bar.style.width = `${pct}%`;
      // 状态图标
      const statusIcon = e.tc.status === 'done' ? '✓' : e.tc.status === 'error' ? '✗' : e.tc.status === 'running' ? '⏳' : '○';
      bar.createEl('span', { cls: 'biounix-timeline-bar-status', text: statusIcon });
      // 耗时文字
      const durText = e.tc.status === 'running' ? '进行中…' : e.tc.duration ? `${(e.tc.duration / 1000).toFixed(2)}s` : '-';
      barWrap.createEl('span', { cls: 'biounix-timeline-dur', text: durText });
      // 点击展开详情
      item.onclick = () => {
        const detail = item.querySelector('.biounix-timeline-detail');
        if (detail) { detail.remove(); return; }
        const d = item.createDiv({ cls: 'biounix-timeline-detail' });
        d.createEl('div', { text: `调用ID: ${e.tc.toolCallId}`, cls: 'biounix-timeline-detail-line' });
        if (e.tc.args) d.createEl('div', { text: `参数: ${e.tc.args.slice(0, 200)}${e.tc.args.length > 200 ? '…' : ''}`, cls: 'biounix-timeline-detail-line' });
        if (e.tc.result) {
          const resText = e.tc.result.length > 300 ? e.tc.result.slice(0, 300) + '…' : e.tc.result;
          d.createEl('div', { text: `结果: ${resText}`, cls: 'biounix-timeline-detail-line' });
        }
        d.createEl('div', { text: `所在消息: #${e.msgIdx + 1}`, cls: 'biounix-timeline-detail-line' });
      };
    });
    modal.open();
  }

  /** 查看当前 session 可调用的计算资源（运行时/系统资源/Slurm 分区队列） */
  private async showResources(): Promise<void> {
    if (!this.sessionId) {
      new Notice('请先选择或创建会话');
      return;
    }
    const modal = new Modal(this.app);
    modal.setTitle('计算资源');
    modal.setContent('');
    const wrap = modal.contentEl.createDiv({ cls: 'biounix-resources' });
    const loading = wrap.createDiv({ cls: 'biounix-resources-loading', text: '正在探测计算资源…' });
    modal.open();

    try {
      // 先检查 BioUnix 主程序是否运行（API server 是否在线）
      const healthy = await this.plugin.api.health();
      if (!healthy) {
        loading.setText('无法连接 BioUnix 主程序（API 未启动）。请先启动 BioUnix 桌面应用，计算资源探测需要主程序的运行时检测服务。');
        return;
      }
      const res = await this.plugin.api.getSessionResources(this.sessionId);
      if (!res.ok) {
        loading.setText(`探测失败: ${res.error || '未知错误'}`);
        return;
      }
      const data = res.resources as {
        workspace?: { kind: string; path?: string; ssh?: { host: string; username: string; port?: number } | null };
        deviceKind: string;
        deviceLabel: string;
        isSlurm: boolean;
        runtimes: Array<{ kind: string; name: string; status: string; installed?: { version: string; path: string; source: string }; allInstallations?: Array<{ version: string; path: string; source: string }> }>;
        runtimesError?: string | null;
        sysStats: { cpu_usage: number; mem_total: number; mem_used: number; load_avg?: number[]; uptime?: number; cpu_count?: number; error?: string };
        diskUsage: Array<{ filesystem: string; mount: string; total: number; used: number; avail: number; percent: number }>;
        slurm: { partitions: Array<{ name: string; avail: string; timelimit: string; nodes: number; state: string; nodeList?: string; maxMemPerNode?: string; maxCpusPerNode?: string }>; nodes: Array<{ name: string; state: string; cpus: number; memory: number; partitions: string[]; reason?: string }>; jobs: Array<{ jobId: string; name: string; partition: string; state: string; stateCode: string; timeUsed: string; timeLimit: string; nodeCount: number; reason?: string }> } | null;
      } | undefined;
      if (!data) {
        loading.setText('后端未返回资源数据');
        return;
      }
      loading.remove();

      // 设备概要
      const summary = wrap.createDiv({ cls: 'biounix-resources-summary' });
      const kindLabel = data.deviceKind === 'local' ? '本机' : data.deviceKind === 'remote-slurm' ? 'Slurm 集群' : data.deviceKind === 'wsl' ? 'WSL' : '远程服务器';
      summary.createEl('span', { cls: 'biounix-resources-badge', text: kindLabel });
      summary.createEl('span', { cls: 'biounix-resources-device', text: data.deviceLabel });
      if (data.workspace?.path) {
        summary.createEl('span', { cls: 'biounix-resources-path', text: `📁 ${data.workspace.path}`, attr: { title: data.workspace.path } });
      }

      // 系统资源
      const sysSection = wrap.createDiv({ cls: 'biounix-resources-section' });
      sysSection.createEl('div', { cls: 'biounix-resources-section-title', text: '系统资源' });
      if (data.sysStats.error) {
        sysSection.createEl('div', { cls: 'biounix-resources-error', text: `⚠ ${data.sysStats.error}` });
      } else {
        const sysGrid = sysSection.createDiv({ cls: 'biounix-resources-grid' });
        const cpu = data.sysStats.cpu_usage ?? 0;
        const memTotal = data.sysStats.mem_total || 0;
        const memUsed = data.sysStats.mem_used || 0;
        const memPct = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;
        const cores = data.sysStats.cpu_count || nodeOs.cpus().length;
        sysGrid.createEl('div', { cls: 'biounix-resources-metric', text: `CPU: ${cpu.toFixed(1)}%` });
        sysGrid.createEl('div', { cls: 'biounix-resources-metric', text: `核心: ${cores}` });
        sysGrid.createEl('div', { cls: 'biounix-resources-metric', text: `内存: ${formatBytes(memUsed)} / ${formatBytes(memTotal)} (${memPct}%)` });
        if (data.sysStats.load_avg && data.sysStats.load_avg.some(v => v > 0)) {
          sysGrid.createEl('div', { cls: 'biounix-resources-metric', text: `负载: ${data.sysStats.load_avg!.join(' / ')}` });
        }
        if (data.sysStats.uptime) {
          sysGrid.createEl('div', { cls: 'biounix-resources-metric', text: `运行: ${formatUptime(data.sysStats.uptime)}` });
        }
      }

      // 磁盘
      if (data.diskUsage && data.diskUsage.length > 0) {
        const diskSection = wrap.createDiv({ cls: 'biounix-resources-section' });
        diskSection.createEl('div', { cls: 'biounix-resources-section-title', text: '磁盘' });
        const diskGrid = diskSection.createDiv({ cls: 'biounix-resources-grid' });
        data.diskUsage.slice(0, 6).forEach(d => {
          const item = diskGrid.createDiv({ cls: 'biounix-resources-disk' });
          item.createEl('div', { cls: 'biounix-resources-disk-mount', text: d.mount, attr: { title: d.filesystem } });
          item.createEl('div', { cls: 'biounix-resources-disk-bar' }).style.width = `${Math.min(100, d.percent)}%`;
          item.createEl('div', { cls: 'biounix-resources-disk-text', text: `${formatBytes(d.used)} / ${formatBytes(d.total)} (${d.percent}%)` });
        });
      }

      // 运行时
      const rtSection = wrap.createDiv({ cls: 'biounix-resources-section' });
      rtSection.createEl('div', { cls: 'biounix-resources-section-title', text: '运行时（已安装的语言/工具链）' });
      if (data.runtimesError) {
        rtSection.createEl('div', { cls: 'biounix-resources-error', text: `⚠ ${data.runtimesError}` });
      } else if (data.runtimes.length === 0) {
        rtSection.createEl('div', { cls: 'biounix-resources-empty', text: '未探测到已安装的运行时' });
      } else {
        const installed = data.runtimes.filter(r => r.installed);
        const rtGrid = rtSection.createDiv({ cls: 'biounix-resources-grid' });
        installed.forEach(rt => {
          const item = rtGrid.createDiv({ cls: 'biounix-resources-runtime' });
          item.createEl('span', { cls: 'biounix-resources-runtime-icon', text: '✓' });
          item.createEl('span', { cls: 'biounix-resources-runtime-name', text: rt.name });
          item.createEl('span', { cls: 'biounix-resources-runtime-version', text: rt.installed!.version });
          if (rt.allInstallations && rt.allInstallations.length > 1) {
            item.createEl('span', { cls: 'biounix-resources-runtime-extra', text: `+${rt.allInstallations.length - 1} 其他版本`, attr: { title: rt.allInstallations.map(v => `${v.version} @ ${v.path}`).join('\n') } });
          }
        });
        const notInstalled = data.runtimes.filter(r => !r.installed);
        if (notInstalled.length > 0) {
          rtSection.createEl('div', { cls: 'biounix-resources-runtime-unavailable', text: `未安装: ${notInstalled.map(r => r.name).join('、')}` });
        }
      }

      // Slurm 分区/节点/队列
      if (data.isSlurm && data.slurm) {
        const slurmSection = wrap.createDiv({ cls: 'biounix-resources-section' });
        slurmSection.createEl('div', { cls: 'biounix-resources-section-title', text: 'Slurm 分区' });
        if (data.slurm.partitions.length === 0) {
          slurmSection.createEl('div', { cls: 'biounix-resources-empty', text: '无可用分区' });
        } else {
          const pGrid = slurmSection.createDiv({ cls: 'biounix-resources-grid' });
          data.slurm.partitions.forEach(p => {
            const item = pGrid.createDiv({ cls: 'biounix-resources-partition' });
            item.createEl('span', { cls: 'biounix-resources-partition-name', text: p.name });
            item.createEl('span', { cls: `biounix-resources-partition-state biounix-slurm-${p.avail === 'up' ? 'up' : 'down'}`, text: p.avail });
            item.createEl('span', { cls: 'biounix-resources-partition-nodes', text: `${p.nodes} 节点` });
            item.createEl('span', { cls: 'biounix-resources-partition-time', text: p.timelimit });
            if (p.maxCpusPerNode) item.createEl('span', { cls: 'biounix-resources-partition-cpu', text: `${p.maxCpusPerNode} CPU/节点` });
          });
        }

        // 节点状态
        if (data.slurm.nodes.length > 0) {
          slurmSection.createEl('div', { cls: 'biounix-resources-section-subtitle', text: '节点状态' });
          const nGrid = slurmSection.createDiv({ cls: 'biounix-resources-grid' });
          data.slurm.nodes.slice(0, 20).forEach(n => {
            const item = nGrid.createDiv({ cls: `biounix-resources-node biounix-node-${n.state}` });
            item.createEl('span', { cls: 'biounix-resources-node-name', text: n.name, attr: { title: n.partitions.join(', ') } });
            item.createEl('span', { cls: 'biounix-resources-node-state', text: n.state });
            item.createEl('span', { cls: 'biounix-resources-node-cpu', text: `${n.cpus} CPU` });
            item.createEl('span', { cls: 'biounix-resources-node-mem', text: `${n.memory} MB` });
          });
          if (data.slurm.nodes.length > 20) {
            slurmSection.createEl('div', { cls: 'biounix-resources-more', text: `…还有 ${data.slurm.nodes.length - 20} 个节点` });
          }
        }

        // 当前用户队列
        if (data.slurm.jobs.length > 0) {
          slurmSection.createEl('div', { cls: 'biounix-resources-section-subtitle', text: '我的作业队列' });
          const jList = slurmSection.createDiv({ cls: 'biounix-resources-jobs' });
          data.slurm.jobs.slice(0, 30).forEach(j => {
            const item = jList.createDiv({ cls: `biounix-resources-job biounix-job-${j.stateCode}` });
            item.createEl('span', { cls: 'biounix-resources-job-id', text: `#${j.jobId}` });
            item.createEl('span', { cls: 'biounix-resources-job-name', text: j.name, attr: { title: j.name } });
            item.createEl('span', { cls: 'biounix-resources-job-state', text: j.state });
            item.createEl('span', { cls: 'biounix-resources-job-partition', text: j.partition });
            item.createEl('span', { cls: 'biounix-resources-job-time', text: `${j.timeUsed} / ${j.timeLimit}` });
            if (j.reason) item.createEl('span', { cls: 'biounix-resources-job-reason', text: j.reason, attr: { title: j.reason } });
          });
        }
      }
    } catch (e) {
      loading.setText(`探测失败: ${(e as Error).message}`);
    }
  }

  /** 查看当前会话的完整配置（工作空间/API/启用的工具/技能/流程等） */
  private async showConfig(): Promise<void> {
    if (!this.sessionId) {
      new Notice('请先选择或创建会话');
      return;
    }
    const modal = new Modal(this.app);
    modal.setTitle('会话配置');
    modal.setContent('');
    const wrap = modal.contentEl.createDiv({ cls: 'biounix-config' });
    const loading = wrap.createDiv({ cls: 'biounix-resources-loading', text: '正在加载会话配置…' });
    modal.open();

    try {
      const healthy = await this.plugin.api.health();
      if (!healthy) {
        loading.setText('无法连接 BioUnix 主程序（API 未启动）。请先启动 BioUnix 桌面应用。');
        return;
      }
      const res = await this.plugin.api.getSession(this.sessionId);
      if (!res.ok) {
        loading.setText(`加载失败: ${res.error || '未知错误'}`);
        return;
      }
      const s = res.session as BioUnixSession | undefined;
      if (!s) {
        loading.setText('后端未返回会话数据');
        return;
      }
      loading.remove();

      // 基本信息
      const basic = wrap.createDiv({ cls: 'biounix-resources-section' });
      basic.createEl('div', { cls: 'biounix-resources-section-title', text: '基本信息' });
      const basicGrid = basic.createDiv({ cls: 'biounix-resources-grid' });
      const modeLabel = s.mode === 'agent' ? 'Agent' : s.mode === 'chat' ? 'Chat' : (s.mode || '-');
      basicGrid.createEl('div', { cls: 'biounix-resources-metric', text: `模式: ${modeLabel}` });
      basicGrid.createEl('div', { cls: 'biounix-resources-metric', text: `模型: ${s.model || s.apiConfig?.model || '-'}` });
      const started = s.startedAt ? new Date(s.startedAt).toLocaleString('zh-CN', { hour12: false }) : '-';
      basicGrid.createEl('div', { cls: 'biounix-resources-metric', text: `创建: ${started}` });
      basicGrid.createEl('div', { cls: 'biounix-resources-metric', text: `ID: ${s.id.slice(0, 8)}`, attr: { title: s.id } });
      if (s.activeTaskCount && s.activeTaskCount > 0) {
        basicGrid.createEl('div', { cls: 'biounix-resources-metric', text: `活动任务: ${s.activeTaskCount}` });
      }

      // 工作空间
      const wsSection = wrap.createDiv({ cls: 'biounix-resources-section' });
      wsSection.createEl('div', { cls: 'biounix-resources-section-title', text: '工作空间' });
      const ws = s.workspace;
      if (!ws) {
        wsSection.createEl('div', { cls: 'biounix-resources-metric', text: '未设置（默认本机）' });
      } else {
        const kindLabel = ws.kind === 'local' ? '本机' : ws.kind === 'remote' ? (ws.isSlurm ? '远程 Slurm' : '远程服务器') : ws.kind === 'wsl' ? 'WSL' : ws.kind;
        const wsGrid = wsSection.createDiv({ cls: 'biounix-resources-grid' });
        wsGrid.createEl('div', { cls: 'biounix-resources-metric', text: `类型: ${kindLabel}` });
        if (ws.path) wsGrid.createEl('div', { cls: 'biounix-resources-metric', text: `路径: ${ws.path}`, attr: { title: ws.path } });
        if (ws.ssh) {
          wsGrid.createEl('div', { cls: 'biounix-resources-metric', text: `主机: ${ws.ssh.username}@${ws.ssh.host}${ws.ssh.port ? ':' + ws.ssh.port : ''}` });
          if (ws.ssh.auth_type) wsGrid.createEl('div', { cls: 'biounix-resources-metric', text: `认证: ${ws.ssh.auth_type}` });
          if (ws.ssh.key_path) wsGrid.createEl('div', { cls: 'biounix-resources-metric', text: `密钥: ${ws.ssh.key_path}`, attr: { title: ws.ssh.key_path } });
        }
        if (ws.wsl?.dist) wsGrid.createEl('div', { cls: 'biounix-resources-metric', text: `发行版: ${ws.wsl.dist}` });
      }

      // API 配置
      const apiSection = wrap.createDiv({ cls: 'biounix-resources-section' });
      apiSection.createEl('div', { cls: 'biounix-resources-section-title', text: 'API 配置' });
      const api = s.apiConfig;
      if (!api) {
        apiSection.createEl('div', { cls: 'biounix-resources-metric', text: '未配置' });
      } else {
        const apiGrid = apiSection.createDiv({ cls: 'biounix-resources-grid' });
        apiGrid.createEl('div', { cls: 'biounix-resources-metric', text: `提供商: ${api.provider || '-'}` });
        apiGrid.createEl('div', { cls: 'biounix-resources-metric', text: `模型: ${api.model || '-'}` });
        if (api.customEndpoint) apiGrid.createEl('div', { cls: 'biounix-resources-metric', text: `端点: ${api.customEndpoint}`, attr: { title: api.customEndpoint } });
        // apiKey 部分掩码显示
        const key = api.apiKey || '';
        const masked = key.length > 8 ? key.slice(0, 4) + '****' + key.slice(-4) : (key ? '****' : '-');
        apiGrid.createEl('div', { cls: 'biounix-resources-metric', text: `密钥: ${masked}`, attr: { title: key ? `已配置（${key.length} 字符）` : '未配置' } });
        if (api.language) apiGrid.createEl('div', { cls: 'biounix-resources-metric', text: `语言: ${api.language === 'zh' ? '中文' : 'English'}` });
        if (api.contextLimitOverride) apiGrid.createEl('div', { cls: 'biounix-resources-metric', text: `上下文上限: ${api.contextLimitOverride}` });
        if (api.maxRounds) apiGrid.createEl('div', { cls: 'biounix-resources-metric', text: `最大轮次: ${api.maxRounds}` });
        if (s.commandInterval && s.commandInterval > 0) apiGrid.createEl('div', { cls: 'biounix-resources-metric', text: `命令间隔: ${s.commandInterval}ms` });
      }

      // 启用范围（工具/技能/流程）
      const scopeSection = wrap.createDiv({ cls: 'biounix-resources-section' });
      scopeSection.createEl('div', { cls: 'biounix-resources-section-title', text: '启用范围' });
      const scopeGrid = scopeSection.createDiv({ cls: 'biounix-resources-grid' });
      const tools = s.enabledTools;
      scopeGrid.createEl('div', { cls: 'biounix-resources-metric', text: `工具: ${!tools || tools.length === 0 ? '全部' : `${tools.length} 项`}`, attr: { title: tools && tools.length > 0 ? tools.join(', ') : '未限制（全部启用）' } });
      const skills = s.enabledSkills;
      scopeGrid.createEl('div', { cls: 'biounix-resources-metric', text: `技能: ${!skills || skills.length === 0 ? '全部' : `${skills.length} 项`}`, attr: { title: skills && skills.length > 0 ? skills.join(', ') : '未限制（全部启用）' } });
      const pipes = s.enabledPipelines;
      scopeGrid.createEl('div', { cls: 'biounix-resources-metric', text: `流程: ${!pipes || pipes.length === 0 ? '全部' : `${pipes.length} 项`}`, attr: { title: pipes && pipes.length > 0 ? pipes.join(', ') : '未限制（全部启用）' } });

      // 可用模型列表（如有缓存）
      if (api?.availableModels && api.availableModels.length > 0) {
        const modelsSection = wrap.createDiv({ cls: 'biounix-resources-section' });
        modelsSection.createEl('div', { cls: 'biounix-resources-section-title', text: `可用模型（${api.availableModels.length}）` });
        const mList = modelsSection.createDiv({ cls: 'biounix-resources-grid' });
        api.availableModels.slice(0, 24).forEach(m => {
          const isCurrent = m === api.model;
          mList.createEl('div', { cls: `biounix-resources-metric${isCurrent ? ' biounix-config-current' : ''}`, text: (isCurrent ? '● ' : '') + m, attr: { title: m + (isCurrent ? '（当前）' : '') } });
        });
        if (api.availableModels.length > 24) {
          modelsSection.createEl('div', { cls: 'biounix-resources-section-subtitle', text: `…还有 ${api.availableModels.length - 24} 个模型未显示` });
        }
      }
    } catch (e) {
      loading.setText(`加载失败: ${(e as Error).message}`);
    }
  }

  /** 渲染单个工具调用卡片 */
  private renderToolCallCard(parent: HTMLElement, tc: ToolCallInfo): void {
    const isFileEdit = FILE_EDIT_TOOLS.has(tc.toolName);
    const card = parent.createDiv({ cls: `biounix-tool-card ${isFileEdit ? 'is-file-edit' : ''}` });

    // 解析参数与结果
    let parsedArgs: any = {};
    try { if (tc.args) parsedArgs = JSON.parse(tc.args); } catch { /* */ }
    let parsedResult: any = null;
    try { if (tc.result) parsedResult = JSON.parse(tc.result); } catch { /* */ }

    // 头部行
    const head = card.createDiv({ cls: 'biounix-tool-card-head' });
    const statusIcon = head.createEl('span', { cls: 'biounix-tool-card-status' });
    if (tc.status === 'running') {
      statusIcon.setText('⏳');
      statusIcon.addClass('is-running');
    } else if (tc.status === 'done') {
      statusIcon.setText('✅');
    } else if (tc.status === 'error') {
      statusIcon.setText('❌');
    } else {
      statusIcon.setText('⚠️');
    }
    head.createEl('span', { text: tc.toolName, cls: 'biounix-tool-card-name' });

    // 文件路径徽章
    const filePath: string | undefined = parsedResult?.path || parsedArgs?.path;
    if (filePath) {
      const pathBadge = head.createEl('span', { cls: 'biounix-tool-card-path' });
      const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
      pathBadge.setText(fileName);
      pathBadge.setAttribute('title', filePath);
    }

    // 撤销状态徽章
    const undoState: string | undefined = parsedResult?.undo_state;
    const isUndone = undoState === 'undone';
    if (isUndone) {
      head.createEl('span', { text: '已撤销', cls: 'biounix-tool-card-undone-badge' });
    }

    // 时间
    head.createEl('span', {
      text: new Date(tc.timestamp).toLocaleTimeString('zh-CN', { hour12: false }),
      cls: 'biounix-tool-card-time',
    });

    // 文件编辑的撤销/重做按钮
    if (isFileEdit && tc.status === 'done' && this.sessionId) {
      const btns = card.createDiv({ cls: 'biounix-tool-card-btns' });
      const canUndo = parsedResult?.can_undo === true && parsedResult?.backup_id && !isUndone;
      const canRedo = isUndone;

      if (canUndo) {
        const undoBtn = btns.createEl('button', {
          cls: 'biounix-tool-card-btn is-undo',
          attr: { title: '撤销此编辑' },
        });
        setIcon(undoBtn, 'undo');
        undoBtn.createEl('span', { text: '撤销' });
        undoBtn.onclick = (e) => {
          e.stopPropagation();
          void this.handleUndo(tc.toolCallId);
        };
      }
      if (canRedo) {
        const redoBtn = btns.createEl('button', {
          cls: 'biounix-tool-card-btn is-redo',
          attr: { title: '重做此编辑' },
        });
        setIcon(redoBtn, 'redo');
        redoBtn.createEl('span', { text: '重做' });
        redoBtn.onclick = (e) => {
          e.stopPropagation();
          void this.handleRedo(tc.toolCallId);
        };
      }
    }

    // 文件编辑 diff 摘要（展开区）
    if (isFileEdit && tc.status === 'done' && parsedResult) {
      const diffEl = card.createDiv({ cls: 'biounix-tool-card-diff' });
      if (parsedResult.deleted_file === true) {
        // write_file 创建后被撤销删除 → 显示已删除
        diffEl.createEl('span', { text: '文件已删除（撤销创建）', cls: 'biounix-tool-card-deleted' });
      } else if (parsedResult.bytes_after !== undefined) {
        const bytesBefore = parsedResult.bytes_before ?? 0;
        const bytesAfter = parsedResult.bytes_after ?? 0;
        const delta = bytesAfter - bytesBefore;
        const sign = delta >= 0 ? '+' : '';
        const summarySpan = diffEl.createEl('span', {
          text: `${bytesBefore} → ${bytesAfter} 字节（${sign}${delta}）`,
          cls: 'biounix-tool-card-bytes',
        });
        // 异步加载完整内容并渲染行级 diff
        if (this.sessionId) {
          summarySpan.createEl('span', { text: ' · 加载 diff…', cls: 'biounix-tool-card-diff-loading' });
          this.plugin.api.getFileBackup(this.sessionId, tc.toolCallId).then((res: any) => {
            if (res.ok && res.backup && (res.backup.contentBefore !== undefined || res.backup.contentAfter !== undefined)) {
              diffEl.empty();
              this.renderLineDiff(diffEl, res.backup.contentBefore || '', res.backup.contentAfter || '');
            } else {
              summarySpan.setText(`${bytesBefore} → ${bytesAfter} 字节（${sign}${delta}）`);
            }
          }).catch(() => {
            summarySpan.setText(`${bytesBefore} → ${bytesAfter} 字节（${sign}${delta}）`);
          });
        }
      }
    }

    // 折叠的参数/结果详情（点击头部展开）
    const detailEl = card.createDiv({ cls: 'biounix-tool-card-detail' });
    detailEl.setCssProps({ display: 'none' });
    if (tc.args) {
      detailEl.createDiv({ cls: 'biounix-tool-card-detail-label', text: '输入' });
      detailEl.createEl('pre', { cls: 'biounix-tool-card-pre', text: tc.args });
    }
    if (tc.result) {
      detailEl.createDiv({ cls: 'biounix-tool-card-detail-label', text: '输出' });
      let resultText = tc.result;
      try { resultText = JSON.stringify(JSON.parse(tc.result), null, 2); } catch { /* */ }
      detailEl.createEl('pre', { cls: 'biounix-tool-card-pre', text: resultText });
    }
    head.onclick = () => {
      detailEl.style.display = detailEl.style.display === 'none' ? 'block' : 'none';
    };
  }

  /** 渲染行级 diff（红绿高亮） */
  private renderLineDiff(parent: HTMLElement, before: string, after: string): void {
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    // 简单 LCS 行级 diff
    const diffs = this.computeLineDiff(beforeLines, afterLines);
    const diffWrap = parent.createDiv({ cls: 'biounix-line-diff' });
    let added = 0, removed = 0;
    for (const d of diffs) {
      const row = diffWrap.createDiv({ cls: `biounix-diff-row biounix-diff-${d.type}` });
      const prefix = d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' ';
      row.createEl('span', { text: prefix, cls: 'biounix-diff-prefix' });
      row.createEl('span', { text: d.text, cls: 'biounix-diff-text' });
      if (d.type === 'add') added++;
      if (d.type === 'del') removed++;
    }
    // 顶部摘要
    const summary = parent.createDiv({ cls: 'biounix-diff-summary' });
    summary.createEl('span', { text: `+${added}`, cls: 'biounix-diff-add-count' });
    summary.createEl('span', { text: ` -${removed}`, cls: 'biounix-diff-del-count' });
    parent.insertBefore(summary, diffWrap);
  }

  /** 计算行级 diff（基于 LCS） */
  private computeLineDiff(a: string[], b: string[]): Array<{ type: 'add' | 'del' | 'ctx'; text: string }> {
    const n = a.length, m = b.length;
    // DP 表
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const result: Array<{ type: 'add' | 'del' | 'ctx'; text: string }> = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { result.push({ type: 'ctx', text: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { result.push({ type: 'del', text: a[i] }); i++; }
      else { result.push({ type: 'add', text: b[j] }); j++; }
    }
    while (i < n) { result.push({ type: 'del', text: a[i] }); i++; }
    while (j < m) { result.push({ type: 'add', text: b[j] }); j++; }
    return result;
  }

  /** 撤销文件编辑 */
  private async handleUndo(toolCallId: string): Promise<void> {
    if (!this.sessionId) return;
    try {
      const res = await this.plugin.api.undoFileEdit(this.sessionId, toolCallId);
      if (res.ok) {
        new Notice('已撤销文件编辑');
        // 更新本地 toolCalls 状态
        this.updateToolCallUndoState(toolCallId, 'undone', res.deletedFile as boolean | undefined);
      } else {
        new Notice(`撤销失败: ${res.error || '未知错误'}`);
      }
    } catch (e) {
      new Notice(`撤销失败: ${(e as Error).message}`);
    }
  }

  /** 重做文件编辑 */
  private async handleRedo(toolCallId: string): Promise<void> {
    if (!this.sessionId) return;
    try {
      const res = await this.plugin.api.redoFileEdit(this.sessionId, toolCallId);
      if (res.ok) {
        new Notice('已重做文件编辑');
        this.updateToolCallUndoState(toolCallId, 'redone');
      } else {
        new Notice(`重做失败: ${res.error || '未知错误'}`);
      }
    } catch (e) {
      new Notice(`重做失败: ${(e as Error).message}`);
    }
  }

  /** 更新某 toolCall 的撤销状态并重渲染 */
  private updateToolCallUndoState(toolCallId: string, undoState: 'undone' | 'redone', deletedFile?: boolean): void {
    for (const msg of this.messages) {
      if (!msg.toolCalls) continue;
      const tc = msg.toolCalls.find(t => t.toolCallId === toolCallId);
      if (tc) {
        let parsed: any = {};
        try { if (tc.result) parsed = JSON.parse(tc.result); } catch { /* */ }
        parsed.undo_state = undoState;
        parsed.undone = undoState === 'undone';
        if (deletedFile !== undefined) parsed.deleted_file = deletedFile;
        tc.result = JSON.stringify(parsed);
        tc.status = 'done';
      }
    }
    this.renderMessages();
  }

  /** 搜索栏元素 */
  private searchbarEl: HTMLElement | null = null;
  private searchInputEl: HTMLInputElement | null = null;
  /** 挂载的上下文笔记（每轮对话自动注入） */
  private mountedNotes: Array<{ path: string; content: string }> = [];
  private mountedNotesEl: HTMLElement | null = null;

  /** 打开笔记挂载选择器 */
  private openNoteMountPicker(): void {
    const modal = new Modal(this.app);
    modal.setTitle('挂载上下文笔记');
    modal.setContent('');

    const searchEl = modal.contentEl.createEl('input', {
      cls: 'biounix-mount-search',
      attr: { type: 'text', placeholder: '搜索笔记…' },
    });

    const listEl = modal.contentEl.createDiv({ cls: 'biounix-mount-list' });
    const allFiles = this.app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path));
    const alreadyPaths = new Set(this.mountedNotes.map(n => n.path));

    const render = (filter: string) => {
      listEl.empty();
      const f = filter.trim().toLowerCase();
      allFiles
        .filter(file => !f || file.path.toLowerCase().includes(f))
        .slice(0, 100)
        .forEach(file => {
          const isMounted = alreadyPaths.has(file.path);
          const item = listEl.createDiv({ cls: `biounix-mount-item${isMounted ? ' is-mounted' : ''}` });
          item.createEl('span', { cls: 'biounix-mount-item-icon' }).setText(isMounted ? '✓' : '○');
          item.createEl('span', { cls: 'biounix-mount-item-path', text: file.path });
          item.onclick = async () => {
            if (isMounted) {
              this.removeMountedNote(file.path);
            } else {
              const content = await this.app.vault.read(file);
              this.addMountedNote(file.path, content);
              alreadyPaths.add(file.path);
            }
            modal.close();
          };
        });
      if (listEl.children.length === 0) {
        listEl.createEl('div', { cls: 'biounix-mount-empty', text: '无匹配笔记' });
      }
    };
    searchEl.addEventListener('input', () => render(searchEl.value));
    render('');
    searchEl.focus();
    modal.open();
  }

  /** 添加挂载笔记 */
  private addMountedNote(path: string, content: string): void {
    if (this.mountedNotes.some(n => n.path === path)) return;
    this.mountedNotes.push({ path, content });
    this.renderMountedNotes();
    new Notice(`已挂载: ${path}`);
  }

  /** 移除挂载笔记 */
  private removeMountedNote(path: string): void {
    this.mountedNotes = this.mountedNotes.filter(n => n.path !== path);
    this.renderMountedNotes();
    new Notice(`已卸载: ${path}`);
  }

  /** 渲染挂载笔记标签条 */
  private renderMountedNotes(): void {
    if (!this.mountedNotesEl) return;
    this.mountedNotesEl.empty();
    if (this.mountedNotes.length === 0) {
      this.mountedNotesEl.setCssProps({ display: 'none' });
      return;
    }
    this.mountedNotesEl.setCssProps({ display: 'flex' });
    this.mountedNotesEl.createEl('span', { cls: 'biounix-mounted-notes-label', text: '📎 上下文:' });
    this.mountedNotes.forEach(note => {
      const tag = this.mountedNotesEl!.createDiv({ cls: 'biounix-mounted-note-tag' });
      tag.createEl('span', { cls: 'biounix-mounted-note-name', text: note.path.split('/').pop() || note.path, attr: { title: note.path } });
      const rmBtn = tag.createEl('button', { cls: 'biounix-mounted-note-rm', attr: { 'aria-label': '移除' } });
      setIcon(rmBtn, 'x');
      rmBtn.onclick = () => this.removeMountedNote(note.path);
    });
  }

  /** 构建笔记上下文前缀（发送时拼到消息前，每次重新读取最新内容）
   *  仅在存在笔记上下文（当前活动 md 笔记或已挂载笔记）时才注入运行环境说明，
   *  避免每次闲聊都注入冗余的系统提示。
   *  ★ 关键：笔记内容在本地 vault，远程/WSL 会话的 run_command 在远端执行，
   *    无法 cat 本地路径，因此直接注入笔记全文内容（而非传路径让 agent 自行读取）。
   *    本地会话也统一注入内容，省去 agent 多一次 cat 调用。 */
  private async buildContextPrefix(): Promise<string> {
    // ★ 当前活动笔记：读取最新内容（用户可能在发送前编辑过）
    const af = this.app.workspace.getActiveFile();
    const hasCurrent = af && af.extension === 'md';
    const hasMounted = this.mountedNotes.length > 0;
    // 无任何笔记上下文时不注入，直接返回原文（避免每次闲聊都带系统提示）
    if (!hasCurrent && !hasMounted) return '';
    // 单篇笔记内容截断上限（防止超大笔记撑爆上下文）
    const MAX_NOTE_CHARS = 12000;
    const truncate = (s: string): string => s.length > MAX_NOTE_CHARS ? s.slice(0, MAX_NOTE_CHARS) + '\n...（已截断，共 ' + s.length + ' 字符）' : s;
    const sections: string[] = [];
    // ★ 来源标识：告知 agent 运行环境为 Obsidian 插件，笔记内容已直接提供
    sections.push(`【运行环境】\n你正在 Obsidian 笔记软件的 BioUnix 插件中与用户对话。下方"当前笔记"和"挂载笔记"的内容已直接提供，无需再用 run_command 读取。`);
    if (hasCurrent) {
      try {
        const content = await this.app.vault.read(af!);
        sections.push(`【当前笔记】 ${af!.path}\n${truncate(content)}`);
      } catch { /* 读取失败则跳过 */ }
    }
    // 已挂载笔记：直接注入内容（挂载时已 vault.read 读取，这里用缓存的 content）
    if (hasMounted) {
      const blocks = this.mountedNotes.map(n => `### ${n.path}\n${truncate(n.content)}`);
      sections.push(`【挂载笔记】\n${blocks.join('\n\n')}`);
    }
    sections.push(`【用户消息】\n`);
    return sections.join('\n\n');
  }

  /** 切换搜索模式 */
  private toggleSearch(): void {
    if (this.searchbarEl) {
      this.closeSearch();
      return;
    }
    const bar = this.containerEl.createDiv({ cls: 'biounix-search-bar' });
    this.searchbarEl = bar;
    const input = bar.createEl('input', {
      type: 'text',
      cls: 'biounix-search-input',
      attr: { placeholder: '搜索消息内容（支持正则）…' },
    });
    this.searchInputEl = input;
    const counter = bar.createEl('span', { cls: 'biounix-search-counter', text: '0/0' });
    const prevBtn = bar.createEl('button', { cls: 'biounix-search-nav-btn', attr: { title: '上一个' } });
    setIcon(prevBtn, 'chevron-up');
    const nextBtn = bar.createEl('button', { cls: 'biounix-search-nav-btn', attr: { title: '下一个' } });
    setIcon(nextBtn, 'chevron-down');
    const closeBtn = bar.createEl('button', { cls: 'biounix-search-nav-btn', attr: { title: '关闭' } });
    setIcon(closeBtn, 'x');
    input.addEventListener('input', () => {
      this.searchQuery = input.value;
      this.doSearch();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.searchJump(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { this.closeSearch(); }
    });
    prevBtn.onclick = () => this.searchJump(-1);
    nextBtn.onclick = () => this.searchJump(1);
    closeBtn.onclick = () => this.closeSearch();
    input.focus();
  }

  /** 关闭搜索 */
  private closeSearch(): void {
    if (this.searchbarEl) { this.searchbarEl.remove(); this.searchbarEl = null; }
    this.searchInputEl = null;
    this.searchMode = false;
    this.searchQuery = '';
    this.searchMatches = [];
    this.searchCursor = -1;
    this.renderMessages();
  }

  /** 执行搜索，收集匹配的消息索引 */
  private doSearch(): void {
    const q = this.searchQuery.trim();
    if (!q) {
      this.searchMatches = [];
      this.searchCursor = -1;
      this.updateSearchCounter();
      this.renderMessages();
      return;
    }
    this.searchMode = true;
    let regex: RegExp;
    try {
      // 不用 g flag（只需判断是否匹配，避免 lastIndex 状态陷阱）
      regex = new RegExp(q, 'i');
    } catch {
      // 非法正则，退化为字面匹配
      regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    this.searchMatches = [];
    this.messages.forEach((m, i) => {
      if (regex.test(m.content)) this.searchMatches.push(i);
    });
    this.searchCursor = this.searchMatches.length > 0 ? 0 : -1;
    this.updateSearchCounter();
    this.renderMessages();
    if (this.searchCursor >= 0) this.scrollToMatch(this.searchCursor);
  }

  /** 更新搜索计数显示 */
  private updateSearchCounter(): void {
    if (!this.searchbarEl) return;
    const counter = this.searchbarEl.querySelector('.biounix-search-counter');
    if (counter) {
      const total = this.searchMatches.length;
      const cur = this.searchCursor >= 0 ? this.searchCursor + 1 : 0;
      counter.textContent = `${cur}/${total}`;
    }
  }

  /** 跳转到上/下一个匹配 */
  private searchJump(delta: number): void {
    if (this.searchMatches.length === 0) return;
    this.searchCursor = (this.searchCursor + delta + this.searchMatches.length) % this.searchMatches.length;
    this.updateSearchCounter();
    this.scrollToMatch(this.searchCursor);
    this.renderMessages();
  }

  /** 滚动到指定匹配消息 */
  private scrollToMatch(matchIdx: number): void {
    const msgIdx = this.searchMatches[matchIdx];
    if (msgIdx === undefined) return;
    const bubbles = this.messageEl?.querySelectorAll('.biounix-chat-bubble');
    if (bubbles && bubbles[msgIdx]) {
      (bubbles[msgIdx] as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /** 高亮搜索关键词 */
  /** 高亮搜索关键词（直接向容器追加文本与 <mark> 节点，避免 innerHTML） */
  private appendHighlighted(container: HTMLElement, text: string): void {
    container.empty();
    if (!this.searchMode || !this.searchQuery.trim()) {
      container.setText(text);
      return;
    }
    const q = this.searchQuery.trim();
    let regex: RegExp;
    try { regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'); } catch { container.setText(text); return; }
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      if (m.index > last) container.appendText(text.slice(last, m.index));
      const mark = container.createEl('mark', { cls: 'biounix-search-hit', text: m[0] });
      mark.classList.add('biounix-search-hit');
      last = m.index + m[0].length;
      if (m[0].length === 0) regex.lastIndex++; // 防止零宽匹配死循环
    }
    if (last < text.length) container.appendText(text.slice(last));
  }

  /** HTML 转义 */
  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** 切换会话列表面板显示 */
  private async toggleSessionPanel(): Promise<void> {
    if (this.sessionPanelEl) {
      this.sessionPanelEl.remove();
      this.sessionPanelEl = null;
      return;
    }
    const panel = this.containerEl.createDiv({ cls: 'biounix-session-panel' });
    this.sessionPanelEl = panel;
    // 搜索框
    const searchBox = panel.createEl('input', {
      type: 'text',
      cls: 'biounix-session-search',
      attr: { placeholder: '搜索会话…' },
    });
    // 列表容器
    const listEl = panel.createDiv({ cls: 'biounix-session-list' });
    const renderList = (filter: string) => {
      void this.renderSessionList(listEl, filter);
    };
    searchBox.addEventListener('input', () => renderList(searchBox.value));
    renderList('');
    searchBox.focus();
  }

  /** 渲染会话列表 */
  private async renderSessionList(listEl: HTMLElement, filter: string): Promise<void> {
    listEl.empty();
    listEl.createEl('div', { text: '加载中…', cls: 'biounix-session-loading' });
    try {
      const res = await this.plugin.api.listSessions();
      if (!res.ok || !res.sessions) {
        listEl.empty();
        listEl.createEl('div', { text: '加载失败', cls: 'biounix-session-error' });
        return;
      }
      let sessions = res.sessions as Array<{
        id: string; name: string; model: string | null;
        mode: string; messageCount: number; startedAt: number; updatedAt?: number;
      }>;
      // 按 updatedAt DESC（readSessionIndex 已排序，兜底再排一次）
      sessions.sort((a, b) => (b.updatedAt || b.startedAt) - (a.updatedAt || a.startedAt));
      // 过滤
      if (filter.trim()) {
        const q = filter.toLowerCase();
        sessions = sessions.filter(s =>
          s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)
        );
      }
      listEl.empty();
      if (sessions.length === 0) {
        listEl.createEl('div', { text: '暂无会话', cls: 'biounix-session-empty' });
        return;
      }
      for (const s of sessions) {
        const isCurrent = s.id === this.sessionId;
        const item = listEl.createDiv({ cls: `biounix-session-item${isCurrent ? ' is-current' : ''}` });
        const top = item.createDiv({ cls: 'biounix-session-item-top' });
        top.createEl('span', { text: s.name, cls: 'biounix-session-item-name' });
        const meta = item.createDiv({ cls: 'biounix-session-item-meta' });
        const model = s.model || '未知模型';
        const mode = s.mode === 'agent' ? 'Agent' : 'Chat';
        const time = new Date(s.updatedAt || s.startedAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        meta.createEl('span', { text: `${model} · ${mode} · ${s.messageCount}条`, cls: 'biounix-session-item-info' });
        meta.createEl('span', { text: time, cls: 'biounix-session-item-time' });
        // 操作按钮（删除）
        const delBtn = item.createEl('button', { cls: 'biounix-session-item-del', attr: { title: '删除会话' } });
        setIcon(delBtn, 'trash');
        delBtn.onclick = (e) => {
          e.stopPropagation();
          this.deleteSession(s.id, s.name);
        };
        item.onclick = () => this.switchSession(s.id);
      }
    } catch (e) {
      listEl.empty();
      listEl.createEl('div', { text: `加载失败: ${(e as Error).message}`, cls: 'biounix-session-error' });
    }
  }

  /** 切换到指定会话 */
  private async switchSession(sessionId: string): Promise<void> {
    if (sessionId === this.sessionId) {
      if (this.sessionPanelEl) { this.sessionPanelEl.remove(); this.sessionPanelEl = null; }
      return;
    }
    // 停止当前流
    if (this.streaming && this.sessionId) {
      void this.plugin.api.stopSession(this.sessionId).catch(() => { });
    }
    this.sessionId = sessionId;
    this.messages = [];
    this.streaming = false;
    // 加载会话信息
    try {
      const infoRes = await this.plugin.api.getSession(sessionId);
      if (infoRes.ok && infoRes.session) {
        const s = infoRes.session as any;
        this.sessionInfo = {
          provider: s.apiConfig?.provider || 'unknown',
          model: s.model || 'unknown',
          mode: s.mode || 'agent',
          workspaceKind: (s.workspace?.kind === 'remote' ? 'remote' : s.workspace?.kind === 'wsl' ? 'wsl' : 'local') as 'local' | 'remote' | 'wsl',
        };
        this.sessionName = s.name || `会话 ${s.id.slice(0, 8)}`;
      }
    } catch { /* ignore */ }
    // 加载消息
    try {
      const msgRes = await this.plugin.api.getMessages(sessionId);
      if (msgRes.ok && msgRes.messages) {
        this.messages = msgRes.messages.map((m: BioUnixMessage) => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          reasoning: m.reasoning,
          toolCalls: m.tool_calls ? m.tool_calls.map((tc) => ({
            toolCallId: tc.id,
            toolName: tc.function.name,
            status: 'done' as const,
            args: tc.function.arguments,
            timestamp: m.timestamp,
          })) : undefined,
        }));
      }
    } catch { /* ignore */ }
    this.connectWS();
    this.updateStatus();
    this.renderMessages();
    // 关闭面板
    if (this.sessionPanelEl) { this.sessionPanelEl.remove(); this.sessionPanelEl = null; }
    new Notice(`已切换到: ${this.sessionName}`);
  }

  /** 删除会话 */
  private async deleteSession(sessionId: string, name: string): Promise<void> {
    if (this.streaming && sessionId === this.sessionId) {
      new Notice('正在生成中，请先停止后再删除当前会话');
      return;
    }
    const confirmed = await new Promise<boolean>((resolve) => {
      const modal = new Modal(this.app);
      modal.titleEl.setText('删除会话');
      modal.contentEl.createEl('p', { text: `确定删除会话「${name}」？此操作不可撤销。` });
      const btnRow = modal.contentEl.createDiv({ cls: 'biounix-confirm-btns' });
      btnRow.createEl('button', { text: '取消' }).addEventListener('click', () => { modal.close(); resolve(false); });
      btnRow.createEl('button', { text: '删除', cls: 'mod-warning' }).addEventListener('click', () => { modal.close(); resolve(true); });
      modal.open();
    });
    if (!confirmed) return;
    try {
      await this.plugin.api.deleteSession(sessionId);
      new Notice('已删除');
      // 若删除的是当前会话，清空
      if (sessionId === this.sessionId) {
        this.sessionId = null;
        this.sessionInfo = null;
        this.sessionName = '';
        this.messages = [];
        this.updateStatus();
        this.renderMessages();
      }
      // 刷新列表
      if (this.sessionPanelEl) {
        const listEl = this.sessionPanelEl.querySelector('.biounix-session-list');
        if (listEl) void this.renderSessionList(listEl as HTMLElement, '');
      }
    } catch (e) {
      new Notice(`删除失败: ${(e as Error).message}`);
    }
  }

  /** 显示快捷指令面板 */
  private showSlashMenu(): void {
    if (!this.inputEl) return;
    const commands: Array<{ cmd: string; label: string; desc: string }> = [
      { cmd: '/clear', label: '清空对话', desc: '删除当前会话所有消息' },
      { cmd: '/new', label: '新建会话', desc: '创建一个新的对话' },
      { cmd: '/export', label: '导出对话', desc: '导出为 Markdown 文件' },
      { cmd: '/rename', label: '重命名会话', desc: '修改当前会话名称' },
      { cmd: '/regen', label: '重新生成', desc: '重新生成最后一条回复' },
    ];
    if (this.slashMenu) this.slashMenu.close();
    this.slashMenu = new SlashMenu(this.inputEl, commands, (cmd) => {
      if (this.inputEl) this.inputEl.value = '';
      this.updateCharCount();
      this.executeSlashCommand(cmd);
    });
    this.slashMenu.open();
  }

  /** 执行快捷指令 */
  private async executeSlashCommand(cmd: string): Promise<void> {
    switch (cmd) {
      case '/clear':
        if (this.streaming) { new Notice('正在生成中，请先停止'); break; }
        try {
          if (this.sessionId) await this.plugin.api.clearSession(this.sessionId);
          this.messages = [];
          this.renderMessages();
          new Notice('已清空对话');
        } catch (e) {
          new Notice(`清空失败: ${(e as Error).message}`);
        }
        break;
      case '/new':
        await this.openCreateSessionModal();
        break;
      case '/export':
        this.exportConversation();
        break;
      case '/rename':
        await this.renameSession();
        break;
      case '/regen': {
        const lastAssistant = [...this.messages].reverse().find(m => m.role === 'assistant');
        const idx = lastAssistant ? this.messages.lastIndexOf(lastAssistant) : -1;
        if (idx >= 0) this.regenerateFrom(idx);
        else new Notice('没有可重新生成的回复');
        break;
      }
      default:
        new Notice('未知指令: ' + cmd);
    }
  }

  /** 更新状态栏显示 */
  private updateStatus(): void {
    if (!this.statusEl) return;
    this.statusEl.empty();
    if (!this.sessionId || !this.sessionInfo) {
      this.statusEl.createEl('span', { text: '⚪ 未连接', cls: 'biounix-status-disconnected' });
      return;
    }
    // 会话名（点击可重命名）
    const nameSpan = this.statusEl.createEl('span', {
      text: this.sessionName,
      cls: 'biounix-status-session-name',
      attr: { title: '点击重命名会话' },
    });
    nameSpan.onclick = () => this.renameSession();
    this.statusEl.createEl('span', { text: ' · ', cls: 'biounix-status-sep' });
    this.statusEl.createEl('span', {
      text: `🟢 ${this.sessionInfo.provider} · ${this.sessionInfo.model} · ${this.sessionInfo.mode === 'agent' ? 'Agent' : 'Chat'}`,
      cls: 'biounix-status-connected',
    });
    this.statusEl.createEl('span', {
      text: `· ${this.sessionId.slice(0, 8)}`,
      cls: 'biounix-status-sid',
    });
    if (this.streaming) {
      this.statusEl.createEl('span', { text: ' · 生成中…', cls: 'biounix-status-streaming' });
    }
  }

  /** 重命名当前会话 */
  private async renameSession(): Promise<void> {
    if (!this.sessionId) return;
    const newName = await new Promise<string | null>((resolve) => {
      const modal = new Modal(this.app);
      modal.titleEl.setText('重命名会话');
      const input = modal.contentEl.createEl('input', {
        type: 'text',
        value: this.sessionName,
        cls: 'biounix-rename-input',
      });
      input.setCssProps({ width: '100%', padding: '8px', marginTop: '12px' });
      input.focus();
      input.select();
      const btnRow = modal.contentEl.createDiv({ cls: 'biounix-rename-btns' });
      btnRow.setCssProps({ marginTop: '12px', textAlign: 'right' });
      const cancelBtn = btnRow.createEl('button', { text: '取消' });
      cancelBtn.setCssProps({ marginRight: '8px' });
      const okBtn = btnRow.createEl('button', { text: '确定', cls: 'mod-cta' });
      cancelBtn.onclick = () => { modal.close(); resolve(null); };
      okBtn.onclick = () => { modal.close(); resolve(input.value); };
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { modal.close(); resolve(input.value); } });
      modal.open();
    });
    if (!newName || newName === this.sessionName) return;
    try {
      await this.plugin.api.updateSession(this.sessionId, { name: newName });
      this.sessionName = newName;
      this.updateStatus();
      new Notice('已重命名');
    } catch (e) {
      new Notice('重命名失败: ' + (e as Error).message);
    }
  }

  async onClose(): Promise<void> {
    // 清理 Markdown 组件
    if (this.mdComponent) {
      this.mdComponent.unload();
      this.mdComponent = null;
    }
    if (this.slashMenu) this.slashMenu.close();
  }
}

/** 快捷指令下拉面板 */
class SlashMenu {
  private el: HTMLElement | null = null;
  private items: Array<{ cmd: string; label: string; desc: string }>;
  private onSelect: (cmd: string) => void;
  private cursorIdx = 0;
  private itemEls: HTMLElement[] = [];

  constructor(
    private inputEl: HTMLTextAreaElement,
    commands: Array<{ cmd: string; label: string; desc: string }>,
    onSelect: (cmd: string) => void,
  ) {
    this.items = commands;
    this.onSelect = onSelect;
  }

  get isOpen(): boolean { return this.el !== null; }

  open(): void {
    this.close();
    this.el = document.body.createDiv({ cls: 'biounix-slash-menu' });
    this.items.forEach((item, i) => {
      const row = this.el!.createDiv({ cls: `biounix-slash-item${i === 0 ? ' is-active' : ''}` });
      row.createEl('span', { text: item.cmd, cls: 'biounix-slash-cmd' });
      row.createEl('span', { text: item.label, cls: 'biounix-slash-label' });
      row.createEl('span', { text: item.desc, cls: 'biounix-slash-desc' });
      row.onclick = () => { this.select(i); };
      this.itemEls.push(row);
    });
    this.cursorIdx = 0;
    this.position();
  }

  close(): void {
    if (this.el) { this.el.remove(); this.el = null; }
    this.itemEls = [];
  }

  private position(): void {
    if (!this.el) return;
    const rect = this.inputEl.getBoundingClientRect();
    this.el.style.left = `${rect.left}px`;
    this.el.style.top = `${rect.top - this.el.offsetHeight - 4}px`;
    this.el.style.minWidth = `${rect.width}px`;
  }

  moveCursor(delta: number): void {
    this.cursorIdx = (this.cursorIdx + delta + this.items.length) % this.items.length;
    this.itemEls.forEach((el, i) => el.toggleClass('is-active', i === this.cursorIdx));
  }

  selectCurrent(): void { this.select(this.cursorIdx); }

  private select(i: number): void {
    const item = this.items[i];
    this.close();
    this.onSelect(item.cmd);
  }
}
