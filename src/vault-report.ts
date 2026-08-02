/**
 * Vault 报告视图 — 展示扫描结果，支持点击跳转修复
 */
import { ItemView, WorkspaceLeaf, Notice, TFile } from 'obsidian';
import type BioUnixPlugin from './main';
import type { VaultReport, DeadLink, OrphanNote, FrontmatterIssue, BrokenImage, TagEntry } from './vault-tools';

export const BIOUNIX_VAULT_VIEW_TYPE = 'biounix-vault-report';

export class BioUnixVaultReportView extends ItemView {
  private plugin: BioUnixPlugin;
  private report: VaultReport | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: BioUnixPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return BIOUNIX_VAULT_VIEW_TYPE; }
  getDisplayText(): string { return 'Vault 检查报告'; }
  getIcon(): string { return 'search-check'; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('biounix-vault-report');

    if (!this.report) {
      container.createEl('div', {
        text: '尚未扫描。请运行命令 "Scan vault for issues" 或点击 🔍 图标。',
        cls: 'biounix-vault-empty',
      });
      const scanBtn = container.createEl('button', {
        text: '🔍 立即扫描',
        cls: 'biounix-vault-scan-btn',
      });
      scanBtn.onclick = () => this.plugin.runVaultScan();
      return;
    }

    this.renderReport(container);
  }

  /** 更新报告数据并重新渲染 */
  updateReport(report: VaultReport): void {
    this.report = report;
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('biounix-vault-report');
    this.renderReport(container);
  }

  private renderReport(container: HTMLElement): void {
    if (!this.report) return;
    const r = this.report;
    const date = new Date(r.generatedAt).toLocaleString('zh-CN', { hour12: false });

    // 标题栏
    const header = container.createDiv({ cls: 'biounix-vault-header' });
    header.createEl('span', { text: '🔍 Vault 检查报告', cls: 'biounix-vault-title' });
    const rescanBtn = header.createEl('button', { text: '🔄 重新扫描', cls: 'biounix-vault-rescan-btn' });
    rescanBtn.onclick = () => this.plugin.runVaultScan();

    // 统计卡片
    const statsRow = container.createDiv({ cls: 'biounix-vault-stats-row' });
    this.addStatCard(statsRow, '📝', '笔记', r.stats.totalFiles);
    this.addStatCard(statsRow, '🔗', '死链', r.deadLinks.length, r.deadLinks.length > 0 ? 'warning' : 'ok');
    this.addStatCard(statsRow, '🏝️', '孤立', r.orphanNotes.length, r.orphanNotes.length > 0 ? 'warning' : 'ok');
    this.addStatCard(statsRow, '📋', 'FM问题', r.frontmatterIssues.length, r.frontmatterIssues.length > 0 ? 'warning' : 'ok');
    this.addStatCard(statsRow, '🖼️', '图片', r.brokenImages.length, r.brokenImages.length > 0 ? 'warning' : 'ok');
    this.addStatCard(statsRow, '🏷️', '标签', r.stats.totalTags);

    // Tab 区域
    const tabBar = container.createDiv({ cls: 'biounix-vault-tabs' });
    const tabContent = container.createDiv({ cls: 'biounix-vault-tab-content' });

    const tabs = [
      { id: 'deadlinks', label: `🔗 死链 (${r.deadLinks.length})`, show: r.deadLinks.length > 0 },
      { id: 'orphans', label: `🏝️ 孤立 (${r.orphanNotes.length})`, show: r.orphanNotes.length > 0 },
      { id: 'frontmatter', label: `📋 FM (${r.frontmatterIssues.length})`, show: r.frontmatterIssues.length > 0 },
      { id: 'images', label: `🖼️ 图片 (${r.brokenImages.length})`, show: r.brokenImages.length > 0 },
      { id: 'tags', label: `🏷️ 标签 (${r.tagCloud.length})`, show: r.tagCloud.length > 0 },
    ];

    for (const tab of tabs) {
      if (!tab.show) continue;
      const tabBtn = tabBar.createEl('button', {
        text: tab.label,
        cls: 'biounix-vault-tab',
      });
      tabBtn.onclick = () => {
        // 切换激活状态
        tabBar.querySelectorAll('.biounix-vault-tab').forEach(el => el.removeClass('active'));
        tabBtn.addClass('active');
        tabContent.empty();
        this.renderTab(tab.id, tabContent);
      };
    }

    // 默认激活第一个有内容的 tab
    const firstActive = tabBar.querySelector('.biounix-vault-tab') as HTMLElement | null;
    if (firstActive) {
      firstActive.addClass('active');
      const firstTab = tabs.find(t => t.show);
      if (firstTab) this.renderTab(firstTab.id, tabContent);
    }

    // 底部信息
    container.createEl('div', {
      text: `生成时间: ${date}`,
      cls: 'biounix-vault-footer',
    });
  }

  private addStatCard(parent: HTMLElement, icon: string, label: string, value: number, status?: 'ok' | 'warning'): void {
    const card = parent.createDiv({ cls: `biounix-vault-stat-card ${status || ''}` });
    card.createEl('div', { text: icon, cls: 'biounix-vault-stat-icon' });
    card.createEl('div', { text: String(value), cls: 'biounix-vault-stat-value' });
    card.createEl('div', { text: label, cls: 'biounix-vault-stat-label' });
  }

  private renderTab(tabId: string, container: HTMLElement): void {
    if (!this.report) return;
    switch (tabId) {
      case 'deadlinks': this.renderDeadLinks(container); break;
      case 'orphans': this.renderOrphans(container); break;
      case 'frontmatter': this.renderFrontmatter(container); break;
      case 'images': this.renderImages(container); break;
      case 'tags': this.renderTags(container); break;
    }
  }

  private renderDeadLinks(container: HTMLElement): void {
    const items = this.report!.deadLinks;
    const list = container.createDiv({ cls: 'biounix-vault-list' });

    for (const dl of items.slice(0, 100)) {
      const item = list.createDiv({ cls: 'biounix-vault-item' });
      item.createEl('span', { text: `行 ${dl.line}`, cls: 'biounix-vault-item-line' });
      const sourceBtn = item.createEl('button', { text: dl.sourceFile, cls: 'biounix-vault-item-link' });
      sourceBtn.onclick = () => this.openFile(dl.sourceFile, dl.line);
      item.createEl('span', { text: '→', cls: 'biounix-vault-item-arrow' });
      item.createEl('code', { text: dl.linkTarget, cls: 'biounix-vault-item-target' });
      // 创建缺失文件按钮
      const createBtn = item.createEl('button', { text: '✏️ 创建', cls: 'biounix-vault-item-action' });
      createBtn.onclick = async () => {
        const filePath = dl.linkTarget.endsWith('.md') ? dl.linkTarget : `${dl.linkTarget}.md`;
        try {
          await this.app.vault.create(filePath, `# ${dl.linkTarget}\n\n`);
          new Notice(`✅ 已创建 ${filePath}`);
        } catch (e) {
          new Notice(`❌ 创建失败: ${(e as Error).message}`);
        }
      };
    }

    if (items.length > 100) {
      container.createEl('div', { text: `...还有 ${items.length - 100} 个死链`, cls: 'biounix-vault-more' });
    }
  }

  private renderOrphans(container: HTMLElement): void {
    const items = this.report!.orphanNotes;
    const list = container.createDiv({ cls: 'biounix-vault-list' });

    for (const on of items.slice(0, 100)) {
      const item = list.createDiv({ cls: 'biounix-vault-item' });
      const link = item.createEl('button', { text: on.name, cls: 'biounix-vault-item-link' });
      link.onclick = () => this.openFile(on.path);
      item.createEl('span', { text: `${on.wordCount} 字`, cls: 'biounix-vault-item-meta' });
      const date = new Date(on.lastModified).toLocaleDateString('zh-CN');
      item.createEl('span', { text: date, cls: 'biounix-vault-item-date' });
    }

    if (items.length > 100) {
      container.createEl('div', { text: `...还有 ${items.length - 100} 个孤立笔记`, cls: 'biounix-vault-more' });
    }
  }

  private renderFrontmatter(container: HTMLElement): void {
    const items = this.report!.frontmatterIssues;
    const list = container.createDiv({ cls: 'biounix-vault-list' });

    for (const fi of items.slice(0, 100)) {
      const item = list.createDiv({ cls: 'biounix-vault-item' });
      const badge = item.createEl('span', {
        text: fi.issue,
        cls: `biounix-vault-fm-badge biounix-vault-fm-${fi.issue}`,
      });
      const link = item.createEl('button', { text: fi.path, cls: 'biounix-vault-item-link' });
      link.onclick = () => this.openFile(fi.path);
      item.createEl('span', { text: fi.detail, cls: 'biounix-vault-item-detail' });
    }

    if (items.length > 100) {
      container.createEl('div', { text: `...还有 ${items.length - 100} 个问题`, cls: 'biounix-vault-more' });
    }
  }

  private renderImages(container: HTMLElement): void {
    const items = this.report!.brokenImages;
    const list = container.createDiv({ cls: 'biounix-vault-list' });

    for (const bi of items.slice(0, 100)) {
      const item = list.createDiv({ cls: 'biounix-vault-item' });
      item.createEl('span', { text: `行 ${bi.line}`, cls: 'biounix-vault-item-line' });
      const link = item.createEl('button', { text: bi.sourceFile, cls: 'biounix-vault-item-link' });
      link.onclick = () => this.openFile(bi.sourceFile, bi.line);
      item.createEl('span', { text: '→', cls: 'biounix-vault-item-arrow' });
      item.createEl('code', { text: bi.imageRef, cls: 'biounix-vault-item-target' });
    }

    if (items.length > 100) {
      container.createEl('div', { text: `...还有 ${items.length - 100} 个断裂引用`, cls: 'biounix-vault-more' });
    }
  }

  private renderTags(container: HTMLElement): void {
    const items = this.report!.tagCloud;
    const cloud = container.createDiv({ cls: 'biounix-vault-tag-cloud' });

    for (const t of items) {
      const tag = cloud.createEl('span', { cls: 'biounix-vault-tag' });
      tag.createEl('span', { text: t.tag, cls: 'biounix-vault-tag-name' });
      tag.createEl('span', { text: String(t.count), cls: 'biounix-vault-tag-count' });
      if (t.similar && t.similar.length > 0) {
        tag.addClass('biounix-vault-tag-warn');
        tag.createEl('span', {
          text: `⚠️ 相似: ${t.similar.join(', ')}`,
          cls: 'biounix-vault-tag-similar',
        });
      }
    }
  }

  /** 打开文件并跳转到指定行 */
  private async openFile(filePath: string, line?: number): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (file instanceof TFile) {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
      if (line) {
        // 延迟一帧确保编辑器已渲染
        setTimeout(() => {
          const editor = this.app.workspace.activeEditor?.editor;
          if (editor) {
            editor.setCursor({ line: line - 1, ch: 0 });
            editor.scrollIntoView({ from: { line: line - 1, ch: 0 }, to: { line: line - 1, ch: 0 } }, true);
          }
        }, 50);
      }
    } else {
      new Notice(`文件不存在: ${filePath}`);
    }
  }

  async onClose(): Promise<void> { /* cleanup */ }
}
