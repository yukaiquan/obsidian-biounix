/**
 * Obsidian 笔记浏览器 — 在聊天侧边栏中预览 vault 笔记内容
 *
 * 功能：
 *  - 列出 vault 中所有 markdown 笔记（按修改时间倒序）
 *  - 搜索框过滤（按路径/文件名）
 *  - 当前活动笔记自动置顶并高亮（便于快速定位正在编辑的内容）
 *  - 选中笔记后右侧渲染 Markdown 预览
 *  - 可将笔记内容插入到聊天输入框，或作为上下文直接发送
 */
import { App, Modal, Notice, MarkdownRenderer, Component, TFile } from 'obsidian';

export class NoteBrowserModal extends Modal {
    private selectedFile: TFile | null = null;
    private previewEl: HTMLElement | null = null;
    private listEl: HTMLElement | null = null;
    private mdComponent: Component | null = null;
    private onInsert: (text: string, path: string) => void;
    private onSend: (text: string, path: string) => void;
    private searchEl: HTMLInputElement | null = null;
    private allFiles: TFile[] = [];
    /** 打开浏览器时 Obsidian 中当前活动的笔记（自动置顶并默认选中） */
    private activeFile: TFile | null = null;

    constructor(
        app: App,
        onInsert: (text: string, path: string) => void,
        onSend: (text: string, path: string) => void,
    ) {
        super(app);
        this.onInsert = onInsert;
        this.onSend = onSend;
    }

    async onOpen(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('biounix-note-browser');

        // 标题
        const titleEl = contentEl.createDiv({ cls: 'biounix-note-browser-title' });
        titleEl.createEl('span', { text: '📖 Obsidian 笔记' });

        // 搜索框
        const searchRow = contentEl.createDiv({ cls: 'biounix-note-browser-search-row' });
        this.searchEl = searchRow.createEl('input', {
            cls: 'biounix-note-browser-search',
            attr: { type: 'text', placeholder: '搜索笔记（路径或文件名）...' },
        });
        this.searchEl.addEventListener('input', () => this.renderList());

        // 主体：左列表 + 右预览
        const body = contentEl.createDiv({ cls: 'biounix-note-browser-body' });
        this.listEl = body.createDiv({ cls: 'biounix-note-browser-list' });
        this.previewEl = body.createDiv({ cls: 'biounix-note-browser-preview' });

        // 底部操作栏
        const footer = contentEl.createDiv({ cls: 'biounix-note-browser-footer' });
        const insertBtn = footer.createEl('button', { text: '插入到输入框', cls: 'biounix-note-browser-btn biounix-note-browser-btn-secondary' });
        insertBtn.onclick = () => this.doInsert();
        const sendBtn = footer.createEl('button', { text: '作为上下文发送', cls: 'biounix-note-browser-btn biounix-note-browser-btn-primary' });
        sendBtn.onclick = () => this.doSend();

        // 初始化 Markdown 组件
        this.mdComponent = new Component();
        this.mdComponent.load();

        // 加载所有 markdown 文件（按修改时间倒序）
        this.allFiles = this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);

        // 获取当前活动笔记（用户正在编辑/查看的那篇），自动置顶并默认选中
        const af = this.app.workspace.getActiveFile();
        this.activeFile = af && af.extension === 'md' ? af : null;

        this.renderList();

