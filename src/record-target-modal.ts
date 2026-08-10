/**
 * 记录目标选择模态框 — 选择 Markdown 记录的写入目标
 *
 * 两种模式：
 *   - 新建文件：用户选择 vault 目录 + 输入文件名
 *   - 追加现有笔记：用户从 vault 笔记列表中选择一篇
 *
 * 返回结果：
 *   - { mode: 'new', dir, filename } → 在 dir 目录下新建 filename.md
 *   - { mode: 'append', path }       → 追加到 path 指向的现有笔记
 *   - null                           → 用户取消
 */
import { App, Modal, Notice, TFile, TFolder } from 'obsidian';

export interface RecordTarget {
    mode: 'new' | 'append';
    /** mode='new' 时：目标目录路径（vault 相对路径，根目录为 ''） */
    dir?: string;
    /** mode='new' 时：文件名（不含扩展名） */
    filename?: string;
    /** mode='append' 时：目标笔记的 vault 相对路径 */
    path?: string;
}

export class RecordTargetModal extends Modal {
    private onResult: (target: RecordTarget | null) => void;
    private answered = false;
    /** 当前选中的模式 */
    private mode: 'new' | 'append' = 'new';
    /** 新建模式下选中的目录 */
    private selectedDir: string = '';
    /** 新建模式下输入的文件名 */
    private filenameInput: HTMLInputElement | null = null;
    /** 追加模式下选中的笔记 */
    private selectedNote: TFile | null = null;
    /** 笔记搜索框 */
    private searchEl: HTMLInputElement | null = null;
    /** 笔记列表容器 */
    private noteListEl: HTMLElement | null = null;
    /** 所有 markdown 笔记（缓存） */
    private allFiles: TFile[] = [];

    constructor(app: App, onResult: (target: RecordTarget | null) => void) {
        super(app);
        this.onResult = onResult;
    }

    async onOpen(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('biounix-record-target-modal');

        contentEl.createEl('h2', { text: '选择记录目标' });

        // 模式切换 Tab
        const tabRow = contentEl.createDiv({ cls: 'biounix-record-target-tabs' });
        const newTab = tabRow.createEl('button', { text: '📄 新建文件', cls: 'biounix-record-target-tab is-active' });
        const appendTab = tabRow.createEl('button', { text: '📎 追加到现有笔记', cls: 'biounix-record-target-tab' });

        // 内容容器
        const body = contentEl.createDiv({ cls: 'biounix-record-target-body' });

        // ===== 新建文件面板 =====
        const newPanel = body.createDiv({ cls: 'biounix-record-target-panel' });
        // 目录选择
        newPanel.createEl('div', { text: '选择目录', cls: 'biounix-record-target-label' });
        const dirRow = newPanel.createDiv({ cls: 'biounix-record-target-dir-row' });
        const dirDisplay = dirRow.createEl('div', { cls: 'biounix-record-target-dir-display', text: '📁 / (vault 根目录)' });
        const dirBtn = dirRow.createEl('button', { text: '选择…', cls: 'biounix-record-target-dir-btn' });
        const dirDropdown = newPanel.createDiv({ cls: 'biounix-record-target-dir-dropdown' });
        dirDropdown.style.display = 'none';

        // 文件名输入
        newPanel.createEl('div', { text: '文件名（不含 .md）', cls: 'biounix-record-target-label' });
        this.filenameInput = newPanel.createEl('input', {
            cls: 'biounix-record-target-filename',
            attr: { type: 'text', placeholder: 'biounix-record-' + new Date().toISOString().slice(0, 10) },
        });

        // 目录下拉构建
        const buildDirList = (): void => {
            dirDropdown.empty();
            // 根目录
            const rootItem = dirDropdown.createDiv({ cls: 'biounix-record-target-dir-item', attr: { 'data-dir': '' } });
            rootItem.createEl('span', { text: '📁 / (vault 根目录)' });
            rootItem.onclick = () => {
                this.selectedDir = '';
                dirDisplay.setText('📁 / (vault 根目录)');
                dirDropdown.style.display = 'none';
            };
            // 所有子目录（递归）
            const folders: TFolder[] = [];
            const collect = (folder: TFolder): void => {
                for (const child of folder.children) {
                    if (child instanceof TFolder) {
                        folders.push(child);
                        collect(child);
                    }
                }
            };
            collect(this.app.vault.getRoot());
            folders.sort((a, b) => a.path.localeCompare(b.path));
            for (const f of folders) {
                const item = dirDropdown.createDiv({ cls: 'biounix-record-target-dir-item', attr: { 'data-dir': f.path } });
                const depth = f.path.split('/').length;
                item.createEl('span', { text: `${'  '.repeat(depth - 1)}📁 ${f.path}/` });
                item.onclick = () => {
                    this.selectedDir = f.path;
                    dirDisplay.setText(`📁 ${f.path}/`);
                    dirDropdown.style.display = 'none';
                };
            }
        };

        dirBtn.onclick = (e) => {
            e.stopPropagation();
            if (dirDropdown.style.display === 'none') {
                buildDirList();
                dirDropdown.style.display = 'block';
            } else {
                dirDropdown.style.display = 'none';
            }
        };
        // 点击外部关闭下拉
        document.addEventListener('click', () => { dirDropdown.style.display = 'none'; }, { once: true });

        // ===== 追加笔记面板 =====
        const appendPanel = body.createDiv({ cls: 'biounix-record-target-panel' });
        appendPanel.style.display = 'none';
        appendPanel.createEl('div', { text: '搜索并选择笔记', cls: 'biounix-record-target-label' });
        this.searchEl = appendPanel.createEl('input', {
            cls: 'biounix-record-target-search',
            attr: { type: 'text', placeholder: '搜索笔记（路径或文件名）...' },
        });
        this.noteListEl = appendPanel.createDiv({ cls: 'biounix-record-target-note-list' });
        this.allFiles = this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);
        this.renderNoteList();
        this.searchEl.addEventListener('input', () => this.renderNoteList());

