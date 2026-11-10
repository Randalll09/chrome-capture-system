// 캡처 이미지를 확장 프로그램 내부 IndexedDB에 잠시 보관합니다.
// (서비스 워커 → 편집기 탭으로 큰 이미지를 넘기기 위함)
const DB_NAME = 'capture-db';
const STORE = 'images';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 하루 지난 캡처는 정리

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function putImage(id, blob) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  // 오래된 항목 정리
  const now = Date.now();
  store.openCursor().onsuccess = (e) => {
    const cursor = e.target.result;
    if (!cursor) return;
    if (!cursor.value || now - cursor.value.created > MAX_AGE_MS) cursor.delete();
    cursor.continue();
  };
  store.put({ blob, created: now }, id);
  await done(tx);
  db.close();
}

export async function getImage(id) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const req = tx.objectStore(STORE).get(id);
  await done(tx);
  db.close();
  return req.result ? req.result.blob : null;
}
