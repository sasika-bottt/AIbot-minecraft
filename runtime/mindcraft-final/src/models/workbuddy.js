// The local gateway is created by the configurator for the selected model channel.

import OpenAIApi from 'openai';
import { readFileSync, existsSync } from 'fs';
import { strictFormat } from '../utils/text.js';

const SHIM_DIR = process.env.WORKBUDDY_SHIM_DIR || '';

/**
 * 读取 shim 落盘信息。
 *
 * 按优先级返回候选列表：国内版（workbuddy.json）优先，其次国际版，
 * 最后是早期单文件补丁留下的 discovery.json。
 *
 * 这里**只做"文件存在且能解析出 baseUrl/token"的校验，不做连通性校验**
 * （连通性测试是异步的，而本函数被同步调用）。连不上时由 sendRequest
 * 的 catch 兜底 —— 见那里的降级处理。
 */
function readDiscoveryFile(p) {
    try {
        const info = JSON.parse(readFileSync(p, 'utf8'));
        if (!info || !info.baseUrl || !info.token) return null;
        return info;
    } catch (e) {
        return null;   // 文件损坏 / 半写 -> 跳过，继续试下一个
    }
}

/** 按优先级列出全部可解析的候选（可能为空）。 */
function discoveryCandidates() {
    const out = [];
    if (!SHIM_DIR) return out;
    for (const fn of ['workbuddy.json', 'workbuddy-ai.json', 'discovery.json']) {
        const p = `${SHIM_DIR}\\${fn}`;
        if (!existsSync(p)) continue;
        const info = readDiscoveryFile(p);
        if (info) out.push({ path: p, ...info });
    }
    return out;
}

/** 取首选候选；一个都没有时抛出可读指引。 */
function loadDiscovery() {
    const cands = discoveryCandidates();
    if (cands.length > 0) return cands[0];
    throw new Error(
        `[workbuddy] 找不到可用的 shim 发现文件，已尝试：\n` +
        ['workbuddy.json', 'workbuddy-ai.json', 'discovery.json']
            .map((f) => `  · ${SHIM_DIR}\\${f}`).join('\n') + `\n` +
        `  请在境伴中重新启动伙伴并检查模型通道。`
    );
}

export class WorkBuddy {
    static prefix = 'workbuddy';

    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        this.url = url;   // 显式指定 baseURL 时优先（一般不用）
    }

    /** 每次请求现建 client —— 顺带达成「自动跟随 DSH 重启后的端口/bearer」。 */
    _client() {
        const info = loadDiscovery();
        return new OpenAIApi({
            baseURL: (this.url || info.baseUrl) + '/v1',
            apiKey: info.token,
            // 超时保护：OpenAI SDK 默认 10 分钟且会重试 2 次，DSH 卡住时
            // bot 会长时间僵死。这里收紧到 90 秒、不自动重试 —— 交给
            // mindcraft 自己的错误处理走「My brain disconnected」降级。
            timeout: 90_000,
            maxRetries: 0,
        });
    }

    async sendRequest(turns, systemMessage, stop_seq = '***') {
        let messages = [{ 'role': 'system', 'content': systemMessage }].concat(turns);

        // 【刻意与 deepseek.js 保持一致的消息整形】
        // 这是本 bot 当前**生产环境正在跑**的形态，也是 prompts / examples 所适配的。
        // 迁移的意图是「只换端点、不换协议形态」—— 若这里改了形态，一旦出问题就
        // 分不清是端点不兼容还是形态变了，验证会被污染。
        //
        // 具体原因：src/agent/coder.js 会在**对话中途**插入 role:'system' 消息。
        // 上游对「非首条 system」是否接受未经验证；strictFormat 会统一改写为
        // 'SYSTEM: ' 前缀的 user 消息，从而保证只出现 user / assistant 两种 role，
        // 兼容性最好。
        //
        // 逃生开关：若日后确认上游原生支持，可在 profile 的 params 里设
        //   "workbuddy_native_format": true
        // 即可跳过整形、原样发送。
        const opts = this.params || {};
        if (!opts.workbuddy_native_format) {
            messages = strictFormat(messages);
        }

        // 剔除全部 workbuddy_* 控制键，避免它们被当成上游参数发出去
        const params = {};
        for (const [k, v] of Object.entries(opts)) {
            if (!k.startsWith('workbuddy_')) params[k] = v;
        }

        const pack = {
            model: this.model_name || 'deepseek-v4.1-flash',
            messages,
            stream: true,     // shim 会强制 stream:true，显式声明避免两侧协议错配
            ...params,
        };

        // 【实测结论，2026-10-09】腾讯上游**拒收 `stop` 字段**：
        //   带 stop: '***'  → HTTP 400 "请求内容不合法，请重试"
        //   不带 stop       → HTTP 200 正常返回
        // 故默认**不发送** stop。这与 deepseek.js 行为不同，但属实测取证，非推测。
        //
        // 逃生开关：若日后上游支持了 stop，可在 profile 的 params 里设
        //   "workbuddy_use_stop": true
        // 重新启用。
        if (opts.workbuddy_use_stop) pack.stop = stop_seq;

        let res = null;
        try {
            console.log('Awaiting workbuddy api response...');
            const stream = await this._client().chat.completions.create(pack);
            let text = '';
            let finish = null;
            for await (const chunk of stream) {
                const choice = chunk.choices && chunk.choices[0];
                if (!choice) continue;
                if (choice.delta && choice.delta.content) text += choice.delta.content;
                if (choice.finish_reason) finish = choice.finish_reason;
            }
            if (finish === 'length') throw new Error('Context length exceeded');
            console.log('Received.');
            res = text;
        } catch (err) {
            if ((err.message == 'Context length exceeded' || err.code == 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
            } else {
                console.log(err);
                res = 'My brain disconnected, try again.';
            }
        }
        return res;
    }

    async embed(text) {
        throw new Error('WorkBuddy shim 不提供 embeddings 接口（将自动降级为词重叠匹配）。');
    }
}