        // 默认选中当前活动笔记；无活动笔记则选第一个
        const initial = this.activeFile || this.allFiles[0];
        if (initial) {
            void this.selectFile(initial);
            this.scrollToSelected();
        } else {
            this.previewEl?.createEl('div', { text: 'Vault 中暂无笔记', cls: 'biounix-note-browser-empty' });
        }
    }

    /** 渲染左侧笔记列表（应用搜索过滤） */
    private renderList(): void {
        if (!this.listEl) return;
        this.listEl.empty();
        const q = (this.searchEl?.value || '').toLowerCase().trim();
        const files = q
            ? this.allFiles.filter(f => f.path.toLowerCase().includes(q) || f.basename.toLowerCase().includes(q))
            : this.allFiles;

        if (files.length === 0) {
            this.listEl.createEl('div', { text: '无匹配笔记', cls: 'biounix-note-browser-empty' });
            return;
        }

        // 当前活动笔记优先置顶显示（若匹配搜索条件）
        if (this.activeFile) {
            const af = this.activeFile;
            const matchQ = !q || af.path.toLowerCase().includes(q) || af.basename.toLowerCase().includes(q);
            if (matchQ) {
                const item = this.listEl.createDiv({
                    cls: `biounix-note-browser-item is-active${this.selectedFile?.path === af.path ? ' is-selected' : ''}`,
                    attr: { 'data-path': af.path },
                });
                item.createEl('div', { text: af.basename, cls: 'biounix-note-browser-item-name' });
                item.createEl('div', { text: `${af.path}  ·  当前打开`, cls: 'biounix-note-browser-item-path' });
                item.onclick = () => this.selectFile(af);
                // 分隔线
                this.listEl.createDiv({ cls: 'biounix-note-browser-sep' });
            }
        }

        // 其余笔记（排除已置顶的活动笔记），限制 200 条避免卡顿
        const rest = files.filter(f => f.path !== this.activeFile?.path);
        for (const f of rest.slice(0, 200)) {
            const item = this.listEl.createDiv({
                cls: `biounix-note-browser-item${this.selectedFile?.path === f.path ? ' is-selected' : ''}`,
                attr: { 'data-path': f.path },
            });
            // 文件名
            item.createEl('div', { text: f.basename, cls: 'biounix-note-browser-item-name' });
            // 路径
            item.createEl('div', { text: f.path, cls: 'biounix-note-browser-item-path' });
            item.onclick = () => this.selectFile(f);
        }
    }

    /** 滚动列表到当前选中项 */
    private scrollToSelected(): void {
        const sel = this.listEl?.querySelector('.biounix-note-browser-item.is-selected') as HTMLElement | null;
        sel?.scrollIntoView({ block: 'nearest' });
    }

    /** 选中笔记并渲染预览（仅切换列表选中态，不重新渲染整个列表，保留滚动位置） */
    private async selectFile(f: TFile): Promise<void> {
        this.selectedFile = f;
        // 仅切换选中态 class，避免重新渲染列表导致滚动位置丢失
        this.listEl?.querySelectorAll('.biounix-note-browser-item').forEach(el => {
            if (el.getAttribute('data-path') === f.path) el.addClass('is-selected');
            else el.removeClass('is-selected');
        });

        if (!this.previewEl) return;
        this.previewEl.empty();
        this.previewEl.createEl('div', { text: f.path, cls: 'biounix-note-browser-preview-path' });
        try {
            const content = await this.app.vault.read(f);
            const mdEl = this.previewEl.createDiv({ cls: 'biounix-note-browser-preview-content' });
            if (this.mdComponent) {
                await MarkdownRenderer.renderMarkdown(content, mdEl, f.path, this.mdComponent);
            } else {
                mdEl.setText(content);
            }
        } catch (e) {
            this.previewEl.createEl('div', { text: `读取失败: ${(e as Error).message}`, cls: 'biounix-note-browser-error' });
        }
    }

    /** 插入到输入框：以引用块形式插入笔记路径 + 内容摘要 */
    private async doInsert(): Promise<void> {
        if (!this.selectedFile) {
            new Notice('请先选择笔记');
            return;
        }
        try {
            const content = await this.app.vault.read(this.selectedFile);
            const text = `> 📖 笔记: [[${this.selectedFile.path}]]\n\n${content}`;
            this.onInsert(text, this.selectedFile.path);
            this.close();
        } catch (e) {
            new Notice(`读取失败: ${(e as Error).message}`);
        }
    }

    /** 作为上下文发送：直接调 onSend 回调发送 */
    private async doSend(): Promise<void> {
        if (!this.selectedFile) {
            new Notice('请先选择笔记');
            return;
        }
        try {
            const content = await this.app.vault.read(this.selectedFile);
            const text = `请基于以下 Obsidian 笔记内容回答（来源: ${this.selectedFile.path}）：\n\n${content}`;
            this.onSend(text, this.selectedFile.path);
            this.close();
        } catch (e) {
            new Notice(`读取失败: ${(e as Error).message}`);
        }
    }

    onClose(): void {
        if (this.mdComponent) {
            this.mdComponent.unload();
            this.mdComponent = null;
        }
        this.contentEl.empty();
    }
}
