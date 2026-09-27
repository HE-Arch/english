/* ============================================================
   EngForDev 应用逻辑 app.js
   - 状态管理（localStorage 持久化）
   - 章节解锁 / 路径图渲染
   - 学习页 8 步流程：目标→词块→语法→8题→视频→角色扮演→章测→完成
   - 判分逻辑（choice / order / fill）
   - 复习页、视频页、我的页
   - 音效（Web Audio）、朗读（SpeechSynthesis）
   全部挂到全局 window.EngForDev（下文简称 App）便于测试调用
   ============================================================ */
(function () {
  'use strict';

  /* =========================================================
     0. 工具
     ========================================================= */
  const App = window.EngForDev = window.EngForDev || {};
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  // 创建元素的小助手：el('div','cls',{text:'hi',onclick:fn})
  function el(tag, cls, attrs) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null) continue;
      if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k === 'onclick' && typeof v === 'function') tap(e, v);   // 移动端用 pointerdown
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    return e;
  }
  App.el = el;

  // 移动端友好的点击绑定：pointerdown + touchstart 双保险
  // 部分老旧移动端 WebView 不支持 pointerdown，故同时绑定 touchstart；用 fired 标志防重复触发
  function tap(el, fn) {
    if (!el) return;
    let fired = false;
    const handler = (e) => {
      if (fired) return;
      fired = true;
      if (e.cancelable) { try { e.preventDefault(); } catch (_) {} }
      fn(e);
      setTimeout(() => { fired = false; }, 300);
    };
    el.addEventListener('pointerdown', handler);
    el.addEventListener('touchstart', handler, { passive: false });
  }
  App.tap = tap;

  // 带滑动阈值的点击：按住滑动不触发，只有移动距离 < 10px 才认为是点击
  // 仅用于可滚动列表中的卡片（章节卡片、视频卡片），避免滑动误触进入
  function tapCard(el, fn) {
    if (!el) return;
    const THRESHOLD = 10;   // 滑动阈值（px）
    let startX = 0, startY = 0, moved = false, lastTouchEnd = 0;

    el.addEventListener('touchstart', (e) => {
      const t = e.touches && e.touches[0];
      if (!t) return;
      startX = t.clientX; startY = t.clientY; moved = false;
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
      if (moved) return;
      const t = e.touches && e.touches[0];
      if (!t) return;
      if (Math.abs(t.clientX - startX) > THRESHOLD || Math.abs(t.clientY - startY) > THRESHOLD) {
        moved = true;
      }
    }, { passive: true });

    el.addEventListener('touchend', (e) => {
      lastTouchEnd = Date.now();
      if (moved) return;          // 滑动过，不触发
      fn(e);
    });

    // 桌面鼠标点击兜底；移动端 touchend 后会触发合成 click，用时间窗抑制重复
    el.addEventListener('click', (e) => {
      if (Date.now() - lastTouchEnd < 500) return;
      fn(e);
    });
  }
  App.tapCard = tapCard;

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // 昨天的日期字符串
  function yesterdayStr() {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // Toast 提示
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast'); if (!t) { console.log('[toast]', msg); return; }
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
  }
  App.toast = toast;

  /* =========================================================
     1. 状态 / localStorage
     ========================================================= */
  const STORAGE_KEY = 'engfordev_v1';

  function defaultState() {
    return {
      xp: 0,
      streak: 0,
      lastCheckIn: null,        // 'YYYY-MM-DD'
      completed: {},           // { ch1: { xp, examScore } }
      currentChapterId: 'ch1', // 当前可学章节
      wrong: [],                // 错题本 [{chapterId,qid,type,prompt,userAnswer,correctAnswer,ts}]
      spaced: [],               // 间隔复习队列（同 wrong 结构 +due）
      badges: [],               // 已获徽章 id
      // ---- v2 新增：学习时长打卡 / 跟读 / 角色扮演 计数 ----
      todayStudyMs: 0,         // 当日累计学习毫秒数（满 10 分钟算打卡）
      lastStudyDate: null,     // 最近一次累加学习时长的日期（跨日清零）
      shadowCount: 0,          // 跟读成功次数
      roleplayCount: 0,        // 角色扮演完成次数
      // ---- v3 新增：Gemini AI 角色扮演 ----
      geminiApiKey: '',        // 用户在设置页填入的 Gemini API Key（明文存 localStorage）
      aiHistory: [],            // AI 对话历史 [{role:'user'|'ai', text, ts, chapterId}]
      chapterProgress: {}       // 各章学习进度步数（0..STEPS.length-1）
    };
  }
  App.defaultState = defaultState;

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const s = raw ? JSON.parse(raw) : defaultState();
      // 兜底：合并默认字段，防止旧数据缺字段
      return Object.assign(defaultState(), s);
    } catch (e) {
      console.warn('[loadState] 失败，使用默认状态', e);
      return defaultState();
    }
  }
  App.loadState = loadState;

  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state || App.state));
      return true;
    } catch (e) {
      console.warn('[saveState] 失败', e);
      return false;
    }
  }
  App.saveState = saveState;

  /* =========================================================
     2. 章节解锁逻辑
     ========================================================= */
  function getChapter(id) {
    return (window.ENG_DATA && window.ENG_DATA.CHAPTERS || window.CHAPTERS || []).find(c => c.id === id);
  }
  App.getChapter = getChapter;

  // 自由选择模式：所有章节均可进入。返回 'done' | 'available'
  function chapterStatus(ch, state) {
    const s = state || App.state;
    if (!ch) return 'available';
    if (s.completed[ch.id]) return 'done';
    return 'available';
  }
  App.chapterStatus = chapterStatus;

  // 所有章节均已解锁
  function isUnlocked(ch, state) {
    return true;
  }
  App.isUnlocked = isUnlocked;

  // 章节学习进度百分比（0-100）
  function chapterProgressPct(ch, state) {
    const s = state || App.state;
    if (!ch) return 0;
    if (s.completed[ch.id]) return 100;
    const step = s.chapterProgress && s.chapterProgress[ch.id] ? s.chapterProgress[ch.id] : 0;
    return Math.min(100, Math.round(step / (STEPS.length - 1) * 100));
  }
  App.chapterProgressPct = chapterProgressPct;

  // 标记章节完成：写 completed、推进 currentChapterId、加分、发徽章
  function markChapterDone(chId, examScore) {
    const s = App.state;
    const ch = getChapter(chId);
    if (!ch) return false;
    if (s.completed[chId]) return true; // 已完成
    s.completed[chId] = { xp: ch.xp || 0, examScore: examScore };
    s.xp += ch.xp || 0;
    // 解锁下一章
    const list = window.ENG_DATA.CHAPTERS || window.CHAPTERS;
    const idx = list.findIndex(c => c.id === chId);
    const next = list[idx + 1];
    if (next) s.currentChapterId = next.id;
    awardBadges(s);
    saveState(s);
    return true;
  }
  App.markChapterDone = markChapterDone;

  /* =========================================================
     3. 判分逻辑
     ========================================================= */
  // 输入题目 q 与用户答案 userAnswer（choice 为 index，order 为数组，fill 为字符串）
  // 返回 { correct:boolean, correctAnswer }
  function checkAnswer(q, userAnswer) {
    if (!q) return { correct: false, correctAnswer: null };
    let correct = false;
    try {
      if (q.type === 'choice') {
        correct = Number(userAnswer) === Number(q.answer);
      } else if (q.type === 'order') {
        const a = q.answer;
        correct = Array.isArray(userAnswer) && userAnswer.length === a.length &&
          userAnswer.every((w, i) => w === a[i]);
      } else if (q.type === 'fill') {
        const accept = q.accept && q.accept.length ? q.accept : [q.answer];
        const norm = String(userAnswer == null ? '' : userAnswer).trim().toLowerCase();
        correct = norm !== '' && accept.some(a => String(a).trim().toLowerCase() === norm);
      } else if (q.type === 'translation') {
        // 中译英：用 accept 数组做归一化匹配（去标点、小写）
        const accept = q.accept && q.accept.length ? q.accept : [q.answer];
        const norm = String(userAnswer == null ? '' : userAnswer).trim().toLowerCase().replace(/[.!?,，。！？]/g, '');
        correct = norm !== '' && accept.some(a => String(a).trim().toLowerCase().replace(/[.!?,，。！？]/g, '') === norm);
      } else if (q.type === 'retell') {
        // 复述：关键词覆盖率 ≥ 60% 算通过
        const kws = (q.keywords || []).map(w => String(w).toLowerCase());
        const said = tokenize(String(userAnswer == null ? '' : userAnswer)).map(w => w.toLowerCase());
        if (!kws.length) { correct = false; }
        else {
          const saidSet = new Set(said);
          const hit = kws.filter(w => saidSet.has(w)).length;
          correct = (hit / kws.length) >= 0.6;
        }
      }
    } catch (e) {
      console.warn('[checkAnswer] 异常', e);
      correct = false;
    }
    return { correct, correctAnswer: q.answer };
  }
  App.checkAnswer = checkAnswer;

  /* =========================================================
     4. 视图切换
     ========================================================= */
  const VIEWS = ['home', 'learn', 'review', 'video', 'profile'];
  App.currentView = 'home';

  function switchView(name) {
    if (!VIEWS.includes(name)) return false;
    $$('.view').forEach(v => v.classList.remove('active'));
    const v = $('#view-' + name);
    if (!v) return false;
    v.classList.add('active');
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    const main = $('#main-view'); if (main) main.scrollTop = 0;
    App.currentView = name;
    return true;
  }
  App.switchView = switchView;

  /* =========================================================
     5. 音效（Web Audio）
     ========================================================= */
  function audioCtx() {
    if (!App._audio) {
      try { App._audio = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { console.warn('[audio] 不支持', e); }
    }
    return App._audio;
  }
  function beep(freq, dur, type) {
    const ctx = audioCtx(); if (!ctx) return;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    osc.connect(gain); gain.connect(ctx.destination);
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.18));
    osc.start(t); osc.stop(t + (dur || 0.18) + 0.03);
  }
  function soundCorrect() { beep(880, 0.15); setTimeout(() => beep(1175, 0.18), 130); }
  function soundWrong() { beep(220, 0.28, 'sawtooth'); }
  App.soundCorrect = soundCorrect;
  App.soundWrong = soundWrong;

  /* =========================================================
     6. 朗读（SpeechSynthesis）
     ========================================================= */
  // 浏览器是否支持语音合成：需同时存在 speechSynthesis 与 SpeechSynthesisUtterance
  function supportsSpeech() {
    return 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  }
  App.supportsSpeech = supportsSpeech;

  function speak(text) {
    if (!supportsSpeech()) {
      // 不支持时静默返回，不弹 toast 打断流程；按钮已在 init 时隐藏
      console.warn('[speak] 当前浏览器不支持语音合成');
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US'; u.rate = 0.95; u.pitch = 1;
      window.speechSynthesis.speak(u);
    } catch (e) { console.warn('[speak] 异常', e); }
  }
  App.speak = speak;

  // 不支持朗读时，隐藏所有朗读按钮（block-speak、word-popup-speak 等）
  function hideSpeakButtonsIfUnsupported() {
    if (supportsSpeech()) return;
    $$('.block-speak, #word-popup-speak, #shadow-speak, #vp-shadow-speak').forEach(b => {
      if (b) b.style.display = 'none';
    });
  }
  App.hideSpeakButtonsIfUnsupported = hideSpeakButtonsIfUnsupported;

  /* =========================================================
     7. 徽章
     ========================================================= */
  function awardBadges(state) {
    const s = state || App.state;
    const badges = (window.ENG_DATA && window.ENG_DATA.BADGES) || [];
    badges.forEach(b => {
      if (!s.badges.includes(b.id) && b.check(s)) {
        s.badges.push(b.id);
        toast('🏅 获得徽章：' + b.name);
      }
    });
  }
  App.awardBadges = awardBadges;

  /* =========================================================
     7.5 Gemini AI 角色扮演
     - Key 存 state.geminiApiKey（localStorage 持久化）
     - 浏览器直调 https://generativelanguage.googleapis.com/v1beta/...
     - 无 Key 或调用失败 → 回退预设对话树，绝不崩溃
     ========================================================= */
  const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';
  const GEMINI_SYS_TPL = "You are a foreign colleague at a tech company. The user is a Chinese software tester with basic English (A2 level). Respond in simple English, max 2 sentences. If the user makes a grammar mistake, gently correct it in one short sentence, then continue the conversation. Scenario: {scene}";

  // 读取当前 API Key
  function getApiKey() {
    return (App.state && App.state.geminiApiKey) || '';
  }
  App.getApiKey = getApiKey;

  // 保存 API Key 到 state（同步 localStorage）
  function setApiKey(key) {
    const s = App.state;
    s.geminiApiKey = String(key || '').trim();
    saveState(s);
    return s.geminiApiKey;
  }
  App.setApiKey = setApiKey;

  // 清空 API Key
  function clearApiKey() {
    return setApiKey('');
  }
  App.clearApiKey = clearApiKey;

  // 调用 Gemini：成功返回字符串文本，失败返回 null（不抛错）
  // history 形如 [{role:'user', text:'...'}, {role:'model', text:'...'}]
  // 内置 10s 超时（AbortController），防止网络挂起
  async function callGemini(apiKey, scene, history, userText) {
    if (!apiKey) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const sys = GEMINI_SYS_TPL.replace('{scene}', scene || 'office talk');
      const contents = [];
      (history || []).forEach(h => {
        contents.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.text }] });
      });
      if (userText) contents.push({ role: 'user', parts: [{ text: userText }] });

      const resp = await fetch(GEMINI_URL + '?key=' + encodeURIComponent(apiKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: sys }] },
          contents: contents,
          generationConfig: { temperature: 0.7, maxOutputTokens: 100 }
        }),
        signal: ctrl.signal
      });
      if (!resp.ok) {
        console.warn('[Gemini] HTTP ' + resp.status);
        return null;
      }
      const data = await resp.json();
      const text = data && data.candidates && data.candidates[0] &&
                   data.candidates[0].content && data.candidates[0].content.parts &&
                   data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
      return text ? String(text).trim() : null;
    } catch (e) {
      console.warn('[Gemini] 调用异常', e);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  App.callGemini = callGemini;

  // 测试连接：发 "Hello" 验证 Key，返回 { ok, msg }
  async function testApiKey(apiKey) {
    if (!apiKey) return { ok: false, msg: '请先填写 API Key' };
    const text = await callGemini(apiKey, 'greeting', [], 'Hello');
    return text ? { ok: true, msg: '连接成功：' + text.slice(0, 60) } : { ok: false, msg: '连接失败，请检查 Key 或网络' };
  }
  App.testApiKey = testApiKey;

  /* =========================================================
     8. 每日打卡（streak）
     - 学习满 10 分钟（600_000 ms）才算打卡
     - 连续打卡额外奖励 XP：第 N 天打卡 +N XP（封顶 10）
     - init() 不再自动打卡，需用户在 learn 视图累计学习时长触发
     ========================================================= */
  const STUDY_THRESHOLD_MS = 10 * 60 * 1000; // 10 分钟
  const STREAK_XP_CAP = 10;                  // 连续打卡额外 XP 上限

  // 累加学习时长：跨日清零；满阈值且当日未打卡则打卡
  function addStudyTime(ms) {
    const s = App.state;
    const today = todayStr();
    if (s.lastStudyDate !== today) {
      s.todayStudyMs = 0;
      s.lastStudyDate = today;
    }
    s.todayStudyMs += ms;
    saveState(s);
    // 达阈值且今日未打卡 → 打卡
    if (s.todayStudyMs >= STUDY_THRESHOLD_MS && s.lastCheckIn !== today) {
      const newStreak = checkIn();
      if (newStreak) {
        const bonus = Math.min(newStreak, STREAK_XP_CAP);
        s.xp += bonus;
        awardBadges(s);   // 加完 bonus XP 再发徽章，保证 first_step(xp>0) 能触发
        saveState(s);
        renderHeader();
        toast('📅 今日打卡！连续第 ' + newStreak + ' 天，+' + bonus + ' XP');
      }
    }
    return s.todayStudyMs;
  }
  App.addStudyTime = addStudyTime;

  // 真正执行打卡：推进 streak、写 lastCheckIn、返回新 streak
  function checkIn() {
    const s = App.state;
    const today = todayStr();
    if (s.lastCheckIn === today) return s.streak; // 今天已打卡
    if (s.lastCheckIn === yesterdayStr()) s.streak += 1;
    else s.streak = 1;
    s.lastCheckIn = today;
    awardBadges(s);            // 触发 first_checkin / streak7 等
    saveState(s);
    return s.streak;
  }
  App.checkIn = checkIn;

  /* =========================================================
     8.5 词义弹窗（点击字幕单词弹出释义卡片，替代旧 toast）
     ========================================================= */
  function showWordPopup(word, def) {
    const popup = $('#word-popup'); if (!popup) { toast(def ? word + '：' + def : word); return; }
    const w = $('#word-popup-word'), d = $('#word-popup-def'), sBtn = $('#word-popup-speak');
    if (w) w.textContent = word;
    if (d) d.textContent = def || '（暂无释义）';
    if (sBtn) {
      if (supportsSpeech()) {
        sBtn.style.display = '';
        sBtn.onclick = () => App.speak(word);
      } else {
        sBtn.style.display = 'none';
      }
    }
    popup.hidden = false;
  }
  App.showWordPopup = showWordPopup;
  function hideWordPopup() {
    const popup = $('#word-popup'); if (popup) popup.hidden = true;
  }
  App.hideWordPopup = hideWordPopup;

  // 绑定关闭事件（点击遮罩或关闭按钮）
  function bindWordPopup() {
    const popup = $('#word-popup'); if (!popup) return;
    popup.addEventListener('click', e => { if (e.target === popup) hideWordPopup(); });
    const close = $('#word-popup-close'); if (close) tap(close, hideWordPopup);
  }

  /* =========================================================
     8.6 跟读模式（Web Speech API: SpeechRecognition）
     - scoreSentence(target, said) 计算词重叠率，返回 0~1
     - startShadowing(cues, panelEl, onDone) 用当前 cue 跟读
     ========================================================= */
  // 句子分词：小写、去标点（含撇号，但不拆词）、按空白拆分
  // 例："It's ten o'clock." → ["its","ten","oclock"]
  function tokenize(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  }
  // 评分：基于词重叠率（Jaccard 的简化版，重叠词数 / 目标词数）
  function scoreSentence(target, said) {
    const t = tokenize(target), s = tokenize(said);
    if (!t.length) return 0;
    if (!s.length) return 0;
    const setT = new Set(t), setS = new Set(s);
    let hit = 0;
    setT.forEach(w => { if (setS.has(w)) hit++; });
    // 重叠率：命中目标词占比（不惩罚多说，惩罚少说）
    const ratio = hit / t.length;
    // 句长差距过大略降权：少说太多则扣分
    const lenPenalty = s.length < t.length * 0.6 ? 0.7 : 1;
    return Math.max(0, Math.min(1, ratio * lenPenalty));
  }
  App.scoreSentence = scoreSentence;

  // 获取 SpeechRecognition 构造器（兼容 webkit 前缀）
  function getRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  // 在指定面板里跑跟读：cues 为字幕数组（{t,en,zh}），panelEl 为面板容器
  // onDone(score) 跟读成功一次后回调（不传则不调）
  // 当前 cue 索引从 App.learn.shadowIdx 读取（由视频播放器在切字幕时同步）
  function startShadowing(cues, panelEl, onDone) {
    if (!panelEl) return;
    const Rec = getRecognitionCtor();
    panelEl.hidden = false;
    const enEl = $('.shadow-target-en', panelEl);
    const zhEl = $('.shadow-target-zh', panelEl);
    const resultEl = $('.shadow-result', panelEl);
    const startBtn = $('.btn', panelEl);
    if (!cues || !cues.length) { if (enEl) enEl.textContent = '（无字幕可跟读）'; return; }

    let cueIdx = App.learn.shadowIdx || 0;
    if (cueIdx >= cues.length) cueIdx = 0;
    function renderCue() {
      const c = cues[cueIdx];
      if (!c) return;
      if (enEl) enEl.textContent = c.en;
      if (zhEl) zhEl.textContent = c.zh;
      if (resultEl) { resultEl.hidden = true; resultEl.textContent = ''; }
    }
    renderCue();
    if (!Rec) {
      if (startBtn) startBtn.textContent = '🎤 当前浏览器不支持，建议用 Chrome';
      toast('浏览器不支持语音识别，建议用 Chrome');
      return;
    }
    if (startBtn) startBtn.textContent = '🎤 开始录音跟读';
    // 关闭按钮
    const closeBtn = $('.shadow-close', panelEl);
    if (closeBtn) closeBtn.onclick = () => { panelEl.hidden = true; stopRec(); };
    let rec = null, recognizing = false;
    function stopRec() {
      if (rec && recognizing) { try { rec.stop(); } catch (e) {} recognizing = false; }
      if (startBtn) { startBtn.textContent = '🎤 开始录音跟读'; startBtn.disabled = false; }
    }
    startBtn.onclick = () => {
      if (recognizing) { stopRec(); return; }
      // 先朗读目标句，再开始识别
      const c = cues[cueIdx];
      if (c) App.speak(c.en);
      // 朗读约 0.6s/词后启动识别（确保朗读播放完）
      const delay = Math.max(800, (c ? tokenize(c.en).length : 3) * 600);
      setTimeout(() => {
        try {
          rec = new Rec();
          rec.lang = 'en-US';
          rec.interimResults = false;
          rec.maxAlternatives = 1;
          rec.onstart = () => { recognizing = true; if (startBtn) { startBtn.textContent = '⏹ 停止录音'; } };
          rec.onerror = e => {
            recognizing = false;
            if (startBtn) { startBtn.textContent = '🎤 开始录音跟读'; startBtn.disabled = false; }
            if (resultEl) { resultEl.hidden = false; resultEl.textContent = '⚠ 识别失败：' + (e.error || 'unknown'); }
          };
          rec.onend = () => { recognizing = false; if (startBtn) { startBtn.textContent = '🎤 开始录音跟读'; startBtn.disabled = false; } };
          rec.onresult = ev => {
            const said = ev.results && ev.results[0] && ev.results[0][0] ? ev.results[0][0].transcript : '';
            const target = c ? c.en : '';
            const score = scoreSentence(target, said);
            if (resultEl) {
              resultEl.hidden = false;
              const pct = Math.round(score * 100);
              const ok = pct >= 60;
              resultEl.className = 'shadow-result ' + (ok ? 'pass' : 'fail');
              resultEl.innerHTML = '你说："' + said + '"<br>得分：' + pct + '% ' + (ok ? '✅' : '❌');
            }
            // 评分达 60% 视为成功：累加 shadowCount、发徽章、推进下一句
            if (score >= 0.6) {
              App.state.shadowCount = (App.state.shadowCount || 0) + 1;
              awardBadges(App.state);
              saveState(App.state);
              soundCorrect();
              // 推进到下一句
              cueIdx = (cueIdx + 1) % cues.length;
              App.learn.shadowIdx = cueIdx;
              setTimeout(renderCue, 800);
              onDone && onDone(score);
            } else {
              soundWrong();
            }
          };
          rec.start();
        } catch (e) {
          console.warn('[shadowing] 启动失败', e);
          toast('录音启动失败，请检查麦克风权限');
        }
      }, delay);
    };
  }
  App.startShadowing = startShadowing;

  /* =========================================================
     9. 头部渲染
     ========================================================= */
  function renderHeader() {
    const s = App.state;
    const streakEl = $('#streak-count'), xpEl = $('#xp-count');
    if (streakEl) streakEl.textContent = s.streak;
    if (xpEl) xpEl.textContent = s.xp;
  }
  App.renderHeader = renderHeader;

  /* =========================================================
     10. 首页路径图
     ========================================================= */
  const STAGE_LABEL = { A1: 'A1 基础', A2: 'A2 日常', B1: 'B1 职场' };
  const STAGE_ORDER = ['A1', 'A2', 'B1'];

  function renderPathMap() {
    const map = $('#path-map'); if (!map) return;
    map.innerHTML = '';
    const list = window.ENG_DATA.CHAPTERS || window.CHAPTERS || [];
    const byStage = {};
    STAGE_ORDER.forEach(st => byStage[st] = []);
    list.forEach(ch => {
      const st = ch.stage || 'A1';
      (byStage[st] = byStage[st] || []).push(ch);
    });
    STAGE_ORDER.forEach(st => {
      const chapters = byStage[st] || [];
      if (!chapters.length) return;
      const group = el('div', 'stage-group');
      group.appendChild(el('div', 'stage-label', { text: STAGE_LABEL[st] || st }));
      chapters.forEach((ch, i) => {
        const status = chapterStatus(ch);
        const pct = chapterProgressPct(ch);
        const earnedXp = (App.state.completed[ch.id] && App.state.completed[ch.id].xp) || 0;
        const card = el('div', 'chapter-card ' + status);
        const left = el('div', 'chapter-icon', { text: ch.emoji || '📘' });
        const mid = el('div', 'chapter-meta');
        mid.appendChild(el('div', 'chapter-title', { text: ch.title }));
        const sub = el('div', 'chapter-sub');
        sub.appendChild(el('span', 'chapter-xp', { text: '⭐ ' + earnedXp + ' XP' }));
        if (status === 'done') sub.appendChild(el('span', 'chapter-done', { text: '✓ 已完成' }));
        mid.appendChild(sub);
        // 进度条
        const bar = el('div', 'chapter-progress');
        const fill = el('div', 'chapter-progress-fill');
        fill.style.width = pct + '%';
        bar.appendChild(fill);
        mid.appendChild(bar);
        mid.appendChild(el('div', 'chapter-pct', { text: pct + '%' }));
        card.appendChild(left); card.appendChild(mid);
        tapCard(card, () => startChapter(ch));
        group.appendChild(card);
      });
      map.appendChild(group);
    });
  }
  App.renderPathMap = renderPathMap;

  /* =========================================================
     11. 学习页：8 步流程
     ========================================================= */
  const STEPS = ['goal', 'blocks', 'grammar', 'quiz', 'video', 'roleplay', 'exam', 'done'];
  App.learn = { chapterId: null, stepIndex: 0, quiz: null, exam: null, roleplay: null, video: null };

  function setStepProgress() {
    const fill = $('#step-progress-fill'); if (!fill) return;
    const p = App.learn.stepIndex / (STEPS.length - 1);
    fill.style.width = (Math.round(p * 100)) + '%';
  }

  function showStep(name) {
    const idx = STEPS.indexOf(name);
    App.learn.stepIndex = idx < 0 ? 0 : idx;
    setStepProgress();
    $$('#learn-stage .step').forEach(s => s.hidden = true);
    const target = $('#step-' + name); if (target) target.hidden = false;
    // 记录该章最远到达的步骤（用于首页进度百分比）
    if (App.learn.chapterId) {
      const s = App.state;
      if (!s.chapterProgress) s.chapterProgress = {};
      const prev = s.chapterProgress[App.learn.chapterId] || 0;
      if (idx > prev) { s.chapterProgress[App.learn.chapterId] = idx; saveState(s); }
    }
  }

  function startChapter(ch) {
    if (!ch) return;
    App.learn.chapterId = ch.id;
    App.learn.quiz = { index: 0, answers: [], wrongs: [] };
    App.learn.exam = { index: 0, answers: [], wrongs: [] };
    App.learn.roleplay = null;
    App.learn.video = { playing: false, cueIndex: -1, timer: null };
    App.learn.shadowIdx = 0;
    switchView('learn');
    renderGoalStep(ch);
    showStep('goal');
    startStudyTimer();   // 进入学习页即开始累计时长
  }
  App.startChapter = startChapter;

  // 10.1 本章目标
  function renderGoalStep(ch) {
    const card = $('#goal-card'); if (!card) return;
    card.innerHTML = '';
    card.appendChild(el('div', 'goal-emoji', { text: ch.emoji }));
    card.appendChild(el('div', 'goal-text', { text: ch.goal }));
  }

  // 10.2 词块
  function renderBlocksStep(ch) {
    const list = $('#blocks-list'); if (!list) return;
    list.innerHTML = '';
    const canSpeak = supportsSpeech();
    ch.blocks.forEach(b => {
      const card = el('div', 'block-card');
      if (canSpeak) {
        card.appendChild(el('button', 'block-speak', { text: '🔊', 'aria-label': '朗读', onclick: () => App.speak(b.speak || b.en) }));
      }
      const text = el('div', 'block-text');
      text.appendChild(el('div', 'block-en', { text: b.en }));
      text.appendChild(el('div', 'block-zh', { text: b.zh }));
      card.appendChild(text);
      list.appendChild(card);
    });
  }

  // 10.3 语法
  function renderGrammarStep(ch) {
    const card = $('#grammar-card'); if (!card) return;
    card.innerHTML = '';
    const g = ch.grammar;
    card.appendChild(el('div', 'grammar-title', { text: g.title }));
    card.appendChild(el('div', 'grammar-rule', { text: g.rule }));
    if (g.table) {
      const t = el('table', 'grammar-table');
      g.table.forEach((row, ri) => {
        const tr = el('tr');
        row.forEach((cell, ci) => tr.appendChild(el(ri === 0 ? 'th' : 'td', null, { text: cell })));
        t.appendChild(tr);
      });
      card.appendChild(t);
    }
    if (g.examples) {
      const ex = el('div', 'grammar-example');
      g.examples.forEach(s => ex.appendChild(el('div', null, { text: '• ' + s })));
      card.appendChild(ex);
    }
  }

  // 10.4 练习题（8 题）——通用渲染，章测复用
  function renderQuestion(q, bodyEl, counterEl, total) {
    bodyEl.innerHTML = '';
    if (counterEl) counterEl.textContent = (App.learn[q._scope].index + 1) + ' / ' + total;
    const prompt = el('div', 'quiz-prompt');
    if (q.type === 'fill') {
      // 把 ___ 留作视觉占位，输入框单独放下面
      prompt.appendChild(document.createTextNode(q.prompt));
    } else {
      prompt.textContent = q.prompt;
    }
    bodyEl.appendChild(prompt);

    if (q.type === 'choice') {
      q.options.forEach((opt, i) => {
        const b = el('button', 'option-btn', {
          text: opt,
          onclick: () => {
            $$('button.option-btn', bodyEl).forEach(x => x.classList.remove('selected'));
            b.classList.add('selected');
            App.learn[q._scope].selected = i;
            App.learn[q._scope].answered = false;
            enableCheck(q._scope, true);
          }
        });
        b.dataset.idx = i;
        bodyEl.appendChild(b);
      });
    } else if (q.type === 'order') {
      const area = el('div', 'order-area empty');
      const pool = el('div', 'order-pool');
      App.learn[q._scope].selected = [];
      // 打乱顺序作为词池初始顺序
      const shuffled = q.words.slice().sort(() => Math.random() - 0.5);
      // 一次性重绘 area 与 pool
      function refresh() {
        // 重绘已选区
        area.innerHTML = '';
        const sel = App.learn[q._scope].selected;
        area.classList.toggle('empty', sel.length === 0);
        sel.forEach((w, i) => {
          const chip = el('button', 'order-chip', { text: w });
          tap(chip, () => {
            if (App.learn[q._scope].answered) return;   // 答题后禁止操作
            sel.splice(i, 1);
            refresh();
          });
          area.appendChild(chip);
        });
        // 重绘词池（未被选中的词）
        pool.innerHTML = '';
        shuffled.forEach(w => {
          if (sel.includes(w)) return;            // 已选则不显示（词唯一）
          const chip = el('button', 'order-chip', { text: w });
          tap(chip, () => {
            if (App.learn[q._scope].answered) return;
            sel.push(w);
            refresh();
          });
          pool.appendChild(chip);
        });
        enableCheck(q._scope, sel.length === q.answer.length);
      }
      refresh();
      bodyEl.appendChild(area);
      bodyEl.appendChild(el('div', 'step-hint', { text: '点击词块排序，再点已选词块可移回' }));
      bodyEl.appendChild(pool);
    } else if (q.type === 'fill') {
      const input = el('input', 'fill-input');
      input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
      input.placeholder = '在此输入…';
      input.addEventListener('input', () => {
        App.learn[q._scope].selected = input.value;
        App.learn[q._scope].answered = false;
        enableCheck(q._scope, input.value.trim().length > 0);
      });
      bodyEl.appendChild(input);
    } else if (q.type === 'translation') {
      // 中译英：显示中文题干 + 英文输入框
      const input = el('input', 'fill-input');
      input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
      input.placeholder = 'Type the English translation…';
      input.addEventListener('input', () => {
        App.learn[q._scope].selected = input.value;
        App.learn[q._scope].answered = false;
        enableCheck(q._scope, input.value.trim().length > 0);
      });
      bodyEl.appendChild(input);
    } else if (q.type === 'retell') {
      // 复述：显示原句 + 播放按钮 + 输入框
      const playRow = el('div', 'retell-row');
      const sent = el('div', 'retell-sentence', { text: q.prompt });
      const playBtn = el('button', 'btn btn-secondary', { text: '🔊 听原句' });
      tap(playBtn, () => speak(q.prompt));
      playRow.appendChild(sent);
      playRow.appendChild(playBtn);
      bodyEl.appendChild(playRow);
      bodyEl.appendChild(el('div', 'step-hint', { text: '听完后用英文复述（可换说法，关键词命中 60% 即通过）' }));
      const input = el('input', 'fill-input');
      input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
      input.placeholder = 'Retell in your own words…';
      input.addEventListener('input', () => {
        App.learn[q._scope].selected = input.value;
        App.learn[q._scope].answered = false;
        enableCheck(q._scope, input.value.trim().length > 0);
      });
      bodyEl.appendChild(input);
    }
  }

  function enableCheck(scope, ok) {
    const btn = scope === 'quiz' ? $('#quiz-check') : $('#exam-check');
    if (btn) btn.disabled = !ok;
  }

  // 处理一道题的检查
  function handleCheck(scope, total, onDone) {
    const st = App.learn[scope];
    const list = scope === 'quiz' ? App.learn.chapter && App.learn.chapter.quiz : App.learn.chapter && App.learn.chapter.exam;
    const q = list[st.index];
    if (!q) return;
    const result = checkAnswer(q, st.selected);
    st.answered = true;
    st.answers.push({ id: q.id, correct: result.correct, user: st.selected });

    // UI 反馈
    const body = scope === 'quiz' ? $('#quiz-body') : $('#exam-body');
    if (q.type === 'choice') {
      $$('button.option-btn', body).forEach((b, i) => {
        b.classList.add('disabled');
        if (i === q.answer) b.classList.add('correct');
        else if (i === st.selected && !result.correct) b.classList.add('wrong');
      });
    } else if (q.type === 'order') {
      const area = $('.order-area', body);
      if (area) {
        area.querySelectorAll('.order-chip').forEach((c, i) => {
          c.classList.add(i === q.answer[i] ? 'correct' : 'wrong');
        });
      }
    } else if (q.type === 'fill' || q.type === 'translation' || q.type === 'retell') {
      const input = $('.fill-input', body);
      if (input) input.classList.add(result.correct ? 'correct' : 'wrong');
    }

    // 反馈遮罩 + 音效
    showFeedback(result.correct, result.correct ? '答对了！' : '正确答案：' + humanAnswer(q, result.correctAnswer));
    if (result.correct) soundCorrect(); else soundWrong();

    // 错题入错题本（仅练习题进入 wrong；章测的错题也进 wrong）
    if (!result.correct) {
      App.state.wrong.push({
        chapterId: App.learn.chapterId,
        qid: q.id, type: q.type, prompt: q.prompt,
        userAnswer: st.selected, correctAnswer: result.correctAnswer, ts: Date.now()
      });
      saveState(App.state);
      renderReviewWrong();
    }

    // 按钮变成「继续」
    const btn = scope === 'quiz' ? $('#quiz-check') : $('#exam-check');
    btn.textContent = (st.index + 1 >= total) ? '完成' : '继续';
    btn.disabled = false;
    btn.dataset.continued = '1';
    btn.onclick = () => {
      st.index++; st.selected = null; st.answered = false;
      if (st.index >= total) { onDone && onDone(); }
      else {
        renderCurrent(scope, total);
        btn.textContent = '检查';
        btn.disabled = true;
        delete btn.dataset.continued;
        btn.onclick = () => handleCheck(scope, total, onDone);
      }
    };
  }

  function humanAnswer(q, ans) {
    if (q.type === 'choice') return q.options[ans];
    if (q.type === 'order') return (Array.isArray(ans) ? ans : []).join(' ');
    if (q.type === 'retell') return (q.keywords || []).join(', ');
    return ans;
  }

  function renderCurrent(scope, total) {
    const st = App.learn[scope];
    const list = scope === 'quiz' ? App.learn.chapter.quiz : App.learn.chapter.exam;
    const q = list[st.index];
    q._scope = scope;
    const body = scope === 'quiz' ? $('#quiz-body') : $('#exam-body');
    const counter = scope === 'quiz' ? $('#quiz-counter') : $('#exam-counter');
    renderQuestion(q, body, counter, total);
    enableCheck(scope, false);
  }
  App.renderCurrent = renderCurrent;

  // 10.5 视频步骤（模拟播放器：无真实文件，逐句推进字幕）
  function renderVideoStep(ch) {
    const wrap = $('#video-wrap'); if (!wrap) return;
    wrap.innerHTML = '';
    const sub = $('#subtitle-area'); if (sub) sub.innerHTML = '';

    const poster = el('div', 'sim-poster', {
      style: 'height:180px;display:flex;align-items:center;justify-content:center;font-size:56px;background:linear-gradient(135deg,#46A302,#89E14B);',
      text: ch.video.poster || '🎬'
    });
    const playBtn = el('button', 'btn btn-secondary btn-block', {
      style: 'margin-top:8px;', text: '▶ 播放',
      onclick: () => togglePlay(ch)
    });
    wrap.appendChild(poster);
    wrap.appendChild(playBtn);
    // 初始字幕
    setSubtitleCue(ch, 0);
  }

  function setSubtitleCue(ch, idx) {
    const sub = $('#subtitle-area'); if (!sub) return;
    const cues = ch.video.cues;
    const cue = cues[idx];
    // 同步当前 cue 索引给跟读面板使用
    App.learn.shadowIdx = idx;
    sub.innerHTML = '';
    if (!cue) {
      sub.appendChild(el('div', 'subtitle-en', { text: '（播放结束）' }));
      return;
    }
    const en = el('div', 'subtitle-en');
    // 拆词，支持点击查释义（弹窗卡片）
    cue.en.split(/(\s+)/).forEach(tok => {
      if (/^\s+$/.test(tok)) { en.appendChild(document.createTextNode(tok)); return; }
      const span = el('span', 'word', { text: tok });
      tap(span, () => {
        const key = tok.toLowerCase().replace(/[^a-z']/g, '');
        const def = (window.ENG_DATA.GLOSSARY || {})[key];
        App.showWordPopup(tok, def);
      });
      en.appendChild(span);
    });
    sub.appendChild(en);
    sub.appendChild(el('div', 'subtitle-zh', { text: cue.zh }));
  }

  function togglePlay(ch) {
    const v = App.learn.video;
    if (v.playing) { stopVideo(ch); return; }
    v.playing = true; v.cueIndex = 0;
    setSubtitleCue(ch, 0);
    const cues = ch.video.cues;
    v.timer = setInterval(() => {
      v.cueIndex++;
      if (v.cueIndex >= cues.length) { stopVideo(ch); return; }
      setSubtitleCue(ch, v.cueIndex);
    }, 3000);
  }
  function stopVideo(ch) {
    const v = App.learn.video;
    v.playing = false;
    if (v.timer) { clearInterval(v.timer); v.timer = null; }
  }

  // 10.6 角色扮演（开口模式）
  // 状态机：rp = { cur, speakCount, totalScore, history:[], aiMode, finished, rec }
  function renderRoleplayStart(ch) {
    const rp = ch.roleplay;
    App.learn.roleplay = {
      cur: rp.start,
      speakCount: 0,            // 成功开口次数
      totalScore: 0,            // 累计得分（0-1）
      history: [],              // Gemini 对话历史
      aiMode: !!getApiKey(),
      finished: false,
      rec: null                 // 当前 SpeechRecognition 实例
    };
    const scene = $('#roleplay-scene'); if (scene) scene.textContent = rp.scene;
    const log = $('#roleplay-log'); if (log) log.innerHTML = '';
    roleplayShowNpc(ch);
  }
  // 显示 NPC 一句台词 + 操作区：有 options 则为选择节点，否则为开口节点
  function roleplayShowNpc(ch) {
    const rp = App.learn.roleplay;
    const node = ch.roleplay.nodes[rp.cur];
    if (!node) return;
    const log = $('#roleplay-log');
    if (log) log.appendChild(el('div', 'rp-bubble npc', { text: node.npc }));
    rp.history.push({ role: 'model', text: node.npc });
    const opts = $('#roleplay-options'); if (opts) opts.innerHTML = '';
    if (node.end) { roleplayFinish(); return; }
    if (node.options && node.options.length) {
      node.options.forEach(o => {
        opts.appendChild(el('button', 'option-btn', {
          text: o.text,
          onclick: () => { rp.cur = o.next; roleplayShowNpc(ch); }
        }));
      });
    } else {
      roleplayRenderActions(ch, node);
    }
  }
  // 渲染开口操作区：🎤 说出来 + 键盘输入降级
  function roleplayRenderActions(ch, node) {
    const opts = $('#roleplay-options'); if (!opts) return;
    opts.innerHTML = '';
    const hint = el('div', 'step-hint', { text: '请用英语说出回答：「' + (node.expected || '') + '」' });
    opts.appendChild(hint);

    const recCtor = getRecognitionCtor();
    const micBtn = el('button', 'btn btn-primary', { text: '🎤 说出来' });
    micBtn.disabled = !recCtor;
    if (recCtor) {
      tap(micBtn, () => roleplayStartSpeech(ch, node, micBtn));
    } else {
      micBtn.title = '当前浏览器不支持语音识别';
    }
    opts.appendChild(micBtn);

    const fallbackBtn = el('button', 'btn btn-secondary', { text: '⌨️ 键盘输入' });
    tap(fallbackBtn, () => roleplayShowTextInput(ch, node));
    opts.appendChild(fallbackBtn);
  }
  // 启动语音识别
  function roleplayStartSpeech(ch, node, btn) {
    const rp = App.learn.roleplay;
    const Ctor = getRecognitionCtor();
    if (!Ctor) { roleplayShowTextInput(ch, node); return; }
    let rec;
    try { rec = new Ctor(); } catch (e) { roleplayShowTextInput(ch, node); return; }
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    btn.textContent = '🎙️ 正在听…';
    btn.disabled = true;
    const log = $('#roleplay-log');
    let settled = false;
    rec.onresult = (ev) => {
      if (settled) return;
      settled = true;
      const said = ev.results && ev.results[0] && ev.results[0][0] ? ev.results[0][0].transcript : '';
      roleplayEvaluate(ch, node, said, 'voice');
    };
    rec.onerror = () => {
      if (settled) return;
      settled = true;
      // 识别失败 → 降级到打字
      if (log) log.appendChild(el('div', 'rp-bubble npc', { text: '（语音识别失败，请用键盘输入）' }));
      roleplayShowTextInput(ch, node);
    };
    rec.onend = () => {
      btn.textContent = '🎤 说出来';
      btn.disabled = false;
      if (!settled) { settled = true; roleplayShowTextInput(ch, node); }
    };
    try { rec.start(); } catch (e) { settled = true; roleplayShowTextInput(ch, node); }
    rp.rec = rec;
  }
  // 打字降级输入
  function roleplayShowTextInput(ch, node) {
    const opts = $('#roleplay-options'); if (!opts) return;
    opts.innerHTML = '';
    const input = el('input', 'fill-input');
    input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
    input.placeholder = 'Type your answer in English…';
    const submit = el('button', 'btn btn-primary', { text: '提交' });
    submit.disabled = true;
    input.addEventListener('input', () => { submit.disabled = input.value.trim().length === 0; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !submit.disabled) submit.click(); });
    tap(submit, () => roleplayEvaluate(ch, node, input.value, 'text'));
    opts.appendChild(input);
    opts.appendChild(submit);
  }
  // 评分并推进：得分 ≥ 0.6 通过进下一轮，否则原地重试
  function roleplayEvaluate(ch, node, said, mode) {
    const rp = App.learn.roleplay;
    const expected = node.expected || '';
    const score = scoreSentence(expected, said);
    const log = $('#roleplay-log');
    const pct = Math.round(score * 100);
    if (log) log.appendChild(el('div', 'rp-bubble me', { text: '（' + (mode === 'voice' ? '语音' : '打字') + '）' + said + '  得分 ' + pct + '%' }));
    if (score >= 0.6) {
      rp.speakCount++;
      rp.totalScore += score;
      soundCorrect();
      roleplayAdvance(ch, node, said);
    } else {
      soundWrong();
      if (log) log.appendChild(el('div', 'rp-bubble npc', { text: '再试一次吧，正确回答参考：「' + expected + '」' }));
      roleplayRenderActions(ch, node);
    }
  }
  // 通过后推进到下一节点（含 Gemini 分支）
  async function roleplayAdvance(ch, node, userText) {
    const rp = App.learn.roleplay;
    rp.history.push({ role: 'user', text: userText });
    rp.cur = node.next;
    const log = $('#roleplay-log');
    const apiKey = getApiKey();
    if (apiKey) {
      const loading = log ? el('div', 'rp-bubble npc rp-loading', { text: '...' }) : null;
      if (loading) log.appendChild(loading);
      const aiText = await callGemini(apiKey, ch.roleplay.scene, rp.history.slice(), null);
      if (loading) loading.remove();
      if (aiText) {
        if (log) log.appendChild(el('div', 'rp-bubble npc', { text: aiText }));
        rp.history.push({ role: 'model', text: aiText });
        App.state.aiHistory.push({ role: 'user', text: userText, ts: Date.now(), chapterId: ch.id });
        App.state.aiHistory.push({ role: 'ai',   text: aiText,  ts: Date.now(), chapterId: ch.id });
        saveState(App.state);
      }
    }
    // 下一节点
    const nextNode = ch.roleplay.nodes[node.next];
    if (nextNode && nextNode.end) {
      if (log) log.appendChild(el('div', 'rp-bubble npc', { text: nextNode.npc }));
      roleplayFinish();
    } else {
      setTimeout(() => roleplayShowNpc(ch), 400);
    }
  }
  // 结束：显示开口统计 + 继续按钮
  function roleplayFinish() {
    const rp = App.learn.roleplay;
    if (rp.finished) return;
    rp.finished = true;
    App.state.roleplayCount = (App.state.roleplayCount || 0) + 1;
    awardBadges(App.state);
    saveState(App.state);
    const opts = $('#roleplay-options'); if (!opts) return;
    opts.innerHTML = '';
    const avg = rp.speakCount > 0 ? Math.round((rp.totalScore / rp.speakCount) * 100) : 0;
    opts.appendChild(el('div', 'rp-stats', {
      text: '🎉 本场景你开口说了 ' + rp.speakCount + ' 次，平均得分 ' + avg + '%'
    }));
    opts.appendChild(el('button', 'btn btn-primary btn-block', {
      text: '继续', onclick: () => { showStep('exam'); renderExamStart(App.learn.chapter); }
    }));
  }
  // 暴露给测试：直接以文字提交一个回答，模拟语音/打字路径
  function roleplaySubmitAnswer(text) {
    const ch = App.learn.chapter;
    const rp = App.learn.roleplay;
    if (!ch || !rp) return;
    const node = ch.roleplay.nodes[rp.cur];
    if (!node || node.end) return;
    roleplayEvaluate(ch, node, text, 'text');
  }
  App.renderRoleplayStart = renderRoleplayStart;
  App.roleplaySubmitAnswer = roleplaySubmitAnswer;

  // 10.7 章测开始
  function renderExamStart(ch) {
    App.learn.exam = { index: 0, answers: [], selected: null, answered: false };
    renderCurrent('exam', ch.exam.length);
    const btn = $('#exam-check');
    btn.textContent = '检查'; btn.disabled = true;
    btn.onclick = () => handleCheck('exam', ch.exam.length, () => finishChapter(ch));
  }

  // 10.8 完成页
  function finishChapter(ch) {
    const exam = App.learn.exam;
    const total = ch.exam.length;
    const right = exam.answers.filter(a => a.correct).length;
    const score = right / total;
    markChapterDone(ch.id, score);
    // 统计练习错题数
    const quizWrong = App.learn.quiz.answers.filter(a => !a.correct).length;
    const stats = $('#done-stats'); if (stats) {
      stats.innerHTML = '';
      const s1 = el('div', 'done-stat'); s1.appendChild(el('div', 'ds-value', { text: '+' + ch.xp })); s1.appendChild(el('div', 'ds-label', { text: 'XP' }));
      const s2 = el('div', 'done-stat'); s2.appendChild(el('div', 'ds-value', { text: right + '/' + total })); s2.appendChild(el('div', 'ds-label', { text: '章测' }));
      const s3 = el('div', 'done-stat'); s3.appendChild(el('div', 'ds-value', { text: String(quizWrong) })); s3.appendChild(el('div', 'ds-label', { text: '练习错题' }));
      stats.appendChild(s1); stats.appendChild(s2); stats.appendChild(s3);
    }
    showStep('done');
    renderHeader();
    renderPathMap();
    renderProfile();
  }

  // 反馈遮罩
  function showFeedback(correct, text) {
    const fb = $('#feedback'); if (!fb) { return; }
    fb.classList.remove('correct', 'wrong');
    fb.classList.add(correct ? 'correct' : 'wrong');
    $('#feedback-emoji').textContent = correct ? '✅' : '❌';
    $('#feedback-text').textContent = text;
    fb.classList.add('show');
    setTimeout(() => fb.classList.remove('show'), 1400);
  }

  // 学习页事件绑定（全局一次性）
  function bindLearn() {
    // 退出
    const exit = $('#step-exit'); if (exit) tap(exit, () => {
      stopVideo(App.learn.chapter);
      stopStudyTimer();
      switchView('home');
    });
    const nextBtn = (stepId) => { const s = $('#' + stepId); return s && s.querySelector('[data-step-next]'); };
    // goal → blocks
    const goalNext = nextBtn('step-goal'); if (goalNext) tap(goalNext, () => {
      App.learn.chapter = getChapter(App.learn.chapterId);
      renderBlocksStep(App.learn.chapter); showStep('blocks');
    });
    // blocks → grammar
    const blocksNext = nextBtn('step-blocks'); if (blocksNext) tap(blocksNext, () => {
      renderGrammarStep(App.learn.chapter); showStep('grammar');
    });
    // grammar → quiz
    const grammarNext = nextBtn('step-grammar'); if (grammarNext) tap(grammarNext, () => {
      console.log('继续按钮被点击（grammar → quiz）');
      App.learn.quiz = { index: 0, answers: [], selected: null, answered: false };
      renderCurrent('quiz', App.learn.chapter.quiz.length);
      const btn = $('#quiz-check'); btn.textContent = '检查'; btn.disabled = true;
      btn.onclick = () => handleCheck('quiz', App.learn.chapter.quiz.length, () => {
        stopVideo(App.learn.chapter);
        renderVideoStep(App.learn.chapter);
        showStep('video');
      });
      showStep('quiz');
    });
    // video → roleplay
    const videoNext = nextBtn('step-video'); if (videoNext) tap(videoNext, () => {
      stopVideo(App.learn.chapter);
      renderRoleplayStart(App.learn.chapter);
      showStep('roleplay');
    });
    // 学习页 - 视频步骤跟读按钮：展开跟读面板
    const svShadow = $('#step-video-shadow'); if (svShadow) tap(svShadow, () => {
      const ch = App.learn.chapter;
      if (!ch || !ch.video || !ch.video.cues) { toast('请先播放视频'); return; }
      startShadowing(ch.video.cues, $('#shadow-panel'));
    });
    const shadowClose = $('#shadow-close'); if (shadowClose) tap(shadowClose, () => {
      const p = $('#shadow-panel'); if (p) p.hidden = true;
    });
    // done → home
    const doneBack = $('#done-back-home'); if (doneBack) tap(doneBack, () => {
      stopStudyTimer();
      switchView('home');
    });
  }

  /* =========================================================
     11.5 学习时长计时器：进入学习页后每 5s 累加 5000ms
     ========================================================= */
  let studyTimer = null;
  function startStudyTimer() {
    stopStudyTimer();
    studyTimer = setInterval(() => { addStudyTime(5000); }, 5000);
  }
  function stopStudyTimer() {
    if (studyTimer) { clearInterval(studyTimer); studyTimer = null; }
  }
  App.startStudyTimer = startStudyTimer;
  App.stopStudyTimer = stopStudyTimer;

  /* =========================================================
     12. 复习页
     ========================================================= */
  function renderReviewWrong() {
    const list = $('#wrong-list'); if (!list) return;
    list.innerHTML = '';
    const wrongs = App.state.wrong;
    if (!wrongs.length) {
      list.appendChild(el('div', 'empty-state', { text: '暂无错题，继续保持！' }));
      return;
    }
    // 去重展示（同 qid 只显示最近一次）
    const seen = {};
    const recent = [];
    for (let i = wrongs.length - 1; i >= 0; i--) {
      const w = wrongs[i];
      const key = w.chapterId + ':' + w.qid;
      if (seen[key]) continue; seen[key] = 1;
      recent.push(w);
    }
    recent.forEach(w => {
      const item = el('div', 'review-item');
      item.appendChild(el('div', 'ri-type', { text: w.type + ' · ' + (getChapter(w.chapterId) || {}).title }));
      item.appendChild(el('div', 'ri-prompt', { text: w.prompt }));
      if (w.type !== 'order') {
        item.appendChild(el('div', 'ri-answer wrong-ans', { text: '你的答案：' + humanDisplay(w) }));
      }
      const ch = getChapter(w.chapterId);
      const q = ch && (ch.quiz.concat(ch.exam)).find(x => x.id === w.qid);
      item.appendChild(el('div', 'ri-answer', { text: '正确：' + (q ? humanAnswer(q, w.correctAnswer) : '') }));
      list.appendChild(item);
    });
  }
  function humanDisplay(w) {
    if (w.type === 'order') return (Array.isArray(w.userAnswer) ? w.userAnswer : []).join(' ');
    if (w.type === 'choice') {
      const ch = getChapter(w.chapterId);
      const q = ch && (ch.quiz.concat(ch.exam)).find(x => x.id === w.qid);
      return q ? q.options[w.userAnswer] : w.userAnswer;
    }
    return w.userAnswer;
  }

  function renderReview() {
    renderReviewWrong();
    renderReviewSpaced();
  }
  function renderReviewSpaced() {
    const list = $('#spaced-list'); if (!list) return;
    list.innerHTML = '';
    const due = App.state.wrong; // 简化：错题即待复习
    if (!due.length) {
      list.appendChild(el('div', 'empty-state', { text: '没有需要复习的内容' }));
      return;
    }
    due.slice(-5).forEach(w => {
      const item = el('div', 'review-item');
      item.appendChild(el('div', 'ri-type', { text: w.type }));
      item.appendChild(el('div', 'ri-prompt', { text: w.prompt }));
      list.appendChild(item);
    });
  }
  App.renderReview = renderReview;

  /* =========================================================
     13. 视频页
     ========================================================= */
  function renderVideoList() {
    const list = $('#video-list'); if (!list) return;
    list.innerHTML = '';
    // 第一章视频
    const ch = getChapter('ch1');
    if (ch && ch.video) {
      const card = el('div', 'video-card');
      card.appendChild(el('div', 'video-thumb', { text: ch.video.poster || '🎬' }));
      const meta = el('div', 'video-meta');
      meta.appendChild(el('div', 'video-title', { text: ch.video.title }));
      meta.appendChild(el('div', 'video-desc', { text: '内置字幕 · 点击英文单词查释义' }));
      card.appendChild(meta);
      tapCard(card, () => openVideoPlayer(ch));
      list.appendChild(card);
    }
    // 加载本地视频（.vtt 双字幕）
    const localCard = el('div', 'video-card');
    localCard.appendChild(el('div', 'video-thumb', { text: '📁' }));
    const meta2 = el('div', 'video-meta');
    meta2.appendChild(el('div', 'video-title', { text: '加载本地视频' }));
    meta2.appendChild(el('div', 'video-desc', { text: '选择视频与 .vtt 字幕文件' }));
    localCard.appendChild(meta2);
    localCard.addEventListener('click', () => $('#local-video-input').click());
    list.appendChild(localCard);
    // 隐藏的文件输入
    let inp = $('#local-video-input');
    if (!inp) {
      inp = el('input', null, { type: 'file', id: 'local-video-input', accept: 'video/*' });
      inp.style.display = 'none';
      inp.addEventListener('change', e => loadLocalVideo(e.target.files[0]));
      document.body.appendChild(inp);
    }
  }
  App.renderVideoList = renderVideoList;

  let simPlayerTimer = null;
  function openVideoPlayer(ch) {
    const player = $('#video-player'); player.hidden = false;
    const wrap = $('#vp-wrap'); wrap.innerHTML = '';
    const poster = el('div', 'sim-poster', {
      style: 'height:200px;display:flex;align-items:center;justify-content:center;font-size:60px;background:linear-gradient(135deg,#46A302,#89E14B);',
      text: ch.video.poster || '🎬'
    });
    const play = el('button', 'btn btn-secondary btn-block', { text: '▶ 播放', style: 'margin-top:8px;' });
    let idx = -1, playing = false;
    function tick() {
      idx++;
      if (idx >= ch.video.cues.length) { clearInterval(simPlayerTimer); simPlayerTimer = null; playing = false; play.textContent = '▶ 重播'; return; }
      setVpSubtitle(ch, idx);
    }
    play.onclick = () => {
      if (simPlayerTimer) { clearInterval(simPlayerTimer); simPlayerTimer = null; playing = false; play.textContent = '▶ 继续'; return; }
      if (idx >= ch.video.cues.length - 1) idx = -1;
      playing = true; play.textContent = '⏸ 暂停';
      simPlayerTimer = setInterval(tick, 3000);
      tick();
    };
    wrap.appendChild(poster); wrap.appendChild(play);
    setVpSubtitle(ch, 0);
    // 视频页跟读按钮：展开 #vp-shadow-panel 跑跟读
    const vpShadow = $('#vp-shadow');
    if (vpShadow) vpShadow.onclick = () => {
      if (!ch.video || !ch.video.cues) { toast('该视频无字幕可跟读'); return; }
      startShadowing(ch.video.cues, $('#vp-shadow-panel'));
    };
    const vpShadowClose = $('#vp-shadow-close');
    if (vpShadowClose) vpShadowClose.onclick = () => {
      const p = $('#vp-shadow-panel'); if (p) p.hidden = true;
    };
  }
  function setVpSubtitle(ch, idx) {
    const sub = $('#vp-subtitle'); if (!sub) return;
    const cue = ch.video.cues[idx];
    // 同步当前 cue 索引给跟读面板使用
    App.learn.shadowIdx = idx;
    sub.innerHTML = '';
    if (!cue) { sub.appendChild(el('div', 'subtitle-en', { text: '（结束）' })); return; }
    const en = el('div', 'subtitle-en');
    cue.en.split(/(\s+)/).forEach(tok => {
      if (/^\s+$/.test(tok)) { en.appendChild(document.createTextNode(tok)); return; }
      const span = el('span', 'word', { text: tok });
      span.onclick = () => {
        const key = tok.toLowerCase().replace(/[^a-z']/g, '');
        const def = (window.ENG_DATA.GLOSSARY || {})[key];
        App.showWordPopup(tok, def);
      };
      en.appendChild(span);
    });
    sub.appendChild(en);
    sub.appendChild(el('div', 'subtitle-zh', { text: cue.zh }));
  }

  function loadLocalVideo(file) {
    if (!file) return;
    const player = $('#video-player'); player.hidden = false;
    const wrap = $('#vp-wrap'); wrap.innerHTML = '';
    const url = URL.createObjectURL(file);
    const video = el('video', null, { controls: '', playsinline: '' });
    video.src = url;
    video.style.width = '100%';
    wrap.appendChild(video);
    const sub = $('#vp-subtitle'); sub.innerHTML = '';
    sub.appendChild(el('div', 'subtitle-en', { text: '可点击下方"加载字幕"选择 .vtt 文件' }));
    // 加载字幕按钮
    let vttInput = $('#local-vtt-input');
    if (!vttInput) {
      vttInput = el('input', null, { type: 'file', id: 'local-vtt-input', accept: '.vtt,text/vtt' });
      vttInput.style.display = 'none';
      vttInput.addEventListener('change', e => {
        const f = e.target.files[0]; if (!f) return;
        const track = document.createElement('track');
        track.kind = 'subtitles'; track.label = '双语'; track.srclang = 'en'; track.default = '';
        track.src = URL.createObjectURL(f);
        video.appendChild(track);
        toast('字幕已加载');
      });
      document.body.appendChild(vttInput);
    }
    const loadBtn = el('button', 'btn btn-secondary', { text: '📄 加载 .vtt 字幕', onclick: () => vttInput.click() });
    wrap.appendChild(loadBtn);
    // 跟读模式
    const shadow = $('#vp-shadow');
    shadow.onclick = () => {
      const t = video.textTracks && video.textTracks[0];
      if (!t || !t.activeCues || !t.activeCues.length) { toast('请先加载字幕并播放'); return; }
      App.speak(t.activeCues[0].text);
    };
    toast('视频已加载');
  }

  /* =========================================================
     14. 我的页
     ========================================================= */
  function renderProfile() {
    const s = App.state;
    const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    set('#profile-xp', s.xp);
    set('#profile-streak', s.streak);
    set('#profile-chapters', Object.keys(s.completed).length);
    // 徽章墙
    const wall = $('#badge-wall'); if (wall) {
      wall.innerHTML = '';
      const badges = (window.ENG_DATA && window.ENG_DATA.BADGES) || [];
      badges.forEach(b => {
        const earned = s.badges.includes(b.id);
        const item = el('div', 'badge' + (earned ? ' earned' : ''));
        item.appendChild(el('div', null, { text: b.emoji }));
        item.appendChild(el('div', 'badge-name', { text: b.name }));
        item.title = b.desc;
        wall.appendChild(item);
      });
    }
  }
  App.renderProfile = renderProfile;

  /* =========================================================
     15. 底部导航与全局事件
     ========================================================= */
  function bindNav() {
    $$('.nav-btn').forEach(b => tap(b, () => {
      // 离开学习页：停掉视频与学习计时器
      if (App.currentView === 'learn') {
        stopVideo(App.learn.chapter);
        stopStudyTimer();
      }
      switchView(b.dataset.view);
    }));
    // 复习标签切换
    $$('[data-review-tab]').forEach(t => tap(t, () => {
      $$('[data-review-tab]').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const tab = t.dataset.reviewTab;
      $('#review-wrong').classList.toggle('active', tab === 'wrong');
      $('#review-spaced').classList.toggle('active', tab === 'spaced');
    }));
    // 重做全部错题
    const redo = $('#wrong-redo'); if (redo) tap(redo, () => {
      if (!App.state.wrong.length) { toast('暂无错题'); return; }
      App.state.wrong = []; saveState(App.state); renderReview(); toast('错题已清空，请到学习页重新练习');
    });
    // 重置进度
    const reset = $('#reset-progress'); if (reset) tap(reset, () => {
      if (!confirm('确定重置全部进度？此操作不可撤销。')) return;
      App.state = defaultState(); saveState(App.state);
      renderHeader(); renderPathMap(); renderReview(); renderProfile();
      toast('进度已重置');
    });
  }

  /* =========================================================
     15.5 设置页：Gemini API Key 录入与测试
     ========================================================= */
  function bindSettings() {
    const input = $('#gemini-api-key');
    const save = $('#gemini-save');
    const test = $('#gemini-test');
    const status = $('#gemini-status');
    if (input) input.value = getApiKey();
    if (save) tap(save, () => {
      const v = input ? input.value : '';
      setApiKey(v);
      toast(v ? '✅ API Key 已保存' : '已清空 API Key');
      if (status) { status.textContent = v ? '已保存（角色扮演将使用 AI 模式）' : '未设置（角色扮演回退到预设对话树）'; }
    });
    if (test) tap(test, async () => {
      const v = input ? input.value.trim() : '';
      if (!v) { if (status) status.textContent = '❌ 请先填写 API Key'; return; }
      if (status) status.textContent = '⏳ 正在测试连接…';
      test.disabled = true;
      try {
        const r = await testApiKey(v);
        if (status) status.textContent = (r.ok ? '✅ ' : '❌ ') + r.msg;
      } finally {
        test.disabled = false;
      }
    });
  }
  App.bindSettings = bindSettings;

  /* =========================================================
     16. 初始化
     ========================================================= */
  function init() {
    App.state = loadState();
    // 注意 v2：不再在 init 自动打卡；改为用户进入学习页累计满 10 分钟后自动打卡
    awardBadges(App.state);
    saveState(App.state);
    renderHeader();
    renderPathMap();
    renderReview();
    renderVideoList();
    renderProfile();
    bindNav();
    bindLearn();
    bindWordPopup();
    bindSettings();
    // 不支持语音合成时隐藏朗读按钮
    hideSpeakButtonsIfUnsupported();
    // PWA：注册 Service Worker（失败静默，不影响本地运行）
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js').catch(() => {});
    }
  }
  App.init = init;

  // DOM 就绪后自动初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
