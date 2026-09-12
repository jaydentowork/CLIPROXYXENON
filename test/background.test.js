import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// The dashboard background module is a standalone browser script. This fixture
// drives it the way the browser does: a fake document, FileReader, Image, and
// canvas whose async steps the test resolves explicitly.
const KEY = 'cliproxyapi-monitor.background';
const WEBP = 'data:image/webp;base64,QUJDRA==';
const PNG = 'data:image/png;base64,REVGSA==';
const imageFile = (type = 'image/png', size = 2048, dataUrl = PNG) => ({ type, size, dataUrl });

function browserFixture({ seed = {}, storage = {}, encode } = {}) {
  const saved = new Map(Object.entries(seed));
  const events = [];
  const reads = [];
  const images = [];
  const canvases = [];
  const docProps = new Map();
  const elements = new Map();

  class FakeElement {
    constructor() { this.listeners = {}; this.files = []; this.value = ''; this.src = './1.png'; this.textContent = ''; this.dataset = {}; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
  }

  class FakeCanvas {
    constructor() { this.width = 0; this.height = 0; }
    getContext() { return { drawImage() {} }; }
    toDataURL(type) { return encode ? encode(type, this) : (type === 'image/webp' ? WEBP : PNG); }
  }

  class FakeFileReader {
    readAsDataURL(file) { reads.push({ reader: this, file }); }
  }

  class FakeImage {
    constructor() { this.naturalWidth = 0; this.naturalHeight = 0; }
    set src(value) { this.currentSrc = value; images.push({ image: this, src: value }); }
    get src() { return this.currentSrc; }
  }

  const context = {
    document: {
      getElementById(id) { if (!elements.has(id)) elements.set(id, new FakeElement()); return elements.get(id); },
      createElement() { const canvas = new FakeCanvas(); canvases.push(canvas); return canvas; },
      documentElement: {
        style: {
          setProperty(key, value) { docProps.set(key, value); events.push('apply'); },
          removeProperty(key) { docProps.delete(key); events.push('reset'); },
        },
      },
    },
    localStorage: {
      getItem(key) { if (storage.failGet) throw new Error('blocked'); return saved.has(key) ? saved.get(key) : null; },
      setItem(key, value) { if (storage.failSet) { const error = new Error('storage failed'); error.name = storage.errorName || 'QuotaExceededError'; throw error; } saved.set(key, value); events.push('setItem'); },
      removeItem(key) { if (storage.failRemove) throw new Error('blocked'); saved.delete(key); events.push('removeItem'); },
    },
    FileReader: FakeFileReader,
    Image: FakeImage,
  };
  runInNewContext(readFileSync(new URL('../public/background.js', import.meta.url), 'utf8'), context);

  const settle = () => new Promise(resolve => setImmediate(resolve));
  const resolveRead = async (index, { fail = false } = {}) => {
    const entry = reads[index];
    if (fail) entry.reader.onerror();
    else { entry.reader.result = entry.file.dataUrl; entry.reader.onload(); }
    await settle();
  };
  const resolveImage = async (index, { fail = false, width = 1600, height = 900 } = {}) => {
    const entry = images[index];
    if (fail) entry.image.onerror();
    else { entry.image.naturalWidth = width; entry.image.naturalHeight = height; entry.image.onload(); }
    await settle();
  };
  const select = async (file) => {
    const input = elements.get('background-image');
    input.files = [file];
    input.value = 'selected-image.png';
    input.listeners.change();
    await settle();
  };

  return {
    saved, events, reads, images, canvases, docProps, storage,
    input: elements.get('background-image'),
    reset: elements.get('background-reset'),
    status: elements.get('background-status'),
    preview: elements.get('background-preview'),
    settle, select, resolveRead, resolveImage,
  };
}

test('restores a valid saved background on load', async () => {
  const ui = browserFixture({ seed: { [KEY]: WEBP } });
  assert.equal(ui.docProps.has('--dashboard-background'), false);
  assert.equal(ui.images.length, 1);
  assert.equal(ui.images[0].src, WEBP);
  await ui.resolveImage(0);
  assert.equal(ui.docProps.get('--dashboard-background'), `url("${WEBP}")`);
  assert.equal(ui.preview.src, WEBP);
  assert.equal(ui.status.textContent, '');
});

test('invalid or undecodable saved data falls back without applying it', async () => {
  for (const bad of ['https://evil.example/x.png', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/png;base64,not base64!!', 'blob:http://localhost/abc']) {
    const ui = browserFixture({ seed: { [KEY]: bad } });
    assert.equal(ui.docProps.has('--dashboard-background'), false, bad);
    assert.equal(ui.preview.src, './1.png', bad);
    assert.match(ui.status.textContent, /invalid/i, bad);
    assert.equal(ui.saved.has(KEY), false, bad);
  }
  const undecodable = browserFixture({ seed: { [KEY]: PNG } });
  await undecodable.resolveImage(0, { fail: true });
  assert.equal(undecodable.docProps.has('--dashboard-background'), false);
  assert.equal(undecodable.preview.src, './1.png');
  assert.match(undecodable.status.textContent, /invalid/i);
  assert.equal(undecodable.saved.has(KEY), false);
});

test('persists a validated image before applying it', async () => {
  const ui = browserFixture();
  await ui.select(imageFile('image/png', 4096, PNG));
  assert.equal(ui.saved.has(KEY), false);
  await ui.resolveRead(0);
  assert.equal(ui.images[0].src, PNG);
  await ui.resolveImage(0, { width: 4000, height: 2000 });
  assert.deepEqual([ui.canvases[0].width, ui.canvases[0].height], [2560, 1280]);
  assert.equal(ui.saved.get(KEY), WEBP);
  assert.equal(ui.docProps.get('--dashboard-background'), `url("${WEBP}")`);
  assert.equal(ui.preview.src, WEBP);
  assert.equal(ui.status.textContent, 'Background updated.');
  assert.equal(ui.input.value, '');
  assert.deepEqual(ui.events, ['setItem', 'apply']);
});

test('keeps a small image at its own size and falls back to PNG when WebP is unavailable', async () => {
  const fallback = 'data:image/png;base64,ZmFsbGJhY2s=';
  const ui = browserFixture({ encode: type => (type === 'image/webp' ? PNG : fallback) });
  await ui.select(imageFile());
  await ui.resolveRead(0);
  await ui.resolveImage(0, { width: 1600, height: 900 });
  assert.deepEqual([ui.canvases[0].width, ui.canvases[0].height], [1600, 900]);
  assert.equal(ui.saved.get(KEY), fallback);
  assert.equal(ui.preview.src, fallback);
});

test('storage failures keep the previous background and allow the same file to be retried', async () => {
  for (const [errorName, message] of [['QuotaExceededError', /full.*smaller/i], ['SecurityError', /unavailable.*allow/i]]) {
    const ui = browserFixture({ seed: { [KEY]: WEBP }, storage: { errorName } });
    await ui.resolveImage(0);
    ui.storage.failSet = true;
    await ui.select(imageFile('image/jpeg', 4096));
    await ui.resolveRead(0);
    await ui.resolveImage(1);
    assert.equal(ui.docProps.get('--dashboard-background'), `url("${WEBP}")`);
    assert.equal(ui.preview.src, WEBP);
    assert.equal(ui.saved.get(KEY), WEBP);
    assert.match(ui.status.textContent, message);
    assert.equal(ui.status.dataset.error, 'true');
    assert.equal(ui.input.value, '');
  }
});

test('rejects unsupported, oversized, empty, and undecodable files without changing the background', async () => {
  const cases = [
    [imageFile('image/gif'), /JPEG, PNG, or WebP/],
    [imageFile('image/png', 13 * 1024 * 1024), /12 MB/],
    [imageFile('image/png', 0), /empty/i],
  ];
  for (const [bad, pattern] of cases) {
    const ui = browserFixture();
    await ui.select(bad);
    assert.equal(ui.reads.length, 0);
    assert.equal(ui.docProps.has('--dashboard-background'), false);
    assert.match(ui.status.textContent, pattern);
    assert.equal(ui.input.value, '');
    assert.equal(ui.status.dataset.error, 'true');
  }

  const unreadable = browserFixture();
  await unreadable.select(imageFile('image/png', 1024));
  await unreadable.resolveRead(0, { fail: true });
  assert.equal(unreadable.docProps.has('--dashboard-background'), false);
  assert.match(unreadable.status.textContent, /could not be read/i);

  const undecodable = browserFixture();
  await undecodable.select(imageFile('image/png', 1024));
  await undecodable.resolveRead(0);
  await undecodable.resolveImage(0, { fail: true });
  assert.equal(undecodable.docProps.has('--dashboard-background'), false);
  assert.match(undecodable.status.textContent, /could not be read/i);
});

test('rejects an encoded image past the two million character cap', async () => {
  const oversized = `data:image/webp;base64,${'A'.repeat(2000001)}`;
  const ui = browserFixture({ encode: () => oversized });
  await ui.select(imageFile('image/png', 4096, PNG));
  await ui.resolveRead(0);
  await ui.resolveImage(0);
  assert.equal(ui.saved.has(KEY), false);
  assert.equal(ui.docProps.has('--dashboard-background'), false);
  assert.match(ui.status.textContent, /too detailed/i);
});

test('reset clears only the background key and restores the default scene', async () => {
  const ui = browserFixture({ seed: { [KEY]: WEBP, 'cliproxyapi-monitor.api-key': 'sk-keep' } });
  await ui.resolveImage(0);
  ui.reset.listeners.click();
  assert.equal(ui.saved.has(KEY), false);
  assert.equal(ui.saved.get('cliproxyapi-monitor.api-key'), 'sk-keep');
  assert.equal(ui.docProps.has('--dashboard-background'), false);
  assert.equal(ui.preview.src, './1.png');
  assert.equal(ui.status.textContent, 'Default background restored.');
  assert.deepEqual(ui.events, ['apply', 'removeItem', 'reset']);
});

test('reset during an upload discards the stale image', async () => {
  const ui = browserFixture();
  await ui.select(imageFile('image/png', 2048, PNG));
  ui.reset.listeners.click();
  await ui.resolveRead(0);
  assert.equal(ui.images.length, 0);
  assert.equal(ui.saved.has(KEY), false);
  assert.equal(ui.docProps.has('--dashboard-background'), false);
  assert.equal(ui.preview.src, './1.png');
  assert.equal(ui.status.textContent, 'Default background restored.');
});

test('a newer selection wins over an older in-flight upload', async () => {
  const first = 'data:image/png;base64,QUFB';
  const second = 'data:image/png;base64,QkJC';
  const ui = browserFixture({ encode: () => PNG });
  await ui.select(imageFile('image/png', 2048, first));
  await ui.select(imageFile('image/png', 2048, second));
  assert.equal(ui.reads.length, 2);
  await ui.resolveRead(0);
  assert.equal(ui.images.length, 0);
  await ui.resolveRead(1);
  assert.equal(ui.images.length, 1);
  assert.equal(ui.images[0].src, second);
  await ui.resolveImage(0);
  assert.equal(ui.saved.get(KEY), PNG);
  assert.equal(ui.preview.src, PNG);
});

test('reset and blocked storage reads report honestly', async () => {
  const reset = browserFixture({ seed: { [KEY]: WEBP } });
  await reset.resolveImage(0);
  reset.storage.failRemove = true;
  reset.reset.listeners.click();
  assert.equal(reset.preview.src, './1.png');
  assert.equal(reset.docProps.has('--dashboard-background'), false);
  assert.match(reset.status.textContent, /storage/i);

  const blocked = browserFixture({ seed: { [KEY]: WEBP }, storage: { failGet: true } });
  await blocked.settle();
  assert.equal(blocked.docProps.has('--dashboard-background'), false);
  assert.equal(blocked.preview.src, './1.png');
  assert.match(blocked.status.textContent, /storage/i);
});
test('uses compressed JPEG when the PNG fallback is too large for browser storage', async () => {
  const largePng = 'data:image/png;base64,' + 'A'.repeat(2000001);
  const jpeg = 'data:image/jpeg;base64,SlBFRw==';
  const ui = browserFixture({ encode: type => type === 'image/jpeg' ? jpeg : largePng });
  await ui.select(imageFile());
  await ui.resolveRead(0);
  await ui.resolveImage(0);
  assert.equal(ui.saved.get(KEY), jpeg);
  assert.equal(ui.preview.src, jpeg);
});
