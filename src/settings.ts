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
}

export const DEFAULT_SETTINGS: BioUnixSettings = {
  port: 17564,
  token: '',
  autoConnect: true,
  defaultMode: 'agent',
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
      .setDesc('从 ~/.biounix/api-token 文件读取，留空则自动读取')
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
