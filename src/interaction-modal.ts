/**
 * 交互模态框 — 在 Obsidian 中处理 AI 的确认/选择请求
 *
 * 当 AI 需要用户确认（如执行危险命令、编辑文件）或选择（文件、目录、选项）时，
 * 主程序通过 WebSocket 推送 interaction:request 事件，插件用此 Modal 弹出原生 UI。
 * 用户操作后通过 HTTP POST /api/interaction/submit 提交结果。
 *
 * 支持的交互类型（由 tool_name 区分）：
 *   - confirm_dialog     确认对话框（含风险等级、影响描述、"本次会话不再询问"）
 *   - select_option      选项选择（单选/多选 + 可自定义输入）
 *   - select_file        文件选择
 *   - select_directory   目录选择
 */
import { App, Modal, Setting, Notice } from 'obsidian';
import type BioUnixPlugin from './main';

/** WS 事件传来的交互请求 payload */
export interface InteractionRequest {
    tool_call_id: string;
    tool_name: string;
    params: any;
    timestamp: number;
    session_id?: string;
}

/** 提交给后端的结果（因 tool_name 而异） */
export interface InteractionResult {
    approved?: boolean;
    remember?: boolean;
    cancelled?: boolean;
    selected?: string | string[];
    custom_text?: string;
    path?: string;
}

export class InteractionModal extends Modal {
    private plugin: BioUnixPlugin;
    private request: InteractionRequest;
    private submitted = false;
    /** Enter 快捷键监听器（onClose 时清理，防内存泄漏） */
    private keyHandler: ((e: KeyboardEvent) => void) | null = null;

    constructor(app: App, plugin: BioUnixPlugin, request: InteractionRequest) {
        super(app);
        this.plugin = plugin;
        this.request = request;
    }

    async onOpen(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('biounix-interaction-modal');

        const { tool_name, params } = this.request;

        if (tool_name === 'confirm_dialog') {
            this.renderConfirm(contentEl, params);
        } else if (tool_name === 'select_option') {
            this.renderSelectOption(contentEl, params);
        } else if (tool_name === 'select_file') {
            this.renderSelectFile(contentEl, params);
        } else if (tool_name === 'select_directory') {
            this.renderSelectDirectory(contentEl, params);
        } else {
            // 未知类型，兜底当确认框
            this.renderConfirm(contentEl, params);
        }
    }

    onClose(): void {
        // 清理 Enter 快捷键监听器（防内存泄漏）
        if (this.keyHandler) {
            document.removeEventListener('keydown', this.keyHandler, true);
            this.keyHandler = null;
        }
        // 用户关闭模态框（点 X 或 Esc）且未提交 → 视为取消
        if (!this.submitted) {
            void this.submit({ cancelled: true });
        }
    }

    // ============ 确认对话框 ============

