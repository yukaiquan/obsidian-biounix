/**
 * BioUnix API 客户端 — HTTP + WebSocket 封装
 */
import type { BioUnixSettings } from './settings';

export interface BioUnixAPIResult<T = any> {
  ok: boolean;
  error?: string;
  data?: T;
}

export class BioUnixAPI {
  private baseUrl: string;
  private token: string;
  private ws: WebSocket | null = null;
  private wsListeners: Map<string, (data: any) => void> = new Map();

  constructor(settings: BioUnixSettings) {
    this.baseUrl = `http://127.0.0.1:${settings.port}`;
    this.token = settings.token;
  }

  updateSettings(settings: BioUnixSettings): void {
    this.baseUrl = `http://127.0.0.1:${settings.port}`;
    this.token = settings.token;
    this.disconnectWS();
  }

  /** HTTP 请求 */
  private async request<T = any>(method: string, path: string, body?: any): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // ============ 会话管理 ============

  listSessions() { return this.request('GET', '/api/sessions'); }
  createSession(opts: { name?: string; model?: string; mode?: string; workspace?: any; apiConfig?: any }) {
    return this.request('POST', '/api/sessions', opts);
  }
  getSession(id: string) { return this.request('GET', `/api/sessions/${id}`); }
  deleteSession(id: string) { return this.request('DELETE', `/api/sessions/${id}`); }
  getMessages(sessionId: string) { return this.request('GET', `/api/sessions/${sessionId}/messages`); }
  sendMessage(sessionId: string, message: string) {
    return this.request('POST', `/api/sessions/${sessionId}/messages`, { message });
  }
  stopSession(sessionId: string) {
    return this.request('POST', `/api/sessions/${sessionId}/stop`);
  }

  // ============ 命令执行 ============

  runCommand(command: string, args: string[], cwd?: string, workspace?: any) {
    return this.request('POST', '/api/commands', { command, args, cwd, workspace });
  }

  // ============ 工具/技能/记忆 ============

  listTools() { return this.request('GET', '/api/tools'); }
  listSkills() { return this.request('GET', '/api/skills'); }
  getSkill(name: string) { return this.request('GET', `/api/skills/${encodeURIComponent(name)}`); }
  listMemories() { return this.request('GET', '/api/memories'); }
  searchMemories(query: string, k = 5) {
    return this.request('GET', `/api/memories/search?q=${encodeURIComponent(query)}&k=${k}`);
  }

  // ============ 任务管理 ============

  getTask(taskId: string) { return this.request('GET', `/api/tasks/${taskId}`); }
  getSessionTasks(sessionId: string) { return this.request('GET', `/api/sessions/${sessionId}/tasks`); }

  // ============ 健康检查 ============

  async health(): Promise<boolean> {
    try {
      const res = await this.request('GET', '/api/health');
      return res.ok === true;
    } catch {
      return false;
    }
  }

  // ============ WebSocket ============

  connectWS(onMessage: (data: any) => void): void {
    this.disconnectWS();
    const wsUrl = `ws://127.0.0.1:${this.extractPort() + 1}?token=${this.token}`;
    this.ws = new WebSocket(wsUrl);
    this.ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
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
