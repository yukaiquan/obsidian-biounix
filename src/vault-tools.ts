/**
 * Vault 工具集 — 在 Obsidian 本地扫描 vault 问题
 *
 * 功能：
 * 1. 死链检查 — [[wikilink]] 指向不存在的文件
 * 2. 孤立笔记 — 没有任何反向链接的笔记
 * 3. frontmatter 检查 — 缺失/格式错误的 YAML frontmatter
 * 4. 图片引用检查 — ![[image]] / ![](path) 引用的文件不存在
 * 5. 标签云 — 扫描所有 #tag，发现相似/拼写错误标签
 * 6. 笔记统计 — 文件数、总字数、最近编辑
 */
import { App, TFile, Notice, parseYaml } from 'obsidian';

// ============ 类型定义 ============

export interface VaultReport {
  deadLinks: DeadLink[];
  orphanNotes: OrphanNote[];
  frontmatterIssues: FrontmatterIssue[];
  brokenImages: BrokenImage[];
  tagCloud: TagEntry[];
  stats: VaultStats;
  generatedAt: number;
}

export interface DeadLink {
  sourceFile: string;   // 包含死链的文件路径
  linkTarget: string;   // 死链目标
  line: number;         // 行号
}

export interface OrphanNote {
  path: string;
  name: string;
  wordCount: number;
  lastModified: number;
}

export interface FrontmatterIssue {
  path: string;
  issue: 'missing' | 'invalid' | 'empty';
  detail: string;
}

export interface BrokenImage {
  sourceFile: string;
  imageRef: string;
  line: number;
}

export interface TagEntry {
  tag: string;
  count: number;
  files: string[];
  similar?: string[]; // 相似标签（可能拼写错误）
}

export interface VaultStats {
  totalFiles: number;
  totalWords: number;
  totalLinks: number;
  totalTags: number;
  oldestNote: { path: string; date: number } | null;
  newestNote: { path: string; date: number } | null;
  avgWordsPerNote: number;
}

// ============ 主扫描函数 ============

