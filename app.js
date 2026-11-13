'use strict';

// ---------- 저장소 (IndexedDB) ----------
// meta: 곡 정보(이름, 순서), data: 실제 음원 바이트. 목록을 그릴 때 음원 전체를 읽지 않도록 분리한다.
const DB_NAME = 'my-music';
let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('meta', { keyPath: 'id', autoIncrement: true });
        r.result.createObjectStore('data');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}

// 트랜잭션 하나를 열고, work(t)가 돌려준 값을 트랜잭션 완료 후에 반환한다.
async function withTx(stores, mode, work) {
  const d = await openDb();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    const box = {};
    t.oncomplete = () => resolve(box.value);
    t.onerror = t.onabort = () => reject(t.error);
    work(t, box);
  });
}

const dbAllMeta = () => withTx(['meta'], 'readonly', (t, box) => {
  const r = t.objectStore('meta').getAll();
  r.onsuccess = () => { box.value = r.result; };
});

const dbGetData = (id) => withTx(['data'], 'readonly', (t, box) => {
  const r = t.objectStore('data').get(id);
  r.onsuccess = () => { box.value = r.result; };
});

const dbAdd = (meta, buf) => withTx(['meta', 'data'], 'readwrite', (t, box) => {
  const r = t.objectStore('meta').add(meta);
  r.onsuccess = () => {
    box.value = r.result;
    t.objectStore('data').put({ buf, type: meta.type }, r.result);
  };
});

const dbPutMeta = (metas) => withTx(['meta'], 'readwrite', (t) => {
  metas.forEach((m) => t.objectStore('meta').put(m));
});

const dbDelete = (id) => withTx(['meta', 'data'], 'readwrite', (t) => {
  t.objectStore('meta').delete(id);
  t.objectStore('data').delete(id);
});

// ---------- 상태 ----------
const $ = (id) => document.getElementById(id);
const audio = $('audio');

let tracks = [];            // 저장 순서대로 정렬된 곡 정보
let queue = [];             // 실제 재생 순서(셔플 반영)를 담은 id 배열
let currentId = null;
let shuffle = localStorage.getItem('shuffle') === '1';
let repeat = localStorage.getItem('repeat') || 'all';   // all | one | off
let pendingSeek = 0;
let dragging = false;
let unlocked = false;       // iOS에서 사용자 터치로 오디오 재생 권한을 확보했는지 여부
let realSource = false;     // 현재 audio.src가 실제 곡인지(권한 확보용 무음이 아닌지)
const urls = new Map();     // id -> blob URL (현재 곡과 다음 곡만 유지)

const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', aiff: 'audio/aiff', caf: 'audio/x-caf' };
const PLAY_PATH = 'M8 5v14l11-7z';
const PAUSE_PATH = 'M6 5h4v14H6zm8 0h4v14h-4z';

function splitName(name) {
  const base = name.replace(/\.[^.]+$/, '');
  const i = base.indexOf(' - ');
  return i > 0 ? { artist: base.slice(0, i), title: base.slice(i + 3) } : { artist: '', title: base };
}

function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60), m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600);
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

// ---------- 재생 순서 ----------
function rebuildQueue() {
  const ids = tracks.map((t) => t.id);
  if (!shuffle) { queue = ids; return; }
  const rest = ids.filter((id) => id !== currentId);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  queue = currentId != null && ids.includes(currentId) ? [currentId, ...rest] : rest;
}

// wrap이 true이면 목록의 끝에서 처음으로 되돌아간다.
function neighborId(step, wrap) {
  if (!queue.length) return null;
  const i = queue.indexOf(currentId);
  if (i < 0) return queue[0];
  const n = i + step;
  if (n >= 0 && n < queue.length) return queue[n];
  return wrap ? queue[(n + queue.length) % queue.length] : null;
}

// ---------- 음원 로딩 ----------
async function getUrl(id) {
  if (urls.has(id)) return urls.get(id);
  const rec = await dbGetData(id);
  if (!rec) return null;
  const url = URL.createObjectURL(new Blob([rec.buf], { type: rec.type }));
  urls.set(id, url);
  return url;
}

