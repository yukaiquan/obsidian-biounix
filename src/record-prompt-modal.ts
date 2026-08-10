/**
 * 记录处理过程询问模态框 — 在 Agent 开始处理任务前询问用户是否记录为 Markdown
 *
 * 流程：
 *   1. 用户发送消息 → 弹出此 Modal 询问"是否记录处理过程为 Markdown？"
 *   2. 选"是" → 打开 RecordTargetModal 选择目标（新建文件/追加现有笔记）
 *   3. 选"否" → 直接发送，不记录
 *
 * 用户可在设置中关闭询问（每次都不记录），此 Modal 不会被调用。
 */
import { App, Modal } from 'obsidian';

export class RecordPromptModal extends Modal {
    private onResult: (record: boolean) => void;
    private answered = false;

    constructor(app: App, onResult: (record: boolean) => void) {
        super(app);
        this.onResult = onResult;
    }

    async onOpen(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('biounix-record-prompt-modal');

        contentEl.createEl('h2', { text: '记录处理过程？' });
        contentEl.createEl('p', {
            text: '本次 Agent 处理过程可以记录为 Markdown 笔记。是否记录？',
            cls: 'biounix-record-prompt-desc',
        });

        const btnRow = contentEl.createDiv({ cls: 'biounix-record-prompt-btns' });
        const yesBtn = btnRow.createEl('button', {
            text: '📝 记录',
            cls: 'biounix-record-prompt-btn biounix-record-prompt-btn-primary',
        });
        const noBtn = btnRow.createEl('button', {
            text: '不记录',
            cls: 'biounix-record-prompt-btn biounix-record-prompt-btn-secondary',
        });

        yesBtn.onclick = () => {
            this.answered = true;
            this.close();
            this.onResult(true);
        };
        noBtn.onclick = () => {
            this.answered = true;
            this.close();
            this.onResult(false);
        };
    }

    onClose(): void {
        // 用户关闭模态框（点 X 或 Esc）视为"不记录"
        if (!this.answered) {
            this.onResult(false);
        }
    }
}