export async function scanVault(app: App): Promise<VaultReport> {
  new Notice('🔍 正在扫描 vault...', 2000);

  const files = app.vault.getMarkdownFiles();
  const fileCache = new Map<string, TFile>();
  const allPaths = new Set<string>();
  const linkGraph = new Map<string, Set<string>>(); // file → 它链接到的文件
  const backlinks = new Map<string, Set<string>>();  // file → 链接到它的文件

  for (const f of files) {
    fileCache.set(f.path, f);
    allPaths.add(f.path);
    // 同时注册不带扩展名的名称，用于 wikilink 匹配
    const baseName = f.basename;
    fileCache.set(baseName, f);
    allPaths.add(baseName);
    linkGraph.set(f.path, new Set());
    backlinks.set(f.path, new Set());
  }

  const deadLinks: DeadLink[] = [];
  const frontmatterIssues: FrontmatterIssue[] = [];
  const brokenImages: BrokenImage[] = [];
  const tagMap = new Map<string, { count: number; files: Set<string> }>();
  let totalWords = 0;
  let totalLinks = 0;
  let oldestNote: { path: string; date: number } | null = null;
  let newestNote: { path: string; date: number } | null = null;
  // ★ 缓存每个文件的 wordCount，避免孤立笔记检测时重复 read（同一文件读 2 次）
  const wordCountCache = new Map<string, number>();

  // 单文件处理结果（并发安全，每个文件独立处理）
  interface FileResult {
    path: string;
    mtime: number;
    wordCount: number;
    deadLinks: DeadLink[];
    frontmatterIssues: FrontmatterIssue[];
    brokenImages: BrokenImage[];
    links: { from: string; to: string }[]; // 有效链接，供 linkGraph/backlinks 合并
    tags: { tag: string; file: string }[]; // 标签，供 tagMap 合并
  }

  const processFile = async (file: TFile): Promise<FileResult> => {
    const content = await app.vault.read(file);
    const lines = content.split('\n');
    const wc = content.split(/\s+/).filter(Boolean).length;
    const fDeadLinks: DeadLink[] = [];
    const fFrontmatterIssues: FrontmatterIssue[] = [];
    const fBrokenImages: BrokenImage[] = [];
    const fLinks: { from: string; to: string }[] = [];
    const fTags: { tag: string; file: string }[] = [];

    // frontmatter 检查
    checkFrontmatter(file.path, content, fFrontmatterIssues);

    // 逐行扫描链接、图片、标签
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // [[wikilink]] 检查
      const wikiLinks = line.matchAll(/\[\[([^\]|#]+)(?:#|\||\]\])/g);
      for (const match of wikiLinks) {
        const target = match[1].trim();
        if (!allPaths.has(target) && !allPaths.has(target + '.md')) {
          fDeadLinks.push({ sourceFile: file.path, linkTarget: target, line: i + 1 });
        } else {
          const targetFile = fileCache.get(target) || fileCache.get(target + '.md');
          if (targetFile) {
            fLinks.push({ from: file.path, to: targetFile.path });
          }
        }
      }

      // ![[image]] 和 ![](path) 检查
      const embedMatches = line.matchAll(/!\[\[([^\]]+)\]\]/g);
      for (const match of embedMatches) {
        const imgRef = match[1].trim();
        const imgFile = app.vault.getAbstractFileByPath(imgRef);
        if (!imgFile) {
          fBrokenImages.push({ sourceFile: file.path, imageRef: imgRef, line: i + 1 });
        }
      }
      const mdImages = line.matchAll(/!\[.*?\]\(([^)]+)\)/g);
      for (const match of mdImages) {
        const imgRef = match[1].trim();
        if (!imgRef.startsWith('http') && !allPaths.has(imgRef)) {
          const imgFile = app.vault.getAbstractFileByPath(imgRef);
          if (!imgFile) {
            fBrokenImages.push({ sourceFile: file.path, imageRef: imgRef, line: i + 1 });
          }
        }
      }

      // #tag 扫描
      const tags = line.matchAll(/(?:^|\s)#([a-zA-Z\u4e00-\u9fa5][\w\u4e00-\u9fa5/-]*)/g);
      for (const match of tags) {
        const tag = match[1].toLowerCase();
        fTags.push({ tag, file: file.path });
      }
    }

    return {
      path: file.path,
      mtime: file.stat.mtime,
      wordCount: wc,
      deadLinks: fDeadLinks,
      frontmatterIssues: fFrontmatterIssues,
      brokenImages: fBrokenImages,
      links: fLinks,
      tags: fTags,
    };
  };

  // 分批并发读取（BATCH=20，避免一次性打开过多文件句柄）
  const BATCH = 20;
  const results: FileResult[] = [];
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const batchResults = await Promise.allSettled(batch.map(processFile));
    for (const r of batchResults) {
      if (r.status === 'fulfilled') results.push(r.value);
      // rejected 的文件跳过（读取失败，如权限问题）
    }
  }

  // 合并各文件结果到全局状态
  for (const r of results) {
    totalWords += r.wordCount;
    totalLinks += r.deadLinks.length + r.links.length;
    wordCountCache.set(r.path, r.wordCount);
    deadLinks.push(...r.deadLinks);
    frontmatterIssues.push(...r.frontmatterIssues);
    brokenImages.push(...r.brokenImages);
    for (const link of r.links) {
      linkGraph.get(link.from)?.add(link.to);
      backlinks.get(link.to)?.add(link.from);
    }
    for (const t of r.tags) {
      if (!tagMap.has(t.tag)) {
        tagMap.set(t.tag, { count: 0, files: new Set() });
      }
      const entry = tagMap.get(t.tag)!;
      entry.count++;
      entry.files.add(t.file);
    }
    if (!oldestNote || r.mtime < oldestNote.date) {
      oldestNote = { path: r.path, date: r.mtime };
    }
    if (!newestNote || r.mtime > newestNote.date) {
      newestNote = { path: r.path, date: r.mtime };
    }
  }

  // 3. 孤立笔记检测（没有任何反向链接）——复用主循环的 wordCount 缓存，避免重复读盘
  const orphanNotes: OrphanNote[] = [];
  for (const file of files) {
    const backs = backlinks.get(file.path);
    if (!backs || backs.size === 0) {
      orphanNotes.push({
        path: file.path,
        name: file.basename,
        wordCount: wordCountCache.get(file.path) || 0,
        lastModified: file.stat.mtime,
      });
    }
  }

  // 4. 标签云 + 相似标签检测
  const tagCloud: TagEntry[] = Array.from(tagMap.entries())
    .map(([tag, info]) => ({
      tag,
      count: info.count,
      files: Array.from(info.files),
    }))
    .sort((a, b) => b.count - a.count);

  // 检测相似标签（编辑距离 <= 2 且长度 >= 3）
  for (let i = 0; i < tagCloud.length; i++) {
    for (let j = i + 1; j < tagCloud.length; j++) {
      if (isSimilarTag(tagCloud[i].tag, tagCloud[j].tag)) {
        if (!tagCloud[i].similar) tagCloud[i].similar = [];
        tagCloud[i].similar!.push(tagCloud[j].tag);
      }
    }
  }

  // 5. 统计
  const stats: VaultStats = {
    totalFiles: files.length,
    totalWords,
    totalLinks,
    totalTags: tagMap.size,
    oldestNote,
    newestNote,
    avgWordsPerNote: files.length > 0 ? Math.round(totalWords / files.length) : 0,
  };

  const report: VaultReport = {
    deadLinks,
    orphanNotes,
    frontmatterIssues,
    brokenImages,
    tagCloud,
    stats,
    generatedAt: Date.now(),
  };

  const totalIssues = deadLinks.length + orphanNotes.length + frontmatterIssues.length + brokenImages.length;
  new Notice(`✅ 扫描完成：${totalIssues} 个问题`, 3000);

  return report;
}

// ============ 辅助函数 ============

function checkFrontmatter(path: string, content: string, issues: FrontmatterIssue[]): void {
  const lines = content.split('\n');

  // 检查是否有 frontmatter（--- 开头）
  if (lines.length === 0 || lines[0].trim() !== '---') {
    issues.push({ path, issue: 'missing', detail: '文件缺少 YAML frontmatter' });
    return;
  }

  // 找到结束 ---
  let endLine = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endLine = i;
      break;
    }
  }

  if (endLine === -1) {
    issues.push({ path, issue: 'invalid', detail: 'frontmatter 未闭合（缺少结束 ---）' });
    return;
  }

  // 提取 YAML 内容
  const yamlContent = lines.slice(1, endLine).join('\n');
  if (!yamlContent.trim()) {
    issues.push({ path, issue: 'empty', detail: 'frontmatter 为空' });
    return;
  }

  // 尝试解析
  try {
    const parsed = parseYaml(yamlContent);
    if (!parsed || typeof parsed !== 'object') {
      issues.push({ path, issue: 'invalid', detail: 'YAML 解析结果不是对象' });
    }
  } catch (e) {
    issues.push({ path, issue: 'invalid', detail: `YAML 解析错误: ${(e as Error).message}` });
  }
}