function pruneUrls(keep) {
  for (const [id, url] of urls) {
    if (!keep.includes(id)) { URL.revokeObjectURL(url); urls.delete(id); }
  }
}

// 화면이 잠긴 상태에서는 곡이 끝난 순간에 비동기 작업을 기다릴 수 없는 경우가 있다.
// 그래서 다음 곡의 URL을 재생 중에 미리 만들어 둔다.
async function preloadNext() {
  const next = neighborId(1, repeat === 'all');
  const keep = [currentId, next].filter((v) => v != null);
  pruneUrls(keep);
  if (next != null) await getUrl(next).catch(() => {});
}

function setSource(track, url, autoplay, at) {
  currentId = track.id;
  realSource = true;
  pendingSeek = at || 0;
  audio.src = url;
  if (autoplay) audio.play().catch(() => {});
  localStorage.setItem('current', String(track.id));
  updateNowPlaying();
  renderList();
  preloadNext();
}

async function playTrack(id, autoplay = true, at = 0) {
  const track = tracks.find((t) => t.id === id);
  if (!track) return;
  const url = await getUrl(id);
  if (!url) { setStatus('음원 데이터를 찾지 못했습니다.'); return; }
  setSource(track, url, autoplay, at);
}

// iOS는 사용자 터치와 같은 시점에 호출된 play()만 허용한다.
// 저장소를 읽는 동안 그 시점이 지나갈 수 있으므로, 터치 즉시 무음을 한 번 재생하여 권한을 확보한다.
function unlock() {
  if (unlocked) return;
  unlocked = true;
  if (!realSource) {
    audio.src = SILENCE;
    audio.play().catch(() => {});
  }
}

function userPlay(id) {
  unlock();
  playTrack(id, true, 0);
}

function togglePlay() {
  if (!tracks.length) return;
  if (currentId == null || !realSource) { userPlay(queue[0]); return; }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

function goNext() {
  const id = neighborId(1, true);
  if (id != null) userPlay(id);
}

function goPrev() {
  // 3초 이상 재생된 상태라면 현재 곡의 처음으로 되돌린다.
  if (realSource && audio.currentTime > 3) { audio.currentTime = 0; return; }
  const id = neighborId(-1, true);
  if (id != null) userPlay(id);
}

audio.addEventListener('ended', () => {
  if (!realSource) return;
  if (repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  const id = neighborId(1, repeat === 'all');
  if (id == null) { updatePlayIcon(); return; }
  const track = tracks.find((t) => t.id === id);
  if (urls.has(id)) setSource(track, urls.get(id), true, 0);
  else playTrack(id, true, 0);
});

audio.addEventListener('loadedmetadata', () => {
  if (!realSource) return;
  if (pendingSeek > 0 && pendingSeek < audio.duration - 2) audio.currentTime = pendingSeek;
  pendingSeek = 0;
  $('durTime').textContent = fmt(audio.duration);
});

let lastSaved = 0;
audio.addEventListener('timeupdate', () => {
  if (!realSource) return;
  if (!dragging) {
    $('curTime').textContent = fmt(audio.currentTime);
    $('seek').value = audio.duration ? Math.round((audio.currentTime / audio.duration) * 1000) : 0;
  }
  if (Math.abs(audio.currentTime - lastSaved) >= 5) savePosition();
  updatePositionState();
});

function savePosition() {
  if (!realSource) return;
  lastSaved = audio.currentTime;
  localStorage.setItem('position', String(audio.currentTime));
}

audio.addEventListener('play', updatePlayIcon);
audio.addEventListener('pause', () => { updatePlayIcon(); savePosition(); });
audio.addEventListener('error', () => {
  if (realSource && audio.error) setStatus('이 파일은 재생할 수 없는 형식입니다.');
});
document.addEventListener('visibilitychange', savePosition);

// ---------- 잠금 화면 / 제어 센터 ----------
function updateNowPlaying() {
  const track = tracks.find((t) => t.id === currentId);
  const info = track ? splitName(track.name) : null;
  $('nowTitle').textContent = info ? info.title : '재생할 곡을 선택하세요';
  $('nowArtist').textContent = info ? info.artist : '';
  if (!info) { $('curTime').textContent = $('durTime').textContent = '0:00'; $('seek').value = 0; }
  if ('mediaSession' in navigator && info) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: info.title,
      artist: info.artist,
      album: '내 음원',
      artwork: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  }
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!isFinite(audio.duration) || !audio.duration) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      position: Math.min(audio.currentTime, audio.duration),
      playbackRate: audio.playbackRate || 1,
    });
  } catch (e) { /* 일부 기기에서는 지원하지 않는다 */ }
}

