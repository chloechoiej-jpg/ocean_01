/*************************************************************
 * 정답 보드판 · 영어 조별 퀴즈   (Google Apps Script 웹앱)
 * ------------------------------------------------------------
 * 선생님 화면 :  <배포 URL>?mode=teacher   (비밀번호 필요)
 * 조별 화면   :  <배포 URL>                (조를 골라서 사용)
 * 조 전용 링크:  <배포 URL>?g=g3           (선생님 화면에서 복사)
 *************************************************************/

/** 선생님 화면 비밀번호 — 반드시 바꿔서 쓰세요. */
var TEACHER_PIN = '1234';

var DEFAULT_POINTS = [30, 20, 10, 5, 5, 5];   // 1등 30, 2등 20, 3등 10, 그 아래 5
var DEFAULT_LIMIT  = 30;                      // 제한 시간(초)
var MAX_GROUPS     = 16;
var MAX_ANSWER_LEN = 300;

/* ─────────────────────── 웹앱 진입점 ─────────────────────── */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var mode = (p.mode === 'teacher') ? 'teacher' : 'group';
  var gid  = String(p.g || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20);

  var t = HtmlService.createTemplateFromFile('Index');
  t.boot = JSON.stringify({
    mode: mode,
    gid: gid,
    webUrl: ScriptApp.getService().getUrl()
  }).replace(/</g, '\\u003c');

  return t.evaluate()
    .setTitle('정답 보드판')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ─────────────────────── 저장소 ─────────────────────── */

function props_() { return PropertiesService.getScriptProperties(); }

function blankState_() {
  return {
    rev: 0,
    phase: 'setup',          // setup | ready | collect | reveal | result
    groups: [],              // {id, name, total}
    points: DEFAULT_POINTS.slice(),
    mode: 'submit',          // submit(제출 순서) | correct(정답자끼리)
    limit: DEFAULT_LIMIT,
    roundLimit: DEFAULT_LIMIT,
    round: 1,
    question: '',
    startedAt: 0,
    closed: false,           // 전원 제출로 마감됨
    subs: {}                 // gid -> {text, order, ms, correct, pts, manual}
  };
}

function readState_() {
  var raw = props_().getProperty('STATE');
  if (!raw) {
    var s = blankState_();
    props_().setProperty('STATE', JSON.stringify(s));
    return s;
  }
  return JSON.parse(raw);
}

function writeState_(s) {
  s.rev = (s.rev || 0) + 1;
  props_().setProperty('STATE', JSON.stringify(s));
  return s;
}

/** 동시 제출이 섞이지 않도록 잠금 — 제출 순서의 정확도가 여기서 나옵니다. */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function defaultPointFor_(rank) {
  return (DEFAULT_POINTS[rank - 1] != null) ? DEFAULT_POINTS[rank - 1] : 5;
}

function timeLeftMs_(s) {
  if (s.phase !== 'collect') return 0;
  return Math.max(0, s.roundLimit * 1000 - (Date.now() - s.startedAt));
}

/* ─────────────────────── 클라이언트에 넘길 자료 ─────────────────────── */

function teacherView_(s) {
  return {
    role: 'teacher',
    rev: s.rev, phase: s.phase, round: s.round, question: s.question,
    groups: s.groups, points: s.points, mode: s.mode, limit: s.limit,
    roundLimit: s.roundLimit, startedAt: s.startedAt,
    closed: s.closed || timeLeftMs_(s) <= 0 && s.phase === 'collect',
    subs: s.subs,
    hasHistory: s.round > 1
  };
}

/** 조별 화면에는 그 조의 정보만 — 다른 조의 답과 점수는 아예 보내지 않습니다. */
function groupView_(s, gid) {
  var me = null, myRank = null;
  var g = null, i;
  for (i = 0; i < s.groups.length; i++) if (s.groups[i].id === gid) g = s.groups[i];
  if (g) {
    var sorted = s.groups.slice().sort(function (a, b) { return b.total - a.total; });
    for (i = 0; i < sorted.length; i++) if (sorted[i].id === gid) myRank = i + 1;
    me = { id: g.id, name: g.name, total: g.total, sub: s.subs[g.id] || null, rank: myRank };
  }
  var names = s.groups.map(function (x) { return { id: x.id, name: x.name }; });
  return {
    role: 'group',
    rev: s.rev, phase: s.phase, round: s.round, question: s.question,
    roundLimit: s.roundLimit, startedAt: s.startedAt,
    closed: s.closed || (s.phase === 'collect' && timeLeftMs_(s) <= 0),
    groupCount: s.groups.length,
    submittedCount: Object.keys(s.subs).length,
    groupNames: names,
    me: me
  };
}

/* ─────────────────────── 조회 (모든 화면이 1~3초마다 호출) ─────────────────────── */

