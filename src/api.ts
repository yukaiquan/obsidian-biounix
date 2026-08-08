/**
 * BioUnix API 客户端 — HTTP + WebSocket 封装
 */
import { requestUrl } from 'obsidian';
import type { BioUnixSettings } from './settings';

// Obsidian 桌面端运行在 Electron，可访问 Node.js API 读取 vault 外的 token 文件
// isDesktopOnly: true 保证这些 API 可用
import * as nodeFs from 'fs';
import * as nodePath from 'path';
import * as nodeOs from 'os';

/** BioUnix 应用数据目录（与后端 getAppDataDir() 保持一致） */
function getBioUnixDataDir(): string {
  const home = nodeOs.homedir();
  if (process.platform === 'darwin') {
    return nodePath.join(home, 'Library', 'Application Support', 'biounix');
  } else if (process.platform === 'win32') {
    return nodePath.join(process.env.APPDATA || nodePath.join(home, 'AppData', 'Roaming'), 'biounix');
  }
  return nodePath.join(home, '.local', 'share', 'biounix');
}

/** 从 BioUnix 应用数据目录读取 API token（插件设置留空时自动读取） */
function readApiTokenFromFile(): string {
  try {
    const tokenFile = nodePath.join(getBioUnixDataDir(), 'api-token');
    if (nodeFs.existsSync(tokenFile)) {
      const token = nodeFs.readFileSync(tokenFile, 'utf-8').trim();
      if (token.length >= 32) return token;
    }
  } catch { /* best-effort */ }
  return '';
}

/** 通用 API 响应结构 */
export interface BioUnixAPIResult<T = unknown> {
  ok: boolean;
  error?: string;
  data?: T;
  [key: string]: unknown;
}

/** Agent 会话 */
export interface BioUnixSession {
  id: string;
  name?: string;
  mode?: string;
  model?: string | null;
  startedAt?: number;
  updated_at?: number;
  terminalTabId?: string | null;
  workspaceDir?: string | null;
  workspace?: {
    kind: 'local' | 'remote' | 'wsl';
    path?: string;
    ssh?: { host: string; port?: number; username: string; auth_type?: string; key_path?: string } | null;
    wsl?: { dist?: string } | null;
    isSlurm?: boolean;
  } | null;
  apiConfig?: {
    provider: string;
    apiKey: string;
    model: string;
    customEndpoint?: string;
    contextLimitOverride?: number;
    maxRounds?: number;
    availableModels?: string[];
    language?: 'zh' | 'en';
  };
  enabledTools?: string[] | null;
  enabledSkills?: string[] | null;
  enabledPipelines?: string[] | null;
  commandInterval?: number;
  activeTaskCount?: number;
}

/** 会话消息 */
export interface BioUnixMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  /** assistant 消息携带的工具调用（后端 OpenAI 格式，可选） */
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  /** 工具结果消息的 tool_call_id（可选） */
  tool_call_id?: string;
  /** 模型思维链（GLM/DeepSeek/Claude 等），可选 */
  reasoning?: string;
}

/** WebSocket 推送事件 */
export interface BioUnixWSEvent {
  type: 'agent:chunk' | 'agent:done' | 'agent:error' | string;
  content?: string;
  error?: string;
  [key: string]: unknown;
}

/** 创建会话参数 */
export interface CreateSessionWorkspace {
  kind: 'local' | 'remote' | 'wsl';
  path?: string;
  ssh?: {
    host: string;
    port?: number;
    username: string;
    auth_type: 'password' | 'key';
    password?: string | null;
    key_path?: string | null;
    passphrase?: string | null;
  } | null;
  wsl?: { dist?: string } | null;
  isSlurm?: boolean;
}

export interface CreateSessionOptions {
  name?: string;
  model?: string;
  mode?: string;
  workspace?: CreateSessionWorkspace;
  workspaceDir?: string;
  apiConfig?: Record<string, unknown>;
}

