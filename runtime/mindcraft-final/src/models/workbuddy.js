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
        `  请在 minebot 中重新启动伙伴并检查模型通道。`
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
            // 超时保护：OpenAI SDK 默认等待很久且会自行重试。这里把单次
            // 请求收紧到 90 秒，由 sendRequest 统一进行可观测、有限次数的
            // 重试，避免 SDK 重试与应用重试叠加。
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

        const maxRetries = boundedInteger(opts.workbuddy_max_retries, 2, 0, 3);
        const retryDelayMs = boundedInteger(opts.workbuddy_retry_delay_ms, 750, 0, 5000);
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                console.log(`[workbuddy] 等待模型响应（第 ${attempt + 1}/${maxRetries + 1} 次）…`);
                const stream = await this._client().chat.completions.create(pack);
                let text = '';
                let finish = null;
                for await (const chunk of stream) {
                    const choice = chunk.choices && chunk.choices[0];
                    if (!choice) continue;
                    if (choice.delta && choice.delta.content) text += choice.delta.content;
                    if (choice.finish_reason) finish = choice.finish_reason;
                }
                if (finish === 'length') throw modelError('Context length exceeded', 'context_length_exceeded');
                // A normal OpenAI-compatible stream ends with a finish_reason.  An
                // EOF without it is usually an upstream/proxy disconnect; accepting
                // the partial text would make the bot appear to stop mid-answer.
                if (finish === null) throw modelError('WorkBuddy stream ended before completion', 'incomplete_stream');
                if (!text.trim()) throw modelError('WorkBuddy returned an empty response', 'empty_response');
                console.log('[workbuddy] 已收到完整响应。');
                return text;
            } catch (err) {
                if (isContextLengthError(err) && turns.length > 1) {
                    console.log('[workbuddy] 上下文过长，缩短历史后重试。');
                    return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
                }
                const retryable = isRetryableModelError(err);
                console.error(`[workbuddy] 请求失败：${safeErrorSummary(err)}；${retryable && attempt < maxRetries ? '准备自动重试' : '不再重试'}。`);
                if (!retryable || attempt >= maxRetries) {
                    return friendlyFailureMessage(err, attempt + 1);
                }
                await delay(retryDelayMs * (attempt + 1));
            }
        }
        return '模型通道暂时不可用，请稍后再试。';
    }

    async embed(text) {
        throw new Error('WorkBuddy shim 不提供 embeddings 接口（将自动降级为词重叠匹配）。');
    }
}

function modelError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function boundedInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
}

function isContextLengthError(error) {
    return error?.message === 'Context length exceeded' || error?.code === 'context_length_exceeded';
}

function isRetryableModelError(error) {
    const status = Number(error?.status || error?.statusCode || 0);
    const code = String(error?.code || error?.cause?.code || '').toLowerCase();
    const message = String(error?.message || error || '').toLowerCase();
    if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;
    if (['incomplete_stream', 'empty_response', 'etimedout', 'econnreset', 'econnrefused', 'eai_again', 'und_err_connect_timeout', 'und_err_socket'].includes(code)) return true;
    return /timeout|timed out|fetch failed|network|socket|connection reset|stream ended/.test(message);
}

function safeErrorSummary(error) {
    const status = Number(error?.status || error?.statusCode || 0);
    const code = String(error?.code || error?.cause?.code || '').slice(0, 80);
    const message = String(error?.message || error || '未知错误')
        .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
        .replace(/[A-Za-z0-9_-]{32,}/g, '[REDACTED]')
        .slice(0, 300);
    return [status ? `HTTP ${status}` : '', code ? `code=${code}` : '', message].filter(Boolean).join('，');
}

function friendlyFailureMessage(error, attempts) {
    const status = Number(error?.status || error?.statusCode || 0);
    if (status === 401 || status === 403) return 'WorkBuddy 登录状态已失效，请在配置器中重新检测账号后再试。';
    if (status === 400) return '当前模型无法处理这次请求，请缩短内容或更换模型后再试。';
    if (status === 402) return 'WorkBuddy 积分不足，请检查积分余额或更换模型。';
    if (status === 429) return `模型当前请求较多，已自动尝试 ${attempts} 次，请稍后再说一次。`;
    return `模型通道暂时不稳定，已自动尝试 ${attempts} 次，请稍后再说一次。`;
}

function delay(milliseconds) {
    return milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}
