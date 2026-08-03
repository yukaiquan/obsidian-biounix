/**
 * BioUnix 插件设置
 */
import { App, PluginSettingTab, Setting } from 'obsidian';
import type BioUnixPlugin from './main';

export interface BioUnixSettings {
  port: number;
  token: string;
  autoConnect: boolean;
  defaultMode: 'chat' | 'agent';
  /** 默认 LLM 提供商 */
  llmProvider: 'anthropic' | 'openai' | 'zhipu' | 'deepseek' | 'moonshot' | 'local';
  /** 默认 API Key（留空则需在新建会话时填写） */
  apiKey: string;
  /** 默认模型 */
  model: string;
  /** 自定义端点（local/兼容 OpenAI 的服务） */
  customEndpoint: string;
  /** 默认工作区路径（本地目录；留空=当前 vault） */
  workspaceDir: string;
  /** 默认安全级别 */
  securityLevel: 'paranoid' | 'normal' | 'yolo';
  /** Note Server（供主程序 Pipeline 调用 vault 笔记） */
  noteServerEnabled: boolean;
  noteServerPort: number;
  noteServerToken: string;
}

export const DEFAULT_SETTINGS: BioUnixSettings = {
  port: 17564,
  token: '',
  autoConnect: true,
  defaultMode: 'agent',
  llmProvider: 'anthropic',
  apiKey: '',
  model: 'claude-sonnet-4',
  customEndpoint: '',
  workspaceDir: '',
  securityLevel: 'normal',
  noteServerEnabled: true,
  noteServerPort: 17590,
  noteServerToken: '',
};

export class BioUnixSettingTab extends PluginSettingTab {
  plugin: BioUnixPlugin;