function apiGetState(clientRev, mode, gid, pin) {
  var s = readState_();
  var now = Date.now();

  if (mode === 'teacher' && pin !== TEACHER_PIN) {
    return { locked: true, now: now };
  }
  if (String(clientRev) === String(s.rev)) {
    return { changed: false, rev: s.rev, now: now };
  }
  return {
    changed: true, rev: s.rev, now: now,
    state: (mode === 'teacher') ? teacherView_(s) : groupView_(s, gid)
  };
}

/* ─────────────────────── 조별 제출 ─────────────────────── */

function apiSubmit(gid, text) {
  return withLock_(function () {
    var s = readState_();
    if (s.phase !== 'collect') return { ok: false, msg: '지금은 제출할 수 없어요.' };
    if (s.closed)              return { ok: false, msg: '이미 마감됐어요.' };

    var elapsed = Date.now() - s.startedAt;
    if (elapsed > s.roundLimit * 1000) return { ok: false, msg: '시간이 끝났어요.' };

    var found = false, i;
    for (i = 0; i < s.groups.length; i++) if (s.groups[i].id === gid) found = true;
    if (!found)     return { ok: false, msg: '조를 다시 골라 주세요.' };
    if (s.subs[gid]) return { ok: false, msg: '이미 제출했어요.', order: s.subs[gid].order };

    var order = Object.keys(s.subs).length + 1;
    s.subs[gid] = {
      text: String(text == null ? '' : text).slice(0, MAX_ANSWER_LEN),
      order: order, ms: elapsed, correct: null, pts: 0, manual: false
    };
    if (Object.keys(s.subs).length === s.groups.length) s.closed = true;
    writeState_(s);
    return { ok: true, order: order };
  });
}

/* ─────────────────────── 선생님 동작 ─────────────────────── */

function apiTeacher(action, payload, pin) {
  if (pin !== TEACHER_PIN) return { ok: false, msg: '비밀번호가 맞지 않아요.' };
  payload = payload || {};

  return withLock_(function () {
    var s = readState_();

    switch (action) {

      case 'setup': {
        var names = (payload.names || []).slice(0, MAX_GROUPS);
        if (names.length < 2) return { ok: false, msg: '조는 2개 이상 필요해요.' };
        s.groups = names.map(function (n, i) {
          return { id: 'g' + (i + 1), name: String(n || ((i + 1) + '조')).slice(0, 20), total: 0 };
        });
        var pts = (payload.points || []).map(Number);
        while (pts.length < s.groups.length) pts.push(defaultPointFor_(pts.length + 1));
        s.points = pts.slice(0, s.groups.length).map(function (v) { return isNaN(v) ? 0 : v; });
        s.mode = (payload.mode === 'correct') ? 'correct' : 'submit';
        s.limit = Math.min(600, Math.max(5, Number(payload.limit) || DEFAULT_LIMIT));
        s.roundLimit = s.limit;
        s.round = 1; s.subs = {}; s.question = ''; s.closed = false;
        s.phase = 'ready';
        clearHistory_();
        writeState_(s);
        return { ok: true };
      }

      case 'startRound': {
        if (s.phase !== 'ready') return { ok: false, msg: '지금은 시작할 수 없어요.' };
        s.question = String(payload.question || '').slice(0, 300);
        s.subs = {}; s.closed = false;
        s.roundLimit = s.limit;
        s.startedAt = Date.now();
        s.phase = 'collect';
        writeState_(s);
        return { ok: true };
      }

      case 'extend': {
        if (s.phase !== 'collect') return { ok: false, msg: '' };
        var add = Math.min(300, Math.max(5, Number(payload.sec) || 15));
        s.roundLimit = Math.ceil((Date.now() - s.startedAt) / 1000) + add;
        s.closed = false;
        writeState_(s);
        return { ok: true };
      }

      case 'closeNow': {
        if (s.phase !== 'collect') return { ok: false, msg: '' };
        s.roundLimit = Math.max(0, Math.floor((Date.now() - s.startedAt) / 1000));
        s.closed = true;
        writeState_(s);
        return { ok: true };
      }

      case 'reveal': {
        if (s.phase !== 'collect') return { ok: false, msg: '' };
        s.closed = true;
        s.phase = 'reveal';
        computePoints_(s);
        writeState_(s);
        return { ok: true };
      }

      case 'grade': {
        var sub = s.subs[payload.gid];
        if (!sub) return { ok: false, msg: '' };
        sub.correct = (payload.correct === null) ? null : !!payload.correct;
        sub.manual = false;
        computePoints_(s);
        writeState_(s);
        return { ok: true };
      }

      case 'allCorrect': {
        Object.keys(s.subs).forEach(function (k) { s.subs[k].correct = true; s.subs[k].manual = false; });
        computePoints_(s);
        writeState_(s);
        return { ok: true };
      }

      case 'setPoints': {
        var sb = s.subs[payload.gid];
        if (!sb) return { ok: false, msg: '' };
        sb.pts = Number(payload.pts) || 0;
        sb.manual = true;
        writeState_(s);
        return { ok: true };
      }

      case 'saveRound': {
        if (s.phase !== 'reveal') return { ok: false, msg: '' };
        var rows = s.groups.map(function (g) {
          var sub = s.subs[g.id];
          return {
            gid: g.id, name: g.name,
            order: sub ? sub.order : null,
            text: sub ? sub.text : '',
            correct: sub ? sub.correct : null,
            pts: sub ? (Number(sub.pts) || 0) : 0
          };
        });
        rows.forEach(function (r) {
          for (var i = 0; i < s.groups.length; i++) {
            if (s.groups[i].id === r.gid) s.groups[i].total += r.pts;
          }
        });
        props_().setProperty('H' + s.round,
          JSON.stringify({ round: s.round, question: s.question, rows: rows }));
        s.round += 1;
        s.subs = {}; s.question = ''; s.closed = false;
        s.phase = 'ready';
        writeState_(s);
        return { ok: true };
      }

      case 'skipRound': {
        s.subs = {}; s.question = ''; s.closed = false;
        s.phase = 'ready';
        writeState_(s);
        return { ok: true };
      }

      case 'finish': {
        s.phase = 'result';
        writeState_(s);
        return { ok: true };
      }

      case 'resume': {
        s.phase = 'ready';
        s.subs = {}; s.question = ''; s.closed = false;
        writeState_(s);
        return { ok: true };
      }

      case 'reset': {
        clearHistory_();
        writeState_(blankState_());
        return { ok: true };
      }
    }
    return { ok: false, msg: '알 수 없는 동작이에요.' };
  });
}

