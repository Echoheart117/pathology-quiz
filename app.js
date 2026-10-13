(() => {
  "use strict";

  const STORAGE_KEY = "pathology-study-v1";
  const RECORD_FORMAT = "pathology-study-records";
  const PAGE_SIZE = 120;
  const typeNames = { single: "单选题", multiple: "多选题", text: "文字题" };
  const modeNames = { all: "全部题目", wrong: "错题复习", star: "我的收藏", notes: "我的笔记" };
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const answerList = value => Array.isArray(value) ? value.map(String).filter(Boolean) : value == null || value === "" ? [] : [String(value)];
  const displayAnswer = value => answerList(value).join("、") || "未提供明确答案";
  const data = window.PATHOLOGY_DATA;
  const corrections = window.PATHOLOGY_CORRECTIONS || { entries: {}, chapters: {} };
  let state = { records: {}, view: { chapterId: "all", language: "all", type: "all", mode: "all", order: "sequential", search: "", currentId: "", seed: Date.now() }, theme: "light", lastQuestionId: "" };
  let storageAvailable = true;
  let queue = [];
  let currentIndex = 0;
  let mapPage = 0;
  let answerRevealed = false;
  let noteSaveTimer;
  let searchTimer;
  let toastTimer;
  let lastTimestamp = Date.now();

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
      note: typeof raw.note === "string" ? raw.note.slice(0, 100000) : "",
      updatedAt: Number.isFinite(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : 0
    };
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
    return state.records[id] || { selected: [], text: "", submitted: false, result: null, star: false, note: "", updatedAt: 0 };
  }

  function changeRecord(id, changes) {
    lastTimestamp = Math.max(Date.now(), lastTimestamp + 1, recordFor(id).updatedAt + 1);
    state.records[id] = { ...recordFor(id), ...changes, updatedAt: lastTimestamp };
    persist();
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
    return state.view.mode === "all" || state.view.mode === "wrong" && resultFor(question) === "wrong" || state.view.mode === "star" && record.star || state.view.mode === "notes" && Boolean(record.note.trim());
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
    state.view.currentId = queue[currentIndex]?.id || "";
    persist();
    render();
  }

  function setFilter(name, value) {
    flushNote();
    state.view[name] = value;
    rebuildQueue();
  }

  function renderSidebar() {
    const stats = statistics(questions);
    const graded = stats.correct + stats.wrong;
    const accuracy = graded ? `${Math.round(stats.correct / graded * 100)}%` : "—";
    $("overview").innerHTML = `<div class="overview-top"><span>已作答 <strong>${stats.answered}</strong> / ${stats.total}</span><span>学习进度</span></div><div class="overall-bar"><i style="width:${stats.total ? stats.answered / stats.total * 100 : 0}%"></i></div><div class="overview-bottom"><span>正确率 <b>${accuracy}</b></span><span>计分 <b>${graded}</b> 题</span><span>自查 <b>${stats.neutral}</b> 题</span></div>`;
    $("modes").innerHTML = Object.entries(modeNames).map(([mode, label]) => `<button class="mode-button" data-mode="${mode}" aria-pressed="${state.view.mode === mode}"><span>${label}</span><small>${mode === "all" ? stats.total : mode === "wrong" ? stats.wrong : mode === "star" ? stats.star : stats.notes}</small></button>`).join("");
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


  function sourcesMarkup(question, info) {
    const status = info.entry?.status;
    const label = status === "corrected" ? "修正版答案 · 本次判分采用" : status === "disputed" ? "修正版候选 · 存在争议" : status === "unclear" ? "修正版 · 答案不明" : "练习参考 · 采用原书答案";
    const note = info.entry?.note || "修正版未列出此题的单独修改。请结合教材和授课内容核对。";
    return `<section class="sources" aria-label="答案来源"><h3>答案来源与核对</h3><div class="answer-comparison"><div class="answer-card"><p>原书答案</p><strong>${escape(displayAnswer(info.original))}</strong></div><div class="answer-card"><p>${escape(label)}</p><strong>${escape(status === "unclear" ? "尚未确定" : displayAnswer(info.effective))}</strong></div></div><p class="correction-note">${escape(note)}</p><p class="source-description">${question.printedPage ? `原书印刷页码：${escape(question.printedPage)}。` : ""}PDF 页码按文件中的页面顺序计数，与印刷页码可能不同。修订说明来自答案整理资料。</p></section>`;
  }

  function renderQuestion() {
    const question = queue[currentIndex];
    if (!question) {
      const message = state.view.mode === "wrong" ? "当前范围没有错题。可以先在全部题目中练习，答错的题目会自动加入这里。" : state.view.mode === "star" ? "当前范围没有收藏。练习时点击题目右上角的收藏按钮即可加入。" : state.view.mode === "notes" ? "当前范围没有笔记。在题目下方记录你的思考，之后可在这里复习。" : "当前条件下没有找到题目。可以清除搜索或放宽章节、语言和题型范围。";
      $("questionArea").innerHTML = `<div class="empty"><h3>这里暂时没有题目</h3><p>${message}</p><button class="button" data-reset-filters>查看全部题目</button></div>`;
      $("questionNavigation").innerHTML = "";
      $("questionMap").innerHTML = "";
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
      return `<button class="option${selected ? " selected" : ""}${correct ? " correct" : ""}${wrong ? " wrong" : ""}" data-option="${escape(key)}" aria-pressed="${selected}" ${record.submitted || answerRevealed ? "disabled" : ""}><span class="option-key">${escape(key)}</span><span class="option-text">${escape(option.text)}</span><span class="option-mark">${mark}</span></button>`;
    }).join("")}</div>` : `<label class="selection-hint" for="writtenAnswer">你的作答</label><textarea class="answer-input" id="writtenAnswer" placeholder="在这里写下答案或思考……" ${record.submitted || answerRevealed ? "disabled" : ""}>${escape(record.text)}</textarea>`;
    const verdict = record.submitted ? `<div class="verdict ${outcome || "neutral"}" role="status"><strong>${outcome === "correct" ? "回答正确" : outcome === "wrong" ? "本题回答错误" : "已记录作答 · 本题不计分"}</strong><small>${outcome === "neutral" ? escape(info.reason) : `你的答案：${escape(displayAnswer(record.selected))}　参考答案：${escape(displayAnswer(info.effective))}`}</small></div>` : answerRevealed ? '<div class="verdict"><strong>已显示参考答案</strong><small>本次查看不计为作答。点击重新作答后可以继续练习。</small></div>' : "";
    $("questionArea").innerHTML = `<article class="sheet" data-question-id="${escape(question.id)}"><div class="question-head"><span class="tag">${escape(typeNames[question.type] || "待核对题型")}</span><span class="tag">${question.language === "en" ? "English" : "中文"}</span><span class="question-number">第 ${escape(question.number)} 题</span><span class="spacer"></span><button class="icon" data-star aria-pressed="${record.star}">${record.star ? "★ 已收藏" : "☆ 收藏"}</button></div>${notices.length ? `<div class="notice">${escape(notices.join("\n"))}</div>` : ""}${question.sharedStem ? `<div class="shared-stem">${escape(question.sharedStem)}</div>` : ""}<h3 class="stem">${escape(question.stem)}</h3>${questionImagesMarkup(question)}${selectionInput}${!revealed ? `<p class="selection-hint">${question.type === "single" && options.length ? "点击一个选项后自动记录并判题。" : question.type === "multiple" ? "请选择所有符合题意的选项，再提交答案。" : "完成作答后提交，再查看参考答案。"}</p>` : ""}<div class="actions">${!revealed && (question.type !== "single" || !options.length) ? `<button class="button primary" data-submit ${options.length && !record.selected.length ? "disabled" : ""}>提交答案</button>` : ""}${!revealed ? '<button class="button" data-reveal>查看答案</button>' : '<button class="button" data-retry>重新作答</button>'}</div>${verdict}${revealed ? sourcesMarkup(question, info) : ""}<div class="note-box"><div class="note-header"><label for="questionNote">我的笔记</label><span id="noteStatus">${storageAvailable ? "输入后自动保存" : "临时保存，请导出记录"}</span></div><textarea class="note-input" id="questionNote" placeholder="记录教材依据、容易混淆的知识点或仍需核对的问题……">${escape(record.note)}</textarea></div></article>`;
    $("questionNavigation").innerHTML = `<button class="button" data-prev ${currentIndex === 0 ? "disabled" : ""}>← 上一题</button><span class="spacer"></span><span class="position">${currentIndex + 1} / ${queue.length}</span><span class="spacer"></span><button class="button primary" data-next ${currentIndex >= queue.length - 1 ? "disabled" : ""}>下一题 →</button>`;
    renderMap();
  }

  function renderMap() {
    const start = mapPage * PAGE_SIZE;
    const list = queue.slice(start, start + PAGE_SIZE);
    const cells = list.map((question, offset) => {
      const result = resultFor(question);
      const record = recordFor(question.id);
      const title = `${question.chapterName} · ${question.language === "en" ? "英文" : "中文"} · ${typeNames[question.type] || "题目"}第 ${question.number} 题${result ? " · " + ({ correct: "已答对", wrong: "已答错", neutral: "已作答，未计分" }[result]) : ""}`;
      return `<button class="map-cell ${result || ""}${record.star ? " star" : ""}" data-jump="${start + offset}" aria-current="${start + offset === currentIndex}" aria-label="${escape(title)}" title="${escape(title)}">${start + offset + 1}</button>`;
    }).join("");
    $("questionMap").innerHTML = `<div class="map-header"><h3>题号导航 <span class="selection-hint">· 数字为当前练习顺序</span></h3><div class="map-legend"><span><i class="dot correct"></i>答对</span><span><i class="dot wrong"></i>答错</span><span><i class="dot neutral"></i>未计分</span><span><i class="dot"></i>未答</span></div></div><div class="map-cells">${cells}</div>${queue.length > PAGE_SIZE ? `<div class="map-pages"><button class="icon" data-map-prev ${mapPage === 0 ? "disabled" : ""}>上一组</button><span>${start + 1}–${Math.min(start + PAGE_SIZE, queue.length)} / ${queue.length}</span><button class="icon" data-map-next ${start + PAGE_SIZE >= queue.length ? "disabled" : ""}>下一组</button></div>` : ""}`;
  }

  function render() {
    renderSidebar();
    const chapter = chapterById.get(state.view.chapterId);
    $("chapterTitle").textContent = chapter ? `第 ${chapter.number} 章 ${chapter.name}` : "全部章节";
    $("chapterSubtitle").textContent = `${data.title || "病理学题库"} · ${modeNames[state.view.mode]}`;
    $("scopeSummary").innerHTML = `<span><strong>${modeNames[state.view.mode]}</strong> · ${state.view.language === "all" ? "中英文" : state.view.language === "en" ? "英文" : "中文"} · ${queue.length} 题</span><span>${state.view.order === "random" ? "随机顺序，选项保持原序" : "按原书顺序练习"}</span>`;
    $("typeFilter").value = state.view.type;
    $("order").value = state.view.order;
    $("search").value = state.view.search;
    $("clearSearch").hidden = !state.view.search;
    $("reshuffle").hidden = state.view.order !== "random";
    renderQuestion();
  }

  function flushNote() {
    clearTimeout(noteSaveTimer);
    const question = queue[currentIndex];
    const input = $("questionNote");
    if (question && input && input.value !== recordFor(question.id).note) changeRecord(question.id, { note: input.value });
    const answer = $("writtenAnswer");
    if (question && answer && answer.value !== recordFor(question.id).text) changeRecord(question.id, { text: answer.value });
  }

  function navigate(index) {
    if (index < 0 || index >= queue.length) return;
    flushNote();
    currentIndex = index;
    answerRevealed = false;
    state.view.currentId = queue[index].id;
    state.lastQuestionId = queue[index].id;
    mapPage = Math.floor(index / PAGE_SIZE);
    persist();
    renderQuestion();
    $("stage").scrollTop = 0;
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

  document.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    if (button.dataset.mode) { setFilter("mode", button.dataset.mode); closeMenu(); }
    else if (button.dataset.language) setFilter("language", button.dataset.language);
    else if (button.dataset.chapter) { setFilter("chapterId", button.dataset.chapter); closeMenu(); }
    else if (own(button.dataset, "option")) selectOption(button.dataset.option);
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
  $("reshuffle").addEventListener("click", () => { state.view.seed = Date.now(); rebuildQueue(); toast("练习顺序已重新打乱。"); });
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
    rebuildQueue(id); closeMenu(); $("stage").scrollTop = 0; toast("已回到上次学习的题目。");
  });

  document.addEventListener("input", event => {
    if (event.target.id !== "questionNote" && event.target.id !== "writtenAnswer") return;
    clearTimeout(noteSaveTimer);
    if ($("noteStatus")) $("noteStatus").textContent = "正在保存……";
    noteSaveTimer = setTimeout(() => {
      flushNote();
      if ($("noteStatus")) $("noteStatus").textContent = storageAvailable ? "已保存在当前浏览器" : "已临时记录，请及时导出";
      renderSidebar();
    }, 350);
  });

  $("exportRecords").addEventListener("click", () => {
    flushNote();
    const backup = { format: RECORD_FORMAT, version: 1, exportedAt: new Date().toISOString(), dataVersion: data.version, records: state.records, view: state.view, theme: state.theme, lastQuestionId: state.lastQuestionId };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = `病理学习记录-${new Date().toISOString().slice(0, 10)}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("学习记录已导出，包含作答、收藏和笔记。");
  });
  $("importRecords").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", async event => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { toast("记录文件超过 15 MB，无法导入。请使用本站导出的 JSON 文件。"); return; }
    try {
      const backup = JSON.parse(await file.text());
      if (!backup || backup.format !== RECORD_FORMAT || backup.version !== 1 || !backup.records || typeof backup.records !== "object" || Array.isArray(backup.records)) throw new Error("invalid backup");
      flushNote();
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
      persist(); rebuildQueue();
      toast(`已合并 ${imported} 道题的记录；保留 ${retained} 道题现有的较新记录。${unknown ? `另有 ${unknown} 条记录不属于当前题库或格式无效。` : ""}`);
    } catch { toast("无法导入：请选择本站导出的病理学习记录 JSON 文件。现有记录未被替换。"); }
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") { closeMenu(); return; }
    if ($("rail").classList.contains("open") || event.ctrlKey || event.altKey || event.metaKey || event.target.closest("input,textarea,select,[contenteditable]")) return;
    if (event.key === "ArrowLeft") { event.preventDefault(); navigate(currentIndex - 1); }
    else if (event.key === "ArrowRight") { event.preventDefault(); navigate(currentIndex + 1); }
    else if (/^[1-9]$/.test(event.key)) { const option = queue[currentIndex]?.options?.[Number(event.key) - 1]; if (option) { event.preventDefault(); selectOption(String(option.key)); } }
    else if (event.key === "Enter" && queue[currentIndex]?.type === "multiple" && !recordFor(queue[currentIndex].id).submitted && !answerRevealed) { event.preventDefault(); submit(); }
  });
  window.addEventListener("pagehide", flushNote);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushNote(); });
  rebuildQueue();
})();
