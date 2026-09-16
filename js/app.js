/* Квиз по предпринимательскому праву — логика игры.
   Командный режим для проектора: ведущий кликает вариант, который назвала команда. */
(function () {
  'use strict';

  var DATA = window.QUIZ_DATA;

  var STORE_KEY = 'business-law-quiz:game';
  var AUTH_KEY = 'business-law-quiz:auth';
  var THEME_KEY = 'business-law-quiz:theme';
  var PASSWORD_HASH = 1984369114866794; // хэш пароля: строчные русские буквы без пробелов

  var LETTERS = ['А', 'Б', 'В', 'Г'];
  var TEAM_COLORS = ['#f2b53c', '#57c5f7', '#a78bfa', '#34d399', '#fb7185', '#f97316'];
  var MIN_TEAMS = 2;
  var MAX_TEAMS = 6;
  var UNDO_LIMIT = 50;

  var DIGITS = {
    Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3,
    Numpad1: 0, Numpad2: 1, Numpad3: 2, Numpad4: 3
  };

  var appEl = document.getElementById('app');
  var toastEl = document.getElementById('toast');

  var state = null;
  var undoStack = [];
  var authed = false;
  var ui = { help: false, confirm: null, toastTimer: null };

  /* ---------- Хранилище ---------- */

  function readStore(kind, key) {
    try { return window[kind].getItem(key); } catch (e) { return null; }
  }

  function writeStore(kind, key, value) {
    try { window[kind].setItem(key, value); } catch (e) { /* приватный режим — переживём */ }
  }

  function dropStore(kind, key) {
    try { window[kind].removeItem(key); } catch (e) { /* ничего */ }
  }

  function save() {
    if (state) writeStore('localStorage', STORE_KEY, JSON.stringify(state));
  }

  function load() {
    var raw = readStore('localStorage', STORE_KEY);
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.order || !parsed.order.length || !parsed.teams) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  /* ---------- Пароль ---------- */

  // Символы английской раскладки → русские буквы на тех же клавишах.
  var EN_TO_RU = {
    q: 'й', w: 'ц', e: 'у', r: 'к', t: 'е', y: 'н', u: 'г', i: 'ш', o: 'щ', p: 'з', '[': 'х', ']': 'ъ', '{': 'х', '}': 'ъ',
    a: 'ф', s: 'ы', d: 'в', f: 'а', g: 'п', h: 'р', j: 'о', k: 'л', l: 'д', ';': 'ж', "'": 'э', ':': 'ж', '"': 'э',
    z: 'я', x: 'ч', c: 'с', v: 'м', b: 'и', n: 'т', m: 'ь', ',': 'б', '.': 'ю', '<': 'б', '>': 'ю', '`': 'ё', '~': 'ё'
  };

  function normalizePassword(value) {
    var s = String(value).toLowerCase();
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (EN_TO_RU[ch]) ch = EN_TO_RU[ch];
      if (ch === 'ё') ch = 'е';
      if (ch >= 'а' && ch <= 'я') out += ch;
    }
    return out;
  }

  function cyrb53(str) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  function tryPassword(value) {
    if (cyrb53(normalizePassword(value)) === PASSWORD_HASH) {
      authed = true;
      writeStore('sessionStorage', AUTH_KEY, '1');
      render();
      if (state && state.screen === 'question') toast('Игра восстановлена');
      return;
    }
    var box = appEl.querySelector('.gate');
    var error = appEl.querySelector('.gate__error');
    var input = appEl.querySelector('.gate__input');
    if (error) error.hidden = false;
    if (box) {
      box.classList.remove('shake');
      void box.offsetWidth;
      box.classList.add('shake');
    }
    if (input) { input.value = ''; input.focus(); }
  }

  /* ---------- Данные и партия ---------- */

  function shuffle(list) {
    var out = list.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }

  function buildOrder() {
    var flat = [];
    DATA.sections.forEach(function (section) {
      section.questions.forEach(function (q) {
        // Перемешиваем варианты, не теряя из виду правильный.
        var pairs = shuffle(q.options.map(function (text, i) {
          return { text: text, correct: i === q.answer };
        }));
        var answer = 0;
        pairs.forEach(function (p, i) { if (p.correct) answer = i; });
        flat.push({
          n: q.n,
          section: section.n,
          sectionTitle: section.title,
          text: q.text,
          options: pairs.map(function (p) { return p.text; }),
          answer: answer,
          explanation: q.explanation
        });
      });
    });
    return shuffle(flat);
  }

  function newGame(teamNames) {
    state = {
      screen: 'rules',
      teams: teamNames.map(function (name) { return { name: name, score: 0 }; }),
      order: buildOrder(),
      index: 0,
      turn: 0,
      answering: 0,
      tried: [],
      dead: [],
      revealed: false,
      scored: null,
      stolen: false,
      played: 0,
      unanswered: 0,
      misses: []
    };
    undoStack = [];
    save();
  }

  function current() {
    return state.order[state.index];
  }

  function total() {
    return state.order.length;
  }

  /* ---------- Ход игры ---------- */

  function pushUndo() {
    undoStack.push(clone(state));
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }

  function undo() {
    if (!undoStack.length) { toast('Отменять нечего'); return; }
    state = undoStack.pop();
    save();
    render();
    toast('Отменено');
  }

  // Следующая команда, которая ещё не отвечала на этот вопрос.
  function nextResponder() {
    var count = state.teams.length;
    for (var step = 1; step <= count; step++) {
      var candidate = (state.answering + step) % count;
      if (state.tried.indexOf(candidate) === -1) return candidate;
    }
    return null;
  }

  function closeQuestion(scoredBy) {
    var q = current();
    state.revealed = true;
    state.scored = typeof scoredBy === 'number' ? scoredBy : null;
    state.played = (state.played || 0) + 1;
    if (state.scored === null) state.unanswered = (state.unanswered || 0) + 1;
    if (state.dead.length || state.scored === null) {
      state.misses.push({
        n: q.n,
        section: q.sectionTitle,
        text: q.text,
        correct: q.options[q.answer],
        explanation: q.explanation,
        solvedBy: state.scored === null ? null : state.teams[state.scored].name
      });
    }
  }

  function answer(optIndex) {
    if (!state || state.screen !== 'question' || state.revealed) return;
    if (state.dead.indexOf(optIndex) !== -1) return;
    pushUndo();

    var q = current();
    if (optIndex === q.answer) {
      state.teams[state.answering].score += 1;
      state.stolen = state.answering !== state.turn;
      closeQuestion(state.answering);
    } else {
      state.dead.push(optIndex);
      state.tried.push(state.answering);
      var next = nextResponder();
      if (next === null) {
        closeQuestion(null);
      } else {
        state.answering = next;
      }
    }
    save();
    render();
  }

  // Команда молчит: право ответа уходит дальше, вариант не гасится.
  function passTurn() {
    if (!state || state.screen !== 'question' || state.revealed) return;
    pushUndo();
    state.tried.push(state.answering);
    var next = nextResponder();
    if (next === null) closeQuestion(null);
    else state.answering = next;
    save();
    render();
  }

  function nextQuestion() {
    if (!state || state.screen !== 'question' || !state.revealed) return;
    pushUndo();
    if (state.index + 1 >= total()) {
      state.screen = 'final';
    } else {
      state.index += 1;
      state.turn = (state.turn + 1) % state.teams.length;
      state.answering = state.turn;
      state.tried = [];
      state.dead = [];
      state.revealed = false;
      state.scored = null;
      state.stolen = false;
    }
    save();
    render();
  }

  function finishEarly() {
    pushUndo();
    state.screen = 'final';
    save();
    render();
  }

  function resetGame() {
    state = null;
    undoStack = [];
    dropStore('localStorage', STORE_KEY);
    render();
  }

  /* ---------- Вспомогательное ---------- */

  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function teamColor(i) {
    return TEAM_COLORS[i % TEAM_COLORS.length];
  }

  function plural(n, one, few, many) {
    var mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
  }

  function toast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2200);
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    writeStore('localStorage', THEME_KEY, theme);
  }

  function toggleTheme() {
    var now = document.documentElement.getAttribute('data-theme');
    setTheme(now === 'dark' ? 'light' : 'dark');
    toast(now === 'dark' ? 'Светлая тема' : 'Тёмная тема');
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  }

  /* ---------- Экраны ---------- */

  function renderGate() {
    return '<div class="screen screen--center"><div class="gate">' +
      '<div class="gate__seal">⚖️</div>' +
      '<div class="eyebrow">Предпринимательское право</div>' +
      '<h1>Субъекты предпринимательской деятельности</h1>' +
      '<p class="lead">Командный квиз на семинар. 30 вопросов, 7 разделов.</p>' +
      '<form class="gate__form" data-form="gate" autocomplete="off">' +
        '<div class="gate__row">' +
          '<input class="gate__input" type="password" autocomplete="off" spellcheck="false" aria-label="Пароль">' +
          '<button class="btn btn--primary" type="submit">Войти</button>' +
        '</div>' +
        '<p class="lead" style="font-size:.9rem">Регистр, пробелы и раскладка клавиатуры не важны.</p>' +
        '<p class="gate__error" hidden>Пароль не подошёл</p>' +
      '</form>' +
    '</div></div>';
  }

  function renderTeams() {
    var names = ui.teamNames;
    var rows = names.map(function (name, i) {
      return '<div class="team-row" style="--team-color:' + teamColor(i) + '">' +
        '<span class="team-row__dot"></span>' +
        '<input class="team-row__input" data-team="' + i + '" value="' + esc(name) + '" ' +
          'maxlength="28" aria-label="Название команды ' + (i + 1) + '">' +
      '</div>';
    }).join('');

    return '<div class="screen screen--center"><div class="teams-setup">' +
      '<div class="eyebrow">Шаг 1 из 2</div>' +
      '<h1>Кто играет?</h1>' +
      '<p class="lead">Впишите названия команд или оставьте как есть. От ' + MIN_TEAMS + ' до ' + MAX_TEAMS + '.</p>' +
      '<div class="teams-setup__list">' + rows + '</div>' +
      '<div class="teams-setup__actions">' +
        '<button class="btn btn--sm" data-action="team-remove"' + (names.length <= MIN_TEAMS ? ' disabled' : '') + '>— Убрать</button>' +
        '<button class="btn btn--sm" data-action="team-add"' + (names.length >= MAX_TEAMS ? ' disabled' : '') + '>+ Добавить</button>' +
      '</div>' +
      '<div class="teams-setup__actions">' +
        '<button class="btn btn--primary" data-action="to-rules">Дальше →</button>' +
      '</div>' +
    '</div></div>';
  }

  function renderRules() {
    var chips = state.teams.map(function (t, i) {
      return '<b style="color:' + teamColor(i) + '">' + esc(t.name) + '</b>';
    });
    var names = chips.join(', ');
    var firstTeam = chips[0];

    return '<div class="screen screen--center"><div class="rules">' +
      '<div class="eyebrow">Шаг 2 из 2</div>' +
      '<h1>Как играем</h1>' +
      '<ol>' +
        '<li>Вопросы идут по кругу: первый — команде ' + firstTeam + ', второй — следующей и так далее. Всего ' + total() + ' вопросов.</li>' +
        '<li>Команда, чей ход, называет вариант вслух. Ведущий кликает его или жмёт <kbd>1</kbd>–<kbd>4</kbd>.</li>' +
        '<li>Верно — команде балл. Неверно — вариант гаснет, право ответа переходит следующей команде: это перехват, балл достаётся ей.</li>' +
        '<li>Команда не хочет отвечать — <kbd>N</kbd>, ход уходит дальше без потери варианта.</li>' +
        '<li>Когда вопрос закрыт, на экране правильный ответ и пояснение. <kbd>Пробел</kbd> — следующий вопрос.</li>' +
        '<li>Ошиблись с кликом — <kbd>Backspace</kbd> отменит последнее действие.</li>' +
      '</ol>' +
      '<p class="lead" style="margin-top:1.2em">Играют: ' + names + '</p>' +
      '<div class="teams-setup__actions" style="margin-top:1.2em">' +
        '<button class="btn" data-action="back-to-teams">← Назад</button>' +
        '<button class="btn btn--primary" data-action="start">Начать игру</button>' +
      '</div>' +
    '</div></div>';
  }

  function renderScoreboard() {
    return '<div class="scoreboard">' + state.teams.map(function (team, i) {
      var isTurn = !state.revealed && i === state.answering;
      var isOut = !state.revealed && state.tried.indexOf(i) !== -1;
      var badge = '';
      if (isTurn) badge = '<span class="team__badge">' + (state.tried.length ? 'перехват' : 'ход') + '</span>';
      else if (state.revealed && i === state.scored) badge = '<span class="team__badge">+1</span>';
      return '<div class="team' + (isTurn ? ' team--turn' : '') + (isOut ? ' team--out' : '') + '" ' +
        'style="--team-color:' + teamColor(i) + '">' +
        '<span class="team__dot"></span>' +
        '<span class="team__name">' + esc(team.name) + '</span>' +
        badge +
        '<span class="team__score">' + team.score + '</span>' +
      '</div>';
    }).join('') + '</div>';
  }

  function renderOptions(q) {
    return '<div class="options">' + q.options.map(function (text, i) {
      var cls = 'option';
      if (state.revealed) {
        if (i === q.answer) cls += ' option--correct';
        else if (state.dead.indexOf(i) !== -1) cls += ' option--wrong';
        else cls += ' option--muted';
      } else if (state.dead.indexOf(i) !== -1) {
        cls += ' option--dead';
      }
      var disabled = state.revealed || state.dead.indexOf(i) !== -1;
      return '<button class="' + cls + '" data-option="' + i + '"' + (disabled ? ' disabled' : '') + '>' +
        '<span class="option__letter">' + LETTERS[i] + '</span>' +
        '<span>' + esc(text) + '</span>' +
      '</button>';
    }).join('') + '</div>';
  }

  function renderReveal(q) {
    var color, verdict;
    if (state.scored === null) {
      color = 'var(--bad)';
      verdict = 'Никто не ответил. Правильный ответ — ' + LETTERS[q.answer] + '.';
    } else if (state.stolen) {
      color = 'var(--ok)';
      verdict = 'Перехват! Балл команде «' + esc(state.teams[state.scored].name) + '».';
    } else {
      color = 'var(--ok)';
      verdict = 'Верно. Балл команде «' + esc(state.teams[state.scored].name) + '».';
    }
    return '<div class="reveal" style="--verdict-color:' + color + '">' +
      '<div class="reveal__verdict">' + verdict + '</div>' +
      '<div class="reveal__text">' + esc(q.explanation) + '</div>' +
    '</div>';
  }

  function renderQuestion() {
    var q = current();
    var done = state.index;
    var percent = Math.round((done / total()) * 100);
    var turnLine = state.revealed
      ? '<div class="question__turn">Вопрос закрыт. <kbd>Пробел</kbd> — дальше.</div>'
      : '<div class="question__turn" style="--turn-color:' + teamColor(state.answering) + '">' +
          (state.tried.length ? 'Перехват — отвечает ' : 'Отвечает ') +
          '<b>' + esc(state.teams[state.answering].name) + '</b></div>';

    return '<div class="screen">' +
      '<div class="topbar">' +
        '<div class="topbar__section">Раздел ' + q.section + '. ' + esc(q.sectionTitle) + '</div>' +
        '<div class="topbar__count">Вопрос <b>' + (state.index + 1) + '</b> из ' + total() + '</div>' +
      '</div>' +
      '<div class="progress"><div class="progress__bar" style="width:' + percent + '%"></div></div>' +
      renderScoreboard() +
      '<div class="question">' +
        turnLine +
        '<div class="question__text">' + esc(q.text) + '</div>' +
        renderOptions(q) +
        (state.revealed ? renderReveal(q) : '') +
      '</div>' +
      '<div class="footbar">' +
        '<div class="footbar__keys">' +
          '<span><kbd>1</kbd>–<kbd>4</kbd> ответ</span>' +
          '<span><kbd>N</kbd> команда молчит</span>' +
          '<span><kbd>Пробел</kbd> дальше</span>' +
          '<span><kbd>Backspace</kbd> отменить</span>' +
          '<span><kbd>F</kbd> во весь экран</span>' +
          '<span><kbd>H</kbd> ещё</span>' +
        '</div>' +
        '<div class="footbar__actions">' +
          (state.revealed ? '<button class="btn btn--sm btn--primary" data-action="next">Дальше →</button>' : '') +
          '<button class="btn btn--sm btn--ghost" data-action="ask-finish">Итоги</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function renderFinal() {
    var ranked = state.teams.map(function (team, i) {
      return { name: team.name, score: team.score, color: teamColor(i) };
    }).sort(function (a, b) { return b.score - a.score; });

    var top = ranked[0].score;
    var champions = ranked.filter(function (t) { return t.score === top; });
    var played = state.played || 0;
    var unanswered = state.unanswered || 0;

    var head = champions.length > 1
      ? '<h1>Ничья</h1><p class="lead">' + champions.map(function (t) {
          return '<b class="winner__name">' + esc(t.name) + '</b>';
        }).join(' и ') + ' — по ' + top + ' ' + plural(top, 'баллу', 'балла', 'баллов') + '</p>'
      : '<h1>Победитель — <span class="winner__name">' + esc(champions[0].name) + '</span></h1>' +
        '<p class="lead">' + top + ' ' + plural(top, 'балл', 'балла', 'баллов') + '</p>';

    head += '<p class="lead" style="margin-top:.5em">Сыграно ' + played + ' ' +
      plural(played, 'вопрос', 'вопроса', 'вопросов') +
      (unanswered ? ', из них ' + unanswered + ' без ответа' : '') + '.</p>';

    var standings = ranked.map(function (t, i) {
      return '<div class="standing" style="--team-color:' + t.color + '">' +
        '<span class="standing__place">' + (i + 1) + '.</span>' +
        '<span class="team__dot"></span>' +
        '<span class="standing__name">' + esc(t.name) + '</span>' +
        '<span class="standing__score">' + t.score + '</span>' +
      '</div>';
    }).join('');

    var misses = state.misses.length
      ? '<div class="misses"><h2>Что стоит разобрать</h2>' +
          '<p class="lead">' + state.misses.length + ' ' +
          plural(state.misses.length, 'вопрос вызвал', 'вопроса вызвали', 'вопросов вызвали') + ' затруднение.</p>' +
          '<div class="misses__list">' + state.misses.map(function (m) {
            return '<div class="miss">' +
              '<div class="miss__q">' + esc(m.text) + '</div>' +
              '<div class="miss__a">Верно: ' + esc(m.correct) + '</div>' +
              '<div class="miss__why">' + esc(m.explanation) + '</div>' +
            '</div>';
          }).join('') + '</div>' +
        '</div>'
      : '<div class="misses"><h2>Ни одной осечки</h2>' +
          '<p class="lead">Все вопросы взяты с первого раза. Разбирать нечего.</p></div>';

    return '<div class="screen"><div class="final" style="margin:0 auto">' +
      '<div class="winner"><div class="winner__cup">🏆</div>' + head + '</div>' +
      '<div class="standings">' + standings + '</div>' +
      misses +
      '<div class="teams-setup__actions">' +
        '<button class="btn btn--primary" data-action="ask-reset">Новая игра</button>' +
      '</div>' +
    '</div></div>';
  }

  function renderOverlay() {
    if (ui.confirm) {
      return '<div class="overlay"><div class="overlay__box">' +
        '<h2>' + esc(ui.confirm.title) + '</h2>' +
        '<p class="lead">' + esc(ui.confirm.text) + '</p>' +
        '<div class="overlay__actions">' +
          '<button class="btn" data-action="confirm-no">Отмена</button>' +
          '<button class="btn btn--primary" data-action="confirm-yes">' + esc(ui.confirm.yes) + '</button>' +
        '</div>' +
      '</div></div>';
    }
    if (ui.help) {
      return '<div class="overlay"><div class="overlay__box">' +
        '<h2>Горячие клавиши</h2>' +
        '<div class="keys-table">' +
          '<div><kbd>1</kbd>–<kbd>4</kbd></div><div>ответ, который назвала команда</div>' +
          '<div><kbd>N</kbd></div><div>команда молчит, ход уходит дальше</div>' +
          '<div><kbd>Пробел</kbd></div><div>следующий вопрос</div>' +
          '<div><kbd>Backspace</kbd></div><div>отменить последнее действие</div>' +
          '<div><kbd>F</kbd></div><div>во весь экран</div>' +
          '<div><kbd>T</kbd></div><div>светлая или тёмная тема</div>' +
          '<div><kbd>H</kbd></div><div>эта подсказка</div>' +
        '</div>' +
        '<div class="overlay__actions">' +
          '<button class="btn" data-action="ask-reset">Новая игра</button>' +
          '<button class="btn btn--primary" data-action="help-close">Закрыть</button>' +
        '</div>' +
      '</div></div>';
    }
    return '';
  }

  function render() {
    var html;
    if (!authed) {
      html = renderGate();
    } else if (!state) {
      if (!ui.teamNames) ui.teamNames = ['Команда 1', 'Команда 2'];
      html = renderTeams();
    } else if (state.screen === 'rules') {
      html = renderRules();
    } else if (state.screen === 'final') {
      html = renderFinal();
    } else {
      html = renderQuestion();
    }

    appEl.innerHTML = html + renderOverlay();

    var focusable = appEl.querySelector('.gate__input') ||
      (state ? null : appEl.querySelector('.team-row__input'));
    if (focusable) focusable.focus();
  }

  /* ---------- События ---------- */

  function readTeamNames() {
    var inputs = appEl.querySelectorAll('.team-row__input');
    var names = [];
    for (var i = 0; i < inputs.length; i++) {
      var value = inputs[i].value.trim();
      names.push(value || ('Команда ' + (i + 1)));
    }
    return names;
  }

  function syncTeamNames() {
    if (!state && appEl.querySelector('.team-row__input')) ui.teamNames = readTeamNames();
  }

  appEl.addEventListener('submit', function (e) {
    if (e.target.getAttribute('data-form') === 'gate') {
      e.preventDefault();
      tryPassword(appEl.querySelector('.gate__input').value);
    }
  });

  appEl.addEventListener('click', function (e) {
    var optionEl = e.target.closest('[data-option]');
    if (optionEl && !optionEl.disabled) {
      answer(Number(optionEl.getAttribute('data-option')));
      return;
    }

    var actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    var action = actionEl.getAttribute('data-action');

    switch (action) {
      case 'team-add':
        syncTeamNames();
        ui.teamNames.push('Команда ' + (ui.teamNames.length + 1));
        render();
        break;
      case 'team-remove':
        syncTeamNames();
        ui.teamNames.pop();
        render();
        break;
      case 'to-rules':
        newGame(readTeamNames());
        render();
        break;
      case 'back-to-teams':
        ui.teamNames = state.teams.map(function (t) { return t.name; });
        state = null;
        dropStore('localStorage', STORE_KEY);
        render();
        break;
      case 'start':
        state.screen = 'question';
        state.answering = state.turn;
        save();
        render();
        break;
      case 'next':
        nextQuestion();
        break;
      case 'ask-finish':
        ui.confirm = {
          title: 'Подвести итоги?',
          text: 'Оставшиеся вопросы будут пропущены, откроется итоговый экран.',
          yes: 'Подвести итоги',
          run: finishEarly
        };
        render();
        break;
      case 'ask-reset':
        ui.help = false;
        ui.confirm = {
          title: 'Начать заново?',
          text: 'Счёт обнулится, вопросы и варианты перемешаются по-новому.',
          yes: 'Начать заново',
          run: resetGame
        };
        render();
        break;
      case 'confirm-yes':
        var run = ui.confirm && ui.confirm.run;
        ui.confirm = null;
        if (run) run(); else render();
        break;
      case 'confirm-no':
        ui.confirm = null;
        render();
        break;
      case 'help-close':
        ui.help = false;
        render();
        break;
    }
  });

  document.addEventListener('keydown', function (e) {
    var tag = e.target.tagName;
    var typing = tag === 'INPUT' || tag === 'TEXTAREA';

    if (typing) {
      // Enter в поле пароля: не полагаемся на неявную отправку формы браузером.
      if (e.key === 'Enter' && !authed && e.target.classList.contains('gate__input')) {
        e.preventDefault();
        tryPassword(e.target.value);
        return;
      }
      // На экране команд Enter ведёт дальше, остальное отдаём полю ввода.
      if (e.key === 'Enter' && !state && appEl.querySelector('.team-row__input')) {
        e.preventDefault();
        newGame(readTeamNames());
        render();
      }
      return;
    }

    if (!authed) return;

    if (ui.confirm) {
      if (e.key === 'Escape') { e.preventDefault(); ui.confirm = null; render(); }
      if (e.key === 'Enter') {
        e.preventDefault();
        var run = ui.confirm.run;
        ui.confirm = null;
        if (run) run(); else render();
      }
      return;
    }

    if (ui.help && (e.key === 'Escape' || e.code === 'KeyH')) {
      e.preventDefault();
      ui.help = false;
      render();
      return;
    }

    if (e.code === 'KeyF') { e.preventDefault(); toggleFullscreen(); return; }
    if (e.code === 'KeyT') { e.preventDefault(); toggleTheme(); return; }
    if (e.code === 'KeyH') { e.preventDefault(); ui.help = true; render(); return; }
    if (ui.help) return;

    if (!state) return;

    if (state.screen === 'rules') {
      if (e.code === 'Space' || e.key === 'Enter') {
        e.preventDefault();
        state.screen = 'question';
        state.answering = state.turn;
        save();
        render();
      }
      return;
    }

    if (state.screen !== 'question') return;

    if (e.code === 'Backspace') { e.preventDefault(); undo(); return; }
    if (e.code === 'KeyN') { e.preventDefault(); passTurn(); return; }

    if (e.code === 'Space' || e.key === 'Enter') {
      e.preventDefault();
      if (state.revealed) nextQuestion();
      return;
    }

    if (DIGITS.hasOwnProperty(e.code)) {
      var idx = DIGITS[e.code];
      if (idx < current().options.length) { e.preventDefault(); answer(idx); }
    }
  });

  /* ---------- Запуск ---------- */

  setTheme(readStore('localStorage', THEME_KEY) || 'dark');
  authed = readStore('sessionStorage', AUTH_KEY) === '1';
  state = load();
  render();
})();