        // Tab 切换
        newTab.onclick = () => {
            this.mode = 'new';
            newTab.addClass('is-active');
            appendTab.removeClass('is-active');
            newPanel.style.display = 'block';
            appendPanel.style.display = 'none';
        };
        appendTab.onclick = () => {
            this.mode = 'append';
            appendTab.addClass('is-active');
            newTab.removeClass('is-active');
            appendPanel.style.display = 'block';
            newPanel.style.display = 'none';
        };

        // 底部按钮
        const footer = contentEl.createDiv({ cls: 'biounix-record-target-footer' });
        const confirmBtn = footer.createEl('button', {
            text: '确定',
            cls: 'biounix-record-target-confirm',
        });
        const cancelBtn = footer.createEl('button', {
            text: '取消',
            cls: 'biounix-record-target-cancel',
        });

        confirmBtn.onclick = () => {
            if (this.mode === 'new') {
                const fn = (this.filenameInput?.value || '').trim()
                    || `biounix-record-${new Date().toISOString().slice(0, 10)}`;
                // 校验文件名合法性
                if (/[\\:*?"<>|]/.test(fn)) {
                    new Notice('文件名包含非法字符');
                    return;
                }
                this.answered = true;
                this.close();
                this.onResult({ mode: 'new', dir: this.selectedDir, filename: fn });
            } else {
                if (!this.selectedNote) {
                    new Notice('请选择一篇笔记');
                    return;
                }
                this.answered = true;
                this.close();
                this.onResult({ mode: 'append', path: this.selectedNote.path });
            }
        };
        cancelBtn.onclick = () => {
            this.answered = true;
            this.close();
            this.onResult(null);
        };
    }

    /** 渲染笔记列表（应用搜索过滤） */
    private renderNoteList(): void {
        if (!this.noteListEl) return;
        this.noteListEl.empty();
        const q = (this.searchEl?.value || '').toLowerCase().trim();
        const files = q
            ? this.allFiles.filter(f => f.path.toLowerCase().includes(q) || f.basename.toLowerCase().includes(q))
            : this.allFiles;

        if (files.length === 0) {
            this.noteListEl.createEl('div', { text: '无匹配笔记', cls: 'biounix-record-target-empty' });
            return;
        }

        for (const f of files.slice(0, 200)) {
            const item = this.noteListEl.createDiv({
                cls: `biounix-record-target-note-item${this.selectedNote?.path === f.path ? ' is-selected' : ''}`,
                attr: { 'data-path': f.path },
            });
            item.createEl('div', { text: f.basename, cls: 'biounix-record-target-note-name' });
            item.createEl('div', { text: f.path, cls: 'biounix-record-target-note-path' });
            item.onclick = () => {
                this.selectedNote = f;
                // 更新高亮
                this.noteListEl?.querySelectorAll('.biounix-record-target-note-item').forEach(el => el.removeClass('is-selected'));
                item.addClass('is-selected');
            };
        }
    }

    onClose(): void {
        if (!this.answered) {
            this.onResult(null);
        }
    }
}