if ('mediaSession' in navigator) {
  const set = (name, fn) => { try { navigator.mediaSession.setActionHandler(name, fn); } catch (e) {} };
  set('play', () => audio.play().catch(() => {}));
  set('pause', () => audio.pause());
  set('nexttrack', goNext);
  set('previoustrack', goPrev);
  set('seekto', (e) => { if (e.seekTime != null) audio.currentTime = e.seekTime; });
}

// ---------- 화면 ----------
function setStatus(text) { $('status').textContent = text || ''; }

function updatePlayIcon() {
  const playing = realSource && !audio.paused && !audio.ended;
  $('playIcon').setAttribute('d', playing ? PAUSE_PATH : PLAY_PATH);
  $('playBtn').setAttribute('aria-label', playing ? '일시정지' : '재생');
}

function updateModeButtons() {
  $('shuffleBtn').classList.toggle('on', shuffle);
  $('repeatBtn').classList.toggle('on', repeat !== 'off');
  $('repeatBadge').textContent = repeat === 'one' ? '1' : '';
  $('repeatBtn').setAttribute('aria-label',
    repeat === 'all' ? '전체 반복' : repeat === 'one' ? '한 곡 반복' : '반복 없음');
}

function updateInfo() {
  const bytes = tracks.reduce((sum, t) => sum + (t.size || 0), 0);
  $('info').textContent = tracks.length ? `${tracks.length}곡 · ${(bytes / 1048576).toFixed(1)}MB` : '';
}

function renderList() {
  const list = $('list');
  list.textContent = '';
  tracks.forEach((track, i) => {
    const info = splitName(track.name);
    const li = document.createElement('li');
    if (track.id === currentId) li.className = 'current';

    const num = document.createElement('div');
    num.className = 'num';
    num.textContent = track.id === currentId ? '♪' : String(i + 1);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = info.title;
    const artist = document.createElement('div');
    artist.className = 'artist';
    artist.textContent = info.artist || '알 수 없는 아티스트';
    meta.append(title, artist);

    const tools = document.createElement('div');
    tools.className = 'tools';
    const mk = (label, text, cls, fn) => {
      const b = document.createElement('button');
      b.className = 'tool' + (cls ? ' ' + cls : '');
      b.textContent = text;
      b.setAttribute('aria-label', label);
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    tools.append(
      mk('위로 이동', '▲', '', () => moveTrack(i, -1)),
      mk('아래로 이동', '▼', '', () => moveTrack(i, 1)),
      mk('삭제', '✕', 'del', () => removeTrack(track)),
    );

    li.append(num, meta, tools);
    li.addEventListener('click', () => {
      if (!document.body.classList.contains('editing')) userPlay(track.id);
    });
    list.append(li);
  });
  $('empty').hidden = tracks.length > 0;
  updateInfo();
}

// ---------- 목록 편집 ----------
async function moveTrack(index, step) {
  const other = index + step;
  if (other < 0 || other >= tracks.length) return;
  const a = tracks[index], b = tracks[other];
  [a.order, b.order] = [b.order, a.order];
  tracks.sort((x, y) => x.order - y.order);
  await dbPutMeta([a, b]);
  rebuildQueue();
  renderList();
  preloadNext();
}

async function removeTrack(track) {
  if (!confirm(`'${splitName(track.name).title}' 곡을 앱에서 삭제할까요?\n('파일' 앱에 있는 원본은 삭제되지 않습니다.)`)) return;
  await dbDelete(track.id);
  tracks = tracks.filter((t) => t.id !== track.id);
  if (track.id === currentId) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    realSource = false;
    currentId = null;
    localStorage.removeItem('current');
    updateNowPlaying();
    updatePlayIcon();
  }
  rebuildQueue();
  renderList();
  preloadNext();
}

