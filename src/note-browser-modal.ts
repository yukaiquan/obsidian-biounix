/**
 * Obsidian 笔记浏览器 — 在聊天侧边栏中预览 vault 笔记内容
 *
 * 功能：
 *  - 列出 vault 中所有 markdown 笔记（按修改时间倒序）
 *  - 搜索框过滤（按路径/文件名）
 *  - 当前活动笔记自动置顶并高亮（便于快速定位正在编辑的内容）
 *  - 选中笔记后右侧渲染 Markdown 预览
 *  - ★ 段落级索引选取：点击预览区任意段落可只发送该段（节省 token）
 *  - 可将笔记内容插入到聊天输入框，或作为上下文直接发送
 */
import { App, Modal, Notice, MarkdownRenderer, Component, TFile } from 'obsidian';
import type { BioUnixAPI } from './api';

/** markdown 源码按块切分结果（保留原文，用于段落级发送） */
interface ParaBlock {
    idx: number;
    source: string; // 该段原始 markdown 文本
    kind: 'heading' | 'paragraph' | 'list' | 'code' | 'quote' | 'table' | 'other';
}

/** 单次文件编辑记录（来自后端 file-edits 接口） */
interface EditRecord {
    id: string;
    tool_call_id: string;
    file_path: string;
    action: string;          // edit_file / write_file
    bytes_before: number;
    bytes_after: number;
    timestamp: number;
    undo_state: 'active' | 'undone' | 'redone';
    version_seq: number;
}

/** 行级 diff 结果 */
interface DiffLine { type: 'add' | 'del' | 'ctx'; text: string }

