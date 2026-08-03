/**
 * 新建会话模态框 — 对齐主程序 SessionConfigDialog 的核心选项
 *
 * 支持配置：
 *  - 会话名称、模式（chat/agent）
 *  - LLM Provider / API Key / 模型 / 自定义端点
 *  - 工作区目录（本地路径；agent 模式才用）
 *  - 安全级别（paranoid/normal/yolo）
 *
 * 与主程序差异：
 *  - Obsidian 无原生文件选择对话框暴露给插件，工作区用手动输入 + vault 根目录快捷按钮
 *  - 安全级别通过后端 IPC（security:setSessionLevel）在会话创建后设置
 */
import { App, Modal, Notice, Setting } from 'obsidian';
import type BioUnixPlugin from './main';
import type { BioUnixSettings } from './settings';
import { readMainExecution, readMainApiProfiles, type MainApiProfile } from './config-reader';

/** 创建会话时收集的完整参数 */
export interface CreateSessionInput {
    name: string;
    mode: 'chat' | 'agent';
    provider: BioUnixSettings['llmProvider'];
    apiKey: string;
    model: string;
    customEndpoint: string;
    workspaceDir: string;
    securityLevel: BioUnixSettings['securityLevel'];
    // ★ 工作空间目标类型（local/remote/wsl）
    workspaceKind: 'local' | 'remote' | 'wsl';
    // remote SSH 配置
    ssh: {
        host: string;
        port: number;
        username: string;
        auth_type: 'password' | 'key';
        password: string;
        key_path: string;
        passphrase: string;
    };
    // wsl 发行版
    wslDist: string;
}

/** 各 Provider 的内置模型列表（与主程序 BUILTIN_MODELS 对齐） */
const MODELS_BY_PROVIDER: Record<BioUnixSettings['llmProvider'], string[]> = {
    anthropic: ['claude-sonnet-4', 'claude-opus-4', 'claude-haiku-4', 'claude-3-5-sonnet-20241022', 'claude-3-opus-20240229'],
    openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo', 'o1-preview', 'o1-mini'],
    zhipu: ['glm-4-plus', 'glm-4-air', 'glm-4-flash', 'glm-4-long', 'glm-4', 'glm-3-turbo'],
    deepseek: ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner'],
    moonshot: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    local: [], // local 由用户自定义端点决定，不预设
};

export class CreateSessionModal extends Modal {
    private plugin: BioUnixPlugin;
    private input: CreateSessionInput;
    private onSubmit: (input: CreateSessionInput) => void;
    private modelDropdown!: Setting; // 延迟初始化
    /** 主程序已保存的 API 配置（供快速选择） */
    private apiProfiles: MainApiProfile[];
    /** 主程序已保存的远程 SSH 会话（异步从后端加载，密码已解密） */
    private savedSshSessions: Array<{
        id: string; name: string; host: string; port: number; username: string;
        authType: 'password' | 'key'; password?: string; keyPath?: string; passphrase?: string; lastUsed: number;
    }> = [];
    /** savedSshSessions 是否已完成加载（区分"加载中"与"暂无数据"） */
    private sshSessionsLoaded = false;
    /** 已保存配置列表容器（可重建） */
    private profileListEl!: HTMLDivElement;
    /** 工作区表单容器（按 kind 动态重建） */
    private workspaceFormEl!: HTMLDivElement;
    /** 工作区 Setting 引用（用于 chat 模式禁用） */
    private workspaceSetting?: Setting;

    constructor(app: App, plugin: BioUnixPlugin, onSubmit: (input: CreateSessionInput) => void) {
        super(app);
        this.plugin = plugin;
        this.onSubmit = onSubmit;
        const s = plugin.settings;

        // ★ 优先复用主程序已配置的 LLM 设置，避免用户重复填写
        const mainExec = readMainExecution();
        const provider = (mainExec?.llmProvider as BioUnixSettings['llmProvider']) || s.llmProvider;
        const apiKey = mainExec?.apiKey || s.apiKey;
        const model = mainExec?.model || s.model;
        // local provider 用 localEndpoint；其他用 customEndpoint
        const customEndpoint = provider === 'local'
            ? (mainExec?.localEndpoint || s.customEndpoint)
            : (mainExec?.useCustomEndpoint ? (mainExec?.customEndpoint || '') : (s.customEndpoint));

        this.apiProfiles = readMainApiProfiles();
        this.input = {
            name: '',
            mode: s.defaultMode,
            provider,
            apiKey,
            model,
            customEndpoint,
            workspaceDir: s.workspaceDir,
            securityLevel: s.securityLevel,
            workspaceKind: 'local',
            ssh: { host: '', port: 22, username: '', auth_type: 'password', password: '', key_path: '', passphrase: '' },
            wslDist: '',
        };
        // ★ 异步从后端加载已保存的 SSH 会话（后端用 safeStorage 解密密码后返回）
        void this.loadSavedSshSessions();
    }

