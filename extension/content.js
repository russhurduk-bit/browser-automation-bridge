/* [bridge-cs] Content Script — Browser Automation Bridge */
(function () {
  'use strict';
  const LOG = '[bridge-cs]';
  const VER = '1.0.0';
  let busy = false;

  /* ===== TARGET-APP CONFIG =====
   * The automation locates controls by their VISIBLE TEXT (resilient to CSS/DOM
   * churn). Adjust these labels to match the web app you are driving.
   * MEDIA_URL_RE matches the URLs of generated media in the target app's DOM. */
  const CFG = {
    MODE_IMAGE:  ['Image'],
    MODE_VIDEO:  ['Video'],
    MODEL_IMAGE: ['Standard'],
    MODEL_VIDEO: ['Fast'],
    UPLOAD:      ['Upload image', 'Upload'],
    ADD:         ['add'],
    FRAMES_TAB:  ['Frames'],
    START_SLOT:  ['Start', 'First frame'],
    DOWNLOAD:    ['Download'],
    MODEL_HINT:  /model|fast|standard|hd/i,   // pill text that looks like a model selector
    MEDIA_URL_RE: /media|asset|blob/i,        // generated-media URL signature
  };

  /* ===== UTILS ===== */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const pause = (a, b) => sleep(rand(a, b));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  function findByText(sel, texts, root = document) {
    for (const el of $$(sel, root)) {
      const t = el.textContent.trim().toLowerCase();
      for (const tx of texts) if (t.includes(tx.toLowerCase())) return el;
    }
    return null;
  }

  function findVisible(sel, texts, root = document) {
    for (const el of $$(sel, root)) {
      if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue;
      const t = el.textContent.trim().toLowerCase();
      for (const tx of texts) if (t.includes(tx.toLowerCase())) return el;
    }
    return null;
  }

  async function debuggerClick(el) {
    const r = el.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2 + (Math.random() * 6 - 3));
    const y = Math.round(r.y + r.height / 2 + (Math.random() * 6 - 3));
    console.log(`${LOG} click (${x},${y})`, el.textContent?.substring(0, 30));
    const res = await chrome.runtime.sendMessage({ type: 'DEBUGGER_CLICK', x, y });
    if (!res?.ok) throw new Error('debuggerClick failed: ' + (res?.error || 'no response'));
    await pause(200, 500);
  }

  function assignFile(input, blob, filename) {
    const f = new File([blob], filename, { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    console.log(`${LOG} assignFile: ${filename} (${blob.size}b)`);
  }

  async function waitFor(fn, timeout = 30000, poll = 500) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const r = typeof fn === 'function' ? fn() : $(fn);
      if (r) return r;
      await sleep(poll);
    }
    throw new Error(`waitFor timeout ${timeout}ms`);
  }

  async function freshFileInput(timeout = 15000) {
    const existing = new Set($$('input[type="file"]'));
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      for (const inp of $$('input[type="file"]'))
        if (!existing.has(inp)) return inp;
      await sleep(300);
    }
    const all = $$('input[type="file"]');
    if (all.length) return all[all.length - 1];
    throw new Error('No file input found');
  }

  function findEditor() {
    for (const ed of $$('[contenteditable="true"]')) {
      if (ed.offsetParent === null && getComputedStyle(ed).position !== 'fixed') continue;
      const r = ed.getBoundingClientRect();
      if (r.bottom > window.innerHeight * 0.5) return ed;
    }
    return $$('[contenteditable="true"]').find(e => e.offsetParent !== null) || null;
  }

  async function typePrompt(editor, text) {
    // Human-like input: type a short "head" burst, pause, then insert the tail as
    // a single paste — mimics a person typing a few words then pasting the rest.
    editor.focus();
    await sleep(200);
    const n = 30 + Math.floor(Math.random() * 20);
    const head = text.substring(0, Math.min(n, text.length));
    editor.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: head, bubbles: true, cancelable: true, composed: true }));
    console.log(`${LOG} typed head ${head.length}ch`);
    const tail = text.substring(head.length);
    if (tail) {
      await pause(4000, 9000);
      editor.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertFromPaste', data: tail, bubbles: true, cancelable: true, composed: true }));
      console.log(`${LOG} pasted tail ${tail.length}ch`);
    }
  }

  async function fetchBlob(url) {
    console.log(`${LOG} fetch ${url.substring(0, 60)}`);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    return r.blob();
  }

  /** POST result as multipart/form-data with field "file" */
  async function postResult(url, blob, filename) {
    console.log(`${LOG} POST result ${url.substring(0, 60)} (${blob.size}b)`);
    const fd = new FormData();
    fd.append('file', blob, filename);
    const r = await fetch(url, { method: 'POST', body: fd });
    if (!r.ok) throw new Error(`POST result ${r.status}`);
    const j = await r.json();
    console.log(`${LOG} POST result ok:`, j);
    return j;
  }

  /** Report error via HTTP POST to bridge error_url */
  async function reportError(job, error) {
    console.error(`${LOG} Job #${job.job_id} ERROR: ${error}`);
    if (job.error_url) {
      try {
        await fetch(job.error_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: String(error).substring(0, 500) })
        });
      } catch (e) { console.error(`${LOG} reportError HTTP failed`, e); }
    }
    chrome.runtime.sendMessage({ type: 'JOB_FAILED', job_id: job.job_id, error: String(error) });
  }

  /* ===== MODE / MODEL ===== */

  async function selectMode(tabTexts) {
    // Check if already in desired mode by looking at pill text
    const allBtns = $$('button');
    const pill = allBtns.find(b => {
      const r = b.getBoundingClientRect();
      return r.bottom > window.innerHeight * 0.4 && r.height > 20 && r.height < 80 &&
        new RegExp(tabTexts.join('|'), 'i').test(b.textContent);
    });
    if (!pill) { console.warn(`${LOG} selectMode: no pill found`); return; }

    const pillText = pill.textContent.trim().toLowerCase();
    for (const tx of tabTexts) {
      if (pillText.includes(tx.toLowerCase())) {
        console.log(`${LOG} mode ok (pill contains "${tx}")`);
        return;
      }
    }

    // Click pill to open mode tabs
    console.log(`${LOG} clicking pill: "${pill.textContent.trim().substring(0,40)}"`);
    await debuggerClick(pill);
    await pause(800, 1500);

    // Wait for [role="tab"] to appear (up to 5s)
    let tab = null;
    for (let i = 0; i < 10; i++) {
      tab = findByText('[role="tab"]', tabTexts);
      if (tab) break;
      // Also try button with tab-like classes
      tab = findVisible('button, [role="tab"], [role="option"]', tabTexts);
      if (tab) break;
      await sleep(500);
    }
    if (!tab) throw new Error(`Tab not found after pill click: ${tabTexts}`);
    await debuggerClick(tab);
    await pause(800, 1500);
    console.log(`${LOG} mode → ${tabTexts[0]}`);
  }

  async function ensureModel(texts) {
    const pills = $$('button').filter(b => b.getBoundingClientRect().bottom > window.innerHeight * 0.5);
    for (const p of pills) { const t = p.textContent.toLowerCase(); for (const tx of texts) if (t.includes(tx.toLowerCase())) return; }
    const pill = pills.find(p => CFG.MODEL_HINT.test(p.textContent));
    if (pill) { await debuggerClick(pill); await pause(500, 1000); }
    const item = findByText('[role="menuitem"], [role="option"], li', texts);
    if (item) { await debuggerClick(item); await pause(800, 1200); }
  }

  /* ===== IMAGE JOB ===== */

  async function doImageJob(job) {
    console.log(`${LOG} === IMAGE #${job.job_id} ===`);

    const coverBlob = await fetchBlob(job.cover_url);
    console.log(`${LOG} cover ${coverBlob.size}b`);

    await selectMode(CFG.MODE_IMAGE);
    await pause(500, 1000);
    await ensureModel(CFG.MODEL_IMAGE);
    await pause(500, 1000);

    // Attach cover via CDP file chooser (trusted upload, no native dialog)
    console.log(`${LOG} attaching cover…`);

    // Click "+" / Add button to open the asset library
    const addBtn = await waitFor(() => {
      return $$('button').find(b => {
        const t = b.textContent.trim();
        const r = b.getBoundingClientRect();
        return r.bottom > window.innerHeight * 0.5 && new RegExp(`\\b(${CFG.ADD.join('|')})\\b|add_2`, 'i').test(t);
      });
    }, 10000);
    await debuggerClick(addBtn);
    await pause(800, 1500);

    // Wait for the library dialog
    const dlg = await waitFor('[role="dialog"][data-state="open"], [role="dialog"]', 10000);
    console.log(`${LOG} library dialog open`);

    // Find the "Upload" card
    const upCard = findByText('button, div, [role="button"]', CFG.UPLOAD, dlg)
      || findVisible('*', CFG.UPLOAD, dlg);
    if (!upCard) throw new Error('Upload card not found in dialog');

    // Get upload card position for CDP click
    const upRect = upCard.getBoundingClientRect();
    const clickX = Math.round(upRect.x + upRect.width / 2);
    const clickY = Math.round(upRect.y + upRect.height / 2);

    // Create blob URL for background script to download
    const blobUrl = URL.createObjectURL(coverBlob);
    const filename = `cover_${job.job_id}.png`;

    console.log(`${LOG} uploading via CDP file chooser at (${clickX}, ${clickY})`);
    const uploadResult = await chrome.runtime.sendMessage({
      type: 'UPLOAD_FILE',
      blobUrl,
      filename,
      clickX,
      clickY
    });
    URL.revokeObjectURL(blobUrl);

    if (!uploadResult?.ok) {
      console.warn(`${LOG} CDP upload failed: ${uploadResult?.error}, falling back to assignFile`);
      // Fallback: click upload card normally + assignFile
      await debuggerClick(upCard);
      await pause(500, 1000);
      const fi = await freshFileInput(10000);
      assignFile(fi, coverBlob, filename);
      await sleep(5000);
    }

    // Wait for upload to process + dialog to auto-close
    console.log(`${LOG} waiting for upload confirmation…`);
    await waitFor(() => !$('[role="dialog"]'), 20000, 1000).catch(() => {
      console.warn(`${LOG} dialog didn't auto-close`);
    });

    // If dialog still open, close it
    if ($('[role="dialog"]')) {
      for (let esc = 0; esc < 3; esc++) {
        document.dispatchEvent(new PointerEvent('pointerdown', {clientX: 5, clientY: 5, bubbles: true, composed: true}));
        await sleep(500);
        if (!$('[role="dialog"]')) break;
        document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, composed: true}));
        await sleep(500);
        if (!$('[role="dialog"]')) break;
      }
    }

    console.log(`${LOG} cover attached, dialog ${$('[role="dialog"]') ? 'still open' : 'closed'}`);

    // Type prompt
    await pause(500, 1000);
    const ed = findEditor();
    if (!ed) throw new Error('Editor not found');
    await typePrompt(ed, job.prompt);
    await pause(15000, 30000);

    // Baseline: count all media imgs + snapshot URLs
    const baselineImgSrcs = new Set($$('img').filter(i => i.naturalWidth >= 100 && CFG.MEDIA_URL_RE.test(i.src || '')).map(i => i.src));
    const baselineCount = baselineImgSrcs.size;
    console.log(`${LOG} baseline: ${baselineCount} media imgs`);

    // Submit: click the submit/forward button (NOT the "+" add button!)
    const submitBtn = $$('button').find(b => /arrow_forward/.test(b.textContent));
    if (!submitBtn) throw new Error('Submit button (arrow_forward) not found');
    console.log(`${LOG} clicking submit (arrow_forward)`);
    await debuggerClick(submitBtn);
    await sleep(3000);
    console.log(`${LOG} submitted`);

    // Wait for generation: check /edit/ URL, new img count, or new img src
    const img = await waitFor(() => {
      // Signal 1: URL changed to /edit/ — result ready
      if (/\/edit\//.test(location.href)) {
        const editImg = $$('img').find(i => i.naturalWidth >= 100 && CFG.MEDIA_URL_RE.test(i.src || ''));
        if (editImg) return editImg;
      }
      // Signal 2: more media imgs than baseline (grid mode — new thumbnail appeared)
      const currentImgs = $$('img').filter(i => i.naturalWidth >= 100 && CFG.MEDIA_URL_RE.test(i.src || ''));
      if (currentImgs.length > baselineCount) {
        // Return the img whose src is NOT in baseline
        const newImg = currentImgs.find(i => !baselineImgSrcs.has(i.src));
        if (newImg) return newImg;
        return currentImgs[0]; // fallback: first img
      }
      return null;
    }, 240000, 10000);
    console.log(`${LOG} image ready ${img.src.substring(0, 60)}`);

    const blob = await fetchBlob(img.src);
    await postResult(job.result_image_url, blob, `start_frame_${job.job_id}.png`);
    console.log(`${LOG} === IMAGE #${job.job_id} DONE ===`);
    chrome.runtime.sendMessage({ type: 'JOB_DONE', job_id: job.job_id });
  }

  /* ===== VIDEO JOB ===== */

  async function doVideoJob(job) {
    console.log(`${LOG} === VIDEO #${job.job_id} ===`);

    const frameBlob = await fetchBlob(job.startframe_url);
    console.log(`${LOG} startframe ${frameBlob.size}b`);

    // If we're in /edit/ view, go back to the project grid first
    if (/\/edit\//.test(location.href)) {
      console.log(`${LOG} in edit view, navigating back`);
      const backBtn = $('button[aria-label="Back"], a[aria-label="Back"]') || findByText('button', ['arrow_back']);
      if (backBtn) { backBtn.click(); await sleep(3000); }
      else { history.back(); await sleep(3000); }
    }

    // Wait for prompt bar to be ready
    await waitFor(() => findEditor(), 30000, 1000);
    await pause(1000, 2000);

    await selectMode(CFG.MODE_VIDEO);
    await pause(1000, 2000);

    // Ensure video mode; model is typically auto-selected in video mode.
    await pause(500, 1000);

    // Frames sub-tab
    const frTab = findByText('button, [role="tab"]', CFG.FRAMES_TAB);
    if (frTab) {
      console.log(`${LOG} clicking Frames tab`);
      await debuggerClick(frTab);
      await pause(1000, 2000);
    }

    // Wait for start frame slot to appear
    console.log(`${LOG} attaching start frame…`);
    const startSlot = await waitFor(() => findVisible('button, div, [role="button"], span', CFG.START_SLOT), 30000, 1000);
    await debuggerClick(startSlot);
    await pause(1000, 2000);

    // Upload start frame via CDP file chooser
    const sfUpBtn = await waitFor(() => findVisible('button, div, [role="button"], a, span', CFG.UPLOAD), 15000, 1000);
    const sfRect = sfUpBtn.getBoundingClientRect();
    const sfClickX = Math.round(sfRect.x + sfRect.width / 2);
    const sfClickY = Math.round(sfRect.y + sfRect.height / 2);
    const sfBlobUrl = URL.createObjectURL(frameBlob);
    const sfFilename = `sf_${job.job_id}.png`;

    console.log(`${LOG} uploading start frame via CDP at (${sfClickX}, ${sfClickY})`);
    const sfResult = await chrome.runtime.sendMessage({
      type: 'UPLOAD_FILE', blobUrl: sfBlobUrl, filename: sfFilename, clickX: sfClickX, clickY: sfClickY
    });
    URL.revokeObjectURL(sfBlobUrl);

    if (!sfResult?.ok) {
      console.warn(`${LOG} CDP upload failed: ${sfResult?.error}, fallback assignFile`);
      await debuggerClick(sfUpBtn);
      await pause(500, 1000);
      const fi = await freshFileInput(15000);
      assignFile(fi, frameBlob, sfFilename);
      await sleep(5000);
    }

    await sleep(3000);
    // Close any panel
    for (let esc = 0; esc < 2; esc++) {
      if (!$('[role="dialog"]')) break;
      document.dispatchEvent(new PointerEvent('pointerdown', {clientX: 5, clientY: 5, bubbles: true, composed: true}));
      await sleep(1000);
    }
    console.log(`${LOG} start frame attached`);

    // Human-like pause before typing
    console.log(`${LOG} human pause ~30s…`);
    await pause(25000, 35000);

    // Type prompt
    const ed = findEditor();
    if (!ed) throw new Error('Editor not found');
    await typePrompt(ed, job.prompt);
    await pause(15000, 25000);

    // Submit: click the submit/forward button
    const vSub = $$('button').find(b => /arrow_forward/.test(b.textContent));
    if (!vSub) throw new Error('Video submit button not found');
    console.log(`${LOG} clicking video submit (arrow_forward)`);
    await debuggerClick(vSub);
    await sleep(3000);
    console.log(`${LOG} submitted video`);

    // Wait result (600s)
    console.log(`${LOG} waiting video (600s)…`);
    const vid = await waitFor(() => {
      // Check for video element with real src
      const v = $$('video').find(v => { const s = v.currentSrc || v.src || ''; return s.startsWith('http') || s.startsWith('blob:'); });
      if (v) return v;
      // Check for edit-view with Download button
      if (/\/edit\//.test(location.href)) {
        const dl = findVisible('button, a', CFG.DOWNLOAD);
        if (dl) return dl; // return Download btn as signal
      }
      return null;
    }, 600000, 10000);

    let videoBlob;
    if (vid.tagName === 'VIDEO') {
      videoBlob = await fetchBlob(vid.currentSrc || vid.src);
    } else {
      // Download button found — look for video element now
      const v2 = $$('video').find(v => (v.currentSrc || v.src || '').length > 10);
      if (v2) {
        videoBlob = await fetchBlob(v2.currentSrc || v2.src);
      } else {
        throw new Error('Video ready but cannot extract src');
      }
    }

    await postResult(job.result_video_url, videoBlob, `video_${job.job_id}.mp4`);
    console.log(`${LOG} === VIDEO #${job.job_id} DONE ===`);
    chrome.runtime.sendMessage({ type: 'JOB_DONE', job_id: job.job_id });
  }

  /* ===== MESSAGE HANDLER ===== */

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'EXECUTE_JOB') return;
    const job = msg.job;
    if (!job || !job.step) {
      console.error(`${LOG} bad job payload:`, msg);
      return;
    }
    if (busy) {
      reportError(job, 'Extension busy with another job');
      return;
    }
    busy = true;
    console.log(`${LOG} executing ${job.step} #${job.job_id}`);

    (async () => {
      try {
        if (job.step === 'image') await doImageJob(job);
        else if (job.step === 'video') await doVideoJob(job);
        else throw new Error(`Unknown step: ${job.step}`);
      } catch (e) {
        await reportError(job, e.message || String(e));
      } finally {
        busy = false;
      }
    })();
  });

  console.log(`${LOG} v${VER} loaded on ${location.href}`);
})();
