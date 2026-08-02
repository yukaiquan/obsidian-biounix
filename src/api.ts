/**
 * BioUnix API 客户端 — HTTP + WebSocket 封装
 */
import { requestUrl } from 'obsidian';
import type { BioUnixSettings } from './settings';

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
}

/** 会话消息 */
export interface BioUnixMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

/** WebSocket 推送事件 */
export interface BioUnixWSEvent {
  type: 'agent:chunk' | 'agent:done' | 'agent:error' | string;
  content?: string;
  error?: string;
  [key: string]: unknown;
}

/** 创建会话参数 */
export interface CreateSessionOptions {
  name?: string;
  model?: string;
  mode?: string;
  workspace?: { kind: 'local' | 'ssh' | 'wsl'; path?: string };
  apiConfig?: Record<string, unknown>;
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
    this.token = settings.token;
  }

  updateSettings(settings: BioUnixSettings): void {
    this.baseUrl = `http://127.0.0.1:${settings.port}`;
    this.token = settings.token;
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

  connectWS(onMessage: WSListener): void {
    this.disconnectWS();
    const wsUrl = `ws://127.0.0.1:${this.extractPort() + 1}?token=${this.token}`;
    this.ws = new WebSocket(wsUrl);
    this.ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as BioUnixWSEvent;
        onMessage(data);
      } catch { /* ignore parse errors */ }
    };
    this.ws.onclose = () => { this.ws = null; };
    this.ws.onerror = () => { /* connection failed */ };
  }

  disconnectWS(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private extractPort(): number {
    const match = this.baseUrl.match(/:(\d+)$/);
    return match ? parseInt(match[1], 10) : 17564;
  }
}