    /** 从后端加载已保存的远程 SSH 会话，加载完后若当前在 remote 视图则重建表单 */
    private async loadSavedSshSessions(): Promise<void> {
        try {
            this.savedSshSessions = await this.plugin.api.listSavedSshSessions();
        } catch {
            this.savedSshSessions = [];
        }
        this.sshSessionsLoaded = true;
        // 无论成功/失败/空，只要当前在 remote 视图就重建表单，避免占位文案永久停留
        if (this.input.workspaceKind === 'remote') {
            this.rebuildWorkspaceForm();
        }
    }

    onOpen(): void {
        const { contentEl, titleEl } = this;
        titleEl.setText('新建 BioUnix 会话');
        contentEl.addClass('biounix-create-session-modal');

        // ---- 会话基本信息 ----
        contentEl.createEl('div', { text: '会话信息', cls: 'biounix-modal-section-title' });

        new Setting(contentEl)
            .setName('会话名称')
            .setDesc('留空则自动按时间生成')
            .addText(text => text
                .setPlaceholder('如：分析 RNA-seq 数据')
                .onChange(v => { this.input.name = v.trim(); }));

        new Setting(contentEl)
            .setName('模式')
            .setDesc('Agent=可执行工具/命令；Chat=纯对话')
            .addDropdown(dd => dd
                .addOption('agent', 'Agent（工具执行）')
                .addOption('chat', 'Chat（纯对话）')
                .setValue(this.input.mode)
                .onChange(v => {
                    this.input.mode = v as 'chat' | 'agent';
                    // chat 模式禁用工作区（纯对话不需要）
                    this.updateWorkspaceEnabled();
                }));

        // ---- LLM 配置 ----
        contentEl.createEl('div', { text: 'LLM 配置', cls: 'biounix-modal-section-title' });

        // 已保存的 API 配置快速选择（来自主程序 useConfigStore.apiProfiles）
        if (this.apiProfiles.length > 0) {
            const profileSetting = new Setting(contentEl)
                .setName('已保存 API 配置')
                .setDesc('点击「加载」复用主程序保存的配置，自动填充下方字段');
            this.profileListEl = profileSetting.controlEl.createDiv({ cls: 'biounix-profile-list' });
            this.rebuildProfileButtons();
        }

        this.providerSetting = new Setting(contentEl)
            .setName('Provider')
            .setDesc('选择 LLM 服务商');
        this.rebuildProviderDropdown();

        this.apiKeySetting = new Setting(contentEl)
            .setName('API Key')
            .setDesc('对应 Provider 的 API Key（local 模式可留空）');
        this.rebuildApiKeyControl();

        // 模型下拉（可重建）
        this.modelDropdown = new Setting(contentEl)
            .setName('模型')
            .setDesc('选择或输入模型名称');
        this.rebuildModelDropdown();

        // 自定义端点（可重建）
        this.endpointSetting = new Setting(contentEl)
            .setName('自定义端点')
            .setDesc('Local 模型或兼容 OpenAI 的服务端点');
        this.rebuildEndpointControl();

        // ---- 工作区（仅 agent 模式） ----
        contentEl.createEl('div', { text: '工作区', cls: 'biounix-modal-section-title' });

        // 工作区类型选择：本地 / 远程 SSH / WSL
        new Setting(contentEl)
            .setName('工作区类型')
            .setDesc('选择 Agent 执行命令的目标环境')
            .addDropdown(dd => dd
                .addOption('local', '本地（当前机器）')
                .addOption('remote', '远程服务器（SSH）')
                .addOption('wsl', 'WSL（Windows 子系统）')
                .setValue(this.input.workspaceKind)
                .onChange(v => {
                    this.input.workspaceKind = v as 'local' | 'remote' | 'wsl';
                    this.rebuildWorkspaceForm();
                }));

        // 工作区表单容器（根据类型动态重建）
        this.workspaceFormEl = contentEl.createDiv({ cls: 'biounix-workspace-form' });
        this.rebuildWorkspaceForm();

        this.updateWorkspaceEnabled();

        // ---- 安全级别 ----
        contentEl.createEl('div', { text: '安全', cls: 'biounix-modal-section-title' });

        new Setting(contentEl)
            .setName('安全级别')
            .setDesc('paranoid=每次工具调用确认；normal=敏感操作确认；yolo=全自动放行')
            .addDropdown(dd => dd
                .addOption('paranoid', 'Paranoid（全部确认）')
                .addOption('normal', 'Normal（默认）')
                .addOption('yolo', 'YOLO（全自动）')
                .setValue(this.input.securityLevel)
                .onChange(v => { this.input.securityLevel = v as BioUnixSettings['securityLevel']; }));

        // ---- 底部按钮 ----
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('取消')
                .onClick(() => this.close()))
            .addButton(btn => btn
                .setButtonText('创建会话')
                .setCta()
                .onClick(() => {
                    // 校验：非 local 模式必须有 API Key
                    if (this.input.provider !== 'local' && !this.input.apiKey.trim()) {
                        new Notice('请填写 API Key（或在设置中配置默认 Key）');
                        return;
                    }
                    // local 模式必须有端点
                    if (this.input.provider === 'local' && !this.input.customEndpoint.trim()) {
                        new Notice('Local 模式需填写自定义端点');
                        return;
                    }
                    this.close();
                    this.onSubmit(this.input);
                }));
    }

    private providerSetting!: Setting;
    private apiKeySetting!: Setting;
    private endpointSetting!: Setting;

    /** 重建 Provider 下拉 */
    private rebuildProviderDropdown(): void {
        this.providerSetting.controlEl.empty();
        this.providerSetting.addDropdown(dd => {
            dd.addOption('anthropic', 'Anthropic (Claude)');
            dd.addOption('openai', 'OpenAI (GPT)');
            dd.addOption('zhipu', '智谱 (GLM)');
            dd.addOption('deepseek', 'DeepSeek');
            dd.addOption('moonshot', 'Moonshot (Kimi)');
            dd.addOption('local', 'Local Model');
            dd.setValue(this.input.provider);
            dd.onChange(v => {
                this.input.provider = v as BioUnixSettings['llmProvider'];
                // 切换 provider 时刷新模型下拉为该 provider 的内置列表
                const models = MODELS_BY_PROVIDER[this.input.provider];
                if (models.length > 0 && !models.includes(this.input.model)) {
                    this.input.model = models[0];
                }
                this.rebuildModelDropdown();
                this.rebuildEndpointControl();
            });
        });
    }

    /** 重建 API Key 输入框（默认遮蔽，可切换显示） */
    private rebuildApiKeyControl(): void {
        this.apiKeySetting.controlEl.empty();
        this.apiKeySetting.addText(text => {
            text
                .setValue(this.input.apiKey)
                .setPlaceholder('sk-...')
                .onChange(v => { this.input.apiKey = v; });
            // 默认密码遮蔽
            text.inputEl.type = 'password';
            // 切换显示/隐藏按钮
            const toggleBtn = this.apiKeySetting.controlEl.createEl('button', {
                cls: 'biounix-apikey-toggle',
                attr: { type: 'button', title: '显示/隐藏' },
            });
            toggleBtn.setText('👁');
            toggleBtn.setCssProps({ marginLeft: '6px', padding: '4px 8px', cursor: 'pointer', background: 'var(--background-secondary)', border: '1px solid var(--background-modifier-border)', borderRadius: '4px' });
            toggleBtn.addEventListener('click', () => {
                if (text.inputEl.type === 'password') {
                    text.inputEl.type = 'text';
                    toggleBtn.setText('🙈');
                } else {
                    text.inputEl.type = 'password';
                    toggleBtn.setText('👁');
                }
            });
        });
    }

    /** 切换 provider / 选择 profile 后重建模型下拉，支持自定义模型名 */
    private rebuildModelDropdown(): void {
        this.modelDropdown.controlEl.empty();
        const models = MODELS_BY_PROVIDER[this.input.provider];
        this.modelDropdown.addDropdown(dd => {
            for (const m of models) {
                dd.addOption(m, m);
            }
            // 当前模型不在内置列表时追加显示（避免受控 select 误显示首项）
            if (this.input.model && !models.includes(this.input.model)) {
                dd.addOption(this.input.model, this.input.model);
            }
            dd.setValue(this.input.model);
            dd.onChange(v => { this.input.model = v; });
        });
        // local 模式额外允许手动输入模型名
        if (this.input.provider === 'local') {
            this.modelDropdown.addText(text => text
                .setPlaceholder('或手动输入模型名')
                .onChange(v => {
                    const trimmed = v.trim();
                    if (trimmed) this.input.model = trimmed;
                }));
        }
    }

    /** 重建端点输入框 */
    private rebuildEndpointControl(): void {
        this.endpointSetting.controlEl.empty();
        this.endpointSetting.addText(text => text
            .setValue(this.input.customEndpoint)
            .setPlaceholder('http://localhost:1234/v1')
            .onChange(v => { this.input.customEndpoint = v.trim(); }));
    }

    /** 重建已保存配置列表（每行：名称 + provider·model + 加载按钮） */
    private rebuildProfileButtons(): void {
        if (!this.profileListEl) return;
        this.profileListEl.empty();
        for (const p of this.apiProfiles) {
            const row = this.profileListEl.createDiv({ cls: 'biounix-profile-row' });
            // 左侧：名称 + 副信息
            const info = row.createDiv({ cls: 'biounix-profile-info' });
            info.createDiv({ cls: 'biounix-profile-name', text: p.name });
            info.createDiv({
                cls: 'biounix-profile-desc',
                text: `${p.provider}${p.model ? ` · ${p.model}` : ''}${p.apiKey ? ' · 已配置 Key' : ''}`,
            });
            // 右侧：加载按钮
            const btn = row.createEl('button', { cls: 'biounix-profile-load-btn', text: '加载' });
            btn.addEventListener('click', () => {
                this.applyProfile(p);
                new Notice(`已加载配置: ${p.name}`);
            });
        }
    }

    /** 应用某个已保存配置到当前输入并刷新所有控件 */
    private applyProfile(p: MainApiProfile): void {
        this.input.provider = p.provider;
        this.input.apiKey = p.apiKey || '';
        this.input.model = p.model || '';
        this.input.customEndpoint = p.provider === 'local'
            ? (p.localEndpoint || '')
            : (p.useCustomEndpoint ? (p.customEndpoint || '') : '');
        // 刷新所有依赖 provider 的控件显示
        this.rebuildProviderDependentControls();
    }

    /** 选择已保存配置后，重建所有依赖 provider 的控件以刷新显示 */
    private rebuildProviderDependentControls(): void {
        this.rebuildProviderDropdown();
        this.rebuildApiKeyControl();
        this.rebuildModelDropdown();
        this.rebuildEndpointControl();
    }

    /** chat 模式禁用工作区 */
    private updateWorkspaceEnabled(): void {
        const disabled = this.input.mode === 'chat';
        // 禁用工作区表单内的所有交互控件
        if (this.workspaceFormEl) {
            this.workspaceFormEl.toggleClass('is-disabled', disabled);
            this.workspaceFormEl.querySelectorAll('input, button, select').forEach(el => {
                (el as HTMLInputElement).disabled = disabled;
            });
        }
    }

    /** 根据工作区类型重建表单：local=目录选择；remote=SSH 配置+测试；wsl=distro 选择 */
    private rebuildWorkspaceForm(): void {
        if (!this.workspaceFormEl) return;
        this.workspaceFormEl.empty();
        const kind = this.input.workspaceKind;

        if (kind === 'local') {
            const s = new Setting(this.workspaceFormEl)
                .setName('工作区目录')
                .setDesc('Agent 执行命令的工作目录（留空=当前 vault 根目录）');
            s.addText(text => text
                .setValue(this.input.workspaceDir)
                .setPlaceholder('/path/to/project')
                .onChange(v => { this.input.workspaceDir = v.trim(); }));
            s.addButton(btn => btn
                .setButtonText('使用 Vault')
                .setTooltip('填入当前 Obsidian Vault 根目录')
                .onClick(() => {
                    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
                    const vaultPath = adapter.getBasePath?.() || '';
                    if (vaultPath) {
                        this.input.workspaceDir = vaultPath;
                        this.rebuildWorkspaceForm();
                    } else {
                        new Notice('无法获取 Vault 路径，请手动输入');
                    }
                }));
            this.workspaceSetting = s;
        } else if (kind === 'remote') {
            // SSH 配置表单
            const ssh = this.input.ssh;
            // ★ 已保存的远程会话快速加载（类似 API profiles 的"加载"按钮）
            // 异步加载：首次打开时可能还在请求中，加载完成后会 rebuild
            if (this.savedSshSessions.length > 0) {
                new Setting(this.workspaceFormEl)
                    .setName('已保存的远程会话')
                    .setDesc('从主程序已保存的 SSH 配置中加载')
                    .addDropdown(dd => {
                        dd.addOption('', '请选择...');
                        for (const s of this.savedSshSessions) {
                            dd.addOption(s.id, s.name || `${s.username}@${s.host}`);
                        }
                        dd.onChange(v => {
                            const found = this.savedSshSessions.find(s => s.id === v);
                            if (!found) return;
                            this.input.ssh = {
                                host: found.host,
                                port: found.port || 22,
                                username: found.username,
                                auth_type: found.authType === 'key' ? 'key' : 'password',
                                password: found.password || '',
                                key_path: found.keyPath || '',
                                passphrase: found.passphrase || '',
                            };
                            // 用已保存会话名作为会话名（若用户未填）
                            if (!this.input.name) this.input.name = found.name;
                            this.rebuildWorkspaceForm();
                            new Notice(`已加载: ${found.name}`);
                        });
                    });
            } else {
                // 加载中或无数据时显示占位
                new Setting(this.workspaceFormEl)
                    .setName('已保存的远程会话')
                    .setDesc(this.sshSessionsLoaded ? '暂无已保存的远程会话（可在主程序中保存 SSH 配置后复用）' : '正在从主程序加载...');
            }
            new Setting(this.workspaceFormEl)
                .setName('主机')
                .addText(text => text
                    .setValue(ssh.host)
                    .setPlaceholder('如 192.168.1.10')
                    .onChange(v => { ssh.host = v.trim(); }));
            new Setting(this.workspaceFormEl)
                .setName('端口')
                .addText(text => text
                    .setValue(String(ssh.port))
                    .setPlaceholder('22')
                    .onChange(v => { ssh.port = parseInt(v) || 22; }));
            new Setting(this.workspaceFormEl)
                .setName('用户名')
                .addText(text => text
                    .setValue(ssh.username)
                    .setPlaceholder('如 root')
                    .onChange(v => { ssh.username = v.trim(); }));
            new Setting(this.workspaceFormEl)
                .setName('认证方式')
                .addDropdown(dd => dd
                    .addOption('password', '密码')
                    .addOption('key', '密钥文件')
                    .setValue(ssh.auth_type)
                    .onChange(v => {
                        ssh.auth_type = v as 'password' | 'key';
                        this.rebuildWorkspaceForm();
                    }));
            if (ssh.auth_type === 'password') {
                new Setting(this.workspaceFormEl)
                    .setName('密码')
                    .addText(text => text
                        .setValue(ssh.password)
                        .setPlaceholder('SSH 密码')
                        .onChange(v => { ssh.password = v; }));
            } else {
                new Setting(this.workspaceFormEl)
                    .setName('密钥路径')
                    .setDesc('如 ~/.ssh/id_rsa')
                    .addText(text => text
                        .setValue(ssh.key_path)
                        .setPlaceholder('~/.ssh/id_rsa')
                        .onChange(v => { ssh.key_path = v.trim(); }));
                new Setting(this.workspaceFormEl)
                    .setName('密钥口令')
                    .setDesc('密钥有口令时填写，无则留空')
                    .addText(text => text
                        .setValue(ssh.passphrase)
                        .setPlaceholder('可选')
                        .onChange(v => { ssh.passphrase = v; }));
            }
            new Setting(this.workspaceFormEl)
                .setName('远程工作目录')
                .setDesc('SSH 登录后的默认工作目录（留空=用户家目录）')
                .addText(text => text
                    .setValue(this.input.workspaceDir)
                    .setPlaceholder('/home/user/project')
                    .onChange(v => { this.input.workspaceDir = v.trim(); }))
                .addButton(btn => btn
                    .setButtonText('浏览')
                    .setTooltip('浏览远程目录选择')
                    .onClick(() => {
                        if (!ssh.host || !ssh.username) {
                            new Notice('请先填写主机和用户名');
                            return;
                        }
                        new RemoteDirBrowserModal(this.app, this.plugin, {
                            host: ssh.host, port: ssh.port, username: ssh.username,
                            authType: ssh.auth_type, password: ssh.password || undefined,
                            keyPath: ssh.key_path || undefined, passphrase: ssh.passphrase || undefined,
                        }, this.input.workspaceDir, (p) => {
                            this.input.workspaceDir = p;
                            this.rebuildWorkspaceForm();
                        }).open();
                    }));
            // 测试连接按钮
            new Setting(this.workspaceFormEl)
                .setName('测试连接')
                .setDesc('验证 SSH 可达性与主机公钥')
                .addButton(btn => btn
                    .setButtonText('测试连接')
                    .onClick(() => void this.testSshConnection()));
        } else if (kind === 'wsl') {
            // WSL 发行版选择
            if (process.platform !== 'win32') {
                new Setting(this.workspaceFormEl)
                    .setName('WSL 发行版')
                    .setDesc('WSL 仅支持 Windows 平台');
            } else {
                const distroSetting = new Setting(this.workspaceFormEl)
                    .setName('WSL 发行版')
                    .setDesc('从本机已安装的 WSL 发行版中选择');
                distroSetting.addDropdown(dd => {
                    dd.addOption('', '加载中...');
                    dd.setDisabled(true);
                    this.plugin.api.listWslDistros().then(distros => {
                        dd.selectEl.empty();
                        if (distros.length === 0) {
                            dd.addOption('', '未检测到发行版');
                            dd.setDisabled(true);
                        } else {
                            dd.addOption('', '请选择');
                            for (const d of distros) dd.addOption(d, d);
                            dd.setValue(this.input.wslDist || '');
                            dd.setDisabled(false);
                            dd.onChange(v => { this.input.wslDist = v; });
                        }
                    });
                });
                new Setting(this.workspaceFormEl)
                    .setName('WSL 工作目录')
                    .setDesc('WSL 内的工作目录路径')
                    .addText(text => text
                        .setValue(this.input.workspaceDir)
                        .setPlaceholder('/home/user/project')
                        .onChange(v => { this.input.workspaceDir = v.trim(); }));
            }
        }

        // 重建后重新应用 chat 模式禁用
        this.updateWorkspaceEnabled();
    }

    /** 测试 SSH 连接：成功提示；hostKeyChallenge 弹框确认后写入 */
    private async testSshConnection(): Promise<void> {
        const ssh = this.input.ssh;
        if (!ssh.host || !ssh.username) {
            new Notice('请填写主机和用户名');
            return;
        }
        new Notice('正在测试 SSH 连接...');
        try {
            const res = await this.plugin.api.testSsh({
                host: ssh.host,
                port: ssh.port,
                username: ssh.username,
                authType: ssh.auth_type,
                password: ssh.password || undefined,
                keyPath: ssh.key_path || undefined,
                passphrase: ssh.passphrase || undefined,
            });
            if (res.ok) {
                new Notice(`✓ SSH 连接成功${res.serverVersion ? '：' + res.serverVersion : ''}`);
                return;
            }
            // 需要确认主机公钥
            if (res.hostKeyChallenge) {
                const ch = res.hostKeyChallenge;
                const fp = ch.fingerprint || '(未知)';
                const reasonText = ch.reason === 'changed' ? '主机公钥已变更！' : '未知主机';
                const confirmModal = new ConfirmHostKeyModal(this.app, `${reasonText}\n主机: ${ch.host}:${ch.port}\n指纹: ${fp}`, (accepted) => {
                    if (!accepted) {
                        new Notice('已拒绝主机公钥');
                        return;
                    }
                    void (async () => {
                        try {
                            await this.plugin.api.confirmHostKey(ch);
                            new Notice('已确认主机公钥，重试连接...');
                            await this.testSshConnection();
                        } catch (e) {
                            new Notice('确认主机公钥失败: ' + (e as Error).message);
                        }
                    })();
                });
                confirmModal.open();
                return;
            }
            new Notice('✗ SSH 连接失败: ' + (res.error || '未知错误'));
        } catch (e) {
            new Notice('✗ 测试失败: ' + (e as Error).message);
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

/**
 * 远程目录浏览器 — 用 SFTP 列目录，可选择远程工作目录。
 * 测试连接通过后可使用；未测试也可尝试（连接失败会提示）。
 */
export class RemoteDirBrowserModal extends Modal {
    private readonly plugin: BioUnixPlugin;
    private readonly ssh: {
        host: string; port: number; username: string;
        authType: 'password' | 'key'; password?: string; keyPath?: string; passphrase?: string;
    };
    private readonly initialPath: string;
    private readonly onSelect: (path: string) => void;
    private cwd = '';
    private listEl!: HTMLElement;
    private pathEl!: HTMLElement;
    private loading = false;
    private loadingDir = ''; // 防止快速点击竞态
    private showHidden = false;
    private hiddenBtnEl!: HTMLButtonElement;
    private lastError = '';

    constructor(app: App, plugin: BioUnixPlugin, ssh: RemoteDirBrowserModal['ssh'], initialPath: string, onSelect: (path: string) => void) {
        super(app);
        this.plugin = plugin;
        this.ssh = ssh;
        this.initialPath = initialPath;
        this.onSelect = onSelect;
        this.titleEl.setText('选择远程目录');
    }

    onOpen(): void {
        const body = this.contentEl.createDiv({ cls: 'biounix-remote-browser' });
        // 工具栏：上级按钮 + 路径面包屑 + 显示隐藏开关
        const toolbar = body.createDiv({ cls: 'biounix-remote-browser-toolbar' });
        const upBtn = toolbar.createEl('button', { text: '↑', cls: 'biounix-remote-browser-up' });
        upBtn.title = '上级目录';
        upBtn.addEventListener('click', () => this.goUp());
        this.pathEl = toolbar.createDiv({ cls: 'biounix-remote-browser-path' });
        this.hiddenBtnEl = toolbar.createEl('button', { text: '◐', cls: 'biounix-remote-browser-hidden' });
        this.hiddenBtnEl.title = '显示/隐藏隐藏文件';
        this.hiddenBtnEl.addEventListener('click', () => {
            this.showHidden = !this.showHidden;
            this.hiddenBtnEl.classList.toggle('is-active', this.showHidden);
            this.renderList();
        });
        this.listEl = body.createDiv({ cls: 'biounix-remote-browser-list' });
        // 底部操作栏
        const footer = body.createDiv({ cls: 'biounix-remote-browser-footer' });
        const selectBtn = footer.createEl('button', { text: '选择此目录', cls: 'mod-cta' });
        const cancelBtn = footer.createEl('button', { text: '取消' });
        selectBtn.addEventListener('click', () => {
            if (this.cwd) { this.onSelect(this.cwd); this.close(); }
        });
        cancelBtn.addEventListener('click', () => this.close());
        void this.loadDir(this.initialPath || '');
    }

    /** 渲染路径面包屑（可点击跳转） */
    private renderBreadcrumb(): void {
        this.pathEl.empty();
        this.pathEl.createSpan({ text: `${this.ssh.username}@${this.ssh.host}:`, cls: 'biounix-remote-browser-path-host' });
        if (!this.cwd) {
            this.pathEl.createSpan({ text: '~' });
            return;
        }
        const parts = this.cwd.replace(/\/+$/, '').split('/').filter(Boolean);
        const segs: { label: string; path: string }[] = [{ label: '/', path: '/' }];
        let acc = '';
        for (const p of parts) {
            acc += '/' + p;
            segs.push({ label: p, path: acc });
        }
        segs.forEach((seg, i) => {
            if (i > 0) this.pathEl.createSpan({ text: '/', cls: 'biounix-remote-browser-path-sep' });
            const span = this.pathEl.createEl('span', { text: seg.label, cls: 'biounix-remote-browser-path-seg' });
            if (i < segs.length - 1) {
                span.addEventListener('click', () => void this.loadDir(seg.path));
            } else {
                span.classList.add('is-current');
            }
        });
    }

    /** 根据 this.entries 渲染列表（不重新请求） */
    private renderList(): void {
        this.listEl.empty();
        const entries = this.lastEntries;
        const visible = this.showHidden ? entries : entries.filter((e) => !e.name.startsWith('.'));
        if (visible.length === 0) {
            this.listEl.createDiv({ text: '（无子目录）', cls: 'biounix-remote-browser-empty' });
            return;
        }
        for (const e of visible) {
            const row = this.listEl.createDiv({ cls: 'biounix-remote-browser-item' + (e.is_dir ? ' is-dir' : ' is-file') });
            row.createSpan({ text: e.is_dir ? '📁' : '📄', cls: 'biounix-remote-browser-icon' });
            row.createSpan({ text: e.name, cls: 'biounix-remote-browser-name' });
            if (e.is_dir) {
                row.addEventListener('click', () => void this.loadDir(e.path));
            } else {
                row.classList.add('is-disabled');
            }
        }
    }

    private lastEntries: Array<{ name: string; path: string; is_dir: boolean; size: number }> = [];

    private async loadDir(dir: string): Promise<void> {
        if (this.loading && this.loadingDir === dir) return;
        const target = dir || '';
        this.loadingDir = target;
        this.loading = true;
        this.lastError = '';
        this.listEl.empty();
        this.listEl.createDiv({ text: '加载中...', cls: 'biounix-remote-browser-loading' });
        try {
            const res = await this.plugin.api.listRemoteDir({
                host: this.ssh.host, port: this.ssh.port, username: this.ssh.username,
                authType: this.ssh.authType, password: this.ssh.password,
                keyPath: this.ssh.keyPath, passphrase: this.ssh.passphrase,
                path: target || undefined,
            });
            if (this.loadingDir !== target) return; // 已被后续点击覆盖
            this.listEl.empty();
            if (!res.ok) {
                this.lastError = res.error || '未知错误';
                this.renderError();
                return;
            }
            this.cwd = res.path || dir || '';
            this.lastEntries = res.entries || [];
            this.renderBreadcrumb();
            this.renderList();
        } catch (e) {
            if (this.loadingDir !== target) return;
            this.lastError = (e as Error).message;
            this.listEl.empty();
            this.renderError();
        } finally {
            if (this.loadingDir === target) {
                this.loading = false;
                this.loadingDir = '';
            }
        }
    }

    private renderError(): void {
        this.listEl.empty();
        const errDiv = this.listEl.createDiv({ cls: 'biounix-remote-browser-error' });
        errDiv.createDiv({ text: '列目录失败: ' + this.lastError });
        const retryBtn = errDiv.createEl('button', { text: '重试', cls: 'biounix-remote-browser-retry' });
        retryBtn.addEventListener('click', () => void this.loadDir(this.cwd));
    }

    private goUp(): void {
        if (!this.cwd || this.cwd === '/') return;
        const parent = this.cwd.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
        void this.loadDir(parent);
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

/**
 * 主机公钥确认对话框 — SSH 首次连接或公钥变更时弹出，让用户决定是否信任。
 */
export class ConfirmHostKeyModal extends Modal {
    private onResult: (accepted: boolean) => void;

    constructor(app: App, message: string, onResult: (accepted: boolean) => void) {
        super(app);
        this.onResult = onResult;
        this.titleEl.setText('确认主机公钥');
        const body = this.contentEl.createDiv({ cls: 'biounix-confirm-hostkey' });
        body.createEl('pre', { text: message, cls: 'biounix-hostkey-pre' });
        body.createEl('div', {
            text: '⚠ 仅在你确认该指纹属于目标服务器时点击「信任」。公钥变更可能意味着中间人攻击。',
            cls: 'biounix-hostkey-warning',
        });
        const btns = body.createDiv({ cls: 'biounix-hostkey-btns' });
        const trustBtn = btns.createEl('button', { text: '信任并连接', cls: 'mod-warning' });
        const cancelBtn = btns.createEl('button', { text: '拒绝' });
        trustBtn.addEventListener('click', () => { this.onResult(true); this.close(); });
        cancelBtn.addEventListener('click', () => { this.onResult(false); this.close(); });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