/* ─────────────────────── 점수 계산 ─────────────────────── */

function computePoints_(s) {
  var list = Object.keys(s.subs).map(function (gid) { return { gid: gid, sub: s.subs[gid] }; });
  list.sort(function (a, b) { return a.sub.order - b.sub.order; });

  var rank = 0;
  list.forEach(function (item) {
    var sub = item.sub;
    if (sub.manual) return;                       // 선생님이 직접 고친 점수는 그대로 둠
    if (s.mode === 'correct') {
      if (sub.correct === true) { rank += 1; sub.pts = pointFor_(s, rank); }
      else sub.pts = 0;
    } else {
      sub.pts = (sub.correct === false) ? 0 : pointFor_(s, sub.order);
    }
  });
}

function pointFor_(s, rank) {
  if (!s.points.length) return 0;
  var idx = Math.min(rank, s.points.length) - 1;
  return Number(s.points[idx]) || 0;
}

/* ─────────────────────── 기록 ─────────────────────── */

function clearHistory_() {
  var all = props_().getProperties();
  Object.keys(all).forEach(function (k) {
    if (/^H\d+$/.test(k)) props_().deleteProperty(k);
  });
}

function apiHistory(pin) {
  if (pin !== TEACHER_PIN) return { ok: false, msg: '비밀번호가 맞지 않아요.' };
  var s = readState_();
  var out = [];
  for (var r = 1; r < s.round; r++) {
    var raw = props_().getProperty('H' + r);
    if (raw) out.push(JSON.parse(raw));
  }
  return { ok: true, history: out, groups: s.groups };
}

/** 결과를 새 구글 시트로 저장하고 링크를 돌려줍니다. */
function apiExport(pin) {
  if (pin !== TEACHER_PIN) return { ok: false, msg: '비밀번호가 맞지 않아요.' };
  var h = apiHistory(pin);
  if (!h.ok) return h;

  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  var ss = SpreadsheetApp.create('정답 보드판 결과 ' + stamp);
  var sh = ss.getActiveSheet();
  sh.setName('기록');

  var rows = [['라운드', '문제', '조', '제출 순서', '제출한 답', '채점', '점수']];
  h.history.forEach(function (r) {
    r.rows.slice().sort(function (a, b) { return (a.order || 99) - (b.order || 99); })
      .forEach(function (x) {
        rows.push([
          r.round, r.question, x.name,
          x.order ? x.order + '번째' : '미제출',
          x.text,
          x.correct === true ? 'O' : x.correct === false ? 'X' : '-',
          x.pts
        ]);
      });
  });
  sh.getRange(1, 1, rows.length, 7).setValues(rows);
  sh.getRange(1, 1, 1, 7).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, 7);

  var sh2 = ss.insertSheet('총점');
  var tot = [['순위', '조', '총점']];
  h.groups.slice().sort(function (a, b) { return b.total - a.total; })
    .forEach(function (g, i) { tot.push([i + 1, g.name, g.total]); });
  sh2.getRange(1, 1, tot.length, 3).setValues(tot);
  sh2.getRange(1, 1, 1, 3).setFontWeight('bold');
  sh2.autoResizeColumns(1, 3);

  return { ok: true, url: ss.getUrl() };
}
