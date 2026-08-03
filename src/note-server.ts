/**
 * Obsidian 笔记 HTTP Server
 *
 * 暴露 vault 读写能力，供 BioUnix 主程序 Pipeline 调用。
 * 监听 127.0.0.1:17590（默认），端点：
 *   GET  /health              健康检查
 *   GET  /notes/list          列出笔记 ?folder= & ext=
 *   GET  /notes/read          读取笔记 ?path=
 *   POST /notes/write         写入笔记 {path, content}
 *   GET  /notes/search        搜索笔记 ?q= & limit=
 *   GET  /notes/frontmatter   读取 frontmatter ?path=
 */
import http from 'node:http';
import type { App, Plugin } from 'obsidian';

export interface NoteServerOptions {
    port: number;
    token: string; // 空则不鉴权
}

export class NoteServer {
    private server: http.Server | null = null;
    private app: App;
    private opts: NoteServerOptions;

    constructor(app: App, opts: NoteServerOptions) {
        this.app = app;
        this.opts = opts;
    }

    async start(): Promise<void> {
        if (this.server) return;
        const vault = this.app.vault;
        const adapter = vault.adapter as any;

        const server = http.createServer(async (req, res) => {
            // CORS + JSON
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            // 鉴权
            if (this.opts.token) {
                const auth = req.headers['authorization'];
                const expected = `Bearer ${this.opts.token}`;
                if (auth !== expected) {
                    this.sendJson(res, 401, { error: 'unauthorized' });
                    return;
                }
            }

            const url = new URL(req.url || '/', `http://127.0.0.1:${this.opts.port}`);
            const path = url.pathname;
            const q = (k: string) => url.searchParams.get(k) || '';

            try {
                // 健康检查
                if (path === '/health') {
                    this.sendJson(res, 200, { ok: true, vault: vault.getName(), files: vault.getMarkdownFiles().length });
                    return;
                }

                // 列出笔记
                if (path === '/notes/list') {
                    const folder = q('folder'); // 可选，如 "projects/"
                    const ext = q('ext') || 'md';
                    let files = vault.getMarkdownFiles();
                    if (folder) {
                        files = files.filter((f) => f.path.startsWith(folder));
                    }
                    const list = files.map((f) => ({
                        path: f.path,
                        name: f.name,
                        basename: f.basename,
                        size: f.stat.size,
                        mtime: f.stat.mtime,
                    }));
                    this.sendJson(res, 200, { count: list.length, files: list });
                    return;
                }

                // 读取笔记
                if (path === '/notes/read') {
                    const notePath = q('path');
                    if (!notePath) { this.sendJson(res, 400, { error: 'missing path' }); return; }
                    if (!(await adapter.exists(notePath))) {
                        this.sendJson(res, 404, { error: `note not found: ${notePath}` });
                        return;
                    }
                    const content = await adapter.read(notePath);
                    this.sendJson(res, 200, { path: notePath, content });
                    return;
                }

                // 写入笔记
                if (path === '/notes/write' && req.method === 'POST') {
                    const body = await this.readBody(req);
                    let parsed: { path?: string; content?: string };
                    try { parsed = JSON.parse(body); } catch { this.sendJson(res, 400, { error: 'invalid json' }); return; }
                    if (!parsed.path || parsed.content === undefined) {
                        this.sendJson(res, 400, { error: 'missing path or content' });
                        return;
                    }
                    // 路径安全：禁止 .. 越界
                    if (parsed.path.includes('..')) {
                        this.sendJson(res, 400, { error: 'path traversal not allowed' });
                        return;
                    }
                    const exists = await adapter.exists(parsed.path);
                    if (exists) {
                        await adapter.write(parsed.path, parsed.content);
                    } else {
                        await vault.create(parsed.path, parsed.content);
                    }
                    this.sendJson(res, 200, { ok: true, path: parsed.path, created: !exists, bytes: parsed.content.length });
                    return;
                }

                // 搜索笔记
                if (path === '/notes/search') {
                    const query = q('q');
                    const limit = parseInt(q('limit') || '50', 10);
                    if (!query) { this.sendJson(res, 400, { error: 'missing q' }); return; }
                    const files = vault.getMarkdownFiles();
                    const matches: Array<{ path: string; snippet: string }> = [];
                    for (const f of files) {
                        if (matches.length >= limit) break;
                        try {
                            const content = await adapter.read(f.path);
                            const idx = content.toLowerCase().indexOf(query.toLowerCase());
                            if (idx >= 0) {
                                const start = Math.max(0, idx - 40);
                                const snippet = content.slice(start, idx + query.length + 60);
                                matches.push({ path: f.path, snippet });
                            }
                        } catch { /* ignore binary/unreadable */ }
                    }
                    this.sendJson(res, 200, { query, count: matches.length, matches });
                    return;
                }

                // 读取 frontmatter
                if (path === '/notes/frontmatter') {
                    const notePath = q('path');
                    if (!notePath) { this.sendJson(res, 400, { error: 'missing path' }); return; }
                    if (!(await adapter.exists(notePath))) {
                        this.sendJson(res, 404, { error: `note not found: ${notePath}` });
                        return;
                    }
                    const content = await adapter.read(notePath);
                    const fm = this.parseFrontmatter(content);
                    this.sendJson(res, 200, { path: notePath, frontmatter: fm });
                    return;
                }

                // 404
                this.sendJson(res, 404, { error: `unknown endpoint: ${path}` });
            } catch (e) {
                this.sendJson(res, 500, { error: (e as Error).message });
            }
        });

        return new Promise((resolve, reject) => {
            server.once('error', (e) => reject(e));
            server.listen(this.opts.port, '127.0.0.1', () => {
                this.server = server;
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        if (!this.server) return;
        return new Promise((resolve) => {
            this.server!.close(() => {
                this.server = null;
                resolve();
            });
        });
    }

    isRunning(): boolean {
        return this.server !== null;
    }

    private sendJson(res: http.ServerResponse, code: number, data: any): void {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
    }

    private readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            let data = '';
            req.on('data', (chunk) => { data += chunk; if (data.length > 10 * 1024 * 1024) reject(new Error('body too large')); });
            req.on('end', () => resolve(data));
            req.on('error', reject);
        });
    }

    /** 简易 YAML frontmatter 解析（返回 key-value） */
    private parseFrontmatter(content: string): Record<string, any> {
        const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (!m) return {};
        const fm: Record<string, any> = {};
        for (const line of m[1].split('\n')) {
            const km = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
            if (km) {
                let val: any = km[2].trim();
                // 去引号
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                // 数组 [a, b]
                if (val.startsWith('[') && val.endsWith(']')) {
                    val = val.slice(1, -1).split(',').map((s: string) => s.trim()).filter(Boolean);
                }
                fm[km[1]] = val;
            }
        }
        return fm;
    }
}
