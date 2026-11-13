'use strict';

// ---------- 저장소 (IndexedDB) ----------
// meta: 곡 정보(이름, 순서), data: 실제 음원 바이트, playlists: 플레이리스트.
// 목록을 그릴 때 음원 전체를 읽지 않도록 meta와 data를 분리한다.
const DB_NAME = 'my-music';
let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 2);
      r.onupgradeneeded = (e) => {
        const d = r.result;
        if (e.oldVersion < 1) {
          d.createObjectStore('meta', { keyPath: 'id', autoIncrement: true });
          d.createObjectStore('data');
        }
        if (e.oldVersion < 2) {
          d.createObjectStore('playlists', { keyPath: 'id', autoIncrement: true });
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}

// 트랜잭션 하나를 열고, work가 box.value에 담은 값을 트랜잭션 완료 후에 반환한다.
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

const dbAll = (store) => withTx([store], 'readonly', (t, box) => {
  const r = t.objectStore(store).getAll();
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

// 새 플레이리스트는 id 없이 저장하며, 저장소가 부여한 id를 반환한다.
const dbPutPlaylist = (p) => withTx(['playlists'], 'readwrite', (t, box) => {
  const r = t.objectStore('playlists').put(p);
  r.onsuccess = () => { box.value = r.result; };
});

const dbDeletePlaylist = (id) => withTx(['playlists'], 'readwrite', (t) => {
  t.objectStore('playlists').delete(id);
});

// ---------- 상태 ----------
const $ = (id) => document.getElementById(id);
const audio = $('audio');

let tracks = [];            // 보관함의 모든 곡 (저장 순서)
let playlists = [];         // { id, name, trackIds }
let viewId = null;          // 화면에 표시 중인 목록 (null이면 전체 곡)
let contextId = null;       // 재생 중인 목록 (null이면 전체 곡)
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

const trackById = (id) => tracks.find((t) => t.id === id);
const playlistById = (id) => playlists.find((p) => p.id === id);
const isEditing = () => document.body.classList.contains('editing');

// 목록에 속한 곡 id를 순서대로 반환한다. listId가 null이면 보관함 전체이다.
function idsOf(listId) {
  const p = listId == null ? null : playlistById(listId);
  return p ? p.trackIds.filter(trackById) : tracks.map((t) => t.id);
}

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

function setContext(id) {
  contextId = id;
  if (id == null) localStorage.removeItem('context'); else localStorage.setItem('context', String(id));
}

// ---------- 재생 순서 ----------
function rebuildQueue() {
  const ids = idsOf(contextId);
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
  const track = trackById(id);
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

// 화면에 표시된 목록에서 곡을 선택하면, 그 목록이 재생 대상이 된다.
function playFromView(id) {
  if (contextId !== viewId) {
    setContext(viewId);
    currentId = id;
    rebuildQueue();
    renderChips();
  }
  userPlay(id);
}

function togglePlay() {
  if (currentId == null || !realSource) {
    const ids = idsOf(viewId);
    if (ids.length) {
      setContext(viewId);
      rebuildQueue();
      renderChips();
      userPlay(queue[0]);
    }
    return;
  }
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
  if (urls.has(id)) setSource(trackById(id), urls.get(id), true, 0);
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
audio.addEventListener('playing', () => { if (realSource) bindMediaActions(); });
audio.addEventListener('pause', () => { updatePlayIcon(); savePosition(); });
audio.addEventListener('error', () => {
  if (realSource && audio.error) setStatus('이 파일은 재생할 수 없는 형식입니다.');
});
document.addEventListener('visibilitychange', savePosition);

// ---------- 잠금 화면 / 제어 센터 ----------
function updateNowPlaying() {
  const track = trackById(currentId);
  const info = track ? splitName(track.name) : null;
  const list = playlistById(contextId);
  $('nowTitle').textContent = info ? info.title : '재생할 곡을 선택하세요';
  $('nowArtist').textContent = info ? info.artist : '';
  if (!info) { $('curTime').textContent = $('durTime').textContent = '0:00'; $('seek').value = 0; }
  if ('mediaSession' in navigator && info) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: info.title,
      artist: info.artist,
      album: list ? list.name : '내 음원',
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

// iOS는 '10초 이동' 동작이 등록되어 있거나 이전/다음 곡 동작이 인식되지 않으면
// 잠금 화면에 10초 이동 버튼을 표시한다. 그래서 10초 이동 동작을 명시적으로 해제하고,
// 재생이 실제로 시작될 때마다 이전/다음 곡 동작을 다시 등록한다.
function bindMediaActions() {
  if (!('mediaSession' in navigator)) return;
  const set = (name, fn) => { try { navigator.mediaSession.setActionHandler(name, fn); } catch (e) {} };
  set('seekbackward', null);
  set('seekforward', null);
  set('play', () => audio.play().catch(() => {}));
  set('pause', () => audio.pause());
  set('previoustrack', goPrev);
  set('nexttrack', goNext);
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
  const shown = idsOf(viewId).map(trackById);
  const bytes = shown.reduce((sum, t) => sum + (t.size || 0), 0);
  $('info').textContent = shown.length ? `${shown.length}곡 · ${(bytes / 1048576).toFixed(1)}MB` : '';
}

function renderChips() {
  const box = $('chips');
  box.textContent = '';
  const chip = (text, id, extra) => {
    const b = document.createElement('button');
    b.className = 'chip' + (extra || '');
    b.textContent = text;
    if (id !== undefined) {
      if (id === viewId) b.classList.add('active');
      if (id === contextId && currentId != null) b.classList.add('playing');
      b.addEventListener('click', () => { viewId = id; renderChips(); renderList(); });
    }
    box.append(b);
    return b;
  };
  chip('전체 곡', null);
  playlists.forEach((p) => chip(p.name, p.id));
  chip('+ 새 목록', undefined, ' new').addEventListener('click', createPlaylist);
}

function renderList() {
  const list = $('list');
  const inPlaylist = viewId != null;
  list.textContent = '';
  const shown = idsOf(viewId).map(trackById);

  shown.forEach((track, i) => {
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
      mk(inPlaylist ? '목록에서 빼기' : '삭제', '✕', 'del', () => removeTrack(track)),
    );

    li.append(num, meta, tools);
    li.addEventListener('click', () => { if (!isEditing()) playFromView(track.id); });
    list.append(li);
  });

  $('plBar').hidden = !inPlaylist;
  $('empty').hidden = inPlaylist || tracks.length > 0;
  $('emptyList').hidden = !inPlaylist || shown.length > 0;
  updateInfo();
}

// ---------- 입력 창 (이름 입력, 곡 선택) ----------
// 내용을 채우는 build 함수는 '완료'를 눌렀을 때 반환할 값을 만드는 함수를 돌려준다.
function openSheet(title, build) {
  return new Promise((resolve) => {
    const body = $('sheetBody');
    body.textContent = '';
    $('sheetTitle').textContent = title;
    const collect = build(body);
    const close = (value) => {
      $('sheet').hidden = true;
      $('sheetOk').onclick = $('sheetCancel').onclick = null;
      resolve(value);
    };
    $('sheetOk').onclick = () => close(collect());
    $('sheetCancel').onclick = () => close(null);
    $('sheet').hidden = false;
  });
}

function askName(title, initial) {
  return openSheet(title, (body) => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'nameInput';
    input.placeholder = '목록 이름';
    input.maxLength = 40;
    input.value = initial || '';
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('sheetOk').click(); });
    body.append(input);
    setTimeout(() => input.focus(), 50);
    return () => input.value.trim() || null;
  });
}

function pickTracks(playlist) {
  return openSheet('곡 선택', (body) => {
    const chosen = new Set(playlist.trackIds);
    const ul = document.createElement('ul');
    ul.className = 'pickList';
    tracks.forEach((track) => {
      const info = splitName(track.name);
      const li = document.createElement('li');
      const mark = document.createElement('span');
      mark.className = 'mark';
      const text = document.createElement('span');
      text.className = 'pickText';
      text.textContent = info.artist ? `${info.title} · ${info.artist}` : info.title;
      li.append(mark, text);
      const paint = () => li.classList.toggle('picked', chosen.has(track.id));
      li.addEventListener('click', () => {
        if (chosen.has(track.id)) chosen.delete(track.id); else chosen.add(track.id);
        paint();
      });
      paint();
      ul.append(li);
    });
    body.append(ul);
    // 기존 순서를 유지하고, 새로 선택한 곡은 목록의 끝에 추가한다.
    return () => [
      ...playlist.trackIds.filter((id) => chosen.has(id)),
      ...tracks.map((t) => t.id).filter((id) => chosen.has(id) && !playlist.trackIds.includes(id)),
    ];
  });
}

// ---------- 플레이리스트 ----------
async function createPlaylist() {
  const name = await askName('새 목록', '');
  if (!name) return;
  const p = { name, trackIds: [] };
  p.id = await dbPutPlaylist(p);
  playlists.push(p);
  viewId = p.id;
  renderChips();
  renderList();
}

async function renamePlaylist() {
  const p = playlistById(viewId);
  if (!p) return;
  const name = await askName('이름 변경', p.name);
  if (!name) return;
  p.name = name;
  await dbPutPlaylist(p);
  renderChips();
  updateNowPlaying();
}

async function deletePlaylist() {
  const p = playlistById(viewId);
  if (!p) return;
  if (!confirm(`'${p.name}' 목록을 삭제할까요?\n(곡은 보관함에 그대로 남습니다.)`)) return;
  await dbDeletePlaylist(p.id);
  playlists = playlists.filter((x) => x.id !== p.id);
  if (contextId === p.id) { setContext(null); rebuildQueue(); }
  viewId = null;
  renderChips();
  renderList();
  preloadNext();
}

async function addFromLibrary() {
  const p = playlistById(viewId);
  if (!p) return;
  if (!tracks.length) { setStatus("먼저 '+ 추가' 버튼으로 음원을 가져와 주세요."); return; }
  const ids = await pickTracks(p);
  if (!ids) return;
  p.trackIds = ids;
  await dbPutPlaylist(p);
  if (contextId === p.id) rebuildQueue();
  renderList();
  preloadNext();
}

// ---------- 목록 편집 ----------
async function moveTrack(index, step) {
  const other = index + step;
  const p = playlistById(viewId);
  if (p) {
    const ids = idsOf(p.id);
    if (other < 0 || other >= ids.length) return;
    [ids[index], ids[other]] = [ids[other], ids[index]];
    p.trackIds = ids;
    await dbPutPlaylist(p);
  } else {
    if (other < 0 || other >= tracks.length) return;
    const a = tracks[index], b = tracks[other];
    [a.order, b.order] = [b.order, a.order];
    tracks.sort((x, y) => x.order - y.order);
    await dbPutMeta([a, b]);
  }
  rebuildQueue();
  renderList();
  preloadNext();
}

async function removeTrack(track) {
  const p = playlistById(viewId);
  if (p) {
    // 플레이리스트 화면에서는 목록에서만 빼고, 보관함의 곡은 그대로 둔다.
    p.trackIds = p.trackIds.filter((id) => id !== track.id);
    await dbPutPlaylist(p);
  } else {
    if (!confirm(`'${splitName(track.name).title}' 곡을 앱에서 삭제할까요?\n('파일' 앱에 있는 원본은 삭제되지 않습니다.)`)) return;
    await dbDelete(track.id);
    tracks = tracks.filter((t) => t.id !== track.id);
    for (const pl of playlists) {
      if (pl.trackIds.includes(track.id)) {
        pl.trackIds = pl.trackIds.filter((id) => id !== track.id);
        await dbPutPlaylist(pl);
      }
    }
    if (track.id === currentId) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      realSource = false;
      currentId = null;
      localStorage.removeItem('current');
      updateNowPlaying();
      updatePlayIcon();
      renderChips();
    }
  }
  rebuildQueue();
  renderList();
  preloadNext();
}

// ---------- 음원 가져오기 ----------
async function importFiles(files) {
  const list = Array.from(files).sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
  const target = playlistById(viewId);   // 플레이리스트 화면에서 가져오면 그 목록에도 추가한다.
  let order = tracks.reduce((max, t) => Math.max(max, t.order), 0);
  let added = 0, skipped = 0, failed = 0;
  const touched = [];

  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    setStatus(`음원을 가져오는 중입니다 (${i + 1}/${list.length})`);
    const existing = tracks.find((t) => t.name === file.name && t.size === file.size);
    if (existing) { skipped++; touched.push(existing.id); continue; }
    try {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const meta = { name: file.name, type: file.type || MIME[ext] || 'audio/mpeg', size: file.size, order: ++order };
      const buf = await file.arrayBuffer();
      meta.id = await dbAdd(meta, buf);
      tracks.push(meta);
      touched.push(meta.id);
      added++;
    } catch (e) {
      failed++;
    }
  }

  if (target) {
    const fresh = touched.filter((id) => !target.trackIds.includes(id));
    if (fresh.length) {
      target.trackIds.push(...fresh);
      await dbPutPlaylist(target);
    }
  }

  rebuildQueue();
  renderList();
  preloadNext();
  const parts = [`${added}곡을 추가했습니다.`];
  if (skipped) parts.push(`이미 보관함에 있는 ${skipped}곡은 다시 저장하지 않았습니다.`);
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

$('plAddBtn').addEventListener('click', addFromLibrary);
$('plRenameBtn').addEventListener('click', renamePlaylist);
$('plDeleteBtn').addEventListener('click', deletePlaylist);

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
  tracks = (await dbAll('meta')).sort((a, b) => a.order - b.order);
  playlists = await dbAll('playlists');

  const savedContext = Number(localStorage.getItem('context'));
  if (playlistById(savedContext)) contextId = savedContext;
  viewId = contextId;

  const saved = Number(localStorage.getItem('current'));
  if (trackById(saved)) currentId = saved;

  rebuildQueue();
  bindMediaActions();
  updateModeButtons();
  renderChips();
  renderList();
  updateNowPlaying();

  // 마지막으로 듣던 곡과 위치를 복원한다. 자동 재생은 하지 않는다.
  if (currentId != null) {
    await playTrack(currentId, false, Number(localStorage.getItem('position')) || 0);
  }

  // 저장 공간이 부족할 때 브라우저가 음원을 임의로 지우지 않도록 요청한다.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  if ('serviceWorker' in navigator) {
    // 새 버전이 설치되면, 재생 중이 아닐 때에 한하여 화면을 새로 불러와서 바로 적용한다.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && audio.paused) location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init().catch((e) => setStatus('저장소를 열지 못했습니다: ' + (e && e.message ? e.message : e)));
