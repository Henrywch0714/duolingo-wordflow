(() => {
  "use strict";

  const INTERVALS = [1, 2, 4, 7, 15, 30];
  const DB_NAME = "wordflow-progress";
  const DB_STORE = "data";
  const STATE_KEY = "state";
  const FALLBACK_KEY = "wordflow-state-v1";
  const SYNC_API = location.hostname.endsWith("vercel.app") ? "/api/sync" : "https://duolingo-wordflow.vercel.app/api/sync";
  const SYNC_KEY_STORE = "wordflow-sync-key";
  const SYNC_REV_STORE = "wordflow-sync-revision";
  const SYNC_DIRTY_STORE = "wordflow-sync-dirty";
  const byId = (id) => document.getElementById(id);

  let words = [];
  let wordMap = new Map();
  let deckIndex = new Map();
  let state = defaultState();
  let currentWord = null;
  let currentKind = "new";
  let revealed = false;
  let undoSnapshot = null;
  let practiceQueue = [];
  let practiceIndex = 0;
  let practiceRevealed = false;
  let answeringToday = false;
  let answeringPractice = false;
  let db = null;
  let toastTimer = null;
  let selectedUnit = 1;
  let selectedList = 1;
  let catalogPage = 0;
  let syncKey = "";
  let syncRevision = 0;
  let syncDirty = false;
  let syncBusy = false;
  let syncConflict = false;
  let syncTimer = null;
  let pendingCloud = null;
  let applyingCloud = false;

  function defaultState() {
    return {
      version: 1,
      dailyGoal: 20,
      deckOrder: [],
      difficultyFilter: "全部",
      polarityFilter: "全部",
      progress: {},
      history: {}
    };
  }

  function todayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function addDays(key, count) {
    const [year, month, day] = key.split("-").map(Number);
    const date = new Date(year, month - 1, day, 12);
    date.setDate(date.getDate() + count);
    return todayKey(date);
  }

  function getTodayAnswers() {
    const key = todayKey();
    if (!state.history[key] || typeof state.history[key] !== "object") {
      state.history[key] = { answers: {} };
    }
    if (!state.history[key].answers || typeof state.history[key].answers !== "object") {
      state.history[key].answers = {};
    }
    return state.history[key].answers;
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("IndexedDB unavailable"));
        return;
      }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(DB_STORE)) database.createObjectStore(DB_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function idbRead() {
    return new Promise((resolve, reject) => {
      const request = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(STATE_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function idbWrite(value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(value, STATE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  function normalizeState(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return defaultState();
    const base = defaultState();
    const goal = Number(input.dailyGoal);
    base.dailyGoal = Number.isInteger(goal) && goal >= 1 && goal <= 3590 ? Math.ceil(goal / 10) * 10 : 20;
    if (Array.isArray(input.deckOrder)) base.deckOrder = input.deckOrder;
    base.difficultyFilter = ["全部", "易", "中", "难"].includes(input.difficultyFilter) ? input.difficultyFilter : "全部";
    base.polarityFilter = ["全部", "正向", "负面", "中性"].includes(input.polarityFilter) ? input.polarityFilter : "全部";
    if (input.progress && typeof input.progress === "object" && !Array.isArray(input.progress)) base.progress = input.progress;
    if (input.history && typeof input.history === "object" && !Array.isArray(input.history)) base.history = input.history;
    return base;
  }

  async function loadState() {
    try {
      db = await openDB();
      const saved = await idbRead();
      if (saved) return normalizeState(saved);
    } catch (error) {
      db = null;
      console.warn("IndexedDB unavailable; using localStorage.", error);
    }
    try {
      const saved = localStorage.getItem(FALLBACK_KEY);
      return saved ? normalizeState(JSON.parse(saved)) : defaultState();
    } catch (error) {
      console.warn("Saved progress could not be loaded.", error);
      return defaultState();
    }
  }

  async function saveState() {
    try {
      if (db) await idbWrite(state);
      else localStorage.setItem(FALLBACK_KEY, JSON.stringify(state));
      if (syncKey && !applyingCloud) {
        syncDirty = true;
        localStorage.setItem(SYNC_DIRTY_STORE, "1");
        queueSync();
      }
    } catch (error) {
      console.error("Could not save progress.", error);
      showToast("进度保存失败，请导出备份并检查浏览器存储空间");
    }
  }

  function syncStatus(message, connected = Boolean(syncKey)) {
    byId("sync-status").textContent = message;
    byId("sync-pill").innerHTML = `<span class="status-dot"></span> ${connected ? "云端已连接" : "进度存于此设备"}`;
    byId("sync-now").hidden = !connected;
    byId("sync-disconnect").hidden = !connected;
    byId("sync-connect").hidden = connected;
    byId("sync-key").hidden = connected;
  }

  async function syncRequest(method, payload) {
    const response = await fetch(SYNC_API, {
      method,
      headers: { Authorization: `Bearer ${syncKey}`, ...(payload ? { "Content-Type": "application/json" } : {}) },
      body: payload ? JSON.stringify(payload) : undefined,
      cache: "no-store"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function hasStudyData(value) {
    return Object.keys(value.progress || {}).length > 0 || Object.values(value.history || {}).some((day) => Object.keys(day?.answers || {}).length > 0);
  }

  function renderAll() {
    byId("difficulty-filter").value = state.difficultyFilter;
    byId("polarity-filter").value = state.polarityFilter;
    populateCatalogControls();
    renderToday();
    renderCatalog();
    renderMistakes();
  }

  async function useCloud(record) {
    applyingCloud = true;
    try {
      state = normalizeState(record.state);
      ensureDeckOrder();
      await saveState();
    } finally {
      applyingCloud = false;
    }
    syncRevision = record.revision;
    localStorage.setItem(SYNC_REV_STORE, String(syncRevision));
    localStorage.removeItem(SYNC_DIRTY_STORE);
    syncDirty = false;
    syncConflict = false;
    pendingCloud = null;
    byId("sync-choice").hidden = true;
    renderAll();
    syncStatus(`已从云端更新 · 版本 ${syncRevision}`);
  }

  function showSyncChoice(record) {
    pendingCloud = record;
    syncConflict = true;
    byId("sync-choice").hidden = false;
    syncStatus("本机和云端进度不同，请选择要保留的一份。");
    switchTab("settings");
  }

  async function pushSync() {
    if (!syncKey || syncBusy || syncConflict) return;
    syncBusy = true;
    let saved = false;
    syncStatus("正在保存到云端…");
    try {
      const snapshot = JSON.stringify(state);
      const result = await syncRequest("PUT", { revision: syncRevision, state: JSON.parse(snapshot) });
      saved = true;
      syncRevision = result.revision;
      localStorage.setItem(SYNC_REV_STORE, String(syncRevision));
      if (JSON.stringify(state) === snapshot) {
        syncDirty = false;
        localStorage.removeItem(SYNC_DIRTY_STORE);
      }
      syncStatus(`已同步到云端 · 版本 ${syncRevision}`);
    } catch (error) {
      if (error.status === 409) {
        try { showSyncChoice(await syncRequest("GET")); }
        catch { syncStatus("云端版本发生冲突，稍后点“立即同步”重试。"); }
      } else {
        if (error.status === 401) syncConflict = true;
        syncStatus(error.status === 401 ? "同步口令错误，请断开后重新连接。" : "云端暂不可用，本机进度已保存；稍后点“立即同步”重试。");
      }
    } finally {
      syncBusy = false;
      if (saved && syncDirty && !syncConflict) queueSync(700);
    }
  }

  function queueSync(delay = 700) {
    clearTimeout(syncTimer);
    if (syncKey && !syncConflict) syncTimer = setTimeout(pushSync, delay);
  }

  async function connectSync(saved = false) {
    const entered = saved ? localStorage.getItem(SYNC_KEY_STORE) : byId("sync-key").value.trim();
    if (!entered || entered.length < 8) {
      showToast("请输入同步口令");
      return;
    }
    const oldKey = localStorage.getItem(SYNC_KEY_STORE);
    syncKey = entered;
    if (oldKey !== entered) {
      syncRevision = 0;
      syncDirty = false;
      localStorage.removeItem(SYNC_REV_STORE);
      localStorage.removeItem(SYNC_DIRTY_STORE);
    }
    syncStatus("正在连接云端…");
    try {
      const record = await syncRequest("GET");
      localStorage.setItem(SYNC_KEY_STORE, syncKey);
      byId("sync-key").value = "";
      if (!record.state) {
        syncRevision = 0;
        syncConflict = false;
        await pushSync();
      } else if (!hasStudyData(state)) {
        await useCloud(record);
      } else if (syncRevision === record.revision && !syncDirty) {
        syncStatus(`已连接云端 · 版本 ${syncRevision}`);
      } else if (syncRevision > 0 && !syncDirty) {
        await useCloud(record);
      } else {
        showSyncChoice(record);
      }
    } catch (error) {
      if (!saved) {
        syncKey = "";
        syncStatus(error.status === 401 ? "口令错误，请检查后重试。" : "云端暂不可用，请稍后重试。", false);
      } else {
        syncStatus("云端暂不可用，本机进度仍可使用。");
      }
    }
  }

  function ensureDeckOrder() {
    const valid = Array.isArray(state.deckOrder) &&
      state.deckOrder.length === words.length &&
      new Set(state.deckOrder).size === words.length &&
      state.deckOrder.every((word) => wordMap.has(word));
    if (!valid) {
      state.deckOrder = words.map((item) => item.word);
      for (let index = state.deckOrder.length - 1; index > 0; index--) {
        const random = Math.floor(Math.random() * (index + 1));
        [state.deckOrder[index], state.deckOrder[random]] = [state.deckOrder[random], state.deckOrder[index]];
      }
    }
    deckIndex = new Map(state.deckOrder.map((word, index) => [word, index]));
    return !valid;
  }

  function wordLocation(word) {
    const position = deckIndex.get(word) ?? 0;
    const listNumber = Math.floor(position / 10);
    return {
      unit: Math.floor(listNumber / 10) + 1,
      list: listNumber % 10 + 1,
      card: position % 10 + 1
    };
  }

  function showToast(message) {
    const toast = byId("toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
  }

  function dueWords() {
    const today = todayKey();
    const answered = getTodayAnswers();
    return words.filter((item) => {
      const progress = state.progress[item.word];
      return progress && progress.dueDate && progress.dueDate <= today && !answered[item.word];
    }).sort((a, b) => {
      const pa = state.progress[a.word];
      const pb = state.progress[b.word];
      return pa.dueDate.localeCompare(pb.dueDate) || (pb.wrongCount || 0) - (pa.wrongCount || 0) || a.word.localeCompare(b.word);
    });
  }

  function newWords() {
    const answered = getTodayAnswers();
    return words.filter((item) => {
      if (state.progress[item.word] || answered[item.word]) return false;
      if (state.difficultyFilter !== "全部" && item.difficulty !== state.difficultyFilter) return false;
      if (state.polarityFilter !== "全部" && item.polarity !== state.polarityFilter) return false;
      return true;
    }).sort((a, b) => deckIndex.get(a.word) - deckIndex.get(b.word));
  }

  function pickNext() {
    if (Object.keys(getTodayAnswers()).length >= state.dailyGoal) return null;
    const due = dueWords();
    if (due.length) {
      const item = due[0];
      const kind = state.progress[item.word].dueDate < todayKey() ? "overdue" : "review";
      return { item, kind };
    }
    const fresh = newWords();
    return fresh.length ? { item: fresh[0], kind: "new" } : null;
  }

  function renderOverview() {
    const done = Object.keys(getTodayAnswers()).length;
    const goal = state.dailyGoal;
    const percent = Math.min(100, Math.round(done / goal * 100));
    const wrong = Object.values(state.progress).filter((entry) => Number(entry?.wrongCount) > 0).length;
    byId("done-count").textContent = done;
    byId("goal-display").textContent = `${goal / 10} list · ${goal} 张`;
    byId("progress-percent").textContent = `${percent}%`;
    byId("progress-fill").style.width = `${percent}%`;
    byId("progress-track").setAttribute("aria-valuenow", String(percent));
    byId("due-count").textContent = dueWords().length;
    byId("new-count").textContent = words.filter((item) => !state.progress[item.word]).length;
    byId("wrong-count").textContent = wrong;
    byId("mistake-tab-count").textContent = wrong;
    byId("today-label").textContent = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date());
    byId("queue-note").textContent = `待复习 ${dueWords().length} · 还可学 ${Math.max(0, goal - done)}`;
    byId("goal-input").value = goal / 10;
    renderPlan();
  }

  function renderPlan() {
    const today = todayKey();
    const dates = Array.from({ length: 7 }, (_, index) => addDays(today, index));
    const counts = dates.map((date, index) => Object.values(state.progress).filter((entry) => {
      if (!entry?.dueDate) return false;
      return index === 0 ? entry.dueDate <= today : entry.dueDate === date;
    }).length);
    const maximum = Math.max(...counts, 1);
    const list = byId("plan-list");
    list.replaceChildren();
    dates.forEach((date, index) => {
      const day = document.createElement("div");
      day.className = `plan-day ${index === 0 ? "today" : ""}`;
      const count = document.createElement("strong");
      count.textContent = String(counts[index]);
      const track = document.createElement("div");
      track.className = "plan-bar-track";
      const fill = document.createElement("div");
      fill.className = "plan-bar-fill";
      fill.style.height = `${Math.max(8, Math.round(counts[index] / maximum * 100))}%`;
      track.append(fill);
      const label = document.createElement("span");
      label.textContent = index === 0 ? "今天" : `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`;
      day.append(count, track, label);
      list.append(day);
    });
  }

  function renderToday() {
    renderOverview();
    const choice = pickNext();
    currentWord = choice?.item || null;
    currentKind = choice?.kind || "new";
    revealed = false;
    undoSnapshot = null;
    byId("today-card-wrap").hidden = !currentWord;
    byId("today-empty").hidden = Boolean(currentWord);
    if (!currentWord) {
      const goalReached = Object.keys(getTodayAnswers()).length >= state.dailyGoal;
      byId("today-empty-title").textContent = goalReached ? "今天完成啦" : "这个筛选下暂时没有单词";
      byId("today-empty-text").textContent = goalReached
        ? "你已完成今日计划。未完成的到期复习会留到明天，继续按顺序安排。"
        : "可以调整上方的新词筛选条件，或明天再来复习。";
      return;
    }
    byId("today-card").classList.remove("revealed");
    byId("card-kind").className = `card-kind ${currentKind === "new" ? "" : currentKind}`;
    byId("card-kind").textContent = currentKind === "overdue" ? "逾期复习" : currentKind === "review" ? "到期复习" : "今日新词";
    const currentNumber = Object.keys(getTodayAnswers()).length + 1;
    byId("card-index").textContent = `${String(currentNumber).padStart(2, "0")} / ${state.dailyGoal}`;
    const location = wordLocation(currentWord.word);
    byId("card-location").textContent = `UNIT ${String(location.unit).padStart(2, "0")} · LIST ${String(location.list).padStart(2, "0")} · ${String(location.card).padStart(2, "0")}/10`;
    byId("card-prompt").textContent = "先看英文，再选择";
    byId("card-word").textContent = currentWord.word;
    byId("card-difficulty").textContent = `${currentWord.difficulty} · ${currentWord.level}`;
    byId("card-polarity").textContent = currentWord.polarity;
    byId("translation").hidden = true;
    byId("card-gloss").textContent = "";
    byId("card-hint").textContent = "想好了吗？按下你的判断。";
    byId("answer-actions").hidden = false;
    byId("reveal-actions").hidden = true;
  }

  async function recordAnswer(item, answer, source) {
    const today = todayKey();
    const previous = state.progress[item.word] || null;
    const wrongCount = (Number(previous?.wrongCount) || 0) + (answer === "unknown" ? 1 : 0);
    const stage = answer === "known" ? Math.min((Number(previous?.stage ?? -1)) + 1, INTERVALS.length - 1) : -1;
    const days = answer === "known" ? INTERVALS[stage] : 1;
    state.progress[item.word] = {
      wrongCount,
      knownCount: (Number(previous?.knownCount) || 0) + (answer === "known" ? 1 : 0),
      stage,
      dueDate: addDays(today, days),
      lastDate: today,
      lastAnswer: answer
    };
    if (source === "today") getTodayAnswers()[item.word] = answer;
    await saveState();
    return { days, previous };
  }

  async function answerToday(answer) {
    if (!currentWord || revealed || answeringToday) return;
    answeringToday = true;
    byId("known-button").disabled = true;
    byId("unknown-button").disabled = true;
    try {
    const item = currentWord;
    const previous = state.progress[item.word] ? { ...state.progress[item.word] } : null;
    const previousDayAnswer = getTodayAnswers()[item.word];
    undoSnapshot = { word: item.word, previous, previousDayAnswer };
    const result = await recordAnswer(item, answer, "today");
    revealed = true;
    byId("today-card").classList.add("revealed");
    byId("card-prompt").textContent = answer === "known" ? "已经记下你的“认识”" : "已经记下你的“不认识”";
    byId("card-gloss").textContent = item.gloss;
    byId("translation").hidden = false;
    byId("card-hint").textContent = `下次复习：${result.days} 天后`;
    byId("answer-actions").hidden = true;
    byId("reveal-actions").hidden = false;
    renderOverview();
    renderMistakes();
    } finally {
      answeringToday = false;
      byId("known-button").disabled = false;
      byId("unknown-button").disabled = false;
    }
  }

  async function undoAnswer() {
    if (!undoSnapshot || !currentWord || undoSnapshot.word !== currentWord.word) return;
    if (undoSnapshot.previous) state.progress[currentWord.word] = undoSnapshot.previous;
    else delete state.progress[currentWord.word];
    if (undoSnapshot.previousDayAnswer) getTodayAnswers()[currentWord.word] = undoSnapshot.previousDayAnswer;
    else delete getTodayAnswers()[currentWord.word];
    await saveState();
    revealed = false;
    undoSnapshot = null;
    byId("today-card").classList.remove("revealed");
    byId("card-prompt").textContent = "先看英文，再选择";
    byId("translation").hidden = true;
    byId("card-hint").textContent = "想好了吗？按下你的判断。";
    byId("answer-actions").hidden = false;
    byId("reveal-actions").hidden = true;
    renderOverview();
    renderMistakes();
  }

  function switchTab(name) {
    document.querySelectorAll(".tab").forEach((tab) => {
      const active = tab.dataset.tab === name;
      tab.classList.toggle("active", active);
      if (active) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    });
    for (const panel of ["today", "catalog", "mistakes", "settings"]) {
      byId(`${panel}-panel`).classList.toggle("active", panel === name);
    }
    if (name === "mistakes") renderMistakes();
    if (name === "catalog") renderCatalog();
    if (name === "today" && !revealed) renderToday();
  }

  function populateCatalogControls() {
    const unitSelect = byId("unit-select");
    unitSelect.replaceChildren();
    const totalUnits = Math.ceil(words.length / 100);
    for (let number = 1; number <= totalUnits; number++) {
      const option = document.createElement("option");
      option.value = String(number);
      option.textContent = `Unit ${number}`;
      unitSelect.append(option);
    }
    unitSelect.value = String(selectedUnit);
    populateListOptions();
  }

  function populateListOptions() {
    const listSelect = byId("list-select");
    listSelect.replaceChildren();
    const listsInUnit = Math.min(10, Math.ceil((words.length - (selectedUnit - 1) * 100) / 10));
    for (let number = 1; number <= listsInUnit; number++) {
      const option = document.createElement("option");
      option.value = String(number);
      option.textContent = `List ${number}`;
      listSelect.append(option);
    }
    selectedList = Math.min(selectedList, listsInUnit);
    listSelect.value = String(selectedList);
  }

  function renderCatalog() {
    const query = byId("catalog-search").value.trim().toLocaleLowerCase();
    let items;
    let total;
    if (query) {
      const matching = state.deckOrder
        .map((word) => wordMap.get(word))
        .filter((item) => item.word.toLocaleLowerCase().includes(query) || item.gloss.includes(query));
      total = matching.length;
      catalogPage = Math.min(catalogPage, Math.max(0, Math.ceil(total / 10) - 1));
      items = matching.slice(catalogPage * 10, catalogPage * 10 + 10);
      byId("catalog-title").textContent = "搜索结果";
      byId("catalog-count").textContent = `${total} 词`;
      byId("catalog-pagination").hidden = total <= 10;
      byId("catalog-page").textContent = `${catalogPage + 1} / ${Math.max(1, Math.ceil(total / 10))}`;
      byId("catalog-prev").disabled = catalogPage === 0;
      byId("catalog-next").disabled = (catalogPage + 1) * 10 >= total;
    } else {
      const start = (selectedUnit - 1) * 100 + (selectedList - 1) * 10;
      items = state.deckOrder.slice(start, start + 10).map((word) => wordMap.get(word));
      total = items.length;
      byId("catalog-title").textContent = `Unit ${selectedUnit} · List ${selectedList}`;
      byId("catalog-count").textContent = `${total} 词`;
      byId("catalog-pagination").hidden = true;
    }
    const list = byId("catalog-list");
    list.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "list-empty";
      empty.textContent = "没有找到匹配的单词。";
      list.append(empty);
      return;
    }
    for (const item of items) {
      const entry = state.progress[item.word] || {};
      const count = (Number(entry.knownCount) || 0) + (Number(entry.wrongCount) || 0);
      const location = wordLocation(item.word);
      const row = document.createElement("article");
      row.className = "catalog-item";
      const main = document.createElement("div");
      main.className = "catalog-item-main";
      const word = document.createElement("strong");
      word.textContent = item.word;
      const gloss = document.createElement("p");
      gloss.textContent = item.gloss;
      const detail = document.createElement("small");
      detail.textContent = `Unit ${location.unit} · List ${location.list} · ${item.difficulty}/${item.level} · ${item.polarity}`;
      main.append(word, gloss, detail);
      const stats = document.createElement("div");
      stats.className = "catalog-stats";
      const studied = document.createElement("b");
      studied.textContent = `${count} 次`;
      const wrong = document.createElement("span");
      wrong.textContent = `不认识 ${Number(entry.wrongCount) || 0} 次`;
      stats.append(studied, wrong);
      row.append(main, stats);
      list.append(row);
    }
  }

  function sortedMistakes() {
    return words.filter((item) => Number(state.progress[item.word]?.wrongCount) > 0)
      .sort((a, b) => state.progress[b.word].wrongCount - state.progress[a.word].wrongCount || a.word.localeCompare(b.word));
  }

  function renderMistakes() {
    const mistakes = sortedMistakes();
    const query = byId("mistake-search").value.trim().toLocaleLowerCase();
    const filtered = query
      ? mistakes.filter((item) => item.word.toLocaleLowerCase().includes(query) || item.gloss.includes(query))
      : mistakes;
    byId("mistake-summary").textContent = `${mistakes.length} 个单词`;
    byId("practice-mistakes").disabled = mistakes.length === 0;
    byId("mistake-empty").hidden = filtered.length > 0;
    byId("mistake-empty").textContent = query ? "没有找到匹配的错词。" : "错题本还是空的，继续保持。";
    const list = byId("mistake-list");
    list.replaceChildren();
    for (const item of filtered) {
      const row = document.createElement("article");
      row.className = "mistake-item";
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      const gloss = document.createElement("p");
      const count = document.createElement("span");
      title.textContent = item.word;
      gloss.textContent = item.gloss;
      count.className = "mistake-count";
      count.textContent = `不认识 ${state.progress[item.word].wrongCount} 次`;
      copy.append(title, gloss);
      row.append(copy, count);
      list.append(row);
    }
  }

  function renderPractice() {
    const item = practiceQueue[practiceIndex];
    if (!item) {
      byId("mistake-practice").hidden = true;
      showToast("本轮错题复习完成");
      renderMistakes();
      return;
    }
    practiceRevealed = false;
    byId("mistake-practice").hidden = false;
    byId("practice-word").textContent = item.word;
    byId("practice-gloss").hidden = true;
    byId("practice-gloss").textContent = item.gloss;
    byId("practice-actions").hidden = false;
    byId("practice-next").hidden = true;
  }

  async function answerPractice(answer) {
    const item = practiceQueue[practiceIndex];
    if (!item || practiceRevealed || answeringPractice) return;
    answeringPractice = true;
    byId("practice-known").disabled = true;
    byId("practice-unknown").disabled = true;
    try {
    await recordAnswer(item, answer, "practice");
    practiceRevealed = true;
    byId("practice-gloss").hidden = false;
    byId("practice-actions").hidden = true;
    byId("practice-next").hidden = false;
    renderOverview();
    renderMistakes();
    } finally {
      answeringPractice = false;
      byId("practice-known").disabled = false;
      byId("practice-unknown").disabled = false;
    }
  }

  function exportProgress() {
    const payload = { app: "wordflow", exportedAt: new Date().toISOString(), state };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `词间-进度备份-${todayKey()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("进度备份已导出");
  }

  async function importProgress(file) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed.app !== "wordflow" || !parsed.state || typeof parsed.state !== "object") {
        throw new Error("不是词间进度备份");
      }
      if (!window.confirm("导入会覆盖这台设备当前的学习进度。确定继续吗？")) return;
      state = normalizeState(parsed.state);
      ensureDeckOrder();
      await saveState();
      byId("difficulty-filter").value = state.difficultyFilter;
      byId("polarity-filter").value = state.polarityFilter;
      practiceQueue = [];
      byId("mistake-practice").hidden = true;
      renderToday();
      renderMistakes();
      populateCatalogControls();
      renderCatalog();
      showToast("进度已导入");
    } catch (error) {
      console.error("Import failed.", error);
      showToast("导入失败：文件不是有效的进度备份");
    } finally {
      byId("import-input").value = "";
    }
  }

  function speakWord() {
    if (!currentWord || !("speechSynthesis" in window)) {
      showToast("当前浏览器不支持朗读");
      return;
    }
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(currentWord.word);
    utterance.lang = "en-US";
    utterance.rate = 0.85;
    speechSynthesis.speak(utterance);
  }

  function bindEvents() {
    document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));
    byId("known-button").addEventListener("click", () => answerToday("known"));
    byId("unknown-button").addEventListener("click", () => answerToday("unknown"));
    byId("next-button").addEventListener("click", renderToday);
    byId("undo-button").addEventListener("click", undoAnswer);
    byId("speak-button").addEventListener("click", speakWord);
    byId("difficulty-filter").addEventListener("change", async (event) => {
      state.difficultyFilter = event.target.value;
      await saveState();
      if (!revealed) renderToday();
    });
    byId("polarity-filter").addEventListener("change", async (event) => {
      state.polarityFilter = event.target.value;
      await saveState();
      if (!revealed) renderToday();
    });
    byId("goal-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = Number(byId("goal-input").value);
      if (!Number.isInteger(value) || value < 1 || value > 359) {
        showToast("请输入 1 到 359 之间的 list 数量");
        return;
      }
      state.dailyGoal = value * 10;
      await saveState();
      renderToday();
      showToast(`已设置每天 ${value} list（${value * 10} 张）`);
    });
    byId("unit-select").addEventListener("change", (event) => {
      selectedUnit = Number(event.target.value);
      selectedList = 1;
      populateListOptions();
      renderCatalog();
    });
    byId("list-select").addEventListener("change", (event) => {
      selectedList = Number(event.target.value);
      renderCatalog();
    });
    byId("catalog-search").addEventListener("input", () => {
      catalogPage = 0;
      renderCatalog();
    });
    byId("catalog-prev").addEventListener("click", () => {
      catalogPage = Math.max(0, catalogPage - 1);
      renderCatalog();
    });
    byId("catalog-next").addEventListener("click", () => {
      catalogPage += 1;
      renderCatalog();
    });
    byId("mistake-search").addEventListener("input", renderMistakes);
    byId("practice-mistakes").addEventListener("click", () => {
      practiceQueue = sortedMistakes();
      practiceIndex = 0;
      renderPractice();
      byId("mistake-practice").scrollIntoView({ behavior: "smooth", block: "center" });
    });
    byId("practice-known").addEventListener("click", () => answerPractice("known"));
    byId("practice-unknown").addEventListener("click", () => answerPractice("unknown"));
    byId("practice-next").addEventListener("click", () => {
      practiceIndex += 1;
      renderPractice();
    });
    byId("exit-practice").addEventListener("click", () => {
      practiceQueue = [];
      byId("mistake-practice").hidden = true;
    });
    byId("export-button").addEventListener("click", exportProgress);
    byId("import-input").addEventListener("change", (event) => importProgress(event.target.files?.[0]));
    byId("sync-connect").addEventListener("click", () => connectSync());
    byId("sync-now").addEventListener("click", () => syncDirty ? pushSync() : connectSync(true));
    byId("sync-disconnect").addEventListener("click", () => {
      clearTimeout(syncTimer);
      syncKey = "";
      syncRevision = 0;
      syncDirty = false;
      syncConflict = false;
      pendingCloud = null;
      localStorage.removeItem(SYNC_KEY_STORE);
      localStorage.removeItem(SYNC_REV_STORE);
      localStorage.removeItem(SYNC_DIRTY_STORE);
      byId("sync-choice").hidden = true;
      syncStatus("已断开云端连接，进度仍保存在本机。", false);
    });
    byId("sync-use-cloud").addEventListener("click", async () => {
      if (pendingCloud) await useCloud(pendingCloud);
    });
    byId("sync-use-local").addEventListener("click", async () => {
      if (!pendingCloud) return;
      syncRevision = pendingCloud.revision;
      localStorage.setItem(SYNC_REV_STORE, String(syncRevision));
      syncConflict = false;
      pendingCloud = null;
      byId("sync-choice").hidden = true;
      syncDirty = true;
      localStorage.setItem(SYNC_DIRTY_STORE, "1");
      await pushSync();
    });
  }

  async function init() {
    try {
      const response = await fetch("./words.json");
      if (!response.ok) throw new Error(`词库加载失败：${response.status}`);
      words = await response.json();
      if (!Array.isArray(words) || words.length !== 3590 || words.some((item) => !item.word || !item.gloss)) {
        throw new Error("词库格式不完整");
      }
      wordMap = new Map(words.map((item) => [item.word, item]));
      if (wordMap.size !== words.length) throw new Error("词库中存在重复单词");
      state = await loadState();
      const newDeck = ensureDeckOrder();
      if (newDeck) await saveState();
      byId("difficulty-filter").value = state.difficultyFilter;
      byId("polarity-filter").value = state.polarityFilter;
      populateCatalogControls();
      bindEvents();
      renderToday();
      renderCatalog();
      renderMistakes();
      syncRevision = Number(localStorage.getItem(SYNC_REV_STORE)) || 0;
      syncDirty = localStorage.getItem(SYNC_DIRTY_STORE) === "1";
      if (localStorage.getItem(SYNC_KEY_STORE)) connectSync(true);
      else syncStatus("尚未连接云端，进度保存在本机。", false);
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Offline cache unavailable.", error));
      }
    } catch (error) {
      console.error(error);
      byId("today-card-wrap").hidden = true;
      byId("today-empty").hidden = false;
      byId("today-empty-title").textContent = "词库暂时无法加载";
      byId("today-empty-text").textContent = "请检查网络后刷新页面。";
      showToast("词库加载失败");
    }
  }

  init();
})();
