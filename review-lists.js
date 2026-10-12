(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WordflowReviewLists = factory();
})(globalThis, function () {
  "use strict";

  const POLICY = 1;
  const signature = (words) => [...words].sort().join("\u0000");
  const countOf = (entry) => Math.max(0, Math.floor(Number(entry?.systemReviewCount ?? entry?.reviewCount) || 0));

  function groups(deckOrder, activeCount, includeOther = false) {
    const result = [];
    for (let start = 0; start < activeCount; start += 10) {
      const number = Math.floor(start / 10);
      result.push({ key: `unit:${Math.floor(number / 10) + 1}:${number % 10 + 1}`,
        words: deckOrder.slice(start, Math.min(start + 10, activeCount)), other: false });
    }
    if (includeOther) {
      for (let start = activeCount; start < deckOrder.length; start += 10) {
        result.push({ key: `other:${Math.floor((start - activeCount) / 10) + 1}`,
          words: deckOrder.slice(start, start + 10), other: true });
      }
    }
    return result;
  }

  function minimumCount(progress, words) {
    return words.length ? Math.min(...words.map((word) => countOf(progress[word]))) : 0;
  }

  function ensureRecords(state, activeCount, defaultDueDate, newlyLearnedKey = null) {
    let changed = false;
    for (const entry of Object.values(state.progress)) {
      if (!Number.isInteger(entry.systemReviewCount) || entry.systemReviewCount < 0) {
        entry.systemReviewCount = countOf(entry);
        changed = true;
      }
    }
    const old = state.listReviews || {};
    const byMembership = new Map(Object.values(old).filter((entry) => Array.isArray(entry?.words))
      .map((entry) => [signature(entry.words), entry]));
    const next = {};
    for (const group of groups(state.deckOrder, activeCount, true)) {
      if (!group.words.length || !group.words.every((word) => state.progress[word])) continue;
      const entries = group.words.map((word) => state.progress[word]);
      const previous = byMembership.get(signature(group.words));
      const dates = entries.map((entry) => entry.dueDate).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
      next[group.key] = {
        words: group.words,
        count: minimumCount(state.progress, group.words),
        stage: previous ? previous.stage : Math.min(...entries.map((entry) => Math.max(-1, Math.min(5, Number(entry.stage ?? -1))))),
        dueDate: previous?.dueDate || (group.key === newlyLearnedKey ? dates.at(-1) : dates[0]) || defaultDueDate,
        lastDate: previous?.lastDate || null
      };
    }
    if (JSON.stringify(old) !== JSON.stringify(next)) changed = true;
    state.listReviews = next;
    return changed;
  }

  function dueLists(state, activeCount, date) {
    return groups(state.deckOrder, activeCount).filter((group) => {
      const record = state.listReviews?.[group.key];
      return record && signature(record.words) === signature(group.words) &&
        group.words.every((word) => state.progress[word]) && record.dueDate <= date;
    }).sort((a, b) => state.listReviews[a.key].dueDate.localeCompare(state.listReviews[b.key].dueDate));
  }

  function addDays(date, count) {
    const result = new Date(`${date}T12:00:00Z`);
    result.setUTCDate(result.getUTCDate() + count);
    return result.toISOString().slice(0, 10);
  }

  function commitList(state, task, completedByWord, wrongByWord, key, date, intervals) {
    if (task?.type !== "system" || task.reviewPolicy !== POLICY || (task.committedLists || []).includes(key)) return null;
    const selected = task.listWords?.[key];
    const previousList = state.listReviews?.[key];
    if (!selected?.length || !previousList || signature(selected) !== signature(previousList.words) ||
        !selected.every((word) => state.progress[word] && completedByWord.get(word) === 2)) return null;
    const wrongFor = (word) => Math.max(0, Math.min(2, Number(wrongByWord.get(word)) || 0));
    const wrongQuestions = selected.reduce((sum, word) => sum + wrongFor(word), 0);
    const stage = wrongQuestions === 0 ? Math.min(Number(previousList.stage ?? -1) + 1, intervals.length - 1) : -1;
    const dueDate = addDays(date, wrongQuestions === 0 ? intervals[stage] : 1);
    const count = previousList.count + 1;
    state.history[date] ||= { answers: {}, newWords: [] };
    state.history[date].answers ||= {};
    for (const word of selected) {
      const previous = state.progress[word];
      const wrong = wrongFor(word);
      state.progress[word] = {
        ...previous,
        wrongCount: (Number(previous.wrongCount) || 0) + wrong,
        knownCount: (Number(previous.knownCount) || 0) + 2 - wrong,
        reviewCount: (Number(previous.reviewCount) || 0) + 1,
        systemReviewCount: count,
        unmastered: false,
        stage, dueDate, lastDate: date, lastAnswer: wrong ? "unknown" : "known"
      };
      state.history[date].answers[word] = wrong ? "review-unknown" : "review-known";
    }
    state.listReviews[key] = { words: previousList.words, count, stage, dueDate, lastDate: date };
    task.committedLists ||= [];
    task.committedLists.push(key);
    task.completedWords = [...new Set([...(task.completedWords || []), ...selected])];
    return { count, dueDate, wrongQuestions };
  }

  return { POLICY, groups, minimumCount, ensureRecords, dueLists, commitList };
});
