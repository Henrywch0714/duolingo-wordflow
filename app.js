(() => {
  "use strict";

  const INTERVALS = [1, 2, 4, 7, 15, 30];
  const DB_NAME = "wordflow-progress";
  const DB_STORE = "data";
  const STATE_KEY = "state";
  const FALLBACK_KEY = "wordflow-state-v2";
  const SYNC_API = "/api/sync";
  const AUTH_API = "/api/auth";
  const LAST_USER_STORE = "wordflow-last-user";
  const SYNC_REV_STORE = "wordflow-sync-revision";
  const SYNC_DIRTY_STORE = "wordflow-sync-dirty";
  const byId = (id) => document.getElementById(id);

  let words = [];
  let synonymMap = {};
  let wordMap = new Map();
  let deckIndex = new Map();
  let activeCount = 0;
  let state = defaultState();
  let currentWord = null;
  let currentKind = "new";
  let revealed = false;
  let undoSnapshot = null;
  let quiz = null;
  let selectedMistakeGroup = "unmastered";
  let selectedFreeLists = new Set();
  let synonymPage = 0;
  let manualWord = null;
  let answeringToday = false;
  let db = null;
  let toastTimer = null;
  let selectedUnit = 1;
  let selectedList = 1;
  let catalogPage = 0;
  let authUser = null;
  let authMode = "login";
  let appBound = false;
  let syncRevision = 0;
  let syncDirty = false;
  let syncBusy = false;
  let syncConflict = false;
  let syncTimer = null;
  let pendingCloud = null;
  let applyingCloud = false;
  let authGeneration = 0;
  let migrationRebuilt = false;
  let feedbackAudioContext = null;
  let selectedStudyLists = new Set();
  let selectedReviewLists = new Set();
  let calendarMonth = todayKey().slice(0, 7);
  let calendarDay = todayKey();
  const TASK_IDLE_MS = 60 * 60 * 1000;

  function userKey(base) {
    return `${base}:${authUser.id}`;
  }

  function defaultState() {
    return {
      version: 3,
      dailyGoal: 20,
      deckOrder: [],
      preferredDifficulties: ["易", "中", "难"],
      orderSignature: "",
      progress: {},
      history: {},
      taskSessions: [],
      activeTask: null
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
    if (!Array.isArray(state.history[key].newWords)) state.history[key].newWords = [];
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
      const request = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(userKey(STATE_KEY));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function idbWrite(value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(value, userKey(STATE_KEY));
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
    const preferences = Array.isArray(input.preferredDifficulties)
      ? input.preferredDifficulties.filter((value) => ["易", "中", "难"].includes(value))
      : ["易", "中", "难"].includes(input.difficultyFilter) ? [input.difficultyFilter] : ["易", "中", "难"];
    base.preferredDifficulties = [...new Set(preferences)].sort();
    if (!base.preferredDifficulties.length) base.preferredDifficulties = ["易", "中", "难"];
    base.orderSignature = typeof input.orderSignature === "string" ? input.orderSignature : "";
    if (input.progress && typeof input.progress === "object" && !Array.isArray(input.progress)) {
      base.progress = Object.fromEntries(Object.entries(input.progress).map(([word, entry]) => [word, {
        ...entry,
        wrongCount: Math.max(0, Number(entry?.wrongCount) || 0),
        knownCount: Math.max(0, Number(entry?.knownCount) || 0),
        reviewCount: Math.max(0, Number(entry?.reviewCount) || 0),
        unmastered: Boolean(entry?.unmastered)
      }]));
    }
    if (input.history && typeof input.history === "object" && !Array.isArray(input.history)) base.history = input.history;
    if (Array.isArray(input.taskSessions)) base.taskSessions = input.taskSessions.filter((entry) =>
      entry && typeof entry === "object" && Array.isArray(entry.selectedWords) && Array.isArray(entry.completedWords) && Array.isArray(entry.listKeys));
    if (input.activeTask && typeof input.activeTask === "object" && Array.isArray(input.activeTask.selectedWords)) {
      base.activeTask = {
        ...input.activeTask,
        completedWords: Array.isArray(input.activeTask.completedWords) ? input.activeTask.completedWords : [],
        listKeys: Array.isArray(input.activeTask.listKeys) ? input.activeTask.listKeys : []
      };
    }
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
      const saved = localStorage.getItem(userKey(FALLBACK_KEY));
      return saved ? normalizeState(JSON.parse(saved)) : defaultState();
    } catch (error) {
      console.warn("Saved progress could not be loaded.", error);
      return defaultState();
    }
  }

  async function saveState() {
    try {
      if (db) await idbWrite(state);
      else localStorage.setItem(userKey(FALLBACK_KEY), JSON.stringify(state));
      if (authUser && !applyingCloud) {
        syncDirty = true;
        localStorage.setItem(userKey(SYNC_DIRTY_STORE), "1");
        queueSync();
      }
    } catch (error) {
      console.error("Could not save progress.", error);
      showToast("进度保存失败，请导出备份并检查浏览器存储空间");
    }
  }

  function syncStatus(message, connected = Boolean(authUser)) {
    byId("sync-status").textContent = message;
    byId("sync-pill").innerHTML = `<span class="status-dot"></span> ${connected ? "已登录" : "离线使用"}`;
  }

  async function syncRequest(method, payload) {
    const response = await fetch(SYNC_API, {
      method,
      headers: payload ? { "Content-Type": "application/json" } : {},
      body: payload ? JSON.stringify(payload) : undefined,
      credentials: "same-origin",
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
    return Object.keys(value.progress || {}).length > 0 ||
      Object.values(value.history || {}).some((day) => Object.keys(day?.answers || {}).length > 0) ||
      (value.taskSessions || []).length > 0 || Boolean(value.activeTask) ||
      value.dailyGoal !== 20 ||
      [...(value.preferredDifficulties || [])].sort().join("|") !== ["易", "中", "难"].sort().join("|");
  }

  function sameLearningData(local, remote) {
    const canonical = (input) => {
      const value = normalizeState(input);
      const ordered = (object) => Object.fromEntries(Object.entries(object || {}).sort(([a], [b]) => a.localeCompare(b)));
      const progress = ordered(Object.fromEntries(Object.entries(value.progress).map(([word, entry]) => [word, ordered(entry)])));
      const history = ordered(Object.fromEntries(Object.entries(value.history).map(([day, record]) => [day, {
        answers: ordered(record?.answers),
        newWords: (Array.isArray(record?.newWords) ? [...record.newWords] : []).sort()
      }]).filter(([, record]) => Object.keys(record.answers).length || record.newWords.length)));
      return JSON.stringify({ dailyGoal: value.dailyGoal, preferences: [...value.preferredDifficulties].sort(), progress, history,
        taskSessions: value.taskSessions, activeTask: value.activeTask });
    };
    return canonical(local) === canonical(remote);
  }

  function renderAll() {
    document.querySelectorAll('#difficulty-form input[name="difficulty"]').forEach((input) => {
      input.checked = state.preferredDifficulties.includes(input.value);
    });
    populateCatalogControls();
    renderToday();
    renderCatalog();
    renderMistakes();
    renderFreeLists();
    renderSynonymList();
    renderCalendar();
  }

  async function useCloud(record) {
    const generation = authGeneration;
    let rebuilt = false;
    let expiredTask = false;
    applyingCloud = true;
    try {
      state = normalizeState(record.state);
      rebuilt = ensureDeckOrder();
      quiz = null;
      if (taskTimedOut()) { finishTask("timed_out"); expiredTask = true; }
      else restoreQuiz();
      await saveState();
    } finally {
      if (generation === authGeneration) applyingCloud = false;
    }
    if (generation !== authGeneration) return;
    syncRevision = record.revision;
    localStorage.setItem(userKey(SYNC_REV_STORE), String(syncRevision));
    localStorage.removeItem(userKey(SYNC_DIRTY_STORE));
    syncDirty = false;
    syncConflict = false;
    migrationRebuilt = false;
    pendingCloud = null;
    byId("sync-choice").hidden = true;
    renderAll();
    if (quiz) switchTab("review");
    syncStatus(`已从云端更新 · 版本 ${syncRevision}`);
    if (rebuilt || expiredTask) {
      syncDirty = true;
      localStorage.setItem(userKey(SYNC_DIRTY_STORE), "1");
      queueSync();
    }
  }

  function showSyncChoice(record) {
    pendingCloud = record;
    syncConflict = true;
    byId("sync-choice").hidden = false;
    syncStatus("本机和云端进度不同，请选择要保留的一份。");
    switchTab("settings");
  }

  async function pushSync() {
    if (!authUser || syncBusy || syncConflict) return;
    const generation = authGeneration;
    syncBusy = true;
    let saved = false;
    syncStatus("正在保存到云端…");
    try {
      const snapshot = JSON.stringify(state);
      const result = await syncRequest("PUT", { revision: syncRevision, state: JSON.parse(snapshot) });
      if (generation !== authGeneration) return;
      saved = true;
      syncRevision = result.revision;
      migrationRebuilt = false;
      localStorage.setItem(userKey(SYNC_REV_STORE), String(syncRevision));
      if (JSON.stringify(state) === snapshot) {
        syncDirty = false;
        localStorage.removeItem(userKey(SYNC_DIRTY_STORE));
      }
      syncStatus(`已同步到云端 · 版本 ${syncRevision}`);
    } catch (error) {
      if (generation !== authGeneration) return;
      if (error.status === 409) {
        try {
          const record = await syncRequest("GET");
          if (generation !== authGeneration) return;
          showSyncChoice(record);
        }
        catch {
          if (generation === authGeneration) syncStatus("云端版本发生冲突，稍后点“立即同步”重试。");
        }
      } else {
        if (error.status === 401) showAuth("登录已过期，请重新登录。");
        else syncStatus("云端暂不可用，本机进度已保存；稍后点“立即同步”重试。");
      }
    } finally {
      if (generation === authGeneration) {
        syncBusy = false;
        if (saved && syncDirty && !syncConflict) queueSync(700);
      }
    }
  }

  function queueSync(delay = 700) {
    clearTimeout(syncTimer);
    if (authUser && !syncConflict) syncTimer = setTimeout(pushSync, delay);
  }

  async function connectSync() {
    if (!authUser) return;
    const generation = authGeneration;
    syncStatus("正在连接云端…");
    try {
      const record = await syncRequest("GET");
      if (generation !== authGeneration) return;
      if (record.state && syncDirty && sameLearningData(state, record.state)) {
        await useCloud(record);
        return;
      }
      if (!record.state) {
        syncRevision = 0;
        syncConflict = false;
        await pushSync();
      } else if (syncRevision === record.revision) {
        if (migrationRebuilt && !syncDirty) await useCloud(record);
        else if (!hasStudyData(state)) await useCloud(record);
        else if (syncDirty) await pushSync();
        else syncStatus(`已连接云端 · 版本 ${syncRevision}`);
      } else if (!hasStudyData(state)) {
        await useCloud(record);
      } else if (syncRevision > 0 && !syncDirty) {
        await useCloud(record);
      } else {
        showSyncChoice(record);
      }
    } catch (error) {
      if (generation !== authGeneration) return;
      if (error.status === 401) showAuth("登录已过期，请重新登录。");
      else syncStatus("云端暂不可用，本机进度仍可使用。");
    }
  }

  function ensureDeckOrder() {
    const preferences = new Set(state.preferredDifficulties);
    activeCount = words.filter((item) => preferences.has(item.difficulty)).length;
    const signature = `v3:${[...preferences].sort().join("|")}`;
    const valid = Array.isArray(state.deckOrder) &&
      state.deckOrder.length === words.length &&
      new Set(state.deckOrder).size === words.length &&
      state.deckOrder.every((word) => wordMap.has(word)) &&
      state.orderSignature === signature &&
      state.deckOrder.slice(0, activeCount).every((word) => preferences.has(wordMap.get(word).difficulty));
    if (!valid) {
      const shuffle = (array) => {
        for (let index = array.length - 1; index > 0; index--) {
          const random = Math.floor(Math.random() * (index + 1));
          [array[index], array[random]] = [array[random], array[index]];
        }
        return array;
      };
      const oldOrder = state.deckOrder.length === words.length && new Set(state.deckOrder).size === words.length && state.deckOrder.every((word) => wordMap.has(word))
        ? state.deckOrder : words.map((item) => item.word);
      const learned = oldOrder.filter((word) => wordMap.has(word) && state.progress[word]);
      const unlearned = shuffle(words.map((item) => item.word).filter((word) => !state.progress[word]));
      const preferred = (word) => preferences.has(wordMap.get(word).difficulty);
      state.deckOrder = learned.filter(preferred).concat(unlearned.filter(preferred), learned.filter((word) => !preferred(word)), unlearned.filter((word) => !preferred(word)));
      state.orderSignature = signature;
    }
    deckIndex = new Map(state.deckOrder.map((word, index) => [word, index]));
    return !valid;
  }

  function wordLocation(word) {
    const position = deckIndex.get(word) ?? 0;
    const other = position >= activeCount;
    const listNumber = Math.floor((other ? position - activeCount : position) / 10);
    return {
      other,
      unit: Math.floor(listNumber / 10) + 1,
      list: other ? listNumber + 1 : listNumber % 10 + 1,
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
    return state.deckOrder.slice(0, activeCount).map((word) => wordMap.get(word)).filter((item) => {
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
    return state.deckOrder.slice(0, activeCount).map((word) => wordMap.get(word)).filter((item) => {
      if (state.progress[item.word] || answered[item.word]) return false;
      return true;
    });
  }

  function todayNewPlan() {
    const answers = getTodayAnswers();
    const day = state.history[todayKey()];
    const signature = `${state.orderSignature}:${state.dailyGoal}`;
    const candidates = state.deckOrder.slice(0, activeCount).filter((word) =>
      !state.progress[word] || answers[word] === "known" || answers[word] === "unknown");
    if (day.newPlanSignature !== signature || !Array.isArray(day.newPlanLists)) {
      day.newPlanLists = [...new Set(candidates.map(listKey))].slice(0, state.dailyGoal / 10);
      day.newPlanSignature = signature;
    }
    const assigned = new Set(day.newPlanLists);
    const planned = candidates.filter((word) => assigned.has(listKey(word)));
    const done = planned.filter((word) => answers[word] === "known" || answers[word] === "unknown").length;
    return { words: planned, done };
  }

  function taskTimedOut(task = state.activeTask) {
    return Boolean(task && Date.now() - Date.parse(task.lastActivityAt || task.startedAt) >= TASK_IDLE_MS);
  }

  function finishTask(reason = "ended") {
    const task = state.activeTask;
    if (!task) return;
    const completed = new Set(task.completedWords || []);
    if (completed.size >= task.selectedWords.length) reason = "completed";
    state.taskSessions.push({
      id: task.id, type: task.type, date: task.date, startedAt: task.startedAt,
      endedAt: new Date().toISOString(), reason,
      listKeys: task.listKeys, selectedWords: task.selectedWords,
      completedWords: task.selectedWords.filter((word) => completed.has(word))
    });
    state.activeTask = null;
    void saveState();
    renderCalendar();
  }

  function beginTask(type, items, listKeys) {
    if (!items.length || !listKeys.length) { showToast("请先选择至少一个有任务的 List"); return false; }
    if (state.activeTask) finishTask("ended");
    const now = new Date().toISOString();
    state.activeTask = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      type, date: todayKey(), startedAt: now, lastActivityAt: now,
      listKeys: [...listKeys], selectedWords: items.map((item) => item.word), completedWords: []
    };
    void saveState();
    return true;
  }

  function touchTask() {
    if (state.activeTask) state.activeTask.lastActivityAt = new Date().toISOString();
  }

  function markTaskWord(word) {
    const task = state.activeTask;
    if (!task || !task.selectedWords.includes(word)) return;
    if (!task.completedWords.includes(word)) task.completedWords.push(word);
    touchTask();
  }

  function taskGroups(items) {
    const groups = new Map();
    for (const item of items) {
      const key = listKey(item.word);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return groups;
  }

  function renderTaskPicker(targetId, groups, selected, buttonId, kind) {
    const picker = byId(targetId);
    picker.replaceChildren();
    selected = new Set([...selected].filter((key) => groups.has(key)));
    if (kind === "study") selectedStudyLists = selected;
    else selectedReviewLists = selected;
    for (const [key, items] of groups) {
      const label = document.createElement("label");
      label.className = "task-list-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = key;
      checkbox.checked = selected.has(key);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(key);
        else selected.delete(key);
        byId(buttonId).disabled = selected.size === 0;
      });
      const caption = document.createElement("span");
      caption.innerHTML = `<strong>${listLabel(key)}</strong><small>${items.length} 个${kind === "study" ? "待学" : "待复习"}词</small>`;
      label.append(checkbox, caption);
      picker.append(label);
    }
    if (!groups.size) picker.textContent = kind === "study" ? "今日新词 List 已完成。" : "今天暂无到期复习。";
    byId(buttonId).disabled = selected.size === 0;
  }

  function pickNext() {
    if (manualWord) return { item: manualWord, kind: "other" };
    const task = state.activeTask;
    if (!task || task.type !== "study") return null;
    const next = task.selectedWords.find((word) => !task.completedWords.includes(word));
    return next ? { item: wordMap.get(next), kind: "new" } : null;
  }

  function renderOverview() {
    const plan = todayNewPlan();
    const done = plan.done;
    const goal = plan.words.length;
    const percent = goal ? Math.min(100, Math.round(done / goal * 100)) : 100;
    const due = dueWords().length;
    const wrong = Object.values(state.progress).filter((entry) => Number(entry?.wrongCount) > 0 || entry?.unmastered).length;
    byId("done-count").textContent = done;
    byId("goal-display").textContent = `${state.dailyGoal / 10} list · ${goal} 张`;
    byId("progress-percent").textContent = `${percent}%`;
    byId("progress-fill").style.width = `${percent}%`;
    byId("progress-track").setAttribute("aria-valuenow", String(percent));
    byId("due-count").textContent = due;
    byId("new-count").textContent = newWords().length;
    byId("wrong-count").textContent = wrong;
    byId("mistake-tab-count").textContent = wrong;
    byId("today-label").textContent = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date());
    byId("queue-note").textContent = `待复习 ${due} · 今日新词剩余 ${Math.max(0, goal - done)}`;
    state.history[todayKey()].reviewBacklog = due;
    byId("goal-input").value = state.dailyGoal / 10;
    renderPlan();
  }

  function renderPlan() {
    const today = todayKey();
    const dates = Array.from({ length: 7 }, (_, index) => addDays(today, index));
    const scheduled = state.deckOrder.slice(0, activeCount).map((word) => state.progress[word]).filter(Boolean);
    const counts = dates.map((date, index) => scheduled.filter((entry) => {
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
    if (state.activeTask?.type === "study" && !manualWord &&
        state.activeTask.completedWords.length >= state.activeTask.selectedWords.length) finishTask("completed");
    const task = state.activeTask?.type === "study" ? state.activeTask : null;
    const plan = todayNewPlan();
    const remaining = plan.words.filter((word) => !state.progress[word]).map((word) => wordMap.get(word));
    const groups = taskGroups(remaining);
    byId("study-task-picker").hidden = Boolean(task) || Boolean(manualWord);
    byId("study-task-status").hidden = !task;
    if (!task) renderTaskPicker("study-list-picker", groups, selectedStudyLists, "start-study-task", "study");
    else byId("study-task-status-text").textContent = `${task.listKeys.map(listLabel).join("、")} · 已学 ${task.completedWords.length}/${task.selectedWords.length}`;
    const choice = pickNext();
    currentWord = choice?.item || null;
    currentKind = choice?.kind || "new";
    revealed = false;
    undoSnapshot = null;
    const needsReview = dueWords().length > 0;
    byId("system-review-callout").hidden = !needsReview || Boolean(task) || Boolean(manualWord);
    if (needsReview) byId("system-review-count").textContent = `${dueWords().length} 个单词到期，可按 List 选择复习`;
    byId("today-card-wrap").hidden = !currentWord;
    byId("today-empty").hidden = Boolean(currentWord) || Boolean(remaining.length);
    if (!currentWord) {
      const goalReached = plan.words.length > 0 && plan.done >= plan.words.length;
      byId("today-empty-title").textContent = goalReached ? "今天完成啦" : "偏好词库已经学完";
      byId("today-empty-text").textContent = goalReached
        ? "你已完成今日新词 List。未完成的词和到期复习会继续顺延。"
        : "可以到设置调整难度偏好，或到 Other 手动学习。";
      return;
    }
    byId("today-card").classList.remove("revealed");
    byId("card-kind").className = `card-kind ${currentKind === "new" ? "" : currentKind}`;
    byId("card-kind").textContent = currentKind === "other" ? "Other · 手动学习" : "今日新词";
    byId("card-index").textContent = currentKind === "other" ? "自由学习" : `${String((task?.completedWords.length || 0) + 1).padStart(2, "0")} / ${task?.selectedWords.length || 0}`;
    const location = wordLocation(currentWord.word);
    byId("card-location").textContent = `${location.other ? "OTHER" : `UNIT ${String(location.unit).padStart(2, "0")}`} · LIST ${String(location.list).padStart(2, "0")} · ${String(location.card).padStart(2, "0")}/10`;
    byId("card-prompt").textContent = "先看英文，再选择";
    byId("card-word").textContent = currentWord.word;
    byId("translation").hidden = true;
    byId("card-gloss").textContent = "";
    byId("study-synonyms-button").hidden = true;
    byId("study-synonyms").hidden = true;
    byId("card-hint").textContent = "想好了吗？按下你的判断。";
    byId("answer-actions").hidden = false;
    byId("reveal-actions").hidden = true;
  }

  async function recordLearning(item, answer, source) {
    const today = todayKey();
    const previous = state.progress[item.word] || null;
    const stage = answer === "known" ? 0 : -1;
    state.progress[item.word] = {
      ...previous,
      wrongCount: Number(previous?.wrongCount) || 0,
      knownCount: (Number(previous?.knownCount) || 0) + (answer === "known" ? 1 : 0),
      studyCount: (Number(previous?.studyCount) || 0) + 1,
      unmastered: answer === "unknown",
      stage,
      dueDate: addDays(today, 1),
      lastDate: today,
      lastAnswer: answer
    };
    if (source === "today") getTodayAnswers()[item.word] = answer;
    getTodayAnswers();
    if (!state.history[today].newWords.includes(item.word)) state.history[today].newWords.push(item.word);
    markTaskWord(item.word);
    await saveState();
    return { days: 1, previous };
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
    const wasTodayNew = state.history[todayKey()]?.newWords?.includes(item.word) || false;
    undoSnapshot = { word: item.word, previous, previousDayAnswer, wasTodayNew };
    const result = await recordLearning(item, answer, currentKind === "other" ? "manual" : "today");
    revealed = true;
    byId("today-card").classList.add("revealed");
    byId("card-prompt").textContent = answer === "known" ? "已经记下你的“认识”" : "已经记下你的“不认识”";
    byId("card-gloss").textContent = item.gloss;
    byId("translation").hidden = false;
    byId("study-synonyms-button").hidden = false;
    byId("card-hint").textContent = `下次复习：${result.days} 天后`;
    byId("answer-actions").hidden = true;
    byId("reveal-actions").hidden = false;
    renderOverview();
    if (state.activeTask?.type === "study") {
      const task = state.activeTask;
      byId("study-task-status-text").textContent = `${task.listKeys.map(listLabel).join("、")} · 已学 ${task.completedWords.length}/${task.selectedWords.length}`;
    }
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
    if (undoSnapshot.previousDayAnswer !== undefined) getTodayAnswers()[currentWord.word] = undoSnapshot.previousDayAnswer;
    else delete getTodayAnswers()[currentWord.word];
    if (!undoSnapshot.wasTodayNew) state.history[todayKey()].newWords = state.history[todayKey()].newWords.filter((word) => word !== currentWord.word);
    if (state.activeTask?.type === "study") {
      state.activeTask.completedWords = state.activeTask.completedWords.filter((word) => word !== currentWord.word);
      touchTask();
    }
    await saveState();
    revealed = false;
    undoSnapshot = null;
    byId("today-card").classList.remove("revealed");
    byId("card-prompt").textContent = "先看英文，再选择";
    byId("translation").hidden = true;
    byId("study-synonyms-button").hidden = true;
    byId("study-synonyms").hidden = true;
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
    for (const panel of ["today", "review", "free", "catalog", "mistakes", "synonyms", "calendar", "settings"]) {
      byId(`${panel}-panel`).classList.toggle("active", panel === name);
    }
    byId("app-shell").classList.toggle("focus-mode", name === "today" || name === "review");
    if (name === "mistakes") renderMistakes();
    if (name === "catalog") renderCatalog();
    if (name === "free") renderFreeLists();
    if (name === "synonyms") renderSynonymList();
    if (name === "calendar") renderCalendar();
    if (name === "review") {
      renderQuiz();
    }
    if (name === "today" && !revealed) renderToday();
  }

  function populateCatalogControls() {
    const unitSelect = byId("unit-select");
    unitSelect.replaceChildren();
    const totalUnits = Math.ceil(activeCount / 100);
    for (let number = 1; number <= totalUnits; number++) {
      const option = document.createElement("option");
      option.value = String(number);
      option.textContent = `Unit ${number}`;
      unitSelect.append(option);
    }
    if (activeCount < words.length) {
      const other = document.createElement("option");
      other.value = "other";
      other.textContent = `Other (${words.length - activeCount})`;
      unitSelect.append(other);
    }
    if (selectedUnit === "other" && activeCount === words.length) selectedUnit = 1;
    if (selectedUnit !== "other" && Number(selectedUnit) > totalUnits) selectedUnit = totalUnits || "other";
    unitSelect.value = String(selectedUnit);
    populateListOptions();
  }

  function populateListOptions() {
    const listSelect = byId("list-select");
    listSelect.replaceChildren();
    const listsInUnit = selectedUnit === "other"
      ? Math.ceil((words.length - activeCount) / 10)
      : Math.min(10, Math.ceil((activeCount - (Number(selectedUnit) - 1) * 100) / 10));
    for (let number = 1; number <= listsInUnit; number++) {
      const option = document.createElement("option");
      option.value = String(number);
      option.textContent = `List ${number}`;
      listSelect.append(option);
    }
    selectedList = Math.max(1, Math.min(selectedList, listsInUnit));
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
      const start = (selectedUnit === "other" ? activeCount : (Number(selectedUnit) - 1) * 100) + (selectedList - 1) * 10;
      items = state.deckOrder.slice(start, start + 10).map((word) => wordMap.get(word));
      total = items.length;
      byId("catalog-title").textContent = `${selectedUnit === "other" ? "Other" : `Unit ${selectedUnit}`} · List ${selectedList}`;
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
      const count = (Number(entry.studyCount) || 0) + (Number(entry.reviewCount) || 0);
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
      detail.textContent = `${location.other ? "Other" : `Unit ${location.unit}`} · List ${location.list} · ${item.difficulty}/${item.level} · ${item.polarity}`;
      main.append(word, gloss, detail);
      const stats = document.createElement("div");
      stats.className = "catalog-stats";
      const studied = document.createElement("b");
      studied.textContent = count > 0 ? `${count} 次` : state.progress[item.word] ? "已学 · 旧记录" : "0 次";
      const wrong = document.createElement("span");
      wrong.textContent = entry.unmastered && !entry.wrongCount ? "未掌握" : `复习错 ${Number(entry.wrongCount) || 0} 次`;
      stats.append(studied, wrong);
      if (location.other) {
        const learn = document.createElement("button");
        learn.type = "button";
        learn.className = "catalog-learn";
        learn.textContent = "手动学习";
        learn.addEventListener("click", () => {
          manualWord = item;
          switchTab("today");
          renderToday();
        });
        stats.append(learn);
      }
      row.append(main, stats);
      list.append(row);
    }
  }

  function sortedMistakes() {
    return words.filter((item) => Number(state.progress[item.word]?.wrongCount) > 0 || state.progress[item.word]?.unmastered)
      .sort((a, b) => (Number(state.progress[b.word].wrongCount) || 0) - (Number(state.progress[a.word].wrongCount) || 0) || a.word.localeCompare(b.word));
  }

  function mistakeGroup(item) {
    const count = Number(state.progress[item.word]?.wrongCount) || 0;
    return count > 0 ? `count:${count}` : "unmastered";
  }

  function groupName(key) {
    return key === "unmastered" ? "未掌握" : `复习错 ${key.split(":")[1]} 次`;
  }

  function applyReviewFilters(items, prefix) {
    const difficulty = byId(`${prefix}-difficulty`).value;
    const polarity = byId(`${prefix}-polarity`).value;
    return items.filter((item) =>
      (difficulty === "全部" || item.difficulty === difficulty) &&
      (polarity === "全部" || item.polarity === polarity)
    );
  }

  function renderMistakes() {
    const mistakes = sortedMistakes();
    const query = byId("mistake-search").value.trim().toLocaleLowerCase();
    const keys = ["unmastered", ...[...new Set(mistakes.map(mistakeGroup).filter((key) => key !== "unmastered"))].sort((a, b) => Number(a.split(":")[1]) - Number(b.split(":")[1]))];
    if (!keys.includes(selectedMistakeGroup)) selectedMistakeGroup = "unmastered";
    const filtered = applyReviewFilters(mistakes.filter((item) => mistakeGroup(item) === selectedMistakeGroup), "mistake")
      .filter((item) => !query || item.word.toLocaleLowerCase().includes(query) || item.gloss.includes(query));
    byId("mistake-summary").textContent = `${mistakes.length} 个单词`;
    const groups = byId("mistake-groups");
    groups.replaceChildren();
    for (const key of keys) {
      const count = mistakes.filter((item) => mistakeGroup(item) === key).length;
      const card = document.createElement("div");
      card.className = `mistake-group ${key === selectedMistakeGroup ? "selected" : ""}`;
      const heading = document.createElement("strong");
      heading.textContent = `${groupName(key)} · ${count} 词`;
      const actions = document.createElement("div");
      const view = document.createElement("button");
      view.type = "button";
      view.textContent = "查看";
      view.addEventListener("click", () => { selectedMistakeGroup = key; renderMistakes(); });
      const practice = document.createElement("button");
      practice.type = "button";
      practice.textContent = "复习此列表";
      practice.disabled = !count;
      practice.addEventListener("click", () => {
        selectedMistakeGroup = key;
        const candidates = applyReviewFilters(mistakes.filter((item) => mistakeGroup(item) === key), "mistake");
        const listCount = Math.max(1, Number.parseInt(byId("mistake-quantity").value, 10) || 1);
        const limit = byId("mistake-all").checked ? candidates.length : listCount * 10;
        startQuiz("mistake", candidates.slice(0, limit), "mistakes");
      });
      actions.append(view, practice);
      card.append(heading, actions);
      groups.append(card);
    }
    byId("mistake-list-title").textContent = groupName(selectedMistakeGroup);
    byId("mistake-list-count").textContent = `${filtered.length} 词`;
    byId("mistake-empty").hidden = filtered.length > 0;
    byId("mistake-empty").textContent = query ? "没有找到匹配的错词。" : "这个列表暂时没有单词。";
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
      count.textContent = groupName(mistakeGroup(item));
      copy.append(title, gloss);
      row.append(copy, count);
      list.append(row);
    }
  }

  function shuffleItems(items) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function shuffleQuizQuestions(items) {
    const questions = items.flatMap((item) => [{ item, phase: 0 }, { item, phase: 1 }]);
    if (items.length < 2) return shuffleItems(questions);
    for (let attempt = 0; attempt < 32; attempt++) {
      const shuffled = shuffleItems(questions);
      if (shuffled.every((question, index) => index === 0 || question.item.word !== shuffled[index - 1].item.word)) {
        return shuffled;
      }
    }
    const first = shuffleItems(items);
    const second = shuffleItems(items);
    if (first[first.length - 1].word === second[0].word) [second[0], second[1]] = [second[1], second[0]];
    return [...first.map((item) => ({ item, phase: 0 })), ...second.map((item) => ({ item, phase: 1 }))];
  }

  function playAnswerTone(correct) {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      feedbackAudioContext ||= new AudioContextClass();
      if (feedbackAudioContext.state === "suspended") void feedbackAudioContext.resume().catch(() => {});
      const now = feedbackAudioContext.currentTime;
      const notes = correct ? [523.25, 659.25] : [392, 293.66];
      notes.forEach((frequency, index) => {
        const oscillator = feedbackAudioContext.createOscillator();
        const gain = feedbackAudioContext.createGain();
        const start = now + index * 0.11;
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.055, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
        oscillator.connect(gain).connect(feedbackAudioContext.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.17);
      });
    } catch (error) {
      // Audio is optional; an unavailable or blocked audio device must not interrupt review.
    }
  }

  function startQuiz(mode, items, returnTab) {
    if (!items.length) { showToast("当前条件下没有可复习的单词"); return; }
    const keys = [...new Set(items.map((item) => listKey(item.word)))];
    if (!beginTask(mode, items, keys)) return;
    const quizWords = shuffleItems(items);
    quiz = { mode, words: quizWords, questions: shuffleQuizQuestions(quizWords), index: 0,
      wrongByWord: new Map(), completedByWord: new Map(), answeredQuestions: 0, correctQuestions: 0,
      revealed: false, busy: false, options: null, lastChoice: null, returnTab };
    persistQuiz();
    switchTab("review");
  }

  function persistQuiz() {
    if (!quiz || !state.activeTask || state.activeTask.type === "study") return;
    state.activeTask.quiz = {
      mode: quiz.mode, words: quiz.words.map((item) => item.word),
      questions: quiz.questions.map(({ item, phase }) => ({ word: item.word, phase })),
      index: quiz.index, wrongByWord: [...quiz.wrongByWord], completedByWord: [...quiz.completedByWord],
      answeredQuestions: quiz.answeredQuestions, correctQuestions: quiz.correctQuestions,
      revealed: quiz.revealed, options: quiz.options, lastChoice: quiz.lastChoice, returnTab: quiz.returnTab
    };
    touchTask();
    void saveState();
  }

  function restoreQuiz() {
    const saved = state.activeTask?.quiz;
    if (!saved || !Array.isArray(saved.questions)) return;
    quiz = {
      ...saved, words: saved.words.map((word) => wordMap.get(word)).filter(Boolean),
      questions: saved.questions.map(({ word, phase }) => ({ item: wordMap.get(word), phase })).filter(({ item }) => item),
      wrongByWord: new Map(saved.wrongByWord || []), completedByWord: new Map(saved.completedByWord || []),
      busy: false
    };
  }

  function renderReviewPicker() {
    const active = Boolean(quiz);
    byId("review-task-picker").hidden = active;
    byId("exit-review").hidden = !active;
    if (active) return;
    byId("review-title").textContent = "复习测验";
    const groups = taskGroups(dueWords());
    renderTaskPicker("review-list-picker", groups, selectedReviewLists, "start-review-task", "review");
    byId("review-task-summary").textContent = groups.size
      ? `${groups.size} 个 List、${[...groups.values()].reduce((sum, items) => sum + items.length, 0)} 个到期词；可分多次复习。`
      : "暂无到期词。";
  }

  function makeOptions(item, phase) {
    const correct = phase === 0 ? item.gloss : item.word;
    const choices = [correct];
    const candidates = shuffleItems(words);
    for (const candidate of candidates) {
      const value = phase === 0 ? candidate.gloss : candidate.word;
      if (candidate.word !== item.word && !choices.includes(value)) choices.push(value);
      if (choices.length === 4) break;
    }
    return shuffleItems(choices);
  }

  function renderQuiz() {
    renderReviewPicker();
    const question = quiz?.questions[quiz.index];
    byId("quiz-card").hidden = !question;
    byId("review-empty").hidden = Boolean(question) || !quiz;
    byId("review-progress").hidden = !quiz;
    if (!question) {
      if (quiz && state.activeTask && quiz.index >= quiz.questions.length) finishTask("completed");
      byId("review-empty-title").textContent = quiz ? "本轮复习完成" : "暂无进行中的复习";
      byId("review-empty-text").textContent = quiz
        ? `共完成 ${quiz.words.length} 个词、${quiz.answeredQuestions} 道题，答对 ${quiz.correctQuestions} 道。`
        : "可以从今日单词、自由复习或错题本开始。";
      byId("review-progress-text").textContent = quiz ? "100% 完成" : "尚未开始";
      byId("review-progress-fill").style.width = quiz ? "100%" : "0%";
      return;
    }
    byId("review-title").textContent = quiz.mode === "system" ? "系统复习" : quiz.mode === "mistake" ? "错题专项复习" : "自由复习";
    byId("review-progress-text").textContent = `第 ${quiz.index + 1} / ${quiz.questions.length} 题`;
    byId("review-progress-fill").style.width = `${Math.round(quiz.answeredQuestions / quiz.questions.length * 100)}%`;
    byId("quiz-direction").textContent = question.phase === 0 ? "英译中 · 选出中文释义" : "中译英 · 选出英文单词";
    const location = wordLocation(question.item.word);
    byId("quiz-location").textContent = `${location.other ? "OTHER" : `UNIT ${String(location.unit).padStart(2, "0")}`} · LIST ${String(location.list).padStart(2, "0")}`;
    byId("quiz-prompt").textContent = question.phase === 0 ? question.item.word : question.item.gloss;
    if (!quiz.options) quiz.options = makeOptions(question.item, question.phase);
    const options = byId("quiz-options");
    options.replaceChildren();
    for (const choice of quiz.options) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = choice;
      button.disabled = quiz.revealed;
      button.addEventListener("click", () => answerQuiz(choice));
      if (quiz.revealed) {
        const correct = question.phase === 0 ? question.item.gloss : question.item.word;
        if (choice === correct) button.classList.add("correct");
        else if (choice === quiz.lastChoice) button.classList.add("incorrect");
      }
      options.append(button);
    }
    byId("quiz-forgot").hidden = quiz.revealed;
    byId("quiz-result").hidden = !quiz.revealed;
    byId("quiz-next").hidden = !quiz.revealed;
    if (quiz.revealed) {
      const correct = question.phase === 0 ? question.item.gloss : question.item.word;
      byId("quiz-result-title").textContent = quiz.lastChoice === correct ? "回答正确" : quiz.lastChoice === null ? "已标记不记得" : "回答错误";
      byId("quiz-correct-pair").textContent = `${question.item.word} · ${question.item.gloss}`;
      byId("quiz-next").textContent = quiz.index + 1 < quiz.questions.length ? "下一题 →" : "查看本轮结果 →";
    }
    byId("quiz-synonyms").hidden = true;
  }

  async function recordReview(item, wrong, mode) {
    if (mode === "free") return;
    const today = todayKey();
    const previous = state.progress[item.word] || {};
    const allCorrect = wrong === 0;
    state.progress[item.word] = {
      ...previous,
      wrongCount: (Number(previous.wrongCount) || 0) + wrong,
      knownCount: (Number(previous.knownCount) || 0) + (2 - wrong),
      reviewCount: (Number(previous.reviewCount) || 0) + 1,
      unmastered: false,
      lastDate: today,
      lastAnswer: allCorrect ? "known" : "unknown"
    };
    if (mode === "system") {
      const stage = allCorrect ? Math.min((Number(previous.stage ?? -1)) + 1, INTERVALS.length - 1) : -1;
      state.progress[item.word].stage = stage;
      state.progress[item.word].dueDate = addDays(today, allCorrect ? INTERVALS[stage] : 1);
      getTodayAnswers()[item.word] = allCorrect ? "review-known" : "review-unknown";
    }
    markTaskWord(item.word);
    await saveState();
    renderOverview();
    renderMistakes();
    renderFreeLists();
  }

  async function answerQuiz(choice) {
    const question = quiz?.questions[quiz.index];
    if (!question || quiz.revealed || quiz.busy) return;
    const { item, phase } = question;
    quiz.busy = true;
    const correct = phase === 0 ? item.gloss : item.word;
    const right = choice === correct;
    playAnswerTone(right);
    quiz.revealed = true;
    quiz.lastChoice = choice;
    quiz.answeredQuestions++;
    if (right) quiz.correctQuestions++;
    else quiz.wrongByWord.set(item.word, (quiz.wrongByWord.get(item.word) || 0) + 1);
    const completed = (quiz.completedByWord.get(item.word) || 0) + 1;
    quiz.completedByWord.set(item.word, completed);
    byId("quiz-options").querySelectorAll("button").forEach((button) => {
      button.disabled = true;
      if (button.textContent === correct) button.classList.add("correct");
      else if (button.textContent === choice) button.classList.add("incorrect");
    });
    byId("quiz-forgot").hidden = true;
    byId("quiz-result").hidden = false;
    byId("quiz-result-title").textContent = right ? "回答正确" : choice === null ? "已标记不记得" : "回答错误";
    byId("quiz-correct-pair").textContent = `${item.word} · ${item.gloss}`;
    byId("quiz-next").textContent = quiz.index + 1 < quiz.questions.length ? "下一题 →" : "查看本轮结果 →";
    try {
      if (completed === 2) {
        await recordReview(item, quiz.wrongByWord.get(item.word) || 0, quiz.mode);
        markTaskWord(item.word);
      }
      persistQuiz();
    } finally {
      quiz.busy = false;
      byId("quiz-next").hidden = false;
    }
  }

  function nextQuizQuestion() {
    if (!quiz || !quiz.revealed || quiz.busy) return;
    quiz.index++;
    quiz.revealed = false;
    quiz.options = null;
    quiz.lastChoice = null;
    persistQuiz();
    renderQuiz();
  }

  function finishQuiz() {
    const returnTab = quiz?.returnTab || "today";
    if (state.activeTask && state.activeTask.type !== "study") finishTask(quiz && quiz.index >= quiz.questions.length ? "completed" : "ended");
    quiz = null;
    switchTab(returnTab);
  }

  function listKey(word) {
    const location = wordLocation(word);
    return location.other
      ? `other:${Math.floor((deckIndex.get(word) - activeCount) / 10) + 1}`
      : `unit:${location.unit}:${location.list}`;
  }

  function listLabel(key) {
    const parts = key.split(":");
    return parts[0] === "other" ? `Other · List ${parts[1]}` : `Unit ${parts[1]} · List ${parts[2]}`;
  }

  function calendarInfo(date) {
    const today = todayKey();
    const record = state.history[date] || {};
    const sessions = state.taskSessions.filter((task) => task.date === date);
    if (state.activeTask?.date === date) sessions.push({ ...state.activeTask, reason: "active" });
    const newWords = Array.isArray(record.newWords) ? record.newWords : [];
    const reviewed = sessions.filter((task) => task.type !== "study").flatMap((task) => task.completedWords || []);
    const legacyReviews = Object.entries(record.answers || {}).filter(([, answer]) => String(answer).startsWith("review-")).map(([word]) => word);
    const studied = [...new Set([...newWords, ...reviewed, ...legacyReviews])];
    let planned = Array.isArray(record.newPlanLists) ? record.newPlanLists : [];
    if (date > today && !planned.length) {
      const openLists = [...new Set(state.deckOrder.slice(0, activeCount).filter((word) => !state.progress[word]).map(listKey))];
      const daysAhead = Math.round((new Date(`${date}T12:00:00`) - new Date(`${today}T12:00:00`)) / 86400000);
      const perDay = state.dailyGoal / 10;
      planned = openLists.slice(Math.max(0, daysAhead - 1) * perDay, daysAhead * perDay);
    }
    const backlog = date === today ? dueWords().length : date < today
      ? (Number.isInteger(record.reviewBacklog) ? record.reviewBacklog : null)
      : state.deckOrder.slice(0, activeCount).filter((word) => state.progress[word]?.dueDate && state.progress[word].dueDate <= date).length;
    return { planned, backlog, studied, newWords, sessions, forecast: date > today };
  }

  function renderCalendar() {
    const [year, month] = calendarMonth.split("-").map(Number);
    byId("calendar-month").textContent = `${year} 年 ${month} 月`;
    const first = new Date(year, month - 1, 1);
    const offset = (first.getDay() + 6) % 7;
    const count = new Date(year, month, 0).getDate();
    const grid = byId("calendar-grid");
    grid.replaceChildren();
    for (let index = 0; index < offset; index++) {
      const spacer = document.createElement("span");
      spacer.className = "calendar-spacer";
      grid.append(spacer);
    }
    for (let number = 1; number <= count; number++) {
      const date = `${calendarMonth}-${String(number).padStart(2, "0")}`;
      const info = calendarInfo(date);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `calendar-day${date === todayKey() ? " today" : ""}${date === calendarDay ? " selected" : ""}`;
      button.setAttribute("aria-label", `${date}：计划 ${info.planned.length} 个 List，复习积压 ${info.backlog ?? "无历史记录"} 词，已背 ${info.studied.length} 词`);
      const numeral = document.createElement("strong");
      numeral.textContent = String(number);
      const plan = document.createElement("small");
      plan.textContent = `新 ${info.planned.length} 列`;
      const due = document.createElement("small");
      due.textContent = `复 ${info.backlog ?? "—"} 词`;
      const studied = document.createElement("small");
      studied.textContent = `背 ${info.studied.length} 词`;
      button.append(numeral, plan, due, studied);
      button.addEventListener("click", () => { calendarDay = date; renderCalendar(); });
      grid.append(button);
    }
    const info = calendarInfo(calendarDay);
    const detail = byId("calendar-detail");
    detail.replaceChildren();
    const title = document.createElement("h3");
    title.textContent = `${calendarDay} ${info.forecast ? "· 预计" : "· 学习记录"}`;
    const summary = document.createElement("p");
    summary.textContent = `新词计划：${info.planned.length ? info.planned.map(listLabel).join("、") : "无记录"}。复习积压：${info.backlog === null ? "暂无历史快照" : `${info.backlog} 词`}。新词已背：${info.newWords.length} 词。`;
    detail.append(title, summary);
    for (const task of info.sessions) {
      const completed = new Set(task.completedWords || []);
      const missed = (task.selectedWords || []).filter((word) => !completed.has(word));
      const row = document.createElement("div");
      row.className = "calendar-session";
      const label = document.createElement("strong");
      label.textContent = `${({ study: "新词", system: "系统复习", free: "自由复习", mistake: "错题复习" })[task.type] || "任务"} · ${(task.listKeys || []).map(listLabel).join("、")}`;
      const status = document.createElement("span");
      status.textContent = `完成 ${completed.size}/${(task.selectedWords || []).length} 词 · 未完成 ${missed.length} 词 · ${({ completed: "已完成", timed_out: "60 分钟无操作结束", ended: "手动结束", active: "进行中" })[task.reason] || "已结束"}`;
      row.append(label, status);
      if (missed.length) {
        const missedText = document.createElement("small");
        missedText.textContent = `本次未学／未复习：${missed.join("、")}`;
        row.append(missedText);
      }
      detail.append(row);
    }
    const wordsTitle = document.createElement("h4");
    wordsTitle.textContent = `当天背过及复习的单词 · ${info.studied.length}`;
    const list = document.createElement("div");
    list.className = "calendar-words";
    for (const word of info.studied) {
      const item = document.createElement("span");
      item.textContent = `${word} · ${wordMap.get(word)?.gloss || ""}`;
      list.append(item);
    }
    if (!info.studied.length) list.textContent = "这一天暂无新词学习记录。";
    detail.append(wordsTitle, list);
  }

  function renderFreeLists() {
    const learned = applyReviewFilters(words.filter((item) => state.progress[item.word]), "free");
    const groups = new Map();
    for (const item of learned) {
      const key = listKey(item.word);
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    const validKeys = new Set(groups.keys());
    selectedFreeLists = new Set([...selectedFreeLists].filter((key) => validKeys.has(key)));
    const picker = byId("free-list-picker");
    picker.replaceChildren();
    if (!groups.size) {
      const empty = document.createElement("p");
      empty.className = "list-empty";
      empty.textContent = "当前筛选下还没有学过的 List。";
      picker.append(empty);
    }
    for (const [key, count] of groups) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = key;
      checkbox.checked = selectedFreeLists.has(key);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedFreeLists.add(key);
        else selectedFreeLists.delete(key);
        byId("free-selection-count").textContent = `已选择 ${selectedFreeLists.size} 个 List`;
        byId("review-selected-lists").disabled = selectedFreeLists.size === 0;
      });
      const text = document.createElement("span");
      text.textContent = `${listLabel(key)} · 已学 ${count} 词`;
      label.append(checkbox, text);
      picker.append(label);
    }
    byId("free-selection-count").textContent = `已选择 ${selectedFreeLists.size} 个 List`;
    byId("review-selected-lists").disabled = selectedFreeLists.size === 0;
    const todayWords = state.history[todayKey()]?.newWords || [];
    byId("review-today-new").disabled = !applyReviewFilters(todayWords.map((word) => wordMap.get(word)).filter(Boolean), "free").length;
  }

  function showInlineSynonyms(word, containerId) {
    const container = byId(containerId);
    if (!container.hidden) { container.hidden = true; return; }
    container.replaceChildren();
    const matches = synonymMap[word] || [];
    if (!matches.length) {
      container.textContent = "当前词库中暂未匹配到近义词。";
    } else {
      for (const related of matches) {
        const chip = document.createElement("span");
        chip.textContent = `${related} · ${wordMap.get(related)?.gloss || ""}`;
        container.append(chip);
      }
    }
    container.hidden = false;
  }

  function renderSynonymList() {
    const query = byId("synonym-search").value.trim().toLocaleLowerCase();
    const matching = words.filter((item) => !query || item.word.toLocaleLowerCase().includes(query) || item.gloss.includes(query));
    const pages = Math.max(1, Math.ceil(matching.length / 20));
    synonymPage = Math.min(synonymPage, pages - 1);
    byId("synonym-page").textContent = `${synonymPage + 1} / ${pages}`;
    byId("synonym-prev").disabled = synonymPage === 0;
    byId("synonym-next").disabled = synonymPage + 1 >= pages;
    const list = byId("synonym-list");
    list.replaceChildren();
    for (const item of matching.slice(synonymPage * 20, synonymPage * 20 + 20)) {
      const row = document.createElement("article");
      const title = document.createElement("strong");
      title.textContent = `${item.word} · ${item.gloss}`;
      const related = document.createElement("p");
      const matches = synonymMap[item.word] || [];
      related.textContent = matches.length ? matches.map((word) => `${word}（${wordMap.get(word)?.gloss || ""}）`).join("、") : "词库中暂无匹配";
      row.append(title, related);
      list.append(row);
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
      quiz = null;
      manualWord = null;
      selectedFreeLists.clear();
      renderAll();
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
    const noteActivity = () => {
      if (!state.activeTask) return;
      if (taskTimedOut()) {
        finishTask("timed_out");
        quiz = null;
        renderToday();
        renderQuiz();
        showToast("本次任务已因 60 分钟无操作结束");
        return;
      }
      if (Date.now() - Date.parse(state.activeTask.lastActivityAt || state.activeTask.startedAt) > 30000) {
        touchTask();
        void saveState();
      }
    };
    document.addEventListener("pointerdown", noteActivity);
    document.addEventListener("keydown", noteActivity);
    document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));
    byId("start-study-task").addEventListener("click", () => {
      const items = todayNewPlan().words.filter((word) => !state.progress[word] && selectedStudyLists.has(listKey(word))).map((word) => wordMap.get(word));
      if (beginTask("study", items, [...selectedStudyLists])) renderToday();
    });
    byId("end-study-task").addEventListener("click", () => {
      finishTask("ended");
      renderToday();
    });
    byId("start-review-task").addEventListener("click", () => {
      const items = dueWords().filter((item) => selectedReviewLists.has(listKey(item.word)));
      startQuiz("system", items, "review");
    });
    byId("calendar-prev").addEventListener("click", () => {
      const [year, month] = calendarMonth.split("-").map(Number);
      const date = new Date(year, month - 2, 1);
      calendarMonth = todayKey(date).slice(0, 7);
      calendarDay = `${calendarMonth}-01`;
      renderCalendar();
    });
    byId("calendar-next").addEventListener("click", () => {
      const [year, month] = calendarMonth.split("-").map(Number);
      const date = new Date(year, month, 1);
      calendarMonth = todayKey(date).slice(0, 7);
      calendarDay = `${calendarMonth}-01`;
      renderCalendar();
    });
    byId("known-button").addEventListener("click", () => answerToday("known"));
    byId("unknown-button").addEventListener("click", () => answerToday("unknown"));
    byId("next-button").addEventListener("click", () => { manualWord = null; renderToday(); });
    byId("undo-button").addEventListener("click", undoAnswer);
    byId("speak-button").addEventListener("click", speakWord);
    byId("study-synonyms-button").addEventListener("click", () => { if (currentWord) showInlineSynonyms(currentWord.word, "study-synonyms"); });
    byId("start-system-review").addEventListener("click", () => {
      switchTab("review");
    });
    byId("quiz-forgot").addEventListener("click", () => answerQuiz(null));
    byId("quiz-next").addEventListener("click", nextQuizQuestion);
    byId("quiz-synonyms-button").addEventListener("click", () => {
      const item = quiz?.questions[quiz.index]?.item;
      if (item) showInlineSynonyms(item.word, "quiz-synonyms");
    });
    byId("exit-review").addEventListener("click", finishQuiz);
    byId("review-finish").addEventListener("click", finishQuiz);
    for (const id of ["free-difficulty", "free-polarity"]) byId(id).addEventListener("change", renderFreeLists);
    byId("review-today-new").addEventListener("click", () => {
      const items = (state.history[todayKey()]?.newWords || []).map((word) => wordMap.get(word)).filter(Boolean);
      startQuiz("free", applyReviewFilters(items, "free"), "free");
    });
    byId("review-selected-lists").addEventListener("click", () => {
      const items = applyReviewFilters(words.filter((item) => state.progress[item.word] && selectedFreeLists.has(listKey(item.word))), "free");
      startQuiz("free", items, "free");
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
      showToast(`已设置每天安排 ${value} 个新词 List`);
    });
    byId("difficulty-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const next = [...document.querySelectorAll('#difficulty-form input[name="difficulty"]:checked')].map((input) => input.value).sort();
      if (!next.length) { showToast("请至少选择一种难度"); return; }
      if (next.join("|") === [...state.preferredDifficulties].sort().join("|")) { showToast("难度偏好未变化"); return; }
      if (state.activeTask) { finishTask("ended"); quiz = null; }
      state.preferredDifficulties = next;
      ensureDeckOrder();
      selectedUnit = 1;
      selectedList = 1;
      selectedFreeLists.clear();
      manualWord = null;
      await saveState();
      renderAll();
      showToast(`已重排 ${activeCount} 个计划词，其余 ${words.length - activeCount} 个在 Other`);
    });
    byId("unit-select").addEventListener("change", (event) => {
      selectedUnit = event.target.value === "other" ? "other" : Number(event.target.value);
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
    for (const id of ["mistake-difficulty", "mistake-polarity"]) byId(id).addEventListener("change", renderMistakes);
    byId("synonym-search").addEventListener("input", () => { synonymPage = 0; renderSynonymList(); });
    byId("synonym-prev").addEventListener("click", () => { synonymPage = Math.max(0, synonymPage - 1); renderSynonymList(); });
    byId("synonym-next").addEventListener("click", () => { synonymPage++; renderSynonymList(); });
    byId("export-button").addEventListener("click", exportProgress);
    byId("import-input").addEventListener("change", (event) => importProgress(event.target.files?.[0]));
    byId("sync-now").addEventListener("click", () => syncDirty ? pushSync() : connectSync());
    byId("auth-logout").addEventListener("click", logout);
    byId("sync-use-cloud").addEventListener("click", async () => {
      if (pendingCloud) await useCloud(pendingCloud);
    });
    byId("sync-use-local").addEventListener("click", async () => {
      if (!pendingCloud) return;
      syncRevision = pendingCloud.revision;
      localStorage.setItem(userKey(SYNC_REV_STORE), String(syncRevision));
      syncConflict = false;
      pendingCloud = null;
      byId("sync-choice").hidden = true;
      syncDirty = true;
      localStorage.setItem(userKey(SYNC_DIRTY_STORE), "1");
      await pushSync();
    });
    setInterval(() => {
      if (!authUser || !taskTimedOut()) return;
      finishTask("timed_out");
      quiz = null;
      renderToday();
      renderQuiz();
      showToast("本次任务已因 60 分钟无操作结束；未完成词仍可再次选择");
    }, 60 * 1000);
  }

  function setAuthMode(mode) {
    authMode = mode;
    byId("auth-login-tab").classList.toggle("active", mode === "login");
    byId("auth-register-tab").classList.toggle("active", mode === "register");
    byId("auth-login-tab").setAttribute("aria-selected", String(mode === "login"));
    byId("auth-register-tab").setAttribute("aria-selected", String(mode === "register"));
    byId("auth-password").autocomplete = mode === "register" ? "new-password" : "current-password";
    byId("auth-password").minLength = mode === "register" ? 12 : 1;
    byId("auth-password").placeholder = mode === "register" ? "至少 12 位密码" : "输入你的密码";
    byId("auth-submit").textContent = mode === "register" ? "注册并开始" : "登录并继续";
    byId("auth-hint").textContent = mode === "register"
      ? "用户名为 3–32 位字母、数字或下划线。请保存密码；目前不提供自助找回。"
      : "登录后将在这台设备保持登录 90 天。";
    byId("auth-error").hidden = true;
  }

  function showAuth(message = "") {
    authGeneration += 1;
    clearTimeout(syncTimer);
    syncBusy = false;
    applyingCloud = false;
    authUser = null;
    byId("app-shell").hidden = true;
    byId("auth-screen").hidden = false;
    byId("auth-error").textContent = message;
    byId("auth-error").hidden = !message;
  }

  async function authRequest(method, body) {
    const response = await fetch(AUTH_API, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
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

  function authErrorMessage(error) {
    if (error.status === 409) return "这个用户名已被使用，请换一个。";
    if (error.status === 429) return "尝试次数过多，请稍后再试。";
    if (error.message === "weak_password") return "注册密码至少需要 12 位。";
    if (error.message === "invalid_credentials") return authMode === "register" ? "请检查用户名和密码格式。" : "用户名或密码不正确。";
    return "账户服务暂不可用，请检查网络后重试。";
  }

  async function activateUser(user, offline = false) {
    authGeneration += 1;
    clearTimeout(syncTimer);
    syncBusy = false;
    authUser = user;
    localStorage.setItem(LAST_USER_STORE, JSON.stringify(user));
    byId("account-name").textContent = user.username;
    if (!words.length) {
      const response = await fetch("./words.json");
      if (!response.ok) throw new Error(`词库加载失败：${response.status}`);
      words = await response.json();
      if (!Array.isArray(words) || words.length !== 3590 || words.some((item) => !item.word || !item.gloss)) {
        throw new Error("词库格式不完整");
      }
      wordMap = new Map(words.map((item) => [item.word, item]));
      if (wordMap.size !== words.length) throw new Error("词库中存在重复单词");
      const synonymResponse = await fetch("./synonyms.json");
      if (!synonymResponse.ok) throw new Error(`近义词列表加载失败：${synonymResponse.status}`);
      synonymMap = await synonymResponse.json();
    }
    if (db) db.close();
    state = await loadState();
    applyingCloud = true;
    let rebuilt = false;
    let expiredTask = false;
    try {
      rebuilt = ensureDeckOrder();
      if (taskTimedOut()) { finishTask("timed_out"); expiredTask = true; }
      if (rebuilt) await saveState();
    } finally {
      applyingCloud = false;
    }
    syncRevision = Number(localStorage.getItem(userKey(SYNC_REV_STORE))) || 0;
    syncDirty = localStorage.getItem(userKey(SYNC_DIRTY_STORE)) === "1";
    if (expiredTask) {
      syncDirty = true;
      localStorage.setItem(userKey(SYNC_DIRTY_STORE), "1");
    }
    migrationRebuilt = rebuilt;
    syncConflict = false;
    pendingCloud = null;
    byId("sync-choice").hidden = true;
    quiz = null;
    restoreQuiz();
    manualWord = null;
    selectedFreeLists.clear();
    selectedUnit = 1;
    selectedList = 1;
    selectedMistakeGroup = "unmastered";
    catalogPage = 0;
    synonymPage = 0;
    if (!appBound) {
      bindEvents();
      appBound = true;
    }
    renderAll();
    switchTab(quiz ? "review" : "today");
    byId("auth-screen").hidden = true;
    byId("app-shell").hidden = false;
    if (offline) syncStatus("当前离线，本机进度可继续使用；联网后点“立即同步”。", false);
    else connectSync();
  }

  async function logout() {
    try {
      await authRequest("POST", { action: "logout" });
      localStorage.removeItem(LAST_USER_STORE);
      showAuth();
      byId("auth-password").value = "";
      setAuthMode("login");
    } catch {
      showToast("暂时无法退出登录，请联网后重试。");
    }
  }

  function bindAuthEvents() {
    byId("auth-login-tab").addEventListener("click", () => setAuthMode("login"));
    byId("auth-register-tab").addEventListener("click", () => setAuthMode("register"));
    byId("auth-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = byId("auth-submit");
      button.disabled = true;
      byId("auth-error").hidden = true;
      try {
        const result = await authRequest("POST", {
          action: authMode,
          username: byId("auth-username").value,
          password: byId("auth-password").value
        });
        byId("auth-password").value = "";
        await activateUser(result.user);
      } catch (error) {
        console.warn("Account request failed.", error);
        byId("auth-error").textContent = authErrorMessage(error);
        byId("auth-error").hidden = false;
      } finally {
        button.disabled = false;
      }
    });
  }

  async function init() {
    bindAuthEvents();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Offline cache unavailable.", error));
    }
    try {
      const result = await authRequest("GET");
      await activateUser(result.user);
    } catch (error) {
      if (error.status === 401) showAuth();
      else {
        try {
          const remembered = JSON.parse(localStorage.getItem(LAST_USER_STORE) || "null");
          if (!remembered?.id || !remembered?.username) throw new Error("No offline account");
          await activateUser(remembered, true);
        } catch {
          showAuth("网络暂不可用，请联网后登录。 ");
        }
      }
    }
  }

  init();
})();
