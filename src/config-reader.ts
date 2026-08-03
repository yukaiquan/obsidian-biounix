/**
 * 主程序配置读取 — 复用 BioUnix 主程序已配置的 LLM API 设置
 *
 * 主程序（BioUnix Electron）用 zustand persist + localStorage 持久化配置，
 * Chromium 把 localStorage 存到 leveldb：
 *   ~/Library/Application Support/biounix-electron/Local Storage/leveldb/
 * 其中 `app-config-storage` key 的 value 是 JSON 字符串，包含：
 *   - state.execution: { llmProvider, apiKey, model, customEndpoint, localEndpoint, ... }
 *   - state.apiProfiles: ApiProfile[]（已保存的多个 API 配置）
 *
 * 插件读取 leveldb 文件（纯字节解析，无需 native 库），让"新建会话"弹窗
 * 直接预填主程序配置，用户无需重复填写。
 */

// 复用 api.ts 已声明的 Node.js require（避免重复声明）
const nodeFs = require('fs') as typeof import('fs');
const nodePath = require('path') as typeof import('path');
const nodeOs = require('os') as typeof import('os');

/** 与主程序 useConfigStore.execution 对齐（仅取插件需要的字段） */
export interface MainAppExecution {
    llmProvider?: 'anthropic' | 'openai' | 'local' | 'zhipu' | 'deepseek' | 'moonshot';
    apiKey?: string;
    model?: string;
    useCustomEndpoint?: boolean;
    customEndpoint?: string;
    localEndpoint?: string;
    proxy?: string;
    contextLimitOverride?: number;
}

/** 与主程序 ApiProfile 对齐（仅取插件需要的字段） */
export interface MainApiProfile {
    id: string;
    name: string;
    provider: 'anthropic' | 'openai' | 'local' | 'zhipu' | 'deepseek' | 'moonshot';
    apiKey?: string;
    model?: string;
    useCustomEndpoint?: boolean;
    customEndpoint?: string;
    localEndpoint?: string;
    proxy?: string;
    contextLimitOverride?: number;
    lastUsed: number;
}

/** 主程序配置（app-config-storage 解析后的 state） */
export interface MainAppConfig {
    execution?: MainAppExecution;
    apiProfiles?: MainApiProfile[];
    /** 已保存的远程 SSH 会话（与主程序 useConfigStore.savedSessions 对齐） */
    savedSessions?: MainSavedSession[];
    appearance?: { language?: 'zh' | 'en' };
}

/** 与主程序 RemoteConfig 对齐 */
export interface MainRemoteConfig {
    host: string;
    port: number;
    username: string;
    authType: 'password' | 'key';
    password?: string;
    keyPath?: string;
    passphrase?: string;
}

/** 与主程序 SavedSession 对齐 */
export interface MainSavedSession {
    id: string;
    name: string;
    config: MainRemoteConfig;
    lastUsed: number;
}

/**
 * 主程序配置存储位置。
 *
 * 主程序（BioUnix Electron）用 zustand persist + localStorage 持久化配置，
 * Chromium 的 localStorage 实际存储在 leveldb 中：
 *   ~/Library/Application Support/biounix-electron/Local Storage/leveldb/
 * （注意目录是 biounix-electron，不是 biounix）
 *
 * leveldb 在主程序运行时被锁定，无法用 classic-level 打开，
 * 因此这里用纯字节解析：在 .log(WAL)/.ldb(SSTable) 文件中搜索
 * "app-config-storage" key 对应的 {"state":...} JSON 并按括号匹配提取。
 */
function getLeveldbDir(): string {
    const home = nodeOs.homedir();
    if (process.platform === 'darwin') {
        return nodePath.join(home, 'Library', 'Application Support', 'biounix-electron', 'Local Storage', 'leveldb');
    } else if (process.platform === 'win32') {
        return nodePath.join(process.env.LOCALAPPDATA || nodePath.join(home, 'AppData', 'Local'), 'biounix-electron', 'Local Storage', 'leveldb');
    }
    return nodePath.join(home, '.config', 'biounix-electron', 'Local Storage', 'leveldb');
}

/**
 * 从 leveldb 文件（.log/.ldb）中提取 app-config-storage 的 JSON。
 * 按文件修改时间倒序查找，返回最新的一份。
 * 失败时返回 null。
 */
export function readMainAppConfig(): MainAppConfig | null {
    try {
        const dbDir = getLeveldbDir();
        if (!nodeFs.existsSync(dbDir)) return null;
        // 按修改时间倒序（最新优先）
        const files = nodeFs.readdirSync(dbDir)
            .filter(f => f.endsWith('.log') || f.endsWith('.ldb'))
            .map(f => ({ name: f, mtime: nodeFs.statSync(nodePath.join(dbDir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);

        const needle = Buffer.from('app-config-storage');
        // leveldb .log(WAL) 同一 key 可能有多版本，需取最后一个匹配片段（最新版本）
        // 旧版本可能字段为空，若遇第一个就 return 会误返回旧数据
        let lastState: MainAppConfig | null = null;
        for (const file of files) {
            const buf = nodeFs.readFileSync(nodePath.join(dbDir, file.name));
            let pos = 0;
            while (true) {
                const idx = buf.indexOf(needle, pos);
                if (idx < 0) break;
                pos = idx + needle.length;
                // value 紧跟 key 之后，查找 {"state": 起始
                const jsonStart = buf.indexOf('{"state":', idx);
                if (jsonStart < 0 || jsonStart - idx > 200) continue;
                // 按括号匹配提取完整 JSON（处理字符串内的括号/转义）
                let depth = 0, inStr = false, esc = false, end = -1;
                for (let i = jsonStart; i < buf.length; i++) {
                    const c = buf[i];
                    if (esc) { esc = false; continue; }
                    if (c === 0x5c) { esc = true; continue; }       // backslash
                    if (c === 0x22) { inStr = !inStr; continue; }   // quote
                    if (inStr) continue;
                    if (c === 0x7b) depth++;                         // {
                    else if (c === 0x7d) { depth--; if (depth === 0) { end = i + 1; break; } } // }
                }
                if (end > 0) {
                    const jsonStr = buf.slice(jsonStart, end).toString('utf8');
                    try {
                        const parsed = JSON.parse(jsonStr) as { state?: MainAppConfig };
                        if (parsed.state) lastState = parsed.state; // 记录最新，不立即 return
                    } catch {
                        // 损坏片段，继续查找下一个匹配
                    }
                }
            }
            // 本文件若找到 state，由于文件已按 mtime 倒序，这是最新文件，直接用
            if (lastState) break;
        }
        return lastState;
    } catch {
        return null;
    }
}

/** 读取主程序默认 execution 配置（便捷封装） */
export function readMainExecution(): MainAppExecution | null {
    return readMainAppConfig()?.execution || null;
}

/** 读取主程序已保存的 API profiles（按 lastUsed 降序） */
export function readMainApiProfiles(): MainApiProfile[] {
    const profiles = readMainAppConfig()?.apiProfiles || [];
    return [...profiles].sort((a, b) => b.lastUsed - a.lastUsed);
}

/** 读取主程序已保存的远程 SSH 会话（按 lastUsed 降序） */
export function readMainSavedSessions(): MainSavedSession[] {
    const sessions = readMainAppConfig()?.savedSessions || [];
    return [...sessions].sort((a, b) => b.lastUsed - a.lastUsed);
}
