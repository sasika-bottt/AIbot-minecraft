// proactive.js — 定时主动唤醒（2026-10-09 新增）
//
// 【为什么需要它】
// mindcraft 的 agent 只在**收到消息**时才被 handleMessage 唤醒（见 agent.js:261）。
// 没人说话 → 它永远待机，表现就是"玩家在游戏里，它一声不吭地站着"。
// 这与「自主模式（!goal）」是两回事：
//   · !goal = 无节制自提示循环，持续烧 API，已被硬禁用（见 actions.js）
//   · 本模块 = **低频、有上限、可叫停**的主动唤醒，只为让它"活起来"
//
// 【成本控制（三重闸门）】
//   1. 间隔：默认 90 秒才唤醒一次（不是每秒），且每次唤醒后重新计时
//   2. 闲置才唤醒：手头有动作在执行就跳过，不打断干活
//   3. 每日上限：默认 200 次，用满即停（防止挂机烧穿积分）
//   另加：玩家说话时**事件驱动地**把唤醒推后一整段静默期，绝不抢话。
//
// 【如何关闭】
//   在 wb.json 里设 "proactive": false，或让 bot 执行 !shutUp。
//
// 【配置】wb.json 中的可选字段：
//   "proactive": true,          // 总开关，默认 true
//   "proactive_interval": 90,   // 秒：两次主动唤醒之间的最小间隔
//   "proactive_max_per_day": 200

import convoManager from './conversation.js';

const DEFAULTS = {
    enabled: true,
    intervalSec: 90,
    maxPerDay: 200,
};

// 检查节拍固定为 5 秒：唤醒**节奏**由 nextAllowedAt 控制，与节拍解耦。
// （早先版本让节拍 == 静默期，结果边界上必然漏判，已修正。）
const TICK_MS = 5000;

/** 从 agent 的 profile 读配置（profile 已在 prompter 里合并过默认值）。 */
function readConfig(agent) {
    const p = (agent && agent.prompter && agent.prompter.profile) || {};
    let enabled = DEFAULTS.enabled;
    if (p.proactive === false) enabled = false;

    let intervalSec = Number(p.proactive_interval);
    if (!Number.isFinite(intervalSec) || intervalSec <= 0) intervalSec = DEFAULTS.intervalSec;

    let maxPerDay = Number(p.proactive_max_per_day);
    if (!Number.isFinite(maxPerDay) || maxPerDay < 0) maxPerDay = DEFAULTS.maxPerDay;

    return { enabled, intervalSec, maxPerDay };
}

/**
 * 启动主动唤醒循环。
 * 会把 `agent._proactivePushBack()` 挂到 agent 上 —— agent 收到玩家消息时调用它，
 * 即可把下一次唤醒推后一整段静默期（事件驱动，不依赖轮询时序）。
 * @returns {() => void} 停止函数（bot 退出时调用）
 */
export function startProactive(agent) {
    const cfg = readConfig(agent);

    if (!cfg.enabled) {
        console.log('[proactive] 已关闭（profile 里 proactive=false）');
        return () => {};
    }

    let stopped = false;
    let usedToday = 0;
    let dayStamp = new Date().toDateString();

    const quietMs = cfg.intervalSec * 1000;
    // 开场先静默一段，别一进服就冒话
    let nextAllowedAt = Date.now() + quietMs;

    /** 玩家说话时调用：推后下次唤醒。事件驱动，避免轮询漏判。 */
    const pushBack = () => { nextAllowedAt = Date.now() + quietMs; };
    agent._proactivePushBack = pushBack;

    // 唤醒时说的话——刻意做成"通用引导"，具体内容由人格提示词决定
    const PROMPTS = [
        '（主动巡视）看看四周有没有什么需要你做的，或是要跟主人说的事。',
        '（主动汇报）你手头有在忙的事吗？有就简短汇报进度，没有就找件小事做起来。',
        '（主动关心）看看主人的状态和周围环境，有值得提醒的就开口。',
    ];
    let promptIdx = 0;

    console.log(
        `[proactive] 已启用：每 ${cfg.intervalSec} 秒最多唤醒一次，` +
        `每日上限 ${cfg.maxPerDay} 次（玩家说话会自动推后）`
    );

    const timer = setInterval(async () => {
        if (stopped) return;

        // 跨天重置计数
        const today = new Date().toDateString();
        if (today !== dayStamp) {
            dayStamp = today;
            usedToday = 0;
            console.log('[proactive] 新的一天，唤醒计数已重置');
        }

        // 闸门 3：每日上限
        if (usedToday >= cfg.maxPerDay) {
            if (usedToday === cfg.maxPerDay) {
                console.log(
                    `[proactive] 今日已达上限 ${cfg.maxPerDay} 次，停止主动唤醒` +
                    `（明天自动重置；要立即恢复请重启 bot，或调大 proactive_max_per_day）`
                );
                usedToday++;   // 只打印一次
            }
            return;
        }

        try {
            // 未到允许时刻（含开场静默、玩家说话后的静默）
            if (Date.now() < nextAllowedAt) return;

            // 闸门 2：只在闲置时唤醒，不打断正在进行的动作
            if (typeof agent.isIdle !== 'function' || !agent.isIdle()) return;
            if (agent.shut_up) return;

            // 别在跟玩家对话中时打扰
            try {
                if (convoManager && typeof convoManager.inConversation === 'function'
                    && convoManager.inConversation()) return;
            } catch { /* 拿不到会话状态就继续 */ }

            // 唤醒成功才计数并重新计时（避免连续唤醒）
            usedToday++;
            nextAllowedAt = Date.now() + quietMs;
            const text = PROMPTS[promptIdx % PROMPTS.length];
            promptIdx++;
            console.log(`[proactive] 唤醒 #${usedToday}/${cfg.maxPerDay}：${text}`);
            // source='system' → 走 self_prompt 路径，不会当成玩家发言
            await agent.handleMessage('system', text, 1);
        } catch (e) {
            console.log('[proactive] 唤醒失败:', e && e.message ? e.message : e);
        }
    }, TICK_MS);

    return () => {
        stopped = true;
        clearInterval(timer);
        if (agent._proactivePushBack === pushBack) agent._proactivePushBack = null;
        console.log('[proactive] 已停止');
    };
}
