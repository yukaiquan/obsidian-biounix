/**
 * BioUnix Obsidian Plugin — 主入口
 *
 * 功能：
 * 1. 代码块执行（```biounix run: ... ```）
 * 2. 右键菜单（生信文件 → 发送到 Agent）
 * 3. 侧边栏聊天视图
 * 4. WebSocket 实时流式推送
 */
import { Plugin, Notice } from 'obsidian';
import { BioUnixAPI } from './api';
import { BioUnixSettingTab, DEFAULT_SETTINGS, type BioUnixSettings } from './settings';
import { BioUnixCodeBlock } from './codeblock';
import { registerFileMenu } from './file-menu';
import { BioUnixChatView, BIOUNIX_CHAT_VIEW_TYPE } from './sidebar';
import { scanVault, generateReportMarkdown, type VaultReport } from './vault-tools';
import { BioUnixVaultReportView, BIOUNIX_VAULT_VIEW_TYPE } from './vault-report';
import { readMainExecution } from './config-reader';
import { NoteServer } from './note-server';

export default class BioUnixPlugin extends Plugin {
  settings: BioUnixSettings = DEFAULT_SETTINGS;
  api: BioUnixAPI = new BioUnixAPI(DEFAULT_SETTINGS);
  private noteServer: NoteServer | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // 初始化 API 客户端
    this.api = new BioUnixAPI(this.settings);

    // 注册设置页
    this.addSettingTab(new BioUnixSettingTab(this.app, this));

    // 1. 代码块处理器
    this.registerMarkdownCodeBlockProcessor('biounix', (source, el, ctx) => {
      ctx.addChild(new BioUnixCodeBlock(el, source, this));
    });

    // 2. 右键菜单
    registerFileMenu(this);

    // 3. 侧边栏视图（直接返回视图实例，不赋值给 plugin 属性，避免内存泄漏）
    this.registerView(BIOUNIX_CHAT_VIEW_TYPE, (leaf) => new BioUnixChatView(leaf, this));

    // 添加侧边栏图标（用主程序自定义图标替换 Lucide 默认图标）
    const ribbonIconEl = this.addRibbonIcon('flask-conical', 'BioUnix Agent', () => {
      void this.activateSidebar();
    });
    // 把 Lucide svg 替换为插件自带 png 图标
    const svg = ribbonIconEl.querySelector('svg');
    if (svg) {
      // 插件目录在 <vault>/.obsidian/plugins/biounix/，用 adapter.getResourcePath 获取可用 URL
      const iconRelPath = `${this.manifest.dir}/icon.png`;
      const iconUrl = this.app.vault.adapter.getResourcePath?.(iconRelPath) || '';
      const img = ribbonIconEl.createEl('img', { attr: { src: iconUrl || 'icon.png' } });
      img.style.width = '20px';
      img.style.height = '20px';
      img.style.objectFit = 'contain';
      svg.replaceWith(img);
    }

    // 4. WebSocket 连接
    if (this.settings.autoConnect) {
      this.connectWebSocket();
    }

    // 5. 启动笔记服务（供主程序 Pipeline 调用 vault 笔记）
    await this.applyNoteServerState();

    // 命令面板（命令 name 不含插件名 "BioUnix"，Obsidian 会在 UI 自动显示插件名）
    this.addCommand({
      id: 'open-chat',
      name: 'Open Agent chat',
      callback: () => void this.activateSidebar(),
    });