/** 计算行级 diff（基于 LCS） */
function computeLineDiff(a: string[], b: string[]): DiffLine[] {
    const n = a.length, m = b.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const result: DiffLine[] = [];
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

/** 渲染行级 diff 到容器 */
function renderLineDiff(parent: HTMLElement, before: string, after: string): void {
    const diffs = computeLineDiff(before.split('\n'), after.split('\n'));
    const diffWrap = parent.createDiv({ cls: 'biounix-note-browser-diff' });
    let added = 0, removed = 0;
    for (const d of diffs) {
        const row = diffWrap.createDiv({ cls: `biounix-diff-row biounix-diff-${d.type}` });
        const prefix = d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' ';
        row.createEl('span', { text: prefix, cls: 'biounix-diff-prefix' });
        row.createEl('span', { text: d.text, cls: 'biounix-diff-text' });
        if (d.type === 'add') added++;
        if (d.type === 'del') removed++;
    }
    const summary = parent.createDiv({ cls: 'biounix-diff-summary' });
    summary.createEl('span', { text: `+${added}`, cls: 'biounix-diff-add-count' });
    summary.createEl('span', { text: ` -${removed}`, cls: 'biounix-diff-del-count' });
    parent.insertBefore(summary, diffWrap);
}

/** 将 markdown 源码按块切分（空行分隔 + 标题/代码围栏独立成块） */
function splitMarkdownBlocks(src: string): ParaBlock[] {
    const lines = src.split('\n');
    const blocks: ParaBlock[] = [];
    let buf: string[] = [];
    let inFence = false;
    let fenceMarker = '';
    let idx = 0;

    const flush = (): void => {
        if (buf.length === 0) return;
        const text = buf.join('\n').trim();
        if (!text) { buf = []; return; }
        let kind: ParaBlock['kind'] = 'other';
        const first = buf[0];
        if (/^#{1,6}\s/.test(first)) kind = 'heading';
        else if (/^```|^\|{3,}|^~{3,}/.test(first)) kind = 'code';
        else if (/^>\s/.test(first)) kind = 'quote';
        else if (/^\s*[-*+]\s|^\s*\d+\.\s/.test(first)) kind = 'list';
        else if (/^\|.*\|/.test(first)) kind = 'table';
        else kind = 'paragraph';
        blocks.push({ idx: idx++, source: text, kind });
        buf = [];
    };

    for (const line of lines) {
        // 代码围栏开关
        const fenceMatch = line.match(/^(```|~~~)/);
        if (fenceMatch) {
            if (!inFence) {
                flush(); // 围栏前内容先成块
                inFence = true;
                fenceMarker = fenceMatch[1];
                buf.push(line);
            } else if (line.startsWith(fenceMarker)) {
                buf.push(line);
                inFence = false;
                fenceMarker = '';
                flush(); // 代码块成块
            } else {
                buf.push(line);
            }
            continue;
        }
        if (inFence) { buf.push(line); continue; }
        // 空行分隔块
        if (line.trim() === '') {
            flush();
            continue;
        }
        buf.push(line);
    }
    flush();
    return blocks;
}

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
    /** 当前预览笔记的段落块（源码切分） */
    private paraBlocks: ParaBlock[] = [];
    /** 当前选中的段落索引（null=未选段，发送全文） */
    private selectedParaIdx: number | null = null;
    /** 底部按钮引用（动态切换文案） */
    private insertBtn: HTMLButtonElement | null = null;
    private sendBtn: HTMLButtonElement | null = null;
    /** 当前会话 ID（可选，有则显示修改痕迹） */
    private sessionId: string | null;
    /** API 客户端（可选，有 sessionId 时必有） */
    private api: BioUnixAPI | null;
    /** 编辑记录按 filePath 聚合（path → 编辑记录列表，按时间倒序） */
    private editMap: Map<string, EditRecord[]> = new Map();
    /** 当前选中笔记的修改痕迹面板是否展开 */
    private traceExpanded = false;

    constructor(
        app: App,
        onInsert: (text: string, path: string) => void,
        onSend: (text: string, path: string) => void,
        sessionId?: string | null,
        api?: BioUnixAPI | null,
    ) {
        super(app);
        this.onInsert = onInsert;
        this.onSend = onSend;
        this.sessionId = sessionId || null;
        this.api = api || null;
    }

    async onOpen(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('biounix-note-browser');

        // 标题
        const titleEl = contentEl.createDiv({ cls: 'biounix-note-browser-title' });
        titleEl.createEl('span', { text: '📖 Obsidian 笔记' });
        titleEl.createEl('span', { text: ' · 点击段落可只发送该段', cls: 'biounix-note-browser-hint' });
        if (this.sessionId) {
            titleEl.createEl('span', { text: ' · 笔记有修改痕迹可接受/撤销', cls: 'biounix-note-browser-hint' });
        }

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
        this.insertBtn = footer.createEl('button', { text: '插入到输入框', cls: 'biounix-note-browser-btn biounix-note-browser-btn-secondary' });
        this.insertBtn.onclick = () => this.doInsert();
        this.sendBtn = footer.createEl('button', { text: '作为上下文发送', cls: 'biounix-note-browser-btn biounix-note-browser-btn-primary' });
        this.sendBtn.onclick = () => this.doSend();

        // 初始化 Markdown 组件
        this.mdComponent = new Component();
        this.mdComponent.load();

        // 加载所有 markdown 文件（按修改时间倒序）
        this.allFiles = this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);

        // 获取当前活动笔记（用户正在编辑/查看的那篇），自动置顶并默认选中
        const af = this.app.workspace.getActiveFile();
        this.activeFile = af && af.extension === 'md' ? af : null;

        // 加载当前会话的文件编辑记录（用于左侧徽章 + 右侧修改痕迹面板）
        await this.loadEditHistory();

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
                const nameRow = item.createDiv({ cls: 'biounix-note-browser-item-name-row' });
                nameRow.createEl('div', { text: af.basename, cls: 'biounix-note-browser-item-name' });
                this.appendEditBadge(nameRow, af.path);
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
            const nameRow = item.createDiv({ cls: 'biounix-note-browser-item-name-row' });
            // 文件名
            nameRow.createEl('div', { text: f.basename, cls: 'biounix-note-browser-item-name' });
            this.appendEditBadge(nameRow, f.path);
            // 路径
            item.createEl('div', { text: f.path, cls: 'biounix-note-browser-item-path' });
            item.onclick = () => this.selectFile(f);
        }
    }

    /** 加载当前会话的文件编辑记录，按 filePath 聚合 */
    private async loadEditHistory(): Promise<void> {
        if (!this.sessionId || !this.api) return;
        try {
            const res = await this.api.getFileEdits(this.sessionId);
            if (!res.ok || !res.edits) return;
            const edits = res.edits as EditRecord[];
            this.editMap.clear();
            for (const e of edits) {
                const arr = this.editMap.get(e.file_path) || [];
                arr.push(e);
                this.editMap.set(e.file_path, arr);
            }
            // 每个文件按时间倒序
            for (const arr of this.editMap.values()) {
                arr.sort((a, b) => b.timestamp - a.timestamp);
            }
        } catch {
            // 静默失败：无编辑记录不影响基础浏览功能
        }
    }

    /** 在列表项名称行追加"编辑 N 次"徽章（无编辑记录则不显示） */
    private appendEditBadge(parent: HTMLElement, filePath: string): void {
        const edits = this.editMap.get(filePath);
        if (!edits || edits.length === 0) return;
        const activeCount = edits.filter(e => e.undo_state !== 'undone').length;
        const badge = parent.createEl('span', {
            cls: 'biounix-note-browser-edit-badge',
            text: `✎${activeCount}次`,
            attr: { title: `共 ${edits.length} 次编辑，${activeCount} 次生效（点击笔记查看修改痕迹）` },
        });
        if (activeCount === 0) badge.addClass('is-all-undone');
    }

    /** 滚动列表到当前选中项 */
    private scrollToSelected(): void {
        const sel = this.listEl?.querySelector('.biounix-note-browser-item.is-selected') as HTMLElement | null;
        sel?.scrollIntoView({ block: 'nearest' });
    }

    /** 选中笔记并渲染预览（按段落块切分，每段可点击选取） */
    private async selectFile(f: TFile): Promise<void> {
        this.selectedFile = f;
        // 切换笔记时清空段落选中
        this.selectedParaIdx = null;
        this.updateFooterButtons();

        // 仅切换选中态 class，避免重新渲染列表导致滚动位置丢失
        this.listEl?.querySelectorAll('.biounix-note-browser-item').forEach(el => {
            if (el.getAttribute('data-path') === f.path) el.addClass('is-selected');
            else el.removeClass('is-selected');
        });

        if (!this.previewEl) return;
        this.previewEl.empty();
        this.previewEl.createEl('div', { text: f.path, cls: 'biounix-note-browser-preview-path' });
        // ★ 修改痕迹面板（仅有编辑记录时显示）
        this.renderTracePanel(f);
        // 加载占位（读取 + Markdown 渲染期间显示，避免大笔记空白无反馈）
        const loadingEl = this.previewEl.createDiv({ cls: 'biounix-note-browser-preview-loading', text: '加载中…' });
        try {
            const content = await this.app.vault.read(f);
            loadingEl.remove();
            // 按块切分，逐段渲染（每段可点击选取）
            this.paraBlocks = splitMarkdownBlocks(content);
            const mdEl = this.previewEl.createDiv({ cls: 'biounix-note-browser-preview-content' });
            if (this.mdComponent) {
                for (const blk of this.paraBlocks) {
                    const paraWrap = mdEl.createDiv({
                        cls: 'biounix-note-browser-para',
                        attr: { 'data-para-idx': String(blk.idx) },
                    });
                    // 渲染单段 markdown
                    await MarkdownRenderer.renderMarkdown(blk.source, paraWrap, f.path, this.mdComponent);
                    // 点击段落高亮选中
                    paraWrap.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.selectPara(blk.idx);
                    });
                }
            } else {
                mdEl.setText(content);
            }
            // 点击预览区空白处取消选中
            this.previewEl.addEventListener('click', () => {
                if (this.selectedParaIdx !== null) this.selectPara(null);
            });
        } catch (e) {
            loadingEl.remove();
            this.previewEl.createEl('div', { text: `读取失败: ${(e as Error).message}`, cls: 'biounix-note-browser-error' });
        }
    }

    /** 选中某个段落（高亮 + 更新底部按钮文案）；null=取消选中 */
    private selectPara(idx: number | null): void {
        this.selectedParaIdx = idx;
        // 切换高亮
        this.previewEl?.querySelectorAll('.biounix-note-browser-para').forEach(el => {
            if (idx !== null && el.getAttribute('data-para-idx') === String(idx)) {
                el.addClass('is-selected');
            } else {
                el.removeClass('is-selected');
            }
        });
        this.updateFooterButtons();
        // 滚动到选中段
        if (idx !== null) {
            const sel = this.previewEl?.querySelector(`.biounix-note-browser-para[data-para-idx="${idx}"]`) as HTMLElement | null;
            sel?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }

    /** 渲染修改痕迹面板（折叠式，展开后列出每次编辑 + diff + 撤销/重做） */
    private renderTracePanel(f: TFile): void {
        if (!this.previewEl) return;
        const edits = this.editMap.get(f.path);
        if (!edits || edits.length === 0) return;
        const activeCount = edits.filter(e => e.undo_state !== 'undone').length;

        const panel = this.previewEl.createDiv({ cls: 'biounix-note-browser-trace' });
        const head = panel.createDiv({ cls: 'biounix-note-browser-trace-head' });
        head.createEl('span', { text: '✎', cls: 'biounix-note-browser-trace-icon' });
        head.createEl('span', { text: `修改痕迹（${edits.length} 次编辑，${activeCount} 次生效）`, cls: 'biounix-note-browser-trace-title' });

        // 批量操作按钮（头部右侧，折叠状态也可见）
        const headBtns = head.createDiv({ cls: 'biounix-note-browser-trace-head-btns' });
        const activeEdits = edits.filter(e => e.undo_state !== 'undone');
        const undoneEdits = edits.filter(e => e.undo_state === 'undone');
        if (activeEdits.length > 1) {
            const undoAllBtn = headBtns.createEl('button', { cls: 'biounix-note-browser-trace-btn is-undo', attr: { title: `撤销全部 ${activeEdits.length} 次生效编辑` } });
            undoAllBtn.setText(`全部撤销(${activeEdits.length})`);
            undoAllBtn.onclick = (ev) => {
                ev.stopPropagation();
                void this.handleUndoAll(activeEdits, f);
            };
        }
        if (undoneEdits.length > 1) {
            const redoAllBtn = headBtns.createEl('button', { cls: 'biounix-note-browser-trace-btn is-redo', attr: { title: `重做全部 ${undoneEdits.length} 次已撤销编辑` } });
            redoAllBtn.setText(`全部重做(${undoneEdits.length})`);
            redoAllBtn.onclick = (ev) => {
                ev.stopPropagation();
                void this.handleRedoAll(undoneEdits, f);
            };
        }
        const toggle = head.createEl('span', { text: '展开', cls: 'biounix-note-browser-trace-toggle' });

        const body = panel.createDiv({ cls: 'biounix-note-browser-trace-body' });
        // 编辑记录较少（≤3）时默认展开，无需用户点开才能操作
        const autoExpand = edits.length <= 3;
        body.setCssProps({ display: autoExpand ? 'block' : 'none' });
        this.traceExpanded = autoExpand;
        toggle.setText(autoExpand ? '收起' : '展开');

        // 大量编辑时默认只显示最近 10 条 + "显示全部"按钮
        const MAX_COLLAPSED = 10;
        const showCount = edits.length > MAX_COLLAPSED ? MAX_COLLAPSED : edits.length;
        const renderRow = (e: EditRecord, i: number): void => {
            const isUndone = e.undo_state === 'undone';
            const row = body.createDiv({ cls: `biounix-note-browser-trace-row${isUndone ? ' is-undone' : ''}` });
            // 左侧：序号 + 时间 + 字节变化 + 撤销状态
            const info = row.createDiv({ cls: 'biounix-note-browser-trace-info' });
            info.createEl('span', { text: `#${edits.length - i}`, cls: 'biounix-note-browser-trace-seq', attr: { title: `version_seq=${e.version_seq}` } });
            const time = new Date(e.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
            const delta = e.bytes_after - e.bytes_before;
            const sign = delta >= 0 ? '+' : '';
            info.createEl('span', { text: time, cls: 'biounix-note-browser-trace-time' });
            info.createEl('span', { text: `${e.bytes_before}→${e.bytes_after}B (${sign}${delta})`, cls: 'biounix-note-browser-trace-bytes' });
            if (isUndone) {
                info.createEl('span', { text: '已撤销', cls: 'biounix-note-browser-trace-undone-badge' });
            }
            // 右侧：操作按钮
            const btns = row.createDiv({ cls: 'biounix-note-browser-trace-btns' });
            // 查看 diff 按钮
            const diffBtn = btns.createEl('button', { cls: 'biounix-note-browser-trace-btn is-diff', attr: { title: '查看行级 diff' } });
            diffBtn.setText('diff');
            diffBtn.onclick = (ev) => {
                ev.stopPropagation();
                void this.toggleDiff(row, e, diffBtn);
            };
            // 撤销按钮（仅 active 状态显示）
            if (!isUndone) {
                const undoBtn = btns.createEl('button', { cls: 'biounix-note-browser-trace-btn is-undo', attr: { title: '撤销此编辑' } });
                undoBtn.setText('撤销');
                undoBtn.onclick = (ev) => {
                    ev.stopPropagation();
                    void this.handleUndo(e, f, undoBtn);
                };
            } else {
                // 已撤销 → 显示重做按钮
                const redoBtn = btns.createEl('button', { cls: 'biounix-note-browser-trace-btn is-redo', attr: { title: '重做此编辑' } });
                redoBtn.setText('重做');
                redoBtn.onclick = (ev) => {
                    ev.stopPropagation();
                    void this.handleRedo(e, f, redoBtn);
                };
            }
        };
        for (let i = 0; i < showCount; i++) renderRow(edits[i], i);

        // "显示全部"按钮（折叠省略的条目）
        if (edits.length > MAX_COLLAPSED) {
            const moreRow = body.createDiv({ cls: 'biounix-note-browser-trace-more' });
            const moreBtn = moreRow.createEl('button', { cls: 'biounix-note-browser-trace-more-btn', text: `▼ 显示全部 ${edits.length} 条编辑` });
            let expandedAll = false;
            moreBtn.onclick = (ev) => {
                ev.stopPropagation();
                if (!expandedAll) {
                    // 展开全部：清空 body 重画全部条目 + moreRow
                    body.empty();
                    for (let i = 0; i < edits.length; i++) renderRow(edits[i], i);
                    body.appendChild(moreRow);
                    moreBtn.setText(`▲ 收起（只显示最近 ${MAX_COLLAPSED} 条）`);
                    expandedAll = true;
                } else {
                    // 收起：只保留最近 MAX_COLLAPSED 条 + moreRow
                    body.empty();
                    for (let i = 0; i < MAX_COLLAPSED; i++) renderRow(edits[i], i);
                    body.appendChild(moreRow);
                    moreBtn.setText(`▼ 显示全部 ${edits.length} 条编辑`);
                    expandedAll = false;
                }
            };
            body.appendChild(moreRow);
        }

        head.onclick = () => {
            this.traceExpanded = !this.traceExpanded;
            body.setCssProps({ display: this.traceExpanded ? 'block' : 'none' });
            toggle.setText(this.traceExpanded ? '收起' : '展开');
        };
    }

    /** 切换某次编辑的 diff 显示（懒加载 before/after 内容） */
    private async toggleDiff(row: HTMLElement, e: EditRecord, btn: HTMLButtonElement): Promise<void> {
        const existing = row.querySelector('.biounix-note-browser-trace-diff');
        if (existing) { existing.remove(); return; }
        if (!this.sessionId || !this.api) return;
        const diffWrap = row.createDiv({ cls: 'biounix-note-browser-trace-diff' });
        diffWrap.createEl('div', { text: '加载 diff…', cls: 'biounix-note-browser-preview-loading' });
        btn.disabled = true;
        btn.setText('加载中');
        try {
            const res = await this.api.getFileBackup(this.sessionId, e.tool_call_id);
            const r = res as unknown as { ok: boolean; backup?: { contentBefore?: string; contentAfter?: string } };
            if (r.ok && r.backup) {
                diffWrap.empty();
                const before = r.backup.contentBefore || '';
                const after = r.backup.contentAfter || '';
                renderLineDiff(diffWrap, before, after);
            } else {
                diffWrap.empty();
                diffWrap.createEl('div', { text: '无 diff 数据', cls: 'biounix-note-browser-empty' });
            }
        } catch (err) {
            diffWrap.empty();
            diffWrap.createEl('div', { text: `加载失败: ${(err as Error).message}`, cls: 'biounix-note-browser-error' });
        } finally {
            btn.disabled = false;
            btn.setText('diff');
        }
    }

    /** 撤销某次编辑 */
    private async handleUndo(e: EditRecord, f: TFile, btn?: HTMLButtonElement): Promise<void> {
        if (!this.sessionId || !this.api) return;
        if (btn) { btn.disabled = true; btn.setText('撤销中…'); }
        try {
            const res = await this.api.undoFileEdit(this.sessionId, e.tool_call_id);
            if (res.ok) {
                new Notice('已撤销文件编辑');
                // 刷新编辑记录 + 重渲染
                await this.loadEditHistory();
                await this.refreshAfterEdit(f);
            } else {
                new Notice(`撤销失败: ${res.error || '未知错误'}`);
                if (btn) { btn.disabled = false; btn.setText('撤销'); }
            }
        } catch (err) {
            new Notice(`撤销失败: ${(err as Error).message}`);
            if (btn) { btn.disabled = false; btn.setText('撤销'); }
        }
    }

    /** 重做某次已撤销的编辑 */
    private async handleRedo(e: EditRecord, f: TFile, btn?: HTMLButtonElement): Promise<void> {
        if (!this.sessionId || !this.api) return;
        if (btn) { btn.disabled = true; btn.setText('重做中…'); }
        try {
            const res = await this.api.redoFileEdit(this.sessionId, e.tool_call_id);
            if (res.ok) {
                new Notice('已重做文件编辑');
                await this.loadEditHistory();
                await this.refreshAfterEdit(f);
            } else {
                new Notice(`重做失败: ${res.error || '未知错误'}`);
                if (btn) { btn.disabled = false; btn.setText('重做'); }
            }
        } catch (err) {
            new Notice(`重做失败: ${(err as Error).message}`);
            if (btn) { btn.disabled = false; btn.setText('重做'); }
        }
    }

    /** 批量撤销（从最早的生效编辑开始，逐个撤销，避免版本错乱） */
    private async handleUndoAll(edits: EditRecord[], f: TFile): Promise<void> {
        if (!this.sessionId || !this.api) return;
        // 按 version_seq 升序撤销（先撤最新版本会影响旧版本的状态链）
        const sorted = [...edits].sort((a, b) => a.version_seq - b.version_seq);
        let ok = 0;
        for (const e of sorted) {
            try {
                const res = await this.api.undoFileEdit(this.sessionId, e.tool_call_id);
                if (res.ok) ok++;
            } catch { /* 继续下一个 */ }
        }
        new Notice(`已撤销 ${ok}/${sorted.length} 次编辑`);
        await this.loadEditHistory();
        await this.refreshAfterEdit(f);
    }

    /** 批量重做（从最早的已撤销编辑开始，逐个重做） */
    private async handleRedoAll(edits: EditRecord[], f: TFile): Promise<void> {
        if (!this.sessionId || !this.api) return;
        const sorted = [...edits].sort((a, b) => a.version_seq - b.version_seq);
        let ok = 0;
        for (const e of sorted) {
            try {
                const res = await this.api.redoFileEdit(this.sessionId, e.tool_call_id);
                if (res.ok) ok++;
            } catch { /* 继续下一个 */ }
        }
        new Notice(`已重做 ${ok}/${sorted.length} 次编辑`);
        await this.loadEditHistory();
        await this.refreshAfterEdit(f);
    }

    /** 编辑操作后刷新：重渲染列表（更新徽章）+ 重渲染当前笔记预览（含新痕迹面板） */
    private async refreshAfterEdit(f: TFile): Promise<void> {
        this.renderList();
        // 重新选中当前笔记以刷新预览 + 痕迹面板
        await this.selectFile(f);
    }

    /** 根据段落选中态更新底部按钮文案 */
    private updateFooterButtons(): void {
        if (!this.insertBtn || !this.sendBtn) return;
        if (this.selectedParaIdx !== null) {
            const blk = this.paraBlocks[this.selectedParaIdx];
            const label = blk ? `插入第 ${blk.idx + 1} 段` : '插入选中段';
            const sendLabel = blk ? `发送第 ${blk.idx + 1} 段` : '发送选中段';
            this.insertBtn.setText(label);
            this.sendBtn.setText(sendLabel);
        } else {
            this.insertBtn.setText('插入到输入框');
            this.sendBtn.setText('作为上下文发送');
        }
    }

    /** 插入到输入框：选中段时只插该段，否则插全文 */
    private async doInsert(): Promise<void> {
        if (!this.selectedFile) {
            new Notice('请先选择笔记');
            return;
        }
        try {
            const content = await this.app.vault.read(this.selectedFile);
            const body = this.selectedParaIdx !== null
                ? (this.paraBlocks[this.selectedParaIdx]?.source || '')
                : content;
            const header = this.selectedParaIdx !== null
                ? `> 📖 笔记: [[${this.selectedFile.path}]]（第 ${this.selectedParaIdx + 1} 段）`
                : `> 📖 笔记: [[${this.selectedFile.path}]]`;
            const text = body ? `${header}\n\n${body}` : header;
            this.onInsert(text, this.selectedFile.path);
            this.close();
        } catch (e) {
            new Notice(`读取失败: ${(e as Error).message}`);
        }
    }

    /** 作为上下文发送：选中段时只发该段，否则发全文 */
    private async doSend(): Promise<void> {
        if (!this.selectedFile) {
            new Notice('请先选择笔记');
            return;
        }
        try {
            const content = await this.app.vault.read(this.selectedFile);
            const body = this.selectedParaIdx !== null
                ? (this.paraBlocks[this.selectedParaIdx]?.source || '')
                : content;
            const header = this.selectedParaIdx !== null
                ? `请基于以下 Obsidian 笔记片段回答（来源: ${this.selectedFile.path} 第 ${this.selectedParaIdx + 1} 段）：`
                : `请基于以下 Obsidian 笔记内容回答（来源: ${this.selectedFile.path}）：`;
            const text = body ? `${header}\n\n${body}` : header;
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