/** SSH 测试结果 */
export interface TestSshResult {
  ok: boolean;
  error?: string;
  serverVersion?: string;
  hostKeyChallenge?: {
    host: string;
    port: number;
    fingerprint: string;
    keyB64: string;
    keyType: string;
    knownFingerprint?: string;
    reason: 'unknown' | 'changed';
  };
}

/** 命令运行结果 */
export interface RunCommandResult {
  ok: boolean;
  error?: string;
  result?: {
    stdout?: string;
    stderr?: string;
    exit_code?: number;
  };
  session?: BioUnixSession;
  sessions?: BioUnixSession[];
  messages?: BioUnixMessage[];
  [key: string]: unknown;
}

/** WebSocket 消息回调 */
type WSListener = (data: BioUnixWSEvent) => void;

export class BioUnixAPI {
  private baseUrl: string;
  private token: string;
  private ws: WebSocket | null = null;
  private wsListeners: Map<string, WSListener> = new Map();

  constructor(settings: BioUnixSettings) {
    this.baseUrl = `http://127.0.0.1:${settings.port}`;
    // 设置留空时自动从 ~/.biounix（或系统数据目录）读取 token
    this.token = settings.token || readApiTokenFromFile();
  }

  updateSettings(settings: BioUnixSettings): void {
    this.baseUrl = `http://127.0.0.1:${settings.port}`;
    this.token = settings.token || readApiTokenFromFile();
    this.disconnectWS();
  }