function isSimilarTag(a: string, b: string): boolean {
  if (a === b) return false;
  if (a.length < 3 || b.length < 3) return false;
  // 编辑距离 <= 2
  const distance = levenshtein(a, b);
  return distance <= 2 && distance > 0;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp[m][n];
}

// ============ Markdown 报告生成 ============

export function generateReportMarkdown(report: VaultReport): string {
  const date = new Date(report.generatedAt).toLocaleString('zh-CN', { hour12: false });
  const sections: string[] = [];

  sections.push(`# 🔍 Vault 检查报告\n\n> 生成时间: ${date}\n`);

  // 统计概览
  sections.push(`## 📊 统计概览\n
| 指标 | 值 |
|------|-----|
| 笔记总数 | ${report.stats.totalFiles} |
| 总字数 | ${report.stats.totalWords.toLocaleString()} |
| 平均字数/笔记 | ${report.stats.avgWordsPerNote} |
| 链接总数 | ${report.stats.totalLinks} |
| 标签总数 | ${report.stats.totalTags} |
| 最旧笔记 | ${report.stats.oldestNote?.path || '-'} |
| 最新笔记 | ${report.stats.newestNote?.path || '-'} |\n`);

  // 死链
  if (report.deadLinks.length > 0) {
    sections.push(`## 🔗 死链（${report.deadLinks.length}）\n`);
    for (const dl of report.deadLinks.slice(0, 50)) {
      sections.push(`- [[${dl.sourceFile}]] 行 ${dl.line} → \`${dl.linkTarget}\` （不存在）`);
    }
    if (report.deadLinks.length > 50) {
      sections.push(`- ...还有 ${report.deadLinks.length - 50} 个死链`);
    }
    sections.push('');
  }

  // 孤立笔记
  if (report.orphanNotes.length > 0) {
    sections.push(`## 🏝️ 孤立笔记（${report.orphanNotes.length}）\n\n*没有任何反向链接的笔记*\n`);
    for (const on of report.orphanNotes.slice(0, 30)) {
      sections.push(`- [[${on.path}]] (${on.wordCount} 字)`);
    }
    if (report.orphanNotes.length > 30) {
      sections.push(`- ...还有 ${report.orphanNotes.length - 30} 个孤立笔记`);
    }
    sections.push('');
  }

  // frontmatter 问题
  if (report.frontmatterIssues.length > 0) {
    sections.push(`## 📋 Frontmatter 问题（${report.frontmatterIssues.length}）\n`);
    for (const fi of report.frontmatterIssues.slice(0, 30)) {
      sections.push(`- [[${fi.path}]] — ${fi.issue}: ${fi.detail}`);
    }
    if (report.frontmatterIssues.length > 30) {
      sections.push(`- ...还有 ${report.frontmatterIssues.length - 30} 个问题`);
    }
    sections.push('');
  }

  // 图片引用
  if (report.brokenImages.length > 0) {
    sections.push(`## 🖼️ 图片引用断裂（${report.brokenImages.length}）\n`);
    for (const bi of report.brokenImages.slice(0, 30)) {
      sections.push(`- [[${bi.sourceFile}]] 行 ${bi.line} → \`${bi.imageRef}\` （不存在）`);
    }
    if (report.brokenImages.length > 30) {
      sections.push(`- ...还有 ${report.brokenImages.length - 30} 个断裂引用`);
    }
    sections.push('');
  }

  // 标签云
  if (report.tagCloud.length > 0) {
    sections.push(`## 🏷️ 标签云（${report.tagCloud.length} 个标签）\n`);
    for (const t of report.tagCloud.slice(0, 50)) {
      const similarNote = t.similar && t.similar.length > 0
        ? ` ⚠️ 相似: ${t.similar.join(', ')}`
        : '';
      sections.push(`- \`${t.tag}\` (${t.count} 次${t.files.length} 个文件)${similarNote}`);
    }
    sections.push('');
  }

  // 总结
  const totalIssues = report.deadLinks.length + report.orphanNotes.length +
    report.frontmatterIssues.length + report.brokenImages.length;
  sections.push(`---\n\n**共发现 ${totalIssues} 个问题**`);

  return sections.join('\n');
}