  constructor(app: App, plugin: BioUnixPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('BioUnix 连接配置')
      .setHeading();

    new Setting(containerEl)
      .setName('API 端口')
      .setDesc('BioUnix API Server 监听端口（默认 17564）')
      .addText(text => text
        .setValue(String(this.plugin.settings.port))
        .onChange(async (value) => {
          this.plugin.settings.port = parseInt(value, 10) || 17564;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('API Token')
      .setDesc('留空则自动从 BioUnix 数据目录读取（macOS: ~/Library/Application Support/biounix/api-token）')
      .addText(text => text
        .setValue(this.plugin.settings.token)
        .setPlaceholder('自动读取或手动输入')
        .onChange(async (value) => {
          this.plugin.settings.token = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('自动连接')
      .setDesc('启动时自动连接 BioUnix API Server')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoConnect)
        .onChange(async (value) => {
          this.plugin.settings.autoConnect = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('默认模式')
      .setDesc('创建会话时的默认模式')
      .addDropdown(dropdown => dropdown
        .addOption('agent', 'Agent（工具执行）')
        .addOption('chat', 'Chat（纯对话）')
        .setValue(this.plugin.settings.defaultMode)
        .onChange(async (value) => {
          this.plugin.settings.defaultMode = value as 'chat' | 'agent';
          await this.plugin.saveSettings();
        }));

    // ============ LLM 默认配置 ============
    new Setting(containerEl)
      .setName('LLM 默认配置')
      .setHeading();

    new Setting(containerEl)
      .setName('默认 Provider')
      .setDesc('新建会话时默认使用的 LLM 提供商')
      .addDropdown(dropdown => dropdown
        .addOption('anthropic', 'Anthropic (Claude)')
        .addOption('openai', 'OpenAI (GPT)')
        .addOption('zhipu', '智谱 (GLM)')
        .addOption('deepseek', 'DeepSeek')
        .addOption('moonshot', 'Moonshot (Kimi)')
        .addOption('local', 'Local Model')
        .setValue(this.plugin.settings.llmProvider)
        .onChange(async (value) => {
          this.plugin.settings.llmProvider = value as BioUnixSettings['llmProvider'];
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('默认 API Key')
      .setDesc('新建会话时预填的 API Key（留空则需在新建会话弹窗中手动填写）')
      .addText(text => text
        .setValue(this.plugin.settings.apiKey)
        .setPlaceholder('sk-...')
        .onChange(async (value) => {
          this.plugin.settings.apiKey = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('默认模型')
      .setDesc('新建会话时默认使用的模型')
      .addText(text => text
        .setValue(this.plugin.settings.model)
        .setPlaceholder('claude-sonnet-4')
        .onChange(async (value) => {
          this.plugin.settings.model = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('自定义端点')
      .setDesc('Local 模型或兼容 OpenAI 的服务端点（如 http://localhost:1234/v1）')
      .addText(text => text
        .setValue(this.plugin.settings.customEndpoint)
        .setPlaceholder('http://localhost:1234/v1')
        .onChange(async (value) => {
          this.plugin.settings.customEndpoint = value;
          await this.plugin.saveSettings();
        }));

    // ============ 工作区与安全 ============
    new Setting(containerEl)
      .setName('工作区与安全')
      .setHeading();

    new Setting(containerEl)
      .setName('默认工作区目录')
      .setDesc('新建 Agent 会话时默认的工作目录（留空=使用当前 vault 目录）')
      .addText(text => text
        .setValue(this.plugin.settings.workspaceDir)
        .setPlaceholder('/path/to/project')
        .onChange(async (value) => {
          this.plugin.settings.workspaceDir = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('默认安全级别')
      .setDesc('paranoid=每次工具调用都确认；normal=敏感操作确认；yolo=全部自动放行')
      .addDropdown(dropdown => dropdown
        .addOption('paranoid', 'Paranoid（全部确认）')
        .addOption('normal', 'Normal（默认）')
        .addOption('yolo', 'YOLO（全自动）')
        .setValue(this.plugin.settings.securityLevel)
        .onChange(async (value) => {
          this.plugin.settings.securityLevel = value as BioUnixSettings['securityLevel'];
          await this.plugin.saveSettings();
        }));

    // ============ Note Server（供主程序 Pipeline 调用） ============
    new Setting(containerEl)
      .setName('笔记服务（Pipeline 集成）')
      .setHeading();

    new Setting(containerEl)
      .setName('启用笔记服务')
      .setDesc('启动本地 HTTP server，供 BioUnix 主程序 Pipeline 步骤读写 vault 笔记')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.noteServerEnabled)
        .onChange(async (value) => {
          this.plugin.settings.noteServerEnabled = value;
          await this.plugin.saveSettings();
          await this.plugin.applyNoteServerState();
        }));

    new Setting(containerEl)
      .setName('笔记服务端口')
      .setDesc('默认 17590，主程序 Pipeline 将通过此端口读写笔记')
      .addText(text => text
        .setValue(String(this.plugin.settings.noteServerPort))
        .onChange(async (value) => {
          this.plugin.settings.noteServerPort = parseInt(value, 10) || 17590;
          await this.plugin.saveSettings();
          await this.plugin.applyNoteServerState();
        }));

    new Setting(containerEl)
      .setName('笔记服务 Token')
      .setDesc('鉴权令牌（留空则不鉴权）；需与主程序配置一致')
      .addText(text => text
        .setValue(this.plugin.settings.noteServerToken)
        .setPlaceholder('可选')
        .onChange(async (value) => {
          this.plugin.settings.noteServerToken = value;
          await this.plugin.saveSettings();
          await this.plugin.applyNoteServerState();
        }));

    new Setting(containerEl)
      .setName('测试笔记服务')
      .setDesc('检查笔记服务是否正常监听')
      .addButton(btn => btn
        .setButtonText('测试')
        .onClick(async () => {
          btn.setButtonText('测试中...');
          btn.setDisabled(true);
          const ok = await this.plugin.testNoteServer();
          btn.setButtonText(ok ? '✅ 已监听' : '❌ 未监听');
          btn.setDisabled(false);
          window.setTimeout(() => { btn.setButtonText('测试'); }, 2000);
        }));

    // 测试连接按钮
    new Setting(containerEl)
      .setName('测试连接')
      .setDesc('检查 BioUnix API Server 是否在线')
      .addButton(btn => btn
        .setButtonText('测试')
        .onClick(async () => {
          btn.setButtonText('测试中...');
          btn.setDisabled(true);
          const ok = await this.plugin.api.health();
          btn.setButtonText(ok ? '✅ 已连接' : '❌ 连接失败');
          btn.setDisabled(false);
          window.setTimeout(() => { btn.setButtonText('测试'); }, 2000);
        }));
  }
}