    this.addCommand({
      id: 'send-current-file',
      name: 'Send current file to Agent',
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (file) {
          const adapter = this.app.vault.adapter as any;
          const filePath = adapter.getFullPath?.(file.path) || file.path;
          void this.api.createSessionWithDefaults(this.settings, { name: `分析: ${file.name}` }).then(res => {
            if (res.ok && res.session) {
              void this.api.sendMessage(res.session.id, `请分析文件: ${filePath}`);
            }
          });
        }
      },
    });

    // 5. Vault 检查视图与命令
    this.registerView(BIOUNIX_VAULT_VIEW_TYPE, (leaf) => new BioUnixVaultReportView(leaf, this));

    this.addCommand({
      id: 'vault-scan',
      name: 'Scan vault for issues',
      callback: () => void this.runVaultScan(),
    });

    this.addCommand({
      id: 'vault-report',
      name: 'Open vault report',
      callback: () => void this.activateVaultReport(),
    });

    this.addRibbonIcon('search', 'Vault 检查', () => {
      void this.runVaultScan();
    });
  }

  /** 激活侧边栏 */
  async activateSidebar(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(BIOUNIX_CHAT_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: BIOUNIX_CHAT_VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  /** 连接 WebSocket 接收流式推送 */
  connectWebSocket(): void {
    this.api.connectWS((data) => {
      const leaves = this.app.workspace.getLeavesOfType(BIOUNIX_CHAT_VIEW_TYPE);
      const view = leaves[0]?.view;
      if (view instanceof BioUnixChatView) {
        if (data.type === 'agent:chunk' && data.content) {
          view.onStreamChunk(data.content);
        } else if (data.type === 'agent:done') {
          view.onStreamDone();
        } else if (data.type === 'agent:error' && data.error) {
          view.onStreamChunk(`❌ ${data.error}`);
        }
      }
    });
  }

  /** 运行 Vault 扫描 */
  private lastReport: VaultReport | null = null;

  async runVaultScan(): Promise<void> {
    try {
      const report = await scanVault(this.app);
      this.lastReport = report;
      await this.activateVaultReport();
      // 同时生成 Markdown 报告文件
      const md = generateReportMarkdown(report);
      const reportName = `vault-report-${new Date().toISOString().slice(0, 10)}.md`;
      await this.app.vault.create(reportName, md);
      new Notice(`✅ 报告已保存到 ${reportName}`, 3000);
    } catch (e) {
      new Notice(`❌ 扫描失败: ${(e as Error).message}`);
    }
  }

  /** 激活 Vault 报告视图 */
  async activateVaultReport(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(BIOUNIX_VAULT_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      if (this.lastReport) {
        const view = existing[0].view;
        if (view instanceof BioUnixVaultReportView) {
          view.updateReport(this.lastReport);
        }
      }
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: BIOUNIX_VAULT_VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
      if (this.lastReport) {
        const view = leaf.view;
        if (view instanceof BioUnixVaultReportView) {
          view.updateReport(this.lastReport);
        }
      }
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // ★ 用主程序已配置的 LLM 设置回填插件默认值（插件自身未配置时生效）
    // 这样设置页、快捷入口（发送文件/执行代码块）都能复用主程序配置
    const mainExec = readMainExecution();
    if (mainExec) {
      if (!this.settings.apiKey && mainExec.apiKey) this.settings.apiKey = mainExec.apiKey;
      if (mainExec.llmProvider) this.settings.llmProvider = mainExec.llmProvider;
      if (mainExec.model) this.settings.model = mainExec.model;
      if (mainExec.localEndpoint && !this.settings.customEndpoint) this.settings.customEndpoint = mainExec.localEndpoint;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.api.updateSettings(this.settings);
    this.connectWebSocket();
  }

  /** 根据设置启停笔记服务 */
  async applyNoteServerState(): Promise<void> {
    if (this.settings.noteServerEnabled) {
      // 先停再启（端口/token 可能变了）
      if (this.noteServer) {
        await this.noteServer.stop();
        this.noteServer = null;
      }
      this.noteServer = new NoteServer(this.app, {
        port: this.settings.noteServerPort,
        token: this.settings.noteServerToken,
      });
      try {
        await this.noteServer.start();
        new Notice(`BioUnix 笔记服务已启动 :${this.settings.noteServerPort}`);
      } catch (e) {
        new Notice(`笔记服务启动失败: ${(e as Error).message}`);
        this.noteServer = null;
      }
    } else {
      if (this.noteServer) {
        await this.noteServer.stop();
        this.noteServer = null;
      }
    }
  }

  /** 测试笔记服务是否正常 */
  async testNoteServer(): Promise<boolean> {
    if (!this.noteServer || !this.noteServer.isRunning()) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${this.settings.noteServerPort}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  onunload(): void {
    this.api.disconnectWS();
    void this.noteServer?.stop();
  }
}