// ---------- 음원 가져오기 ----------
async function importFiles(files) {
  const list = Array.from(files).sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
  let order = tracks.reduce((max, t) => Math.max(max, t.order), 0);
  let added = 0, skipped = 0, failed = 0;

  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    setStatus(`음원을 가져오는 중입니다 (${i + 1}/${list.length})`);
    if (tracks.some((t) => t.name === file.name && t.size === file.size)) { skipped++; continue; }
    try {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const meta = { name: file.name, type: file.type || MIME[ext] || 'audio/mpeg', size: file.size, order: ++order };
      const buf = await file.arrayBuffer();
      meta.id = await dbAdd(meta, buf);
      tracks.push(meta);
      added++;
    } catch (e) {
      failed++;
    }
  }

  rebuildQueue();
  renderList();
  preloadNext();
  const parts = [`${added}곡을 추가했습니다.`];
  if (skipped) parts.push(`이미 있는 ${skipped}곡은 건너뛰었습니다.`);
  if (failed) parts.push(`${failed}곡은 저장하지 못했습니다(저장 공간을 확인해 주세요).`);
  setStatus(parts.join(' '));
  setTimeout(() => setStatus(''), 5000);
}

// ---------- 이벤트 연결 ----------
const openPicker = () => $('picker').click();
$('addBtn').addEventListener('click', openPicker);
$('addBtn2').addEventListener('click', openPicker);
$('picker').addEventListener('change', async (e) => {
  if (e.target.files.length) await importFiles(e.target.files);
  e.target.value = '';
});

$('editBtn').addEventListener('click', () => {
  const on = document.body.classList.toggle('editing');
  $('editBtn').textContent = on ? '완료' : '편집';
  $('editBtn').classList.toggle('on', on);
});

$('playBtn').addEventListener('click', () => { unlock(); togglePlay(); });
$('nextBtn').addEventListener('click', goNext);
$('prevBtn').addEventListener('click', goPrev);

$('shuffleBtn').addEventListener('click', () => {
  shuffle = !shuffle;
  localStorage.setItem('shuffle', shuffle ? '1' : '0');
  rebuildQueue();
  updateModeButtons();
  preloadNext();
});

$('repeatBtn').addEventListener('click', () => {
  repeat = repeat === 'all' ? 'one' : repeat === 'one' ? 'off' : 'all';
  localStorage.setItem('repeat', repeat);
  updateModeButtons();
  preloadNext();
});

$('seek').addEventListener('input', () => {
  dragging = true;
  if (audio.duration) $('curTime').textContent = fmt((($('seek').value) / 1000) * audio.duration);
});
$('seek').addEventListener('change', () => {
  if (realSource && audio.duration) audio.currentTime = ($('seek').value / 1000) * audio.duration;
  dragging = false;
});

// ---------- 시작 ----------
async function init() {
  tracks = (await dbAllMeta()).sort((a, b) => a.order - b.order);
  const saved = Number(localStorage.getItem('current'));
  if (tracks.some((t) => t.id === saved)) currentId = saved;
  rebuildQueue();
  updateModeButtons();
  renderList();
  updateNowPlaying();

  // 마지막으로 듣던 곡과 위치를 복원한다. 자동 재생은 하지 않는다.
  if (currentId != null) {
    await playTrack(currentId, false, Number(localStorage.getItem('position')) || 0);
  }

  // 저장 공간이 부족할 때 브라우저가 음원을 임의로 지우지 않도록 요청한다.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init().catch((e) => setStatus('저장소를 열지 못했습니다: ' + (e && e.message ? e.message : e)));
