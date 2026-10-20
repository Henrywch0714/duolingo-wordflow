(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WordflowReviewLists = factory();
})(globalThis, function () {
  "use strict";

  const POLICY = 2;
  const INTERVALS = [1, 2, 4, 7, 15, 30];
  const signature = (words) => [...words].sort().join("\u0000");
  const countOf = (entry) => Math.max(0, Math.floor(Number(entry?.systemReviewCount ?? entry?.reviewCount) || 0));
  const integer = (value) => Math.max(0, Math.floor(Number(value) || 0));
  const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const isErrorKey = (key) => key.startsWith("error:");
  const entryKey = (key, word) => `${key}|${word}`;
  const entryWord = (id) => id.slice(id.indexOf("|") + 1);
  const entryList = (id) => id.slice(0, id.indexOf("|"));

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
        stage: Math.min(minimumCount(state.progress, group.words), INTERVALS.length - 1),
        dueDate: previous?.dueDate || (group.key === newlyLearnedKey ? dates.at(-1) : dates[0]) || defaultDueDate,
        lastDate: previous?.lastDate || null,
        policy: POLICY
      };
      const record = next[group.key];
      // Old failures could reset the List stage. Rebuild it from completed List reviews.
      if (previous && previous.policy !== POLICY && record.count > 0 && validDate(record.lastDate)) {
        record.dueDate = addDays(record.lastDate, INTERVALS[record.stage]);
        for (const word of group.words) {
          state.progress[word].stage = record.stage;
          state.progress[word].dueDate = record.dueDate;
        }
      }
    }
    if (JSON.stringify(old) !== JSON.stringify(next)) changed = true;
    state.listReviews = next;
    const vocabulary = new Set(state.deckOrder);
    const errors = Object.fromEntries(Object.entries(state.errorReviews || {}).filter(([word, entry]) =>
      vocabulary.has(word) && state.progress[word] && entry && validDate(entry.dueDate)).map(([word, entry]) => [word, {
      cycleId: typeof entry.cycleId === "string" ? entry.cycleId : `legacy:${word}:${entry.dueDate}`,
      stage: Math.min(integer(entry.stage), INTERVALS.length - 1), dueDate: entry.dueDate,
      createdDate: validDate(entry.createdDate) ? entry.createdDate : entry.dueDate,
      lastDate: validDate(entry.lastDate) ? entry.lastDate : null,
      reviewCount: integer(entry.reviewCount), revision: integer(entry.revision)
    }]));
    if (JSON.stringify(state.errorReviews) !== JSON.stringify(errors)) changed = true;
    state.errorReviews = errors;
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

  function dueErrorLists(state, date) {
    const due = Object.entries(state.errorReviews || {}).filter(([word, entry]) =>
      state.progress[word] && entry.dueDate <= date).sort(([a, ea], [b, eb]) =>
      ea.dueDate.localeCompare(eb.dueDate) || ea.createdDate.localeCompare(eb.createdDate) || a.localeCompare(b));
    const result = [];
    for (let i = 0; i < due.length; i += 10) result.push({ key: `error:${i / 10 + 1}`, words: due.slice(i, i + 10).map(([word]) => word) });
    return result;
  }

  function prepareTask(state, task) {
    task.selectedEntries = task.listKeys.flatMap((key) => task.listWords[key].map((word) => entryKey(key, word)));
    task.completedEntries = [];
    task.errorTrackedAtStart = Object.keys(state.errorReviews || {});
    task.errorVersions = Object.fromEntries(task.listKeys.filter(isErrorKey).flatMap((key) => task.listWords[key].map((word) =>
      [word, { cycleId: state.errorReviews[word].cycleId, revision: state.errorReviews[word].revision }])));
  }

  function resultsForList(task, answers, key) {
    return new Map((task.listWords[key] || []).map((word) => [word, answers.get(entryKey(key, word)) || 0]));
  }

  function finishList(task, key, words) {
    task.committedLists ||= [];
    task.committedLists.push(key);
    task.completedEntries = [...new Set([...(task.completedEntries || []), ...words.map((word) => entryKey(key, word))])];
    const selected = task.selectedEntries || Object.entries(task.listWords).flatMap(([list, entries]) => entries.map((word) => entryKey(list, word)));
    const completed = new Set(task.completedEntries);
    task.completedWords = selected.filter((id) => completed.has(id)).map(entryWord);
  }

  function answerProgress(state, word, wrong, date) {
    const previous = state.progress[word];
    state.progress[word] = {
      ...previous, wrongCount: (Number(previous.wrongCount) || 0) + wrong,
      knownCount: (Number(previous.knownCount) || 0) + 2 - wrong,
      reviewCount: (Number(previous.reviewCount) || 0) + 1,
      unmastered: false, lastDate: date, lastAnswer: wrong ? "unknown" : "known"
    };
  }

  function enrollError(state, task, key, word, date) {
    state.errorReviews ||= {};
    // A regular List never changes an already tracked error cycle, including one
    // which independently completed its 30-day review earlier in this task.
    if (state.errorReviews[word] || (task.errorTrackedAtStart || []).includes(word)) return;
    state.errorReviews[word] = { cycleId: `${task.id || date}:${key}:${word}`, stage: 0,
      dueDate: addDays(date, 1), createdDate: date, lastDate: null, reviewCount: 0, revision: 0 };
  }

  function commitList(state, task, completedByWord, wrongByWord, key, date, intervals) {
    if (task?.type !== "system" || task.reviewPolicy !== POLICY || isErrorKey(key) || (task.committedLists || []).includes(key)) return null;
    const selected = task.listWords?.[key];
    const previousList = state.listReviews?.[key];
    if (!selected?.length || !previousList || previousList.dueDate > date || signature(selected) !== signature(previousList.words) ||
        !selected.every((word) => state.progress[word] && completedByWord.get(word) === 2)) return null;
    const wrongFor = (word) => Math.max(0, Math.min(2, Number(wrongByWord.get(word)) || 0));
    const wrongQuestions = selected.reduce((sum, word) => sum + wrongFor(word), 0);
    const count = previousList.count + 1;
    const stage = Math.min(count, intervals.length - 1);
    const dueDate = addDays(date, intervals[stage]);
    state.history[date] ||= { answers: {}, newWords: [] };
    state.history[date].answers ||= {};
    for (const word of selected) {
      const wrong = wrongFor(word);
      answerProgress(state, word, wrong, date);
      state.progress[word] = {
        ...state.progress[word],
        systemReviewCount: count,
        stage, dueDate
      };
      if (wrong) enrollError(state, task, key, word, date);
      state.history[date].answers[word] = wrong ? "review-unknown" : "review-known";
    }
    state.listReviews[key] = { words: previousList.words, count, stage, dueDate, lastDate: date, policy: POLICY };
    finishList(task, key, selected);
    return { count, dueDate, wrongQuestions };
  }

  function commitErrorList(state, task, completedByWord, wrongByWord, key, date, intervals) {
    if (task?.type !== "system" || task.reviewPolicy !== POLICY || !isErrorKey(key) || (task.committedLists || []).includes(key)) return null;
    const selected = task.listWords?.[key];
    if (!selected?.length || selected.length > 10 || new Set(selected).size !== selected.length || !selected.every((word) => {
      const entry = state.errorReviews?.[word], version = task.errorVersions?.[word];
      return state.progress[word] && completedByWord.get(word) === 2 && entry && version && entry.dueDate <= date &&
        entry.cycleId === version.cycleId && entry.revision === version.revision;
    })) return null;
    let wrongQuestions = 0, removed = 0;
    state.history[date] ||= { answers: {}, newWords: [] };
    state.history[date].errorAnswers ||= {};
    for (const word of selected) {
      const previous = state.errorReviews[word];
      const wrong = Math.max(0, Math.min(2, Number(wrongByWord.get(word)) || 0));
      wrongQuestions += wrong;
      answerProgress(state, word, wrong, date);
      state.history[date].errorAnswers[word] = wrong ? "unknown" : "known";
      if (!wrong && previous.stage === intervals.length - 1) {
        delete state.errorReviews[word];
        removed++;
      } else {
        const stage = wrong ? 0 : previous.stage + 1;
        state.errorReviews[word] = { ...previous, stage, dueDate: addDays(date, intervals[stage]),
          lastDate: date, reviewCount: previous.reviewCount + 1, revision: previous.revision + 1 };
      }
    }
    finishList(task, key, selected);
    return { wrongQuestions, removed };
  }

  return { POLICY, INTERVALS, groups, minimumCount, ensureRecords, dueLists, dueErrorLists, commitList, commitErrorList,
    isErrorKey, entryKey, entryWord, entryList, prepareTask, resultsForList };
});
