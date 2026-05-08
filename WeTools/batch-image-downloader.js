/* WeTools — Batch Image Downloader
 *
 * Browser port of the provided Python tkinter ImageDownloaderApp.
 * Builds sequential filenames like `${prefix}${index padded}.${ext}` and
 * downloads them concurrently from a base URL.
 *
 * Destination:
 *  - If `window.showDirectoryPicker` is available (Chromium-based browsers in
 *    a secure context), the user picks a folder once and each image is written
 *    directly into it via the File System Access API.
 *  - Otherwise each successful download is offered through the standard
 *    anchor-download mechanism (subject to the browser's "Always ask where to
 *    save each file" preference).
 *
 * Headers caveat:
 *  Browsers forbid setting many request headers from JavaScript (e.g. Host,
 *  User-Agent, Referer, Connection, Cookie, Accept-Encoding, DNT and the
 *  Sec-* family). Such lines are filtered out with a one-time warning so the
 *  user understands why some headers from the Python sample are dropped.
 *
 * Privacy: like the rest of WeTools, this module never persists settings to
 * localStorage / sessionStorage / IndexedDB and never sends data anywhere
 * other than the user-specified Base URL.
 */
(function () {
  "use strict";

  // Headers that fetch() will silently drop (case-insensitive). Sourced from
  // the WHATWG Fetch spec "forbidden header name" list plus the Sec-* and
  // Proxy-* prefixes.
  const FORBIDDEN_HEADERS = new Set([
    "accept-charset", "accept-encoding", "access-control-request-headers",
    "access-control-request-method", "connection", "content-length", "cookie",
    "cookie2", "date", "dnt", "expect", "host", "keep-alive", "origin",
    "referer", "te", "trailer", "transfer-encoding", "upgrade", "via",
    "user-agent", "permissions-policy", "priority",
  ]);
  const FORBIDDEN_PREFIXES = ["sec-", "proxy-"];

  function isForbiddenHeader(name) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower)) return true;
    return FORBIDDEN_PREFIXES.some((p) => lower.startsWith(p));
  }

  const state = {
    abort: null,        // AbortController for in-flight downloads
    running: false,
    dirHandle: null,    // optional directory handle
  };

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") node.className = v;
        else if (k === "dataset") Object.assign(node.dataset, v);
        else if (k.startsWith("on") && typeof v === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v === true) node.setAttribute(k, "");
        else if (v !== false && v != null) node.setAttribute(k, v);
      }
    }
    if (children != null) {
      const list = Array.isArray(children) ? children : [children];
      for (const c of list) {
        if (c == null || c === false) continue;
        node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  function field(labelText, input) {
    return el("label", { class: "mm-field" }, [
      el("span", { class: "mm-muted" }, labelText),
      input,
    ]);
  }

  function parseHeaders(text, onWarn) {
    const headers = {};
    const dropped = [];
    text.split(/\r?\n/).forEach((raw) => {
      const line = raw.trim();
      if (!line || line.startsWith("#")) return;
      const idx = line.indexOf(":");
      if (idx <= 0) {
        onWarn("Skipping malformed header line: " + line);
        return;
      }
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (!key) return;
      if (isForbiddenHeader(key)) {
        dropped.push(key);
        return;
      }
      headers[key] = value;
    });
    if (dropped.length) {
      onWarn(
        "Browser policy forbids setting these header(s); they will be sent by the browser itself if applicable: " +
          dropped.join(", ")
      );
    }
    return headers;
  }

  function padIndex(i, width) {
    const s = String(i);
    return s.length >= width ? s : "0".repeat(width - s.length) + s;
  }

  function downloadBlobAnchor(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function writeBlob(dirHandle, filename, blob) {
    if (dirHandle && typeof dirHandle.getFileHandle === "function") {
      const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      return "saved to chosen folder";
    }
    downloadBlobAnchor(blob, filename);
    return "downloaded via browser";
  }

  function buildUI(host) {
    // ---- Inputs -------------------------------------------------------------
    const urlInput = el("input", {
      type: "url", class: "mm-input", placeholder: "https://static.example.com/cache/xxxxx",
      value: "",
    });

    const countInput = el("input", { type: "number", min: "1", step: "1", class: "mm-input mm-input-sm", value: "10" });
    const tasksInput = el("input", { type: "number", min: "1", max: "32", step: "1", class: "mm-input mm-input-sm", value: "5" });
    const prefixInput = el("input", { type: "text", class: "mm-input", value: "image_" });
    const padInput = el("input", { type: "number", min: "1", max: "12", step: "1", class: "mm-input mm-input-sm", value: "3" });
    const extInput = el("input", { type: "text", class: "mm-input mm-input-sm", value: ".jpg", title: "File extension including the dot" });
    const startInput = el("input", { type: "number", step: "1", class: "mm-input mm-input-sm", value: "1", title: "Index of the first file" });

    const folderLabel = el("span", { class: "mm-muted" }, "No folder chosen — files will use the browser's default download behaviour.");
    const folderBtn = el("button", { type: "button", class: "mm-btn mm-btn-sm" }, "Choose folder…");
    const clearFolderBtn = el("button", { type: "button", class: "mm-btn mm-btn-sm", disabled: true }, "Clear");

    const headersBox = el("textarea", {
      class: "mm-input mm-textarea", rows: "8", spellcheck: "false",
      placeholder: "One header per line, e.g.\nAccept: image/*\nAuthorization: Bearer …",
    });
    headersBox.value = [
      "Accept: image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5",
      "Accept-Language: en-US,en;q=0.5",
    ].join("\n");

    const startBtn = el("button", { type: "button", class: "mm-btn mm-btn-primary" }, "Start download");
    const stopBtn = el("button", { type: "button", class: "mm-btn", disabled: true }, "Stop");
    const clearLogBtn = el("button", { type: "button", class: "mm-btn mm-btn-sm" }, "Clear log");

    const status = el("p", { class: "mm-muted mm-status" }, "Idle.");
    const progress = el("progress", { class: "mm-progress", value: "0", max: "1" });
    progress.style.display = "none";
    const log = el("pre", { class: "mm-pre mm-log", "aria-live": "polite" }, "");

    // ---- Helpers ------------------------------------------------------------
    function appendLog(line) {
      const ts = new Date().toLocaleTimeString();
      log.textContent += "[" + ts + "] " + line + "\n";
      log.scrollTop = log.scrollHeight;
    }

    folderBtn.addEventListener("click", async () => {
      if (typeof window.showDirectoryPicker !== "function") {
        appendLog("Folder picker not available in this browser. Each image will be offered as a normal download.");
        return;
      }
      try {
        const handle = await window.showDirectoryPicker({ mode: "readwrite" });
        // Try to verify write permission proactively.
        if (typeof handle.requestPermission === "function") {
          const perm = await handle.requestPermission({ mode: "readwrite" });
          if (perm !== "granted") {
            appendLog("Write permission was not granted for the chosen folder.");
            return;
          }
        }
        state.dirHandle = handle;
        folderLabel.textContent = "Saving to: " + (handle.name || "(selected folder)");
        clearFolderBtn.disabled = false;
      } catch (err) {
        if (!err || err.name !== "AbortError") {
          appendLog("Folder selection failed: " + (err && err.message ? err.message : String(err)));
        }
      }
    });

    clearFolderBtn.addEventListener("click", () => {
      state.dirHandle = null;
      folderLabel.textContent = "No folder chosen — files will use the browser's default download behaviour.";
      clearFolderBtn.disabled = true;
    });

    clearLogBtn.addEventListener("click", () => { log.textContent = ""; });

    function setRunning(running) {
      state.running = running;
      startBtn.disabled = running;
      stopBtn.disabled = !running;
      [urlInput, countInput, tasksInput, prefixInput, padInput, extInput, startInput, headersBox, folderBtn, clearFolderBtn].forEach((n) => {
        if (n === clearFolderBtn) {
          n.disabled = running || !state.dirHandle;
        } else {
          n.disabled = running;
        }
      });
    }

    stopBtn.addEventListener("click", () => {
      if (state.abort) {
        try { state.abort.abort(); } catch (_) {}
        appendLog("Stop requested — cancelling in-flight requests.");
      }
    });

    startBtn.addEventListener("click", async () => {
      // ---- Validate ---------------------------------------------------------
      const baseUrl = urlInput.value.trim().replace(/\/+$/, "");
      const prefix = prefixInput.value;
      let ext = extInput.value.trim();
      if (ext && !ext.startsWith(".")) ext = "." + ext;
      const numFiles = parseInt(countInput.value, 10);
      const numTasks = parseInt(tasksInput.value, 10);
      const padding = parseInt(padInput.value, 10);
      const startIndex = parseInt(startInput.value, 10);

      if (!baseUrl) { status.textContent = "Please enter a Base URL."; return; }
      try { new URL(baseUrl); } catch (_) { status.textContent = "Base URL is not a valid URL."; return; }
      if (!Number.isFinite(numFiles) || numFiles < 1) { status.textContent = "Number of Files must be ≥ 1."; return; }
      if (!Number.isFinite(numTasks) || numTasks < 1) { status.textContent = "Number of Tasks must be ≥ 1."; return; }
      if (!Number.isFinite(padding) || padding < 1) { status.textContent = "Zeros in Filename must be ≥ 1."; return; }
      if (!Number.isFinite(startIndex)) { status.textContent = "Start index must be a number."; return; }

      const customHeaders = parseHeaders(headersBox.value, appendLog);

      // ---- Run --------------------------------------------------------------
      log.textContent = "";
      appendLog(
        "Starting: " + numFiles + " file(s), " + numTasks + " concurrent task(s)" +
        (state.dirHandle ? ", saving to chosen folder." : ", using browser downloads.")
      );
      progress.value = 0;
      progress.max = numFiles;
      progress.style.display = "";
      status.textContent = "Downloading 0 / " + numFiles + "…";
      setRunning(true);
      state.abort = new AbortController();

      let ok = 0, fail = 0, done = 0;

      async function downloadOne(i) {
        if (state.abort && state.abort.signal.aborted) return;
        const filename = prefix + padIndex(i, padding) + ext;
        const url = baseUrl + "/" + filename;
        try {
          const res = await fetch(url, {
            method: "GET",
            headers: customHeaders,
            signal: state.abort.signal,
            // Do not send credentials by default — matches the Python sample.
            credentials: "omit",
            cache: "no-store",
          });
          if (!res.ok) throw new Error("HTTP " + res.status + " " + res.statusText);
          const blob = await res.blob();
          const where = await writeBlob(state.dirHandle, filename, blob);
          ok++;
          appendLog("Downloaded " + filename + " (" + blob.size + " bytes, " + where + ")");
        } catch (err) {
          if (err && err.name === "AbortError") {
            appendLog("Cancelled " + filename);
          } else {
            fail++;
            appendLog("Failed " + filename + " — " + (err && err.message ? err.message : String(err)));
          }
        } finally {
          done++;
          progress.value = done;
          status.textContent = "Downloading " + done + " / " + numFiles + " (" + ok + " ok, " + fail + " failed)";
        }
      }

      // Concurrency pool that respects the configured task count.
      const indices = [];
      for (let i = 0; i < numFiles; i++) indices.push(startIndex + i);
      let cursor = 0;
      async function worker() {
        while (cursor < indices.length) {
          if (state.abort.signal.aborted) return;
          const myIndex = indices[cursor++];
          await downloadOne(myIndex);
        }
      }
      const workerCount = Math.min(numTasks, indices.length);
      const workers = [];
      for (let w = 0; w < workerCount; w++) workers.push(worker());
      try {
        await Promise.all(workers);
      } finally {
        const wasAborted = state.abort && state.abort.signal.aborted;
        state.abort = null;
        setRunning(false);
        progress.style.display = "none";
        status.textContent = (wasAborted ? "Stopped. " : "Done. ") +
          ok + " ok, " + fail + " failed, of " + numFiles + " requested.";
        appendLog(status.textContent);
      }
    });

    // ---- Layout -------------------------------------------------------------
    host.appendChild(field("Base URL (without filename)", urlInput));

    host.appendChild(el("div", { class: "mm-row mm-row-wrap" }, [
      field("Number of files", countInput),
      field("Number of tasks (parallel)", tasksInput),
      field("Filename prefix (before index)", prefixInput),
      field("Zero padding width (e.g. 3 for 001)", padInput),
      field("File extension", extInput),
      field("Start index", startInput),
    ]));

    host.appendChild(el("div", { class: "mm-row mm-row-wrap" }, [
      el("div", { class: "mm-field" }, [
        el("span", { class: "mm-muted" }, "Destination folder"),
        el("div", { class: "mm-row" }, [folderBtn, clearFolderBtn]),
        folderLabel,
      ]),
    ]));

    host.appendChild(field("Request headers (one per line, “Key: Value”)", headersBox));

    host.appendChild(el("div", { class: "mm-row" }, [startBtn, stopBtn, clearLogBtn]));

    host.appendChild(progress);
    host.appendChild(status);
    host.appendChild(el("div", { class: "mm-field" }, [
      el("span", { class: "mm-muted" }, "Log"),
      log,
    ]));
  }

  function buildPrivacyBanner() {
    return el("div", { class: "mm-banner", role: "note" }, [
      el("strong", null, "Browser-only. "),
      "Headers like Host, User-Agent, Referer, Cookie and the Sec-* family cannot be set from JavaScript and are silently dropped — the browser will add its own. If a server requires those exact values, this tool cannot impersonate them.",
    ]);
  }

  function mount(container) {
    container.classList.add("mm-root");
    container.replaceChildren();
    container.appendChild(buildPrivacyBanner());
    const sec = el("section", { class: "mm-section" }, [
      el("h3", { class: "mm-h3" }, "Batch image downloader"),
    ]);
    const inner = el("div", { class: "mm-section-body" });
    sec.appendChild(inner);
    buildUI(inner);
    container.appendChild(sec);
  }

  function unmount(container) {
    if (state.abort) {
      try { state.abort.abort(); } catch (_) {}
      state.abort = null;
    }
    state.running = false;
    state.dirHandle = null;
    if (container) {
      container.classList.remove("mm-root");
      container.replaceChildren();
    }
  }

  window.WeToolsBatchImageDownloader = { mount, unmount };
})();