    private renderConfirm(el: HTMLElement, params: any): void {
        const title = params?.title || params?.operation || '需要确认';
        const message = params?.message || params?.impact || '';
        const riskLevel = params?.risk_level || '';
        const reversible = params?.reversible;
        const allowRemember = params?.allow_remember !== false;

        // 标题 + 风险等级配色
        const headerEl = el.createDiv({ cls: 'biounix-interaction-header' });
        const riskClass = this.riskClass(riskLevel);
        if (riskLevel) {
            headerEl.createEl('span', { cls: `biounix-risk-badge biounix-risk-${riskClass}`, text: this.riskLabel(riskLevel) });
        }
        headerEl.createEl('h3', { text: title });

        // 消息/影响描述
        if (message) {
            const msgEl = el.createDiv({ cls: 'biounix-interaction-message' });
            msgEl.setText(message);
        }

        // 命令预览（run_command 场景 params.command）
        if (params?.command) {
            const cmdEl = el.createDiv({ cls: 'biounix-interaction-command' });
            cmdEl.createEl('span', { cls: 'biounix-interaction-command-label', text: '命令：' });
            const codeEl = cmdEl.createEl('code', { cls: 'biounix-interaction-command-code' });
            codeEl.setText(params.command);
        }

        // 不可逆警告
        if (reversible === false) {
            el.createDiv({ cls: 'biounix-interaction-warning' }).setText('⚠️ 此操作不可逆');
        }

        // "本次会话不再询问"复选框
        let remember = false;
        if (allowRemember) {
            const rememberRow = el.createDiv({ cls: 'biounix-interaction-remember' });
            const cb = rememberRow.createEl('input', { attr: { type: 'checkbox' } });
            cb.id = 'biounix-remember';
            rememberRow.createEl('label', { attr: { for: 'biounix-remember' }, text: '本次会话不再询问' });
            cb.addEventListener('change', () => { remember = cb.checked; });
        }

        // 按钮栏
        this.renderButtons(el, {
            onConfirm: () => void this.submit({ approved: true, remember }),
            onCancel: () => void this.submit({ cancelled: true }),
            confirmText: '确认执行',
            confirmClass: riskClass === 'critical' || riskClass === 'high'
                ? 'biounix-btn-danger' : 'biounix-btn-primary',
        });

        // 键盘快捷键：Enter 确认（仅低/中风险，高/critical 需手动点击防误触）
        // Esc 由 Modal 基类 onClose 处理（未提交视为 cancelled）
        if (riskClass !== 'critical' && riskClass !== 'high') {
            this.keyHandler = (e: KeyboardEvent): void => {
                // ★ 排除 IME 组合输入中（中文输入法打英文按回车确认组合）
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                    e.preventDefault();
                    e.stopPropagation();
                    document.removeEventListener('keydown', this.keyHandler!, true);
                    this.keyHandler = null;
                    void this.submit({ approved: true, remember });
                }
            };
            // 捕获阶段绑定，避免被内部输入框吞掉
            document.addEventListener('keydown', this.keyHandler, true);
        }
    }

    // ============ 选项选择 ============

    private renderSelectOption(el: HTMLElement, params: any): void {
        const title = params?.title || params?.prompt || '请选择';
        const multiple = params?.multiple === true;
        const allowCustom = params?.allow_custom_input === true;
        const defaultValue = params?.default_value || params?.default || '';

        // ★ 归一化 options：兼容 string[] 和 {label,value,description}[] 两种格式
        // 主程序传的是对象数组，旧代码按 string[] 处理导致显示 [object Object]
        type NormOpt = { label: string; value: string; description?: string };
        const rawOptions: unknown[] = Array.isArray(params?.options) ? params.options : [];
        const options: NormOpt[] = rawOptions.map((o) => {
            if (typeof o === 'string') return { label: o, value: o };
            if (o && typeof o === 'object') {
                const obj = o as Record<string, unknown>;
                const label = String(obj.label ?? obj.name ?? obj.value ?? '');
                const value = String(obj.value ?? obj.id ?? obj.label ?? obj.name ?? '');
                const description = obj.description != null ? String(obj.description) : undefined;
                return { label, value, description };
            }
            return { label: String(o ?? ''), value: String(o ?? '') };
        }).filter(o => o.value);

        el.createEl('h3', { text: title });
        if (params?.description || params?.message) {
            el.createDiv({ cls: 'biounix-interaction-message' }).setText(params?.description || params?.message);
        }

        const selected = new Set<string>();
        const optionEls: HTMLInputElement[] = [];

        const listEl = el.createDiv({ cls: 'biounix-interaction-options' });
        for (const opt of options) {
            const row = listEl.createDiv({ cls: 'biounix-interaction-option' });
            const input = row.createEl('input', {
                attr: { type: multiple ? 'checkbox' : 'radio', name: 'biounix-opt', value: opt.value },
            });
            // 预选默认值
            if (defaultValue && opt.value === defaultValue) {
                input.checked = true;
                selected.add(opt.value);
            }
            optionEls.push(input);
            input.addEventListener('change', () => {
                if (!multiple) {
                    // 单选：清除其他选中
                    selected.clear();
                    for (const e of optionEls) if (e !== input) e.checked = false;
                }
                if (input.checked) {
                    selected.add(opt.value);
                } else {
                    selected.delete(opt.value);
                }
            });
            const labelEl = row.createEl('label', { cls: 'biounix-interaction-option-label' });
            labelEl.createEl('span', { cls: 'biounix-interaction-option-name', text: opt.label });
            if (opt.description) {
                labelEl.createEl('div', { cls: 'biounix-interaction-option-desc', text: opt.description });
            }
        }

        // 自定义输入
        let customInput: HTMLInputElement | null = null;
        if (allowCustom) {
            const customRow = el.createDiv({ cls: 'biounix-interaction-custom' });
            customRow.createEl('span', { text: '自定义：' });
            customInput = customRow.createEl('input', {
                cls: 'biounix-interaction-custom-input',
                attr: { type: 'text', placeholder: '输入自定义选项...' },
            });
        }

        this.renderButtons(el, {
            onConfirm: () => {
                let result: string | string[];
                const customText = customInput?.value?.trim();
                if (multiple) {
                    result = Array.from(selected);
                    if (customText) result.push(customText);
                } else {
                    result = customText || Array.from(selected)[0] || '';
                }
                if (!result || (Array.isArray(result) && result.length === 0)) {
                    new Notice('请选择或输入一个选项');
                    return;
                }
                void this.submit({ selected: result, custom_text: customText || undefined });
            },
            onCancel: () => void this.submit({ cancelled: true }),
            confirmText: '确定',
            confirmClass: 'biounix-btn-primary',
        });
    }

    // ============ 文件选择 ============

    private renderSelectFile(el: HTMLElement, params: any): void {
        const title = params?.title || '选择文件';
        const defaultPath = params?.default_path || params?.path || '';
        const filter = params?.filter || '';

        el.createEl('h3', { text: title });
        if (params?.description) {
            el.createDiv({ cls: 'biounix-interaction-message' }).setText(params.description);
        }

        let currentPath = defaultPath;
        const pathSetting = new Setting(el)
            .setName('文件路径')
            .setDesc('输入完整文件路径，或点击浏览选择');
        const textEl = pathSetting.controlEl.createEl('input', {
            cls: 'biounix-interaction-path-input',
            attr: { type: 'text', placeholder: '/path/to/file' },
        });
        textEl.value = currentPath;
        textEl.addEventListener('input', () => { currentPath = textEl.value; });

        // Obsidian 无原生文件选择对话框暴露给插件，但可用 vault 内文件浏览
        pathSetting.addButton((btn) => {
            btn.setButtonText('浏览 vault').onClick(() => {
                this.browseVaultFile((path) => {
                    textEl.value = path;
                    currentPath = path;
                }, filter);
            });
        });

        this.renderButtons(el, {
            onConfirm: () => {
                if (!currentPath.trim()) { new Notice('请输入或选择文件路径'); return; }
                void this.submit({ path: currentPath.trim() });
            },
            onCancel: () => void this.submit({ cancelled: true }),
            confirmText: '确定',
            confirmClass: 'biounix-btn-primary',
        });
    }

    // ============ 目录选择 ============

    private renderSelectDirectory(el: HTMLElement, params: any): void {
        const title = params?.title || '选择目录';
        const defaultPath = params?.default_path || params?.path || '';

        el.createEl('h3', { text: title });
        if (params?.description) {
            el.createDiv({ cls: 'biounix-interaction-message' }).setText(params.description);
        }

        let currentPath = defaultPath;
        const pathSetting = new Setting(el)
            .setName('目录路径')
            .setDesc('输入完整目录路径，或从 vault 根目录选择');
        const textEl = pathSetting.controlEl.createEl('input', {
            cls: 'biounix-interaction-path-input',
            attr: { type: 'text', placeholder: '/path/to/directory' },
        });
        textEl.value = currentPath;
        textEl.addEventListener('input', () => { currentPath = textEl.value; });

        // 快捷填入 vault 根目录
        pathSetting.addButton((btn) => {
            btn.setButtonText('vault 根目录').onClick(() => {
                const adapter = this.app.vault.adapter as { getBasePath?: () => string };
                const vaultRoot = adapter.getBasePath?.() || '';
                textEl.value = vaultRoot;
                currentPath = vaultRoot;
            });
        });

        this.renderButtons(el, {
            onConfirm: () => {
                if (!currentPath.trim()) { new Notice('请输入目录路径'); return; }
                void this.submit({ path: currentPath.trim() });
            },
            onCancel: () => void this.submit({ cancelled: true }),
            confirmText: '确定',
            confirmClass: 'biounix-btn-primary',
        });
    }

    // ============ vault 文件浏览 ============

    private browseVaultFile(onPick: (path: string) => void, filter: string): void {
        const files = this.app.vault.getFiles().filter((f) => {
            if (filter && !f.path.toLowerCase().includes(filter.toLowerCase())) return false;
            return true;
        });
        // 简易列表选择：用一个子弹出 Modal
        const picker = new Modal(this.app);
        picker.titleEl.setText('选择文件');
        const list = picker.contentEl.createDiv({ cls: 'biounix-interaction-vault-list' });
        for (const f of files.slice(0, 200)) {
            const item = list.createDiv({ cls: 'biounix-interaction-vault-item' });
            item.setText(f.path);
            item.onclick = () => {
                const adapter = this.app.vault.adapter as { getBasePath?: () => string };
                const base = adapter.getBasePath?.() || '';
                const full = base ? `${base}/${f.path}` : f.path;
                onPick(full);
                picker.close();
            };
        }
        if (files.length > 200) {
            list.createDiv({ cls: 'biounix-interaction-vault-more' }).setText(`...共 ${files.length} 个文件，请手动输入路径`);
        }
        picker.open();
    }

    // ============ 通用按钮栏 ============

    private renderButtons(
        el: HTMLElement,
        opts: {
            onConfirm: () => void;
            onCancel: () => void;
            confirmText: string;
            confirmClass: string;
        },
    ): void {
        const footer = el.createDiv({ cls: 'biounix-interaction-footer' });
        const cancelBtn = footer.createEl('button', {
            text: '取消',
            cls: 'biounix-btn biounix-btn-secondary',
        });
        cancelBtn.onclick = () => opts.onCancel();
        const confirmBtn = footer.createEl('button', {
            text: opts.confirmText,
            cls: `biounix-btn ${opts.confirmClass}`,
        });
        confirmBtn.onclick = () => opts.onConfirm();
    }

    // ============ 风险等级辅助 ============

    private riskClass(level: string): string {
        const map: Record<string, string> = {
            safe: 'safe', low: 'low', medium: 'medium', high: 'high', critical: 'critical', blocked: 'blocked',
        };
        return map[level] || 'low';
    }

    private riskLabel(level: string): string {
        const map: Record<string, string> = {
            safe: '安全', low: '低风险', medium: '中风险', high: '高风险', critical: '极高风险', blocked: '已阻止',
        };
        return map[level] || level;
    }

    // ============ 提交结果 ============

    private async submit(result: InteractionResult): Promise<void> {
        if (this.submitted) return;
        this.submitted = true;
        try {
            await this.plugin.api.submitInteraction(this.request.tool_call_id, result);
        } catch (e) {
            new Notice(`提交交互结果失败: ${(e as Error).message}`);
        } finally {
            this.close();
        }
    }
}