  /** HTTP 请求（使用 obsidian requestUrl，绕过 CORS 并统一鉴权） */
  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await requestUrl({
      url: `${this.baseUrl}${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      throw: false,
    });

    const json = res.json as { ok?: boolean; error?: string;[k: string]: unknown };
    if (res.status < 200 || res.status >= 300) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    return json as T;
  }

  // ============ 会话管理 ============

  listSessions(): Promise<RunCommandResult> { return this.request('GET', '/api/sessions'); }
  createSession(opts: CreateSessionOptions): Promise<RunCommandResult> {
    return this.request('POST', '/api/sessions', opts);
  }

  /**
   * 用 settings 默认配置快速创建会话（供"发送文件""执行代码块"等快捷入口使用）。
   * 自动从 settings 构造 apiConfig + workspace，避免快捷创建的会话缺 API 配置而无法发消息。
   */
  createSessionWithDefaults(settings: BioUnixSettings, overrides: CreateSessionOptions = {}): Promise<RunCommandResult> {
    const apiConfig = {
      provider: settings.llmProvider,
      apiKey: settings.apiKey,
      model: settings.model,
      customEndpoint: settings.llmProvider === 'local'
        ? (settings.customEndpoint || 'http://localhost:1234/v1')
        : (settings.customEndpoint || undefined),
      language: 'zh' as const,
    };
    const ws = overrides.workspace
      || (settings.workspaceDir ? { kind: 'local' as const, path: settings.workspaceDir } : undefined);
    return this.createSession({
      name: overrides.name,
      model: overrides.model || settings.model,
      mode: overrides.mode || settings.defaultMode,
      workspace: ws,
      workspaceDir: ws?.path,
      apiConfig,
      ...overrides,
    });
  }
  getSession(id: string): Promise<RunCommandResult> { return this.request('GET', `/api/sessions/${id}`); }
  deleteSession(id: string): Promise<RunCommandResult> { return this.request('DELETE', `/api/sessions/${id}`); }
  getMessages(sessionId: string): Promise<RunCommandResult> {
    return this.request('GET', `/api/sessions/${sessionId}/messages`);
  }
  sendMessage(sessionId: string, message: string): Promise<RunCommandResult> {
    return this.request('POST', `/api/sessions/${sessionId}/messages`, { message });
  }
  stopSession(sessionId: string): Promise<RunCommandResult> {
    return this.request('POST', `/api/sessions/${sessionId}/stop`);
  }
  /** 撤销一次文件编辑（edit_file/write_file） */
  undoFileEdit(sessionId: string, toolCallId: string): Promise<RunCommandResult> {
    return this.request('POST', `/api/sessions/${sessionId}/undo`, { toolCallId });
  }
  /** 重做一次已撤销的文件编辑 */
  redoFileEdit(sessionId: string, toolCallId: string): Promise<RunCommandResult> {
    return this.request('POST', `/api/sessions/${sessionId}/redo`, { toolCallId });
  }
  /** 查询单个工具调用的文件备份详情（含 before/after 内容） */
  getFileBackup(sessionId: string, toolCallId: string): Promise<RunCommandResult> {
    return this.request('GET', `/api/sessions/${sessionId}/file-backup?toolCallId=${encodeURIComponent(toolCallId)}`);
  }
  /** 查询某文件路径的完整编辑历史 */
  getFileHistory(sessionId: string, filePath: string, withContent = false): Promise<RunCommandResult> {
    return this.request('GET', `/api/sessions/${sessionId}/file-history?filePath=${encodeURIComponent(filePath)}&withContent=${withContent ? '1' : '0'}`);
  }
  /** 更新会话配置（apiConfig / workspace / 启用范围等） */
  updateSession(sessionId: string, config: Record<string, unknown>): Promise<RunCommandResult> {
    return this.request('PUT', `/api/sessions/${sessionId}`, { config });
  }
  /** F4 分支对话：克隆指定会话的前 N 条消息到新会话 */
  forkSession(sessionId: string, beforeIndex: number, name?: string): Promise<RunCommandResult> {
    return this.request('POST', `/api/sessions/${sessionId}/fork`, { beforeIndex, name });
  }
  /** 清空会话所有消息（保留会话本身） */
  clearSession(sessionId: string): Promise<RunCommandResult> {
    return this.request('POST', `/api/sessions/${sessionId}/clear`);
  }
  /** 设置会话安全级别（paranoid/normal/yolo） */
  setSessionSecurity(sessionId: string, level: 'paranoid' | 'normal' | 'yolo'): Promise<RunCommandResult> {
    return this.request('POST', `/api/sessions/${sessionId}/security`, { level });
  }

  // ============ 交互结果提交（AI 确认/选择） ============

  /**
   * 提交交互结果（确认/选择/文件选择等）。
   * 当插件收到 interaction:request WS 事件并弹出 Modal 后，用户操作完成时调用。
   * @param toolCallId 交互请求的 tool_call_id（来自 WS 事件 payload）
   * @param result 用户操作结果，结构因 tool_name 而异：
   *   - confirm_dialog: { approved: boolean, remember?: boolean, cancelled?: boolean }
   *   - select_option:  { selected: string|string[], custom_text?: string, cancelled?: boolean }
   *   - select_file:    { path: string, cancelled?: boolean }
   *   - select_directory: { path: string, cancelled?: boolean }
   */
  submitInteraction(toolCallId: string, result: unknown): Promise<RunCommandResult> {
    return this.request('POST', '/api/interaction/submit', { tool_call_id: toolCallId, result });
  }

  // ============ 命令执行 ============

  runCommand(command: string, args: string[], cwd?: string, workspace?: CreateSessionOptions['workspace']): Promise<RunCommandResult> {
    return this.request('POST', '/api/commands', { command, args, cwd, workspace });
  }

  // ============ 工具/技能/记忆 ============

  listTools(): Promise<RunCommandResult> { return this.request('GET', '/api/tools'); }
  listSkills(): Promise<RunCommandResult> { return this.request('GET', '/api/skills'); }
  getSkill(name: string): Promise<RunCommandResult> {
    return this.request('GET', `/api/skills/${encodeURIComponent(name)}`);
  }
  listMemories(): Promise<RunCommandResult> { return this.request('GET', '/api/memories'); }
  searchMemories(query: string, k = 5): Promise<RunCommandResult> {
    return this.request('GET', `/api/memories/search?q=${encodeURIComponent(query)}&k=${k}`);
  }

  // ============ 任务管理 ============

  getTask(taskId: string): Promise<RunCommandResult> { return this.request('GET', `/api/tasks/${taskId}`); }
  getSessionTasks(sessionId: string): Promise<RunCommandResult> {
    return this.request('GET', `/api/sessions/${sessionId}/tasks`);
  }

  // ============ 计算资源 ============

  /** 查询 session 工作空间所在设备的计算资源（运行时/系统资源/Slurm 分区队列） */
  getSessionResources(sessionId: string): Promise<RunCommandResult> {
    return this.request('GET', `/api/sessions/${sessionId}/resources`);
  }

  // ============ 工作空间目标探测（SSH 测试 / WSL 发行版 / 主机公钥确认） ============

  /** 测试 SSH 连接（返回 ok 或 hostKeyChallenge 待用户确认） */
  testSsh(opts: {
    host: string; port: number; username: string;
    authType: 'password' | 'key'; password?: string; keyPath?: string; passphrase?: string;
  }): Promise<TestSshResult> {
    return this.request('POST', '/api/test-ssh', opts);
  }

  /** 确认主机公钥（写入 known_hosts），确认后重试 testSsh 即可匹配通过 */
  confirmHostKey(challenge: NonNullable<TestSshResult['hostKeyChallenge']>): Promise<{ ok: boolean }> {
    return this.request('POST', '/api/confirm-host-key', challenge);
  }

  /** 列出本机 WSL 发行版（macOS/Linux 返回空数组） */
  async listWslDistros(): Promise<string[]> {
    try {
      const res = await this.request<{ distros?: string[] }>('GET', '/api/wsl-distros');
      return res.distros || [];
    } catch {
      return [];
    }
  }

  /** 列出主程序已保存的远程 SSH 会话（密码已解密） */
  async listSavedSshSessions(): Promise<Array<{
    id: string; name: string; host: string; port: number; username: string;
    authType: 'password' | 'key'; password?: string; keyPath?: string; passphrase?: string; lastUsed: number;
  }>> {
    try {
      const res = await this.request<{ sessions?: any[] }>('GET', '/api/saved-ssh-sessions');
      return res.sessions || [];
    } catch {
      return [];
    }
  }

  /** 列出远程目录（SFTP readdir），path 为空时返回家目录 */
  async listRemoteDir(opts: {
    host: string; port: number; username: string;
    authType: 'password' | 'key'; password?: string; keyPath?: string; passphrase?: string; path?: string;
  }): Promise<{ ok: boolean; error?: string; path?: string; entries: Array<{ name: string; path: string; is_dir: boolean; size: number }> }> {
    return this.request('POST', '/api/remote-list-dir', opts);
  }

  // ============ 健康检查 ============

  async health(): Promise<boolean> {
    try {
      const res = await this.request<{ ok?: boolean }>('GET', '/api/health');
      return res.ok === true;
    } catch {
      return false;
    }
  }

  // ============ WebSocket ============

  private wsListener: WSListener | null = null;
  private wsReconnectTimer: number | null = null;
  private wsManuallyClosed = false;

  connectWS(onMessage: WSListener): void {
    this.disconnectWS();
    this.wsListener = onMessage;
    this.wsManuallyClosed = false;
    this.openWS();
  }

  private openWS(): void {
    const wsUrl = `ws://127.0.0.1:${this.extractPort() + 1}?token=${this.token}`;
    this.ws = new WebSocket(wsUrl);
    this.ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as BioUnixWSEvent;
        this.wsListener?.(data);
      } catch { /* ignore parse errors */ }
    };
    this.ws.onclose = () => {
      this.ws = null;
      // 非手动关闭时自动重连（指数退避，上限 5s），避免后端重启/网络抖动后收不到流式
      if (!this.wsManuallyClosed) {
        if (this.wsReconnectTimer) window.clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = window.setTimeout(() => this.openWS(), 2000);
      }
    };
    this.ws.onerror = () => { /* onclose 会处理重连 */ };
  }

  disconnectWS(): void {
    this.wsManuallyClosed = true;
    if (this.wsReconnectTimer) { window.clearTimeout(this.wsReconnectTimer); this.wsReconnectTimer = null; }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.wsListener = null;
  }

  private extractPort(): number {
    const match = this.baseUrl.match(/:(\d+)$/);
    return match ? parseInt(match[1], 10) : 17564;
  }
}
