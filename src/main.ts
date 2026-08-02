/**
 * BioUnix Obsidian Plugin — 主入口
 *
 * 功能：
 * 1. 代码块执行（```biounix run: ... ```）
 * 2. 右键菜单（生信文件 → 发送到 Agent）
 * 3. 侧边栏聊天视图
 * 4. WebSocket 实时流式推送
 */
import { Plugin, WorkspaceLeaf, Notice } from 'obsidian';
import { BioUnixAPI } from './api';
import { BioUnixSettingTab, DEFAULT_SETTINGS, type BioUnixSettings } from './settings';
import { BioUnixCodeBlock } from './codeblock';
import { registerFileMenu } from './file-menu';
import { BioUnixChatView, BIOUNIX_CHAT_VIEW_TYPE } from './sidebar';
import { scanVault, generateReportMarkdown, type VaultReport } from './vault-tools';
import { BioUnixVaultReportView, BIOUNIX_VAULT_VIEW_TYPE } from './vault-report';

export default class BioUnixPlugin extends Plugin {
  settings: BioUnixSettings = DEFAULT_SETTINGS;
  api: BioUnixAPI = new BioUnixAPI(DEFAULT_SETTINGS);
  private chatView: BioUnixChatView | null = null;

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

    // 3. 侧边栏视图
    this.registerView(BIOUNIX_CHAT_VIEW_TYPE, (leaf) => {
      this.chatView = new BioUnixChatView(leaf, this);
      return this.chatView;
    });

    // 添加侧边栏图标
    this.addRibbonIcon('flask-conical', 'BioUnix Agent', () => {
      this.activateSidebar();
    });

    // 4. WebSocket 连接
    if (this.settings.autoConnect) {
      this.connectWebSocket();
    }

    // 命令面板
    this.addCommand({
      id: 'open-chat',
      name: 'Open BioUnix Agent chat',
      callback: () => this.activateSidebar(),
    });

    this.addCommand({
      id: 'send-current-file',
      name: 'Send current file to BioUnix Agent',
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (file) {
          const adapter = this.app.vault.adapter as any;
          const filePath = adapter.getFullPath?.(file.path) || file.path;
          this.api.createSession({ name: `分析: ${file.name}` }).then(res => {
            if (res.ok) {
              this.api.sendMessage(res.session.id, `请分析文件: ${filePath}`);
            }
          });
        }
      },
    });

    // 5. Vault 检查命令
    this.registerView(BIOUNIX_VAULT_VIEW_TYPE, (leaf) => {
      return new BioUnixVaultReportView(leaf, this);
    });

    this.addCommand({
      id: 'vault-scan',
      name: 'Scan vault for issues',
      callback: () => this.runVaultScan(),
    });

    this.addCommand({
      id: 'vault-report',
      name: 'Open vault report',
      callback: () => this.activateVaultReport(),
    });

    this.addRibbonIcon('search', 'Vault 检查', () => {
      this.runVaultScan();
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
      if (data.type === 'agent:chunk' && this.chatView) {
        this.chatView.onStreamChunk(data.content);
      } else if (data.type === 'agent:done' && this.chatView) {
        this.chatView.onStreamDone();
      } else if (data.type === 'agent:error' && this.chatView) {
        this.chatView.onStreamChunk(`❌ ${data.error}`);
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
      if (this.lastReport && existing[0].view instanceof BioUnixVaultReportView) {
        (existing[0].view as BioUnixVaultReportView).updateReport(this.lastReport);
      }
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: BIOUNIX_VAULT_VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
      if (this.lastReport && leaf.view instanceof BioUnixVaultReportView) {
        (leaf.view as BioUnixVaultReportView).updateReport(this.lastReport);
      }
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.api.updateSettings(this.settings);
    this.connectWebSocket();
  }

  onunload(): void {
    this.api.disconnectWS();
  }
}
