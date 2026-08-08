/**
 * Obsidian 笔记 HTTP Server
 *
 * 暴露 vault 读写能力，供 BioUnix 主程序 Agent / Pipeline 调用。
 * 监听 127.0.0.1:17590（默认），端点：
 *   GET  /health              健康检查
 *   GET  /notes/list          列出笔记 ?folder= & ext=
 *   GET  /notes/read          读取笔记 ?path=
 *   POST /notes/write         写入笔记 {path, content}
 *   POST /notes/append        追加内容 {path, content}
 *   POST /notes/prepend       开头插入（frontmatter 之后）{path, content}
 *   POST /notes/delete        删除笔记 {path}（走 vault.trash，可恢复）
 *   POST /notes/rename        重命名/移动 {path, newPath}（自动更新双链）
 *   GET  /notes/search        搜索笔记 ?q= & limit=
 *   GET  /notes/frontmatter   读取 frontmatter ?path=
 *   POST /notes/frontmatter   写入/更新 frontmatter {path, data}（走 processFrontMatter）
 *   GET  /notes/tags          列出所有标签及计数
 *   GET  /notes/links         查询链接关系 ?path=（出链 + 反向链接）
 *   GET  /notes/backlinks     查询反向链接 ?path=
 */
import http from 'node:http';
import { TFile } from 'obsidian';
import type { App } from 'obsidian';

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
                if (path === '/notes/frontmatter' && req.method !== 'POST') {
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

                // 写入/更新 frontmatter（走 Obsidian processFrontMatter，安全且更新元数据缓存）
                if (path === '/notes/frontmatter' && req.method === 'POST') {
                    const body = await this.readBody(req);
                    let parsed: { path?: string; data?: Record<string, any>; action?: 'set' | 'merge' | 'delete' };
                    try { parsed = JSON.parse(body); } catch { this.sendJson(res, 400, { error: 'invalid json' }); return; }
                    if (!parsed.path) { this.sendJson(res, 400, { error: 'missing path' }); return; }
                    const file = vault.getAbstractFileByPath(parsed.path);
                    if (!file || !(file instanceof TFile)) {
                        this.sendJson(res, 404, { error: `note not found: ${parsed.path}` });
                        return;
                    }
                    const action = parsed.action || 'set';
                    const data = parsed.data || {};
                    try {
                        await this.app.fileManager.processFrontMatter(file, (fm) => {
                            if (action === 'delete') {
                                // data 的 value 为要删除的 key 列表
                                const keys = Array.isArray(data) ? data : (data.keys || []);
                                for (const k of keys) delete fm[k];
                            } else if (action === 'merge') {
                                Object.assign(fm, data);
                            } else {
                                // set：清空后写入（替换整个 frontmatter）
                                for (const k of Object.keys(fm)) delete fm[k];
                                Object.assign(fm, data);
                            }
                        });
                        this.sendJson(res, 200, { ok: true, path: parsed.path, action });
                    } catch (e) {
                        this.sendJson(res, 500, { error: `processFrontMatter 失败: ${(e as Error).message}` });
                    }
                    return;
                }

                // 追加内容到笔记末尾
                if (path === '/notes/append' && req.method === 'POST') {
                    const body = await this.readBody(req);
                    let parsed: { path?: string; content?: string };
                    try { parsed = JSON.parse(body); } catch { this.sendJson(res, 400, { error: 'invalid json' }); return; }
                    if (!parsed.path || parsed.content === undefined) {
                        this.sendJson(res, 400, { error: 'missing path or content' }); return;
                    }
                    if (parsed.path.includes('..')) { this.sendJson(res, 400, { error: 'path traversal not allowed' }); return; }
                    const exists = await adapter.exists(parsed.path);
                    let newContent: string;
                    if (exists) {
                        const old = await adapter.read(parsed.path);
                        // 确保旧内容末尾有换行再追加
                        newContent = old.endsWith('\n') ? old + parsed.content : old + '\n' + parsed.content;
                        await adapter.write(parsed.path, newContent);
                    } else {
                        newContent = parsed.content;
                        await vault.create(parsed.path, newContent);
                    }
                    this.sendJson(res, 200, { ok: true, path: parsed.path, bytes: newContent.length, action: exists ? 'appended' : 'created' });
                    return;
                }

                // 在笔记开头插入（frontmatter 之后）
                if (path === '/notes/prepend' && req.method === 'POST') {
                    const body = await this.readBody(req);
                    let parsed: { path?: string; content?: string };
                    try { parsed = JSON.parse(body); } catch { this.sendJson(res, 400, { error: 'invalid json' }); return; }
                    if (!parsed.path || parsed.content === undefined) {
                        this.sendJson(res, 400, { error: 'missing path or content' }); return;
                    }
                    if (parsed.path.includes('..')) { this.sendJson(res, 400, { error: 'path traversal not allowed' }); return; }
                    const exists = await adapter.exists(parsed.path);
                    let newContent: string;
                    if (exists) {
                        const old = await adapter.read(parsed.path);
                        newContent = this.insertAfterFrontmatter(old, parsed.content);
                        await adapter.write(parsed.path, newContent);
                    } else {
                        newContent = parsed.content;
                        await vault.create(parsed.path, newContent);
                    }
                    this.sendJson(res, 200, { ok: true, path: parsed.path, bytes: newContent.length, action: exists ? 'prepended' : 'created' });
                    return;
                }

                // 删除笔记（走 vault.trash，进系统回收站，可恢复）
                if (path === '/notes/delete' && req.method === 'POST') {
                    const body = await this.readBody(req);
                    let parsed: { path?: string; permanent?: boolean };
                    try { parsed = JSON.parse(body); } catch { this.sendJson(res, 400, { error: 'invalid json' }); return; }
                    if (!parsed.path) { this.sendJson(res, 400, { error: 'missing path' }); return; }
                    const file = vault.getAbstractFileByPath(parsed.path);
                    if (!file || !(file instanceof TFile)) {
                        this.sendJson(res, 404, { error: `note not found: ${parsed.path}` });
                        return;
                    }
                    if (parsed.permanent) {
                        await vault.delete(file);
                    } else {
                        await vault.trash(file, true);
                    }
                    this.sendJson(res, 200, { ok: true, path: parsed.path, action: parsed.permanent ? 'deleted' : 'trashed' });
                    return;
                }

                // 重命名/移动笔记（走 vault.rename，Obsidian 自动更新所有双链引用）
                if (path === '/notes/rename' && req.method === 'POST') {
                    const body = await this.readBody(req);
                    let parsed: { path?: string; newPath?: string };
                    try { parsed = JSON.parse(body); } catch { this.sendJson(res, 400, { error: 'invalid json' }); return; }
                    if (!parsed.path || !parsed.newPath) { this.sendJson(res, 400, { error: 'missing path or newPath' }); return; }
                    if (parsed.newPath.includes('..')) { this.sendJson(res, 400, { error: 'path traversal not allowed' }); return; }
                    const file = vault.getAbstractFileByPath(parsed.path);
                    if (!file || !(file instanceof TFile)) {
                        this.sendJson(res, 404, { error: `note not found: ${parsed.path}` });
                        return;
                    }
                    // 若目标已存在则拒绝，避免覆盖
                    if (await adapter.exists(parsed.newPath)) {
                        this.sendJson(res, 409, { error: `target already exists: ${parsed.newPath}` });
                        return;
                    }
                    // 确保目标目录存在（vault.rename 不会自动创建目录）
                    const dir = parsed.newPath.includes('/') ? parsed.newPath.slice(0, parsed.newPath.lastIndexOf('/')) : '';
                    if (dir && !(await adapter.exists(dir))) {
                        try { await adapter.mkdir(dir); } catch { /* 可能已存在或创建失败，继续尝试 rename */ }
                    }
                    await vault.rename(file, parsed.newPath);
                    this.sendJson(res, 200, { ok: true, oldPath: parsed.path, newPath: parsed.newPath, action: 'renamed' });
                    return;
                }

                // 列出所有标签及引用计数（走 metadataCache.getTags）
                if (path === '/notes/tags') {
                    const tags = (this.app.metadataCache as any).getTags?.() as Record<string, number> | undefined;
                    if (tags) {
                        const list = Object.entries(tags)
                            .map(([tag, count]) => ({ tag, count }))
                            .sort((a, b) => (b.count as number) - (a.count as number));
                        this.sendJson(res, 200, { count: list.length, tags: list });
                    } else {
                        this.sendJson(res, 200, { count: 0, tags: [] });
                    }
                    return;
                }

                // 查询笔记的链接关系（出链 + 反向链接）
                if (path === '/notes/links') {
                    const notePath = q('path');
                    if (!notePath) { this.sendJson(res, 400, { error: 'missing path' }); return; }
                    const file = vault.getAbstractFileByPath(notePath);
                    if (!file || !(file instanceof TFile)) {
                        this.sendJson(res, 404, { error: `note not found: ${notePath}` });
                        return;
                    }
                    const cache = this.app.metadataCache.getFileCache(file);
                    const outlinks: string[] = [];
                    if (cache?.links) {
                        for (const link of cache.links) {
                            outlinks.push(link.link);
                        }
                    }
                    if (cache?.embeds) {
                        for (const embed of cache.embeds) {
                            outlinks.push(`!${embed.link}`);
                        }
                    }
                    // 反向链接：遍历所有笔记的链接，找到指向此笔记的
                    const backlinks = this.findBacklinks(notePath);
                    this.sendJson(res, 200, {
                        path: notePath,
                        outlinks: [...new Set(outlinks)],
                        backlinks,
                    });
                    return;
                }

                // 查询某笔记的反向链接（哪些笔记引用了它）
                if (path === '/notes/backlinks') {
                    const notePath = q('path');
                    if (!notePath) { this.sendJson(res, 400, { error: 'missing path' }); return; }
                    const backlinks = this.findBacklinks(notePath);
                    this.sendJson(res, 200, { path: notePath, count: backlinks.length, backlinks });
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

    /** 在 frontmatter 之后插入内容（保留 frontmatter 不动） */
    private insertAfterFrontmatter(content: string, insertion: string): string {
        const m = content.match(/^(---\r?\n[\s\S]*?\r?\n---)(\r?\n*)/);
        if (m) {
            // frontmatter + 插入内容 + 原剩余内容
            const afterFm = content.slice(m[0].length);
            return `${m[1]}\n\n${insertion}\n${afterFm}`;
        }
        // 无 frontmatter，直接在开头插入
        return `${insertion}\n${content}`;
    }

    /** 查找引用了指定笔记的所有反向链接 */
    private findBacklinks(notePath: string): Array<{ path: string; link: string; position?: { line: number; col: number } }> {
        const vault = this.app.vault;
        const results: Array<{ path: string; link: string; position?: { line: number; col: number } }> = [];
        // 目标笔记的 basename（不含扩展名），用于匹配 [[basename]] 形式的链接
        const basename = notePath.replace(/\.md$/i, '').split('/').pop() || notePath;

        for (const file of vault.getMarkdownFiles()) {
            if (file.path === notePath) continue; // 跳过自身
            const cache = this.app.metadataCache.getFileCache(file);
            if (!cache?.links) continue;
            for (const link of cache.links) {
                // 匹配规则：链接指向的文件解析后等于目标，或链接文本等于 basename
                const linkTarget = link.link.replace(/\.md$/i, '').split('/').pop();
                if (link.link === notePath || link.link === basename || linkTarget === basename) {
                    results.push({
                        path: file.path,
                        link: link.link,
                        position: link.position
                            ? { line: link.position.start.line, col: link.position.start.col }
                            : undefined,
                    });
                }
            }
        }
        return results;
    }
}
