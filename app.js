(() => {
  "use strict";

  const STORAGE_KEY = "pathology-study-v1";
  const RECORD_FORMAT = "pathology-study-records";
  const NOTES = window.PATHOLOGY_NOTES;
  const PAGE_SIZE = 120;
  const typeNames = { single: "单选题", multiple: "多选题", text: "文字题" };
  const modeNames = { all: "按章节", wrong: "错题本", star: "收藏", mastered: "已熟练", marked: "视频没讲", notes: "注释" };
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const answerList = value => Array.isArray(value) ? value.map(String).filter(Boolean) : value == null || value === "" ? [] : [String(value)];
  const displayAnswer = value => answerList(value).join("、") || "未提供明确答案";
  const data = window.PATHOLOGY_DATA;
  const corrections = window.PATHOLOGY_CORRECTIONS || { entries: {}, chapters: {} };
  const reviewFlags = window.PATHOLOGY_REVIEW_FLAGS || { entries: {} };
  const translations = window.PATHOLOGY_TRANSLATIONS || { entries: {}, glossary: {} };
  const glossary = new Map(Object.entries(translations.glossary).map(([term, meaning]) => [term.toLowerCase(), meaning]));
  const termPattern = glossary.size ? new RegExp(`(?<![A-Za-z])(?:${[...glossary.keys()].sort((a, b) => b.length - a.length).map(term => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![A-Za-z0-9])`, "gi") : null;
  let state = { records: {}, view: { chapterId: "all", language: "all", type: "all", mode: "all", order: "sequential", search: "", currentId: "", seed: Date.now() }, theme: "light", lastQuestionId: "", viewUpdatedAt: 0 };
  let storageAvailable = true;
  let queue = [];
  let currentIndex = 0;
  let mapPage = 0;
  let answerRevealed = false;
  let translationVisible = false;
  let noteEditing = false;
  let notePreviewMode = false;
  let noteSaveTimer;
  let searchTimer;
  let toastTimer;
  let lastTimestamp = Date.now();
  let sourceQuestion = null;
  let answerDocument = "corrected";

  function warnStorage(message) {
    storageAvailable = false;
    $("storageWarning").textContent = message;
    $("storageWarning").hidden = false;
    document.body.classList.add("has-storage-warning");
  }

  function toast(message) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").hidden = false;
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4500);
  }

  function persist() {
    if (!storageAvailable) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch { warnStorage("浏览器无法保存学习记录。当前页面仍可练习，请及时导出记录；关闭或刷新页面后，未导出的记录可能丢失。"); }
  }

  function normalizedRecord(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return {
      selected: Array.isArray(raw.selected) ? raw.selected.filter(item => typeof item === "string").slice(0, 30) : [],
      text: typeof raw.text === "string" ? raw.text.slice(0, 50000) : "",
      submitted: raw.submitted === true,
      result: ["correct", "wrong", "neutral"].includes(raw.result) ? raw.result : null,
      star: raw.star === true,
      marked: raw.marked === true,
      mastered: raw.mastered === true,
      note: typeof raw.note === "string" ? raw.note.slice(0, 100000) : "",
      updatedAt: Number.isFinite(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : 0
    };
  }

  function validateBackupImages(images) {
    const entries = Object.entries(images);
    if (entries.length > 1000) throw new Error("too many backup images");
    for (const [id, dataUrl] of entries) {
      if (!/^[A-Za-z0-9_-]+$/.test(id) || typeof dataUrl !== "string") throw new Error("invalid backup image");
      const match = dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]*={0,2})$/i);
      if (!match || match[2].length % 4 !== 0 || dataUrl.length > 17_000_000) throw new Error("invalid backup image");
      let bytes;
      try { bytes = atob(match[2]); } catch { throw new Error("invalid backup image"); }
      const mime = match[1].toLowerCase();
      const valid = mime === "jpeg" ? bytes.charCodeAt(0) === 0xff && bytes.charCodeAt(1) === 0xd8 && bytes.charCodeAt(bytes.length - 2) === 0xff && bytes.charCodeAt(bytes.length - 1) === 0xd9
        : mime === "png" ? bytes.length >= 8 && bytes.charCodeAt(0) === 0x89 && bytes.slice(1, 4) === "PNG" && bytes.charCodeAt(4) === 0x0d && bytes.charCodeAt(5) === 0x0a && bytes.charCodeAt(6) === 0x1a && bytes.charCodeAt(7) === 0x0a
          : bytes.length >= 12 && bytes.slice(0, 4) === "RIFF" && bytes.slice(8, 12) === "WEBP";
      if (!valid) throw new Error("backup image signature mismatch");
    }
    return entries;
  }

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid records");
      if (parsed.records && typeof parsed.records === "object") state.records = parsed.records;
      if (parsed.view && typeof parsed.view === "object") state.view = { ...state.view, ...parsed.view };
      state.theme = parsed.theme === "dark" ? "dark" : "light";
      state.lastQuestionId = typeof parsed.lastQuestionId === "string" ? parsed.lastQuestionId : "";
      state.viewUpdatedAt = Number.isFinite(parsed.viewUpdatedAt) && parsed.viewUpdatedAt > 0 ? parsed.viewUpdatedAt : 0;
    } else if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) state.theme = "dark";
  } catch {
    warnStorage("浏览器中的病理学习记录无法读取。当前页面会临时保存本次学习，请导出记录后再离开；旧记录不会被自动覆盖。");
  }
  document.documentElement.dataset.theme = state.theme;

  if (!data || !Array.isArray(data.chapters)) {
    $("chapterTitle").textContent = "题库尚未就绪";
    $("questionArea").innerHTML = '<div class="empty"><h3>未能读取题库数据</h3><p>请确认本页旁边有 data.js、corrections.js 和 assets 文件夹，保留完整文件夹后重新打开 index.html。</p></div>';
    return;
  }

  const chapters = data.chapters.filter(chapter => chapter && typeof chapter.id === "string" && Array.isArray(chapter.questions));
  const questions = chapters.flatMap(chapter => chapter.questions.map(question => ({ ...question, chapterId: chapter.id, chapterName: chapter.name, chapterNumber: chapter.number })));
  const questionById = new Map(questions.map(question => [question.id, question]));
  const chapterById = new Map(chapters.map(chapter => [chapter.id, chapter]));
  const cleanRecords = {};
  for (const [id, raw] of Object.entries(state.records)) {
    if (!questionById.has(id)) continue;
    const record = normalizedRecord(raw);
    if (record) cleanRecords[id] = record;
  }
  state.records = cleanRecords;
  if (state.view.chapterId !== "all" && !chapterById.has(state.view.chapterId)) state.view.chapterId = "all";
  if (!["all", "zh", "en"].includes(state.view.language)) state.view.language = "all";
  if (!["all", "single", "multiple", "text"].includes(state.view.type)) state.view.type = "all";
  if (!own(modeNames, state.view.mode)) state.view.mode = "all";
  if (!["sequential", "random"].includes(state.view.order)) state.view.order = "sequential";
  if (typeof state.view.search !== "string") state.view.search = "";
  if (!Number.isFinite(state.view.seed)) state.view.seed = Date.now();
  if (typeof state.view.currentId !== "string") state.view.currentId = "";

  function recordFor(id) {
    return state.records[id] || { selected: [], text: "", submitted: false, result: null, star: false, marked: false, mastered: false, note: "", updatedAt: 0 };
  }

  function changeRecord(id, changes) {
    lastTimestamp = Math.max(Date.now(), lastTimestamp + 1, recordFor(id).updatedAt + 1);
    state.records[id] = { ...recordFor(id), ...changes, updatedAt: lastTimestamp };
    persist();
  }

  // 题目卡片和右侧注释栏各自标记题目，读取输入内容时沿 DOM 向上查找最近的归属记录。
  function questionIdFor(element) {
    const owner = element?.closest("[data-question-id], [data-note-question-id]");
    return owner?.dataset.questionId || owner?.dataset.noteQuestionId || "";
  }

  function answerInfo(question) {
    const entry = corrections.entries && own(corrections.entries, question.id) ? corrections.entries[question.id] : null;
    const original = answerList(entry?.originalAnswer ?? question.originalAnswer);
    const effective = entry ? answerList(entry.answer) : original;
    const options = Array.isArray(question.options) ? question.options : [];
    const keys = options.map(option => String(option.key));
    let reason = typeof question.gradingBlockedReason === "string" && question.gradingBlockedReason.trim() ? question.gradingBlockedReason.trim() : "";
    if (!reason) {
      if (entry?.status === "disputed") reason = "修正版将此题标为有争议，本题可以作答，但不计入正确率。";
      else if (entry?.status === "unclear") reason = "修正版未能确定此题答案，本题可以作答，但不计入正确率。";
      else if (question.type === "text") reason = "文字题请对照原书答案自查，系统记录作答，但不自动判分。";
      else if (!effective.length) reason = "目前缺少明确答案，本题记录作答，但不计入正确率。";
      else if (!options.length || effective.some(key => !keys.includes(key))) reason = "答案与已录入选项尚未对应，本题记录作答，但不计入正确率。";
      else if (question.type === "single" && effective.length !== 1) reason = "单选题的参考答案包含多个选项，尚需核对，本题不计入正确率。";
      else if (!["single", "multiple"].includes(question.type)) reason = "此题的题型尚需核对，本题不计入正确率。";
      else if (reviewFlags.entries?.[question.id]?.status === "needs_review") reason = "本题参考答案待复核，暂不计分。";
    }
    return { entry, original, effective, gradeable: !reason, reason };
  }

  function resultFor(question) {
    const record = recordFor(question.id);
    if (!record.submitted) return null;
    const info = answerInfo(question);
    if (!info.gradeable) return "neutral";
    const selected = new Set(record.selected);
    const answers = new Set(info.effective);
    return selected.size === answers.size && [...selected].every(key => answers.has(key)) ? "correct" : "wrong";
  }

  function statistics(list) {
    const result = { total: list.length, answered: 0, correct: 0, wrong: 0, neutral: 0, star: 0, notes: 0 };
    for (const question of list) {
      const record = recordFor(question.id);
      const outcome = resultFor(question);
      if (outcome) { result.answered++; result[outcome]++; }
      if (record.star) result.star++;
      if (record.note.trim()) result.notes++;
    }
    return result;
  }

  function matchesMode(question) {
    const record = recordFor(question.id);
    return state.view.mode === "all" || state.view.mode === "wrong" && resultFor(question) === "wrong" || state.view.mode === "star" && record.star || state.view.mode === "mastered" && record.mastered || state.view.mode === "marked" && record.marked || state.view.mode === "notes" && Boolean(record.note.trim());
  }

  function seededShuffle(list, seed) {
    let value = seed >>> 0;
    const random = () => { value = (value + 0x6D2B79F5) >>> 0; let mixed = value; mixed = Math.imul(mixed ^ mixed >>> 15, mixed | 1); mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61); return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296; };
    const shuffled = [...list];
    for (let index = shuffled.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
    }
    return shuffled;
  }

  function rebuildQueue(preferredId = state.view.currentId) {
    const search = state.view.search.trim().toLocaleLowerCase();
    const words = search.split(/\s+/).filter(Boolean);
    const filtered = questions.filter(question => {
      if (state.view.chapterId !== "all" && question.chapterId !== state.view.chapterId) return false;
      if (state.view.language !== "all" && question.language !== state.view.language) return false;
      if (state.view.type !== "all" && question.type !== state.view.type) return false;
      if (!matchesMode(question)) return false;
      if (!words.length) return true;
      const searchable = [question.number, question.stem, question.sharedStem, question.chapterName, ...(question.options || []).map(option => option.text)].join(" ").toLocaleLowerCase();
      return words.every(word => searchable.includes(word));
    });
    queue = state.view.order === "random" ? seededShuffle(filtered, state.view.seed) : filtered;
    const preferredIndex = queue.findIndex(question => question.id === preferredId);
    currentIndex = preferredIndex >= 0 ? preferredIndex : 0;
    mapPage = Math.floor(currentIndex / PAGE_SIZE);
    answerRevealed = false;
    translationVisible = false;
    noteEditing = false;
    notePreviewMode = false;
    state.view.currentId = queue[currentIndex]?.id || "";
    persist();
    render();
    $("questionScroll").scrollTop = 0;
  }

  function setFilter(name, value) {
    flushNote();
    state.view[name] = value;
    state.viewUpdatedAt = Date.now();
    rebuildQueue();
  }

  /*
   * 右栏始终保留题目注释的标题、题目信息和操作入口。
   * 编辑时只显示文本框；切换到预览后显示渲染内容，两个状态共用同一份记录。
   */
  function noteMarkup(record, question) {
    const emptyNote = '<p class="note-empty">这道题还没有注释。点击“编辑”记录教材依据或待核对的问题。</p>';
    const renderedNote = record.note.trim() && NOTES ? NOTES.render(record.note) : record.note.trim() ? escape(record.note) : emptyNote;
    const editorNote = record.note.trim() ? renderedNote : '<p class="note-empty">这道题还没有注释。</p>';
    const status = storageAvailable ? "边写边自动保存" : "临时保存，请导出记录";
    const viewButton = noteEditing
      ? `<button class="text-button" data-note-preview aria-pressed="${notePreviewMode}">${notePreviewMode ? "编辑" : "预览"}</button><button class="text-button" data-note-done>完成</button>`
      : '<button class="text-button" data-note-edit>编辑</button>';

    return `
      <header class="note-pane-header">
        <strong>我的注释</strong><span id="noteStatus">${status}</span>
      </header>
      <div class="note-context">${escape(question.chapterName)} · ${question.language === "en" ? "英文" : "中文"}第 ${escape(question.number)} 题</div>
      <div class="note-pane-controls">
        ${viewButton}
        <button class="button" data-note-image ${noteEditing ? "" : "hidden"}>插入图片</button>
        <button class="button" data-export-text>导出本题文本</button>
      </div>
      <div class="note-edit-tools" ${noteEditing ? "" : "hidden"}>
        <span class="selection-hint">支持 Markdown；可粘贴截图或拖入图片文件。</span>
      </div>
      <div class="note-content note-preview" id="notePreview" ${noteEditing ? "hidden" : ""}>${renderedNote}</div>
      <div class="note-editor${notePreviewMode ? " preview-only" : ""}" ${noteEditing ? "" : "hidden"}>
        <label class="note-edit-label" for="questionNote">编辑 Markdown 注释</label>
        <textarea class="note-input" id="questionNote" placeholder="记录教材依据、容易混淆的知识点或仍需核对的问题……">${escape(record.note)}</textarea>
        <div class="note-preview-label">Markdown 预览</div>
        <div class="note-live-preview note-preview" id="noteLivePreview">${editorNote}</div>
      </div>
      <input type="file" id="noteImageFile" accept="image/*" multiple hidden>`;
  }

  // 找到当前显示模式实际使用的滚动区，切换编辑和预览时保持各自的滚动行为。
  function activeNoteScroller() {
    if (!noteEditing) return $("notePreview");
    return notePreviewMode ? $("noteLivePreview") : $("questionNote");
  }

  function renderSidebar() {
    const stats = statistics(questions);
    const graded = stats.correct + stats.wrong;
    const accuracy = graded ? `${Math.round(stats.correct / graded * 100)}%` : "—";
    const marked = questions.filter(question => recordFor(question.id).marked).length;
    const mastered = questions.filter(question => recordFor(question.id).mastered).length;
    $("modes").innerHTML = Object.entries(modeNames).map(([mode, label]) => `<button class="chip" data-mode="${mode}" aria-pressed="${state.view.mode === mode}">${label}<span class="c">${mode === "all" ? stats.total : mode === "wrong" ? stats.wrong : mode === "star" ? stats.star : mode === "mastered" ? mastered : mode === "marked" ? marked : stats.notes}</span></button>`).join("") + `<button class="chip" data-order-toggle aria-pressed="${state.view.order === "random"}">乱序</button>`;
    $("railStats").textContent = `已答 ${stats.answered}/${stats.total} · 正确率 ${accuracy} · 计分 ${graded} 题 · 不计分 ${stats.neutral} 题 · 记录保存在本机`;
    $("languages").innerHTML = [["all", "全部"], ["zh", "中文"], ["en", "English"]].map(([language, label]) => `<button data-language="${language}" aria-pressed="${state.view.language === language}">${label}</button>`).join("");
    const chapterButton = (id, number, name, list) => {
      const relevant = list.filter(question => state.view.language === "all" || state.view.language === question.language);
      const values = statistics(relevant);
      return `<button class="chapter" data-chapter="${escape(id)}" aria-current="${state.view.chapterId === id}"><span class="chapter-number">${escape(number)}</span><span class="chapter-name">${escape(name)}</span><span class="chapter-count">${values.answered}/${values.total}</span><span class="chapter-bar"><i class="correct" style="width:${values.total ? values.correct / values.total * 100 : 0}%"></i><i class="wrong" style="width:${values.total ? values.wrong / values.total * 100 : 0}%"></i></span></button>`;
    };
    $("chapters").innerHTML = chapterButton("all", "∑", "全部章节", questions) + chapters.map(chapter => chapterButton(chapter.id, String(chapter.number).padStart(2, "0"), chapter.name, questions.filter(question => question.chapterId === chapter.id))).join("");
    $("theme").textContent = state.theme === "dark" ? "浅色主题" : "深色主题";
  }

  function assetPath(path) {
    return typeof path === "string" && /^(?:assets|question-images)\/[a-zA-Z0-9_./-]+\.(?:png|jpg|jpeg|webp)$/i.test(path) && !path.includes("..") ? path : "";
  }

  function questionImagesMarkup(question) {
    if (!Array.isArray(question.images)) return "";
    return question.images.map(image => {
      const src = assetPath(image?.src);
      if (!src) return "";
      const alt = typeof image.alt === "string" ? image.alt : "题目配图";
      const caption = Number.isInteger(image.sourcePage) && image.sourcePage > 0 ? `原书 PDF 第 ${image.sourcePage} 页` : "题目配图";
      return `<figure class="question-image"><img src="${escape(src)}" alt="${escape(alt)}" loading="lazy"><figcaption>${escape(caption)}</figcaption></figure>`;
    }).join("");
  }


  function hasTranslation(question) {
    if (translations.entries[question.id]) return true;
    return termPattern && [question.stem, question.sharedStem, ...(question.options || []).map(option => option.text)]
      .some(text => typeof text === "string" && [...text.matchAll(termPattern)].length > 0);
  }

  function translatedText(text, question, field) {
    const original = String(text || "");
    if (!translationVisible) return escape(original);
    const entry = translations.entries[question.id];
    const fullTranslation = field === "stem" || field === "sharedStem" ? entry?.[field] : entry?.options?.[field];
    if (fullTranslation) {
      if (original.includes(fullTranslation)) return escape(original);
      const longSentence = original.length > 70 || original.trim().split(/\s+/).length > 8;
      return `${escape(original)}<span class="${longSentence ? "sentence-translation" : "term-translation"}" lang="zh-CN">${longSentence ? escape(fullTranslation) : `（${escape(fullTranslation)}）`}</span>`;
    }
    if (!termPattern) return escape(original);
    let result = "";
    let position = 0;
    for (const match of original.matchAll(termPattern)) {
      result += escape(original.slice(position, match.index)) + escape(match[0]);
      result += `<span class="term-translation" lang="zh-CN">（${escape(glossary.get(match[0].toLowerCase()))}）</span>`;
      position = match.index + match[0].length;
    }
    return result + escape(original.slice(position));
  }

  function sourcesMarkup(question, info) {
    const status = info.entry?.status;
    const label = reviewFlags.entries?.[question.id]?.status === "needs_review" ? "参考答案 · 待复核，本题不计分" : status === "corrected" ? "修正版答案 · 本次判分采用" : status === "disputed" ? "修正版候选 · 存在争议" : status === "unclear" ? "修正版 · 答案不明" : "练习参考 · 采用原书答案";
    const note = info.entry?.note || "修正版未列出此题的单独修改。请结合教材和授课内容核对。";
    return `<section class="sources" aria-label="答案来源"><h3>答案来源与核对</h3><div class="answer-comparison"><div class="answer-card"><p>原书答案</p><strong>${escape(displayAnswer(info.original))}</strong></div><div class="answer-card"><p>${escape(label)}</p><strong>${escape(status === "unclear" ? "尚未确定" : displayAnswer(info.effective))}</strong></div></div><p class="correction-note">${escape(note)}</p><div class="source-links"><button class="text-button" data-source-pages>查看原始 PDF 页</button><button class="text-button" data-answer-scans>查看扫描答案</button></div><p class="source-description">${question.printedPage ? `原书印刷页码：${escape(question.printedPage)}。` : ""}PDF 页码按文件中的页面顺序计数，与印刷页码可能不同。修订说明来自答案整理资料。</p></section>`;
  }

  function renderQuestion() {
    const question = queue[currentIndex];
    const previousQuestionId = $("notePane").dataset.noteQuestionId || "";
    const previousNoteScroll = activeNoteScroller()?.scrollTop || 0;
    if (!question) {
      const message = state.view.mode === "wrong" ? "当前范围没有错题。可以先在全部题目中练习，答错的题目会自动加入这里。" : state.view.mode === "star" ? "当前范围没有收藏。练习时点击题目右上角的收藏按钮即可加入。" : state.view.mode === "mastered" ? "当前范围没有已熟练的题目。练习时点击“标为已熟练”即可加入，答对不会自动标记。" : state.view.mode === "notes" ? "当前范围没有笔记。在右侧注释栏记录你的思考，之后可在这里复习。" : "当前条件下没有找到题目。可以清除搜索或放宽章节、语言和题型范围。";
      $("questionArea").innerHTML = `<div class="empty"><h3>这里暂时没有题目</h3><p>${message}</p><button class="button" data-reset-filters>查看全部题目</button></div>`;
      $("notePane").dataset.noteQuestionId = "";
      $("notePane").innerHTML = '<header class="note-pane-header"><strong>我的注释</strong></header><div class="note-context">当前筛选范围内没有题目</div><div class="note-content"><p class="note-empty">没有当前题目可供记录注释。</p></div>';
      $("questionNavigation").innerHTML = "";
      $("questionMap").innerHTML = "";
      $("questionScroll").scrollTop = 0;
      $("notePane .note-content")?.scrollTo(0, 0);
      return;
    }
    const record = recordFor(question.id);
    const info = answerInfo(question);
    const revealed = record.submitted || answerRevealed;
    const outcome = resultFor(question);
    const issues = Array.isArray(question.issues) ? question.issues : [];
    const issueMessage = issues.map(issue => typeof issue === "string" ? issue : issue?.note || issue?.message || issue?.type || "录入内容待核对").join("；");
    const notices = [info.reason, issueMessage ? `录入核对提示：${issueMessage}` : ""].filter(Boolean);
    const options = Array.isArray(question.options) ? question.options : [];
    const selectionInput = options.length ? `<div class="options" role="group" aria-label="答案选项">${options.map(option => {
      const key = String(option.key);
      const selected = record.selected.includes(key);
      const correct = revealed && info.gradeable && info.effective.includes(key);
      const wrong = record.submitted && info.gradeable && selected && !correct;
      const mark = correct ? "参考答案" : wrong ? "你的选择" : selected ? "已选择" : "";
      return `<button class="option${selected ? " selected" : ""}${correct ? " correct" : ""}${wrong ? " wrong" : ""}" data-option="${escape(key)}" aria-pressed="${selected}" ${record.submitted || answerRevealed ? "disabled" : ""}><span class="option-key">${escape(key)}</span><span class="option-text">${translatedText(option.text, question, key)}</span><span class="option-mark">${mark}</span></button>`;
    }).join("")}</div>` : `<label class="selection-hint" for="writtenAnswer">你的作答</label><textarea class="answer-input" id="writtenAnswer" placeholder="在这里写下答案或思考……" ${record.submitted || answerRevealed ? "disabled" : ""}>${escape(record.text)}</textarea>`;
    const verdict = record.submitted ? `<div class="verdict ${outcome || "neutral"}" role="status"><strong>${outcome === "correct" ? "回答正确" : outcome === "wrong" ? "本题回答错误" : "已记录作答 · 本题不计分"}</strong><small>${outcome === "neutral" ? escape(info.reason) : `你的答案：${escape(displayAnswer(record.selected))}　参考答案：${escape(displayAnswer(info.effective))}`}</small></div>` : answerRevealed ? '<div class="verdict"><strong>已显示参考答案</strong><small>本次查看不计为作答。点击重新作答后可以继续练习。</small></div>' : "";
    $("questionArea").innerHTML = `<article class="sheet" data-question-id="${escape(question.id)}"><div class="question-head"><span class="tag">${escape(typeNames[question.type] || "待核对题型")}</span><span class="tag">${question.language === "en" ? "English" : "中文"}</span><span class="question-number">第 ${escape(question.number)} 题</span><button class="icon mark-button${record.marked ? " is-marked" : ""}" data-marked aria-pressed="${record.marked}" title="标记课程视频尚未讲到">${record.marked ? "● 视频没讲" : "○ 视频没讲"}</button><button class="icon note-toggle" data-note-toggle aria-pressed="${noteEditing}">${record.note.trim() ? "✎ 有注释" : "✎ 注释"}</button><button class="icon mastery-button" data-mastered aria-pressed="${record.mastered}">${record.mastered ? "取消熟练" : "标为已熟练"}</button><button class="icon source-button" data-source-open>看原页</button><span class="spacer"></span><button class="icon" data-star aria-pressed="${record.star}">${record.star ? "★ 已收藏" : "☆ 收藏"}</button></div>${hasTranslation(question) ? `<div class="translation-control"><button class="button" data-translation aria-pressed="${translationVisible}">${translationVisible ? "隐藏中文翻译" : "显示中文翻译"}</button></div>` : ""}${notices.length ? `<div class="notice">${escape(notices.join("\n"))}</div>` : ""}${question.sharedStem ? `<div class="shared-stem">${translatedText(question.sharedStem, question, "sharedStem")}</div>` : ""}<h3 class="stem">${translatedText(question.stem, question, "stem")}</h3>${questionImagesMarkup(question)}${selectionInput}${!revealed ? `<p class="selection-hint">${question.type === "single" && options.length ? "点击一个选项后自动记录并判题。" : question.type === "multiple" ? "请选择所有符合题意的选项，再提交答案。" : "完成作答后提交，再查看参考答案。"}</p>` : ""}<div class="actions">${!revealed && (question.type !== "single" || !options.length) ? `<button class="button primary" data-submit ${options.length && !record.selected.length ? "disabled" : ""}>提交答案</button>` : ""}${!revealed ? '<button class="button" data-reveal>查看答案</button>' : '<button class="button" data-retry>重新作答</button>'}</div>${verdict}${revealed ? sourcesMarkup(question, info) : ""}</article>`;
    $("notePane").dataset.noteQuestionId = question.id;
    $("notePane").innerHTML = noteMarkup(record, question);
    if (NOTES) NOTES.hydrate($("notePane"));
    $("questionNavigation").innerHTML = `<button class="button" data-prev ${currentIndex === 0 ? "disabled" : ""}>← 上一题</button><span class="spacer"></span><span class="position">${currentIndex + 1} / ${queue.length}</span><span class="spacer"></span><button class="button primary" data-next ${currentIndex >= queue.length - 1 ? "disabled" : ""}>下一题 →</button>`;
    if (previousQuestionId === question.id) activeNoteScroller().scrollTop = previousNoteScroll;
    else {
      $("questionScroll").scrollTop = 0;
      activeNoteScroller()?.scrollTo(0, 0);
    }
    renderMap();
  }

  function renderMap() {
    const start = mapPage * PAGE_SIZE;
    const list = queue.slice(start, start + PAGE_SIZE);
    const cells = list.map((question, offset) => {
      const result = resultFor(question);
      const record = recordFor(question.id);
      const title = `${question.chapterName} · ${question.language === "en" ? "英文" : "中文"} · ${typeNames[question.type] || "题目"}第 ${question.number} 题${result ? " · " + ({ correct: "已答对", wrong: "已答错", neutral: "已作答，未计分" }[result]) : ""}`;
      return `<button class="map-cell ${result || ""}${record.star ? " star" : ""}${record.marked ? " marked" : ""}" data-jump="${start + offset}" aria-current="${start + offset === currentIndex}" aria-label="${escape(title)}${record.marked ? " · 视频未讲" : ""}" title="${escape(title)}">${start + offset + 1}</button>`;
    }).join("");
    $("questionMap").innerHTML = `<div class="map-header"><h3>题号导航 <span class="selection-hint">· 数字为当前练习顺序</span></h3><div class="map-legend"><span><i class="dot correct"></i>答对</span><span><i class="dot wrong"></i>答错</span><span><i class="dot neutral"></i>未计分</span><span><i class="dot"></i>未答</span></div></div><div class="map-cells">${cells}</div>${queue.length > PAGE_SIZE ? `<div class="map-pages"><button class="icon" data-map-prev ${mapPage === 0 ? "disabled" : ""}>上一组</button><span>${start + 1}–${Math.min(start + PAGE_SIZE, queue.length)} / ${queue.length}</span><button class="icon" data-map-next ${start + PAGE_SIZE >= queue.length ? "disabled" : ""}>下一组</button></div>` : ""}`;
  }

  function render() {
    renderSidebar();
    const chapter = chapterById.get(state.view.chapterId);
    $("chapterTitle").textContent = chapter ? `第 ${chapter.number} 章 ${chapter.name}` : "全部章节";
    $("chapterSubtitle").textContent = `${data.title || "病理学题库"} · ${modeNames[state.view.mode]}`;
    const exportLabel = state.view.mode === "marked" ? `导出 ${queue.length} 道视频没讲的题` : state.view.mode === "notes" ? `导出 ${queue.length} 道有注释的题` : "";
    $("scopeSummary").innerHTML = `<span><strong>${modeNames[state.view.mode]}</strong> · ${state.view.language === "all" ? "中英文" : state.view.language === "en" ? "英文" : "中文"} · ${queue.length} 题</span><span>${state.view.order === "random" ? "随机顺序，选项保持原序" : "按原书顺序练习"}${exportLabel ? ` <button class="button primary collection-export" data-export-collection>${exportLabel}</button>` : ""}</span>`;
    $("typeFilter").value = state.view.type;
    $("order").value = state.view.order;
    $("search").value = state.view.search;
    $("clearSearch").hidden = !state.view.search;
    $("reshuffle").hidden = state.view.order !== "random";
    renderQuestion();
  }

  function flushNote(noteInput = $("questionNote"), answer = $("writtenAnswer"), questionId = questionIdFor(noteInput) || questionIdFor(answer) || $("questionArea").querySelector("[data-question-id]")?.dataset.questionId) {
    clearTimeout(noteSaveTimer);
    if (questionId && questionById.has(questionId) && noteInput && noteInput.value !== recordFor(questionId).note) changeRecord(questionId, { note: noteInput.value });
    if (questionId && questionById.has(questionId) && answer && answer.value !== recordFor(questionId).text) changeRecord(questionId, { text: answer.value });
    if (noteInput?.isConnected && $("noteLivePreview")) {
      $("noteLivePreview").innerHTML = NOTES ? NOTES.render(noteInput.value) : escape(noteInput.value);
      if (NOTES) NOTES.hydrate($("noteLivePreview"));
    }
  }

  function navigate(index) {
    if (index < 0 || index >= queue.length) return;
    flushNote();
    currentIndex = index;
    answerRevealed = false;
    translationVisible = false;
    noteEditing = false;
    notePreviewMode = false;
    state.view.currentId = queue[index].id;
    state.lastQuestionId = queue[index].id;
    state.viewUpdatedAt = Date.now();
    mapPage = Math.floor(index / PAGE_SIZE);
    persist();
    renderQuestion();
    $("questionScroll").scrollTop = 0;
    activeNoteScroller()?.scrollTo(0, 0);
  }

  function submit() {
    const question = queue[currentIndex];
    if (!question) return;
    flushNote();
    const record = recordFor(question.id);
    if (question.options?.length && !record.selected.length) { toast("请先选择答案。"); return; }
    if (!question.options?.length && !record.text.trim()) { toast("请先写下你的答案。"); return; }
    changeRecord(question.id, { submitted: true });
    const result = resultFor(question);
    changeRecord(question.id, { result });
    state.lastQuestionId = question.id;
    persist();
    renderSidebar();
    renderQuestion();
  }

  function selectOption(key) {
    const question = queue[currentIndex];
    if (!question || recordFor(question.id).submitted || answerRevealed) return;
    flushNote();
    const selected = recordFor(question.id).selected;
    const next = question.type === "multiple" ? selected.includes(key) ? selected.filter(item => item !== key) : [...selected, key] : [key];
    changeRecord(question.id, { selected: next });
    if (question.type === "single") submit();
    else renderQuestion();
  }

  function closeMenu() {
    $("rail").classList.remove("open");
    $("drawerShade").hidden = true;
    $("openMenu").setAttribute("aria-expanded", "false");
  }

  function sourcePage(question, kind) {
    const pages = kind === "answer" ? question.answerSourcePages : question.sourcePages;
    return Array.isArray(pages) ? pages.find(page => Number.isInteger(page) && page > 0) || 1 : 1;
  }

  function pageNumber(value, maximum) {
    return Math.max(1, Math.min(maximum, Number.parseInt(value, 10) || 1));
  }

  function updateOriginalPage(value) {
    const page = pageNumber(value, 382);
    $("originalPage").value = page;
    $("originalPageImage").src = "assets/pages/original/" + page + ".webp";
    $("originalPdf").href = "assets/pathology-source.pdf#page=" + page;
  }

  function updateAnswerPage(value) {
    const corrected = answerDocument === "corrected";
    const maximum = corrected ? 12 : 382;
    const page = pageNumber(value, maximum);
    const documentPath = corrected ? corrections.sourcePdf || "assets/corrected-answers-source.pdf" : "assets/pathology-source.pdf";
    const imageDirectory = corrected ? "corrected" : "original";
    $("answerPage").value = page;
    $("answerPageImage").src = "assets/pages/" + imageDirectory + "/" + page + ".webp";
    $("answerPdf").href = documentPath + "#page=" + page;
    $("answerPdf").textContent = corrected ? "打开修正版 PDF" : "打开原始 PDF";
  }

  function openSourcePages(question) {
    const dialog = $("sourceDialog");
    if (!question || !dialog) return;
    sourceQuestion = question;
    answerDocument = "original";
    const originalPage = sourcePage(question, "original");
    const answerPage = sourcePage(question, "answer");
    $("originalPage").value = originalPage;
    $("originalPage").max = "382";
    $("originalPageLabel").firstChild.textContent = "原题 PDF 页码 ";
    $("answerPage").value = answerPage;
    updateOriginalPage(originalPage);
    updateAnswerDocument("original");
    dialog.querySelector("[data-dialog-title]").textContent = `原题与原书答案 · 第 ${question.number} 题`;
    $("sourceHint").textContent = "左右两栏均显示原始题库 PDF。可切换右栏查看答案修正版 PDF和本章扫描答案。";
    showDialog(dialog);
  }

  function showDialog(dialog) {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function openAnswerScans(question) {
    if (!question) return;
    const chapter = String(question.chapterId || "").match(/^ch(\d{2})$/)?.[1];
    const dialog = $("scanDialog");
    if (!chapter || !dialog) return;
    const chapterEntry = corrections.chapters?.[question.chapterId];
    const entryImage = corrections.entries?.[question.id]?.image;
    const images = [...new Set([entryImage, chapterEntry?.images?.[question.language], chapterEntry?.images?.zh, chapterEntry?.images?.en].filter(path => typeof path === "string" && /^assets\/answers\/[A-Za-z0-9_.-]+\.png$/.test(path)))];
    const container = $("scanImages");
    container.innerHTML = images.map((src, index) => `<figure><img src="${escape(src)}" alt="第 ${Number(chapter)} 章扫描答案 ${index + 1}" loading="lazy"><figcaption>第 ${Number(chapter)} 章扫描答案 ${index + 1}</figcaption></figure>`).join("") || "<p>此题暂时没有对应的扫描答案图片。</p>";
    for (const image of container.querySelectorAll("img")) image.addEventListener("error", () => image.closest("figure")?.remove(), { once: true });
    dialog.querySelector("[data-dialog-title]").textContent = `扫描答案 · 第 ${Number(chapter)} 章`;
    showDialog(dialog);
  }

  function exportQuestionText(question) {
    if (!question || !NOTES) return;
    flushNote();
    const record = recordFor(question.id);
    const info = answerInfo(question);
    const entry = info.entry;
    const status = reviewFlags.entries?.[question.id]?.status === "needs_review" ? "参考答案待复核，本题不计分。" : info.reason ? `本题不计分：${info.reason}` : entry?.status === "disputed" ? "修正版候选答案（存在争议，未作为标准答案）：" : entry?.status === "corrected" ? "修正版明确订正（练习判分采用）：" : entry?.status === "unclear" ? "修正版未能确定答案，本题不计分。" : "练习参考答案（按原书答案）：";
    const lines = [`# ${question.chapterName} · 第 ${question.number} 题`, "", question.sharedStem || "", question.stem || ""];
    for (const option of question.options || []) lines.push(`- ${option.key}. ${option.text}`);
    lines.push("", `原书答案：${displayAnswer(info.original) || "未提供"}`, "", status, displayAnswer(info.effective) || "未提供");
    if (entry?.note) lines.push("", `修订说明：${entry.note}`);
    if (question.images?.length) lines.push("", `题目配图：${question.images.map(image => `${image.alt || "配图"}${image.sourcePage ? `（原书第 ${image.sourcePage} 页）` : ""}`).join("；")}。图片未嵌入此文本导出。`);
    if (record.text) lines.push("", "我的作答：", record.text);
    if (record.note) lines.push("", "我的笔记：", record.note);
    NOTES.showTextExport(lines.filter((line, index) => line || index === 0).join("\n"), `第${question.number}题`);
  }

  function exportCollectionText() {
    const kind = state.view.mode === "marked" ? "marked" : state.view.mode === "notes" ? "notes" : "";
    if (!kind || !NOTES) return;
    flushNote();
    const title = kind === "marked" ? "视频没讲" : "注释题目";
    const lines = [`以下是病理学题库中${kind === "marked" ? "标记为视频没讲" : "记录过注释"}的题目，共 ${queue.length} 道。`, ""];
    queue.forEach((question, index) => {
      const record = recordFor(question.id);
      const info = answerInfo(question);
      const entry = info.entry;
      lines.push(`## ${index + 1}. ${question.chapterName} · 第 ${question.number} 题`, "", question.sharedStem || "", question.stem || "");
      for (const option of question.options || []) lines.push(`- ${option.key}. ${option.text}`);
      lines.push("", `原书答案：${displayAnswer(info.original) || "未提供"}`);
      const status = reviewFlags.entries?.[question.id]?.status === "needs_review" ? "参考答案待复核，本题不计分。" : info.reason ? `本题不计分：${info.reason}` : entry?.status === "disputed" ? "修正版候选答案（存在争议，未作为标准答案）：" : entry?.status === "corrected" ? "修正版明确订正（练习判分采用）：" : entry?.status === "unclear" ? "修正版未能确定答案，本题不计分。" : "练习参考答案（按原书答案）：";
      lines.push(status, displayAnswer(info.effective) || "未提供");
      if (entry?.note) lines.push(`修订说明：${entry.note}`);
      if (question.images?.length) lines.push(`题目配图：${question.images.map(image => `${image.alt || "配图"}${image.sourcePage ? `（原书第 ${image.sourcePage} 页）` : ""}`).join("；")}。图片未嵌入此文本导出。`);
      if (record.note) lines.push("", `我的注释：${record.note.replace(/!\[[^\]]*\]\(img:[^)]+\)/g, "[图片]")}`);
      lines.push("");
    });
    NOTES.showTextExport(lines.join("\n").trim(), `导出${title}（${queue.length}题）`);
  }

  /*
   * 图片存储可能在用户切题或重新渲染后才完成。
   * 只有当前右栏仍属于原题时，才刷新可见编辑器；否则只更新原题记录。
   * 同题重新渲染时先读取新编辑器，避免覆盖异步期间新增的文字。
   */
  async function insertNoteImages(files, questionId, editor) {
    if (!NOTES || !questionId || !editor) return;
    const images = [...files].filter(file => file && /^image\//i.test(file.type));
    if (!images.length) return;
    flushNote(editor, null, questionId);
    try {
      for (const file of images) {
        const imageId = await NOTES.storeImage(file);
        const isCurrentQuestion = $("notePane").dataset.noteQuestionId === questionId;
        const currentEditor = isCurrentQuestion ? $("notePane").querySelector("#questionNote") : null;
        if (currentEditor) flushNote(currentEditor, null, questionId);
        const current = recordFor(questionId).note;
        const insertion = `![${file.name.replace(/[\[\]]/g, "")}](img:${imageId})`;
        const note = current ? `${current}${current.endsWith("\n") ? "" : "\n"}${insertion}` : insertion;
        changeRecord(questionId, { note });
        if (isCurrentQuestion) {
          if (currentEditor) currentEditor.value = note;
          const preview = $("notePane").querySelector(noteEditing ? "#noteLivePreview" : "#notePreview");
          if (preview) {
            preview.innerHTML = NOTES.render(note);
            NOTES.hydrate(preview);
          }
        }
      }
      if ($("notePane").dataset.noteQuestionId === questionId && $("noteStatus")) $("noteStatus").textContent = "图片与笔记已保存";
      toast(`${images.length} 张图片已加入笔记并保存在当前浏览器。`);
    } catch (error) { toast(`无法插入图片：${error.message || "请检查图片格式和浏览器存储空间。"}`); }
  }

  $("originalPage").addEventListener("change", event => updateOriginalPage(event.target.value));
  $("originalPage").addEventListener("keydown", event => { if (event.key === "Enter") updateOriginalPage(event.target.value); });
  function updateAnswerDocument(documentType) {
    if (!sourceQuestion) return;
    answerDocument = documentType;
    const original = documentType === "original";
    const chapterPage = corrections.chapters?.[sourceQuestion.chapterId]?.pdfPage || 1;
    const page = original ? sourcePage(sourceQuestion, "answer") : chapterPage;
    $("answerPage").max = original ? "382" : "12";
    $("answerPageLabel").firstChild.textContent = original ? "原书答案页码 " : "修正版 PDF 页码 ";
    $("answerPage").value = page;
    $("answerPdf").title = original ? "病理题库原始 PDF 答案页面" : "病理题库答案修正版 PDF 页面";
    updateAnswerPage(page);
    $("sourceHint").textContent = original ? "左右两栏均显示原始题库 PDF，右栏为本题原书答案页。" : "左栏为原始题目页，右栏为答案修正版 PDF。页码按 PDF 文件顺序计算。";
  }
  $("answerPage").addEventListener("change", event => updateAnswerPage(event.target.value));
  $("answerPage").addEventListener("keydown", event => { if (event.key === "Enter") updateAnswerPage(event.target.value); });
  document.addEventListener("click", event => {
    const close = event.target.closest("[data-close-dialog]");
    if (close) close.closest("dialog")?.close();
    const documentButton = event.target.closest("[data-answer-doc]");
    if (documentButton) updateAnswerDocument(documentButton.dataset.answerDoc);
    const pageButton = event.target.closest("[data-page-prev], [data-page-next]");
    if (pageButton) {
      const isOriginal = pageButton.dataset.pagePrev === "original" || pageButton.dataset.pageNext === "original";
      const field = isOriginal ? "originalPage" : "answerPage";
      const direction = pageButton.dataset.pagePrev ? -1 : 1;
      const page = pageNumber($(field).value, Number($(field).max));
      const adjusted = pageNumber(page + direction, Number($(field).max));
      if (isOriginal) updateOriginalPage(adjusted);
      else updateAnswerPage(adjusted);
    }
  });
  $("notePane").addEventListener("change", async event => {
    if (event.target.id !== "noteImageFile") return;
    const files = [...event.target.files];
    event.target.value = "";
    const questionId = questionIdFor(event.target);
    const card = event.target.closest("[data-note-question-id]");
    const editor = card?.querySelector("#questionNote");
    insertNoteImages(files || [], questionId, editor);
  });
  $("notePane").addEventListener("paste", event => {
    if (event.target.id !== "questionNote") return;
    const files = [...(event.clipboardData?.items || [])].map(item => item.kind === "file" ? item.getAsFile() : null).filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    insertNoteImages(files, questionIdFor(event.target), event.target);
  });
  $("notePane").addEventListener("dragover", event => { if (event.target.closest("#questionNote")) { event.preventDefault(); event.target.closest("#questionNote").classList.add("drag"); } });
  $("notePane").addEventListener("dragleave", event => { if (event.target.closest("#questionNote")) event.target.closest("#questionNote").classList.remove("drag"); });
  $("notePane").addEventListener("drop", event => {
    const editor = event.target.closest("#questionNote");
    if (!editor) return;
    event.preventDefault(); editor.classList.remove("drag");
    insertNoteImages(event.dataTransfer?.files || [], questionIdFor(editor), editor);
  });

  document.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    if (button.dataset.mode) { setFilter("mode", button.dataset.mode); closeMenu(); }
    else if (own(button.dataset, "orderToggle")) { state.view.order = state.view.order === "random" ? "sequential" : "random"; state.view.seed = Date.now(); state.viewUpdatedAt = Date.now(); rebuildQueue(); }
    else if (button.dataset.language) setFilter("language", button.dataset.language);
    else if (button.dataset.chapter) { setFilter("chapterId", button.dataset.chapter); closeMenu(); }
    else if (own(button.dataset, "option")) selectOption(button.dataset.option);
    else if (own(button.dataset, "translation")) { flushNote(); translationVisible = !translationVisible; renderQuestion(); }
    else if (own(button.dataset, "marked")) {
      flushNote();
      const question = queue[currentIndex];
      changeRecord(question.id, { marked: !recordFor(question.id).marked });
      rebuildQueue(question.id);
    }
    else if (own(button.dataset, "mastered")) {
      flushNote();
      const question = queue[currentIndex];
      if (!question) return;
      changeRecord(question.id, { mastered: !recordFor(question.id).mastered });
      rebuildQueue(question.id);
    }
    else if (own(button.dataset, "sourcePages")) openSourcePages(queue[currentIndex]);
    else if (own(button.dataset, "answerScans")) openAnswerScans(queue[currentIndex]);
    else if (own(button.dataset, "sourceOpen")) openSourcePages(queue[currentIndex]);
    else if (own(button.dataset, "scanOpen")) openAnswerScans(queue[currentIndex]);
    else if (own(button.dataset, "exportText")) exportQuestionText(queue[currentIndex]);
    else if (own(button.dataset, "exportCollection")) exportCollectionText();
    else if (own(button.dataset, "noteToggle") || own(button.dataset, "noteEdit")) { flushNote(); noteEditing = true; notePreviewMode = false; renderQuestion(); $("questionNote")?.focus(); }
    else if (own(button.dataset, "noteDone")) { flushNote(); noteEditing = false; notePreviewMode = false; renderSidebar(); renderQuestion(); }
    else if (own(button.dataset, "notePreview")) { flushNote(); notePreviewMode = !notePreviewMode; renderQuestion(); }
    else if (own(button.dataset, "noteImage")) $("noteImageFile").click();
    else if (own(button.dataset, "star")) {
      flushNote();
      const question = queue[currentIndex];
      changeRecord(question.id, { star: !recordFor(question.id).star });
      renderSidebar(); renderQuestion();
    } else if (own(button.dataset, "submit")) submit();
    else if (own(button.dataset, "reveal")) { flushNote(); answerRevealed = true; renderQuestion(); }
    else if (own(button.dataset, "retry")) { flushNote(); const question = queue[currentIndex]; changeRecord(question.id, { selected: [], text: "", submitted: false, result: null }); answerRevealed = false; renderSidebar(); renderQuestion(); }
    else if (own(button.dataset, "prev")) navigate(currentIndex - 1);
    else if (own(button.dataset, "next")) navigate(currentIndex + 1);
    else if (own(button.dataset, "jump")) navigate(Number(button.dataset.jump));
    else if (own(button.dataset, "mapPrev")) { mapPage--; renderMap(); }
    else if (own(button.dataset, "mapNext")) { mapPage++; renderMap(); }
    else if (own(button.dataset, "resetFilters")) { flushNote(); Object.assign(state.view, { chapterId: "all", language: "all", type: "all", mode: "all", search: "" }); rebuildQueue(); }

  });

  $("typeFilter").addEventListener("change", event => setFilter("type", event.target.value));
  $("order").addEventListener("change", event => setFilter("order", event.target.value));
  $("reshuffle").addEventListener("click", () => { state.view.seed = Date.now(); state.viewUpdatedAt = Date.now(); rebuildQueue(); toast("练习顺序已重新打乱。"); });
  $("search").addEventListener("input", event => { clearTimeout(searchTimer); const text = event.target.value; searchTimer = setTimeout(() => setFilter("search", text), 220); });
  $("clearSearch").addEventListener("click", () => { clearTimeout(searchTimer); setFilter("search", ""); $("search").focus(); });
  $("theme").addEventListener("click", () => { state.theme = state.theme === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = state.theme; persist(); renderSidebar(); });
  $("openMenu").addEventListener("click", () => { $("rail").classList.add("open"); $("drawerShade").hidden = false; $("openMenu").setAttribute("aria-expanded", "true"); });
  $("closeMenu").addEventListener("click", closeMenu);
  $("drawerShade").addEventListener("click", closeMenu);
  $("resume").addEventListener("click", () => {
    flushNote();
    const id = state.lastQuestionId || state.view.currentId;
    const question = questionById.get(id);
    if (!question) { toast("还没有学习进度。请选择章节开始练习。"); return; }
    Object.assign(state.view, { chapterId: question.chapterId, language: question.language, type: "all", mode: "all", search: "", currentId: id });
    state.viewUpdatedAt = Date.now();
    rebuildQueue(id); closeMenu(); $("stage").scrollTop = 0; toast("已回到上次学习的题目。");
  });

  document.addEventListener("input", event => {
    if (event.target.id !== "questionNote" && event.target.id !== "writtenAnswer") return;
    clearTimeout(noteSaveTimer);
    const input = event.target;
    const questionId = questionIdFor(input);
    if (input.id === "questionNote" && $("notePreview")) {
      const livePreview = $("noteLivePreview");
      livePreview.innerHTML = NOTES ? NOTES.render(input.value) : escape(input.value);
      if (NOTES) NOTES.hydrate(livePreview);
    }
    if ($("noteStatus")) $("noteStatus").textContent = "正在保存……";
    noteSaveTimer = setTimeout(() => {
      flushNote(input.id === "questionNote" ? input : null, input.id === "writtenAnswer" ? input : null, questionId);
      if (input.isConnected && $("noteStatus")) $("noteStatus").textContent = storageAvailable ? "已保存在当前浏览器" : "已临时记录，请及时导出";
      renderSidebar();
    }, 350);
  });

  $("exportRecords").addEventListener("click", async () => {
    flushNote();
    const recordsSnapshot = JSON.parse(JSON.stringify(state.records));
    const viewSnapshot = { ...state.view };
    const themeSnapshot = state.theme;
    const lastQuestionIdSnapshot = state.lastQuestionId;
    const viewUpdatedAtSnapshot = state.viewUpdatedAt;
    let images = {};
    if (NOTES) {
      const result = await NOTES.exportImages(recordsSnapshot);
      images = result.images;
      if (result.missing.length) toast(`有 ${result.missing.length} 张笔记图片无法读取，备份中会保留其余图片。`);
    }
    const backup = { format: RECORD_FORMAT, version: 2, exportedAt: new Date().toISOString(), dataVersion: data.version, records: recordsSnapshot, images, view: viewSnapshot, theme: themeSnapshot, lastQuestionId: lastQuestionIdSnapshot, viewUpdatedAt: viewUpdatedAtSnapshot };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = `病理学习记录-${new Date().toISOString().slice(0, 10)}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("学习记录已导出，包含作答、收藏、标记、Markdown 笔记和可读取的笔记图片。");
  });
  $("importRecords").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", async event => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) { toast("记录文件超过 100 MB，无法导入。请使用本站导出的 JSON 文件。"); return; }
    try {
      const backup = JSON.parse(await file.text());
      if (!backup || backup.format !== RECORD_FORMAT || ![1, 2].includes(backup.version) || !backup.records || typeof backup.records !== "object" || Array.isArray(backup.records)) throw new Error("invalid backup");
      if (backup.version === 2 && (!backup.images || typeof backup.images !== "object" || Array.isArray(backup.images))) throw new Error("invalid images");
      const images = backup.version === 2 ? validateBackupImages(backup.images) : [];
      flushNote();
      const incomingViewTime = Number.isFinite(backup.viewUpdatedAt) && backup.viewUpdatedAt > 0 ? backup.viewUpdatedAt : Date.parse(backup.exportedAt || "") || 0;
      const importedImages = NOTES && images.length ? await NOTES.importImages(Object.fromEntries(images)) : 0;
      const hadLocalProgress = Object.keys(state.records).length > 0 || Boolean(state.lastQuestionId);
      let imported = 0;
      let retained = 0;
      let unknown = 0;
      for (const [id, raw] of Object.entries(backup.records)) {
        if (!questionById.has(id)) { unknown++; continue; }
        const incoming = normalizedRecord(raw);
        if (!incoming) { unknown++; continue; }
        const local = state.records[id];
        if (!local || incoming.updatedAt > local.updatedAt) { state.records[id] = incoming; imported++; }
        else retained++;
      }
      const view = backup.view;
      const viewIsValid = view && typeof view === "object" && !Array.isArray(view) &&
        (view.chapterId === "all" || chapterById.has(view.chapterId)) && ["all", "zh", "en"].includes(view.language) &&
        ["all", "single", "multiple", "text"].includes(view.type) && own(modeNames, view.mode) &&
        ["sequential", "random"].includes(view.order) && typeof view.search === "string" && view.search.length <= 200 &&
        Number.isFinite(view.seed) && (view.currentId === "" || questionById.has(view.currentId));
      const localViewIsEmpty = !hadLocalProgress && state.viewUpdatedAt === 0;
      if (viewIsValid && (localViewIsEmpty || incomingViewTime > state.viewUpdatedAt)) {
        state.view = { ...state.view, ...view };
        state.theme = backup.theme === "dark" ? "dark" : "light";
        state.lastQuestionId = typeof backup.lastQuestionId === "string" && questionById.has(backup.lastQuestionId) ? backup.lastQuestionId : "";
        state.viewUpdatedAt = incomingViewTime || Date.now();
        document.documentElement.dataset.theme = state.theme;
      }
      persist(); rebuildQueue();
      toast(`已合并 ${imported} 道题的记录，导入 ${importedImages} 张图片；保留 ${retained} 道题现有的较新记录。${unknown ? `另有 ${unknown} 条记录不属于当前题库或格式无效。` : ""}`);
    } catch (error) { toast(error.message === "backup image signature mismatch" || error.message === "invalid backup image" ? "导入文件中的图片格式或内容无效，未合并学习记录。" : "无法导入：请选择本站导出的病理学习记录 JSON 文件，并确认其图片数据完整。"); }
  });

  document.addEventListener("keydown", event => {
    if (event.target.closest("dialog[open]")) return;
    if (event.key === "Escape") { closeMenu(); return; }
    if ($("rail").classList.contains("open") || event.ctrlKey || event.altKey || event.metaKey || event.target.closest("input,textarea,select,[contenteditable]")) return;
    if (event.key === "ArrowLeft") { event.preventDefault(); navigate(currentIndex - 1); }
    else if (event.key === "ArrowRight") { event.preventDefault(); navigate(currentIndex + 1); }
    else if (/^[1-9]$/.test(event.key)) { const option = queue[currentIndex]?.options?.[Number(event.key) - 1]; if (option) { event.preventDefault(); selectOption(String(option.key)); } }
    else if (event.key === "Enter" && queue[currentIndex]?.type === "multiple" && !recordFor(queue[currentIndex].id).submitted && !answerRevealed) { event.preventDefault(); submit(); }
  });
  window.addEventListener("pagehide", () => flushNote());
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushNote(); });
  rebuildQueue();
})();
