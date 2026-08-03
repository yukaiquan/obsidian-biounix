/**
 * 右键菜单 — 对生信文件添加"发送到 BioUnix Agent"选项
 */
import { Notice, TFile } from 'obsidian';
import type BioUnixPlugin from './main';

const BIO_EXTENSIONS = [
  '.vcf', '.vcf.gz',
  '.bam', '.sam', '.cram',
  '.fastq', '.fq', '.fastq.gz', '.fq.gz',
  '.fa', '.fasta', '.fna', '.fa.gz',
  '.gff', '.gff3', '.gtf',
  '.bed',
  '.sam',
];

function isBioFile(filename: string): boolean {
  return BIO_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext));
}

export function registerFileMenu(plugin: BioUnixPlugin): void {
  plugin.registerEvent(
    plugin.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile)) return;
      if (!isBioFile(file.name)) return;

      // 获取文件在 vault 中的绝对路径（getFullPath 仅存在于本地文件系统 adapter）
      const adapter = plugin.app.vault.adapter as { getFullPath?(p: string): string };
      const filePath = adapter.getFullPath?.(file.path) || file.path;

      menu.addItem(item => {
        item
          .setTitle('发送到 BioUnix Agent')
          .setIcon('flask-conical')
          .onClick(async () => {
            await sendToBioUnix(plugin, filePath, file.name);
          });
      });

      // 快速统计选项（对 VCF/BAM/FASTA 文件）
      if (file.name.endsWith('.vcf') || file.name.endsWith('.vcf.gz')) {
        menu.addItem(item => {
          item
            .setTitle('BioUnix: VCF 统计')
            .setIcon('bar-chart-3')
            .onClick(async () => {
              await runBioUnixStats(plugin, 'vcf_stats', filePath, file.name);
            });
        });
      } else if (file.name.endsWith('.bam')) {
        menu.addItem(item => {
          item
            .setTitle('BioUnix: BAM 统计')
            .setIcon('bar-chart-3')
            .onClick(async () => {
              await runBioUnixStats(plugin, 'bam_stats', filePath, file.name);
            });
        });
      } else if (file.name.endsWith('.fasta') || file.name.endsWith('.fa') || file.name.endsWith('.fna')) {
        menu.addItem(item => {
          item
            .setTitle('BioUnix: FASTA 统计')
            .setIcon('bar-chart-3')
            .onClick(async () => {
              await runBioUnixStats(plugin, 'fasta_stats', filePath, file.name);
            });
        });
      }
    })
  );
}

/** 发送文件到 BioUnix Agent 进行分析 */
async function sendToBioUnix(plugin: BioUnixPlugin, filePath: string, filename: string): Promise<void> {
  try {
    // 创建或复用会话
    const sessionRes = await plugin.api.createSessionWithDefaults(plugin.settings, {
      name: `分析: ${filename}`,
      mode: plugin.settings.defaultMode,
    });

    if (!sessionRes.ok || !sessionRes.session) {
      new Notice(`创建会话失败: ${sessionRes.error}`);
      return;
    }

    const sessionId = sessionRes.session.id;
    const message = `请分析文件: ${filePath}\n\n文件路径已提供，请根据文件类型选择合适的分析方式。`;

    await plugin.api.sendMessage(sessionId, message);
    new Notice(`✅ 已发送 ${filename} 到 BioUnix Agent`);
  } catch (e) {
    new Notice(`发送失败: ${(e as Error).message}`);
  }
}

/** 快速运行生信文件统计 */
async function runBioUnixStats(
  plugin: BioUnixPlugin,
  toolName: string,
  filePath: string,
  filename: string,
): Promise<void> {
  try {
    // BioUnix 内置 bioio 工具直接统计，无需创建会话
    const res = await plugin.api.runCommand(toolName, [filePath]);
    if (res.ok) {
      const output = res.result?.stdout || JSON.stringify(res.result, null, 2);
      new Notice(`✅ ${filename} 统计完成`);
      // 在新笔记中展示结果
      const noteName = `${filename}-stats-${Date.now()}.md`;
      const noteContent = `# ${filename} 统计结果\n\n生成时间: ${new Date().toLocaleString()}\n\n\`\`\`\n${output}\n\`\`\`\n`;
      await plugin.app.vault.create(noteName, noteContent);
      new Notice(`结果已保存到 ${noteName}`);
    } else {
      new Notice(`统计失败: ${res.error}`);
    }
  } catch (e) {
    new Notice(`统计失败: ${(e as Error).message}`);
  }
}
