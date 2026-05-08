/* WeTools — Media Manager
 * Browser-only media workspace: playback, subtitle extraction, mic transcription,
 * audio/video cutting, and a yt-dlp command builder for largest-resolution downloads.
 *
 * Privacy: this module never writes to localStorage / sessionStorage / IndexedDB,
 * never sends data over the network, and revokes object URLs on teardown.
 */
(function () {
  "use strict";

  const SUPPORTED = {
    audio: ["audio/"],
    video: ["video/"],
    image: ["image/"],
  };

  const state = {
    objectUrl: null,
    file: null,
    kind: null, // 'audio' | 'video' | 'image'
    recognition: null,
    recognitionActive: false,
    audioCtx: null,
  };

  function classify(file) {
    if (!file || !file.type) {
      const name = (file && file.name ? file.name : "").toLowerCase();
      if (/\.(mp3|wav|ogg|m4a|flac|aac)$/.test(name)) return "audio";
      if (/\.(mp4|webm|mkv|mov|avi)$/.test(name)) return "video";
      if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/.test(name)) return "image";
      return null;
    }
    if (file.type.startsWith("audio/")) return "audio";
    if (file.type.startsWith("video/")) return "video";
    if (file.type.startsWith("image/")) return "image";
    return null;
  }

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
    if (children) {
      for (const c of [].concat(children)) {
        if (c == null || c === false) continue;
        node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  function fmtTime(t) {
    if (!isFinite(t) || t < 0) return "00:00.000";
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const ms = Math.round((t - Math.floor(t)) * 1000);
    const pad = (n, w) => String(n).padStart(w, "0");
    return (h > 0 ? pad(h, 2) + ":" : "") + pad(m, 2) + ":" + pad(s, 2) + "." + pad(ms, 3);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // --- Subtitle helpers ---
  function srtToVtt(srt) {
    const body = srt
      .replace(/\r+/g, "")
      .replace(/^\uFEFF/, "")
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
    return "WEBVTT\n\n" + body.trim() + "\n";
  }

  function cuesToVtt(cues) {
    const lines = ["WEBVTT", ""];
    for (const c of cues) {
      lines.push(fmtTime(c.startTime) + " --> " + fmtTime(c.endTime));
      lines.push(c.text || "");
      lines.push("");
    }
    return lines.join("\n");
  }

  // --- WAV encoder (16-bit PCM) ---
  function encodeWav(audioBuffer) {
    const numCh = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length * numCh * 2 + 44;
    const buf = new ArrayBuffer(length);
    const view = new DataView(buf);
    let p = 0;
    function w8(s) { for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i)); }
    function w32(v) { view.setUint32(p, v, true); p += 4; }
    function w16(v) { view.setUint16(p, v, true); p += 2; }
    w8("RIFF"); w32(length - 8); w8("WAVE");
    w8("fmt "); w32(16); w16(1); w16(numCh);
    w32(sampleRate); w32(sampleRate * numCh * 2); w16(numCh * 2); w16(16);
    w8("data"); w32(length - 44);

    const channels = [];
    for (let c = 0; c < numCh; c++) channels.push(audioBuffer.getChannelData(c));
    const total = audioBuffer.length;
    for (let i = 0; i < total; i++) {
      for (let c = 0; c < numCh; c++) {
        let s = Math.max(-1, Math.min(1, channels[c][i]));
        view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        p += 2;
      }
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  // --- Player section ---
  function buildPlayer(host) {
    const display = el("div", { class: "mm-display", id: "mm-display" }, [
      el("div", { class: "mm-empty" }, "Drop or pick an audio, image, or video file to begin."),
    ]);

    const dropzone = el("div", { class: "mm-dropzone", tabindex: "0", role: "button", "aria-label": "Open or drop a media file" }, [
      el("div", { class: "mm-dropzone-inner" }, [
        el("strong", null, "Click or drop a file"),
        el("span", { class: "mm-muted" }, "audio · image · video — nothing is uploaded or saved"),
      ]),
    ]);
    const picker = el("input", { type: "file", accept: "audio/*,video/*,image/*", hidden: true });
    dropzone.appendChild(picker);

    function trigger() { picker.click(); }
    dropzone.addEventListener("click", trigger);
    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); trigger(); }
    });
    dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("is-drag"); });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-drag"));
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("is-drag");
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });
    picker.addEventListener("change", () => {
      const f = picker.files && picker.files[0];
      if (f) loadFile(f);
    });

    host.appendChild(dropzone);
    host.appendChild(display);

    function loadFile(file) {
      const kind = classify(file);
      if (!kind) {
        display.replaceChildren(el("div", { class: "mm-error" }, "Unsupported file type: " + (file.type || file.name)));
        return;
      }
      // Reset previous URL
      if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
      state.objectUrl = URL.createObjectURL(file);
      state.file = file;
      state.kind = kind;

      const meta = el("div", { class: "mm-meta" }, [
        el("strong", null, file.name),
        el("span", { class: "mm-muted" }, " · " + (file.type || "unknown") + " · " + (file.size / 1024 / 1024).toFixed(2) + " MB"),
      ]);

      let viewer;
      if (kind === "audio") {
        viewer = el("audio", { id: "mm-media", controls: true, src: state.objectUrl, preload: "metadata" });
      } else if (kind === "video") {
        viewer = el("video", { id: "mm-media", controls: true, src: state.objectUrl, preload: "metadata", crossorigin: "anonymous", playsinline: true });
      } else {
        viewer = el("img", { id: "mm-media", src: state.objectUrl, alt: file.name });
      }

      display.replaceChildren(meta, viewer);
      // Notify dependent panels
      host.dispatchEvent(new CustomEvent("mm:loaded", { detail: { file, kind } }));
    }

    return { loadFile };
  }

  // --- Subtitles section ---
  function buildSubtitles(host, hostRoot) {
    const subFile = el("input", { type: "file", accept: ".vtt,.srt,text/vtt,application/x-subrip", hidden: true });
    const pickBtn = el("button", { type: "button", class: "mm-btn" }, "Add subtitle file (.vtt / .srt)");
    const extractBtn = el("button", { type: "button", class: "mm-btn", disabled: true }, "Extract in-band subtitles");
    const status = el("p", { class: "mm-muted mm-status" }, "Load a video to enable extraction.");
    const list = el("ul", { class: "mm-cues" });
    const cmdHelp = el("details", { class: "mm-details" }, [
      el("summary", null, "ffmpeg command for hard cases (non-WebVTT, MKV, etc.)"),
      el("pre", { class: "mm-pre" }, 'ffmpeg -i "INPUT.mkv" -map 0:s:0 "OUTPUT.srt"'),
    ]);

    pickBtn.addEventListener("click", () => subFile.click());
    subFile.addEventListener("change", async () => {
      const f = subFile.files && subFile.files[0];
      if (!f) return;
      const text = await f.text();
      const vtt = /^WEBVTT/.test(text.trim()) ? text : srtToVtt(text);
      attachVttToVideo(vtt, f.name);
      renderCuesFromText(vtt);
      status.textContent = "Loaded sidecar subtitles: " + f.name;
    });

    extractBtn.addEventListener("click", () => {
      const media = hostRoot.querySelector("#mm-media");
      if (!media || !("textTracks" in media)) {
        status.textContent = "No video element available.";
        return;
      }
      const tracks = media.textTracks;
      if (!tracks || tracks.length === 0) {
        status.textContent = "No in-band text tracks were exposed by the browser. Use the ffmpeg command below.";
        return;
      }
      let total = 0;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        t.mode = "showing"; // force cue parsing
        const cues = t.cues ? Array.from(t.cues) : [];
        if (cues.length === 0) continue;
        total += cues.length;
        const vtt = cuesToVtt(cues);
        downloadBlob(new Blob([vtt], { type: "text/vtt" }), (state.file ? state.file.name.replace(/\.[^.]+$/, "") : "subtitles") + "." + (t.language || "track" + i) + ".vtt");
        renderCuesFromText(vtt);
      }
      status.textContent = total > 0
        ? "Extracted " + total + " cue(s) from " + tracks.length + " track(s)."
        : "Tracks found but no cues yet — let the video play for a moment then retry, or use ffmpeg.";
    });

    function attachVttToVideo(vttText, label) {
      const media = hostRoot.querySelector("#mm-media");
      if (!media || media.tagName !== "VIDEO") return;
      // remove previous sidecar tracks we added
      Array.from(media.querySelectorAll("track[data-mm='sidecar']")).forEach((t) => t.remove());
      const blob = new Blob([vttText], { type: "text/vtt" });
      const trackUrl = URL.createObjectURL(blob);
      const track = document.createElement("track");
      track.kind = "subtitles";
      track.src = trackUrl;
      track.label = label || "Subtitles";
      track.default = true;
      track.dataset.mm = "sidecar";
      media.appendChild(track);
    }

    function renderCuesFromText(vtt) {
      list.replaceChildren();
      const blocks = vtt.split(/\n\s*\n/).slice(1, 51);
      for (const b of blocks) {
        const lines = b.split("\n").filter(Boolean);
        const ts = lines.find((l) => l.includes("-->"));
        const text = lines.filter((l) => l !== ts && !/^\d+$/.test(l)).join(" ");
        if (!ts || !text) continue;
        list.appendChild(el("li", null, [el("span", { class: "mm-ts" }, ts), " ", text]));
      }
      if (list.childElementCount === 0) list.appendChild(el("li", { class: "mm-muted" }, "(no cues to preview)"));
    }

    hostRoot.addEventListener("mm:loaded", (e) => {
      extractBtn.disabled = e.detail.kind !== "video";
      status.textContent = e.detail.kind === "video"
        ? "Click Extract to read in-band subtitles, or load a sidecar file."
        : "Load a video to enable extraction.";
      list.replaceChildren();
    });

    host.appendChild(el("div", { class: "mm-row" }, [pickBtn, extractBtn, subFile]));
    host.appendChild(status);
    host.appendChild(list);
    host.appendChild(cmdHelp);
  }

  // --- Voice to text section ---
  function buildVoiceToText(host) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const lang = el("select", { class: "mm-input" }, [
      ["en-US", "English (US)"],
      ["en-GB", "English (UK)"],
      ["zh-TW", "中文 (台灣)"],
      ["zh-CN", "中文 (普通話)"],
      ["ja-JP", "日本語"],
      ["ko-KR", "한국어"],
      ["es-ES", "Español"],
      ["fr-FR", "Français"],
      ["de-DE", "Deutsch"],
    ].map(([v, t]) => el("option", { value: v }, t)));

    const startBtn = el("button", { type: "button", class: "mm-btn mm-btn-primary" }, "Start microphone");
    const stopBtn = el("button", { type: "button", class: "mm-btn", disabled: true }, "Stop");
    const clearBtn = el("button", { type: "button", class: "mm-btn" }, "Clear");
    const dlBtn = el("button", { type: "button", class: "mm-btn" }, "Download .txt");
    const transcript = el("textarea", { class: "mm-textarea", rows: "6", placeholder: "Transcript will appear here. Nothing is sent to a server.", spellcheck: "false" });

    if (!SR) {
      host.appendChild(el("p", { class: "mm-muted" }, "This browser does not support the Web Speech API. For offline file transcription use the whisper command below."));
    } else {
      startBtn.addEventListener("click", () => {
        if (state.recognitionActive) return;
        const rec = new SR();
        rec.lang = lang.value;
        rec.continuous = true;
        rec.interimResults = true;
        let finalText = transcript.value;
        rec.onresult = (e) => {
          let interim = "";
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i];
            if (r.isFinal) finalText += r[0].transcript + " ";
            else interim += r[0].transcript;
          }
          transcript.value = finalText + interim;
        };
        rec.onerror = (e) => {
          transcript.value += "\n[error: " + e.error + "]\n";
        };
        rec.onend = () => {
          state.recognitionActive = false;
          startBtn.disabled = false;
          stopBtn.disabled = true;
        };
        try {
          rec.start();
          state.recognition = rec;
          state.recognitionActive = true;
          startBtn.disabled = true;
          stopBtn.disabled = false;
        } catch (err) {
          transcript.value += "\n[unable to start: " + err.message + "]\n";
        }
      });
      stopBtn.addEventListener("click", () => {
        if (state.recognition) state.recognition.stop();
      });
    }

    clearBtn.addEventListener("click", () => { transcript.value = ""; });
    dlBtn.addEventListener("click", () => {
      const text = transcript.value;
      if (!text.trim()) return;
      downloadBlob(new Blob([text], { type: "text/plain" }), "transcript.txt");
    });

    host.appendChild(el("div", { class: "mm-row" }, [
      el("label", { class: "mm-field" }, [el("span", { class: "mm-muted" }, "Language"), lang]),
      startBtn, stopBtn, clearBtn, dlBtn,
    ]));
    host.appendChild(transcript);
    host.appendChild(el("details", { class: "mm-details" }, [
      el("summary", null, "Offline file transcription (whisper)"),
      el("pre", { class: "mm-pre" }, 'whisper "INPUT.mp4" --model small --output_format srt'),
    ]));
  }

  // --- Cut audio / video section ---
  function buildCutter(host, hostRoot) {
    const startIn = el("input", { type: "number", class: "mm-input", min: "0", step: "0.01", value: "0" });
    const endIn = el("input", { type: "number", class: "mm-input", min: "0", step: "0.01", value: "0" });
    const useCurStart = el("button", { type: "button", class: "mm-btn mm-btn-sm" }, "Use current ↦ start");
    const useCurEnd = el("button", { type: "button", class: "mm-btn mm-btn-sm" }, "Use current ↦ end");
    const cutBtn = el("button", { type: "button", class: "mm-btn mm-btn-primary", disabled: true }, "Cut & download");
    const status = el("p", { class: "mm-muted mm-status" }, "Load audio or video to enable cutting.");

    function media() { return hostRoot.querySelector("#mm-media"); }

    useCurStart.addEventListener("click", () => { const m = media(); if (m && "currentTime" in m) startIn.value = m.currentTime.toFixed(2); });
    useCurEnd.addEventListener("click", () => { const m = media(); if (m && "currentTime" in m) endIn.value = m.currentTime.toFixed(2); });

    hostRoot.addEventListener("mm:loaded", (e) => {
      cutBtn.disabled = !(e.detail.kind === "audio" || e.detail.kind === "video");
      status.textContent = cutBtn.disabled
        ? "Load audio or video to enable cutting."
        : "Set start/end (seconds) and click Cut.";
    });

    cutBtn.addEventListener("click", async () => {
      const m = media();
      if (!m) return;
      const s = parseFloat(startIn.value);
      const e2 = parseFloat(endIn.value);
      if (!(e2 > s) || s < 0) {
        status.textContent = "End must be greater than start.";
        return;
      }
      cutBtn.disabled = true;
      try {
        if (state.kind === "audio") {
          status.textContent = "Decoding audio…";
          const buf = await state.file.arrayBuffer();
          if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          const decoded = await state.audioCtx.decodeAudioData(buf.slice(0));
          const sr = decoded.sampleRate;
          const startSample = Math.floor(s * sr);
          const endSample = Math.min(decoded.length, Math.floor(e2 * sr));
          const length = endSample - startSample;
          const out = state.audioCtx.createBuffer(decoded.numberOfChannels, length, sr);
          for (let c = 0; c < decoded.numberOfChannels; c++) {
            out.copyToChannel(decoded.getChannelData(c).subarray(startSample, endSample), c);
          }
          status.textContent = "Encoding WAV…";
          const blob = encodeWav(out);
          downloadBlob(blob, state.file.name.replace(/\.[^.]+$/, "") + ".cut.wav");
          status.textContent = "Done. Cut audio downloaded as WAV.";
        } else {
          // video
          if (typeof MediaRecorder === "undefined" || !m.captureStream) {
            status.textContent = "MediaRecorder/captureStream not supported here. Use the ffmpeg command below.";
            return;
          }
          status.textContent = "Recording cut…";
          m.pause();
          m.currentTime = s;
          await new Promise((res) => m.addEventListener("seeked", res, { once: true }));
          const stream = m.captureStream();
          const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
            ? "video/webm;codecs=vp9,opus"
            : MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
              ? "video/webm;codecs=vp8,opus"
              : "video/webm";
          const rec = new MediaRecorder(stream, { mimeType: mime });
          const chunks = [];
          rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
          const done = new Promise((res) => { rec.onstop = res; });
          rec.start();
          m.muted = false;
          await m.play();
          const stopAt = setTimeout(() => { try { rec.state !== "inactive" && rec.stop(); } catch (_) {} m.pause(); }, Math.max(50, (e2 - s) * 1000));
          const onTime = () => { if (m.currentTime >= e2) { clearTimeout(stopAt); try { rec.state !== "inactive" && rec.stop(); } catch (_) {} m.pause(); m.removeEventListener("timeupdate", onTime); } };
          m.addEventListener("timeupdate", onTime);
          await done;
          const blob = new Blob(chunks, { type: mime });
          downloadBlob(blob, state.file.name.replace(/\.[^.]+$/, "") + ".cut.webm");
          status.textContent = "Done. Cut video downloaded as WebM.";
        }
      } catch (err) {
        status.textContent = "Cut failed: " + err.message;
      } finally {
        cutBtn.disabled = false;
      }
    });

    host.appendChild(el("div", { class: "mm-row" }, [
      el("label", { class: "mm-field" }, [el("span", { class: "mm-muted" }, "Start (s)"), startIn]),
      useCurStart,
      el("label", { class: "mm-field" }, [el("span", { class: "mm-muted" }, "End (s)"), endIn]),
      useCurEnd,
      cutBtn,
    ]));
    host.appendChild(status);
    host.appendChild(el("details", { class: "mm-details" }, [
      el("summary", null, "Frame-accurate cut with ffmpeg (lossless copy)"),
      el("pre", { class: "mm-pre" }, 'ffmpeg -ss START -to END -i "INPUT" -c copy "OUTPUT"'),
    ]));
  }

  // --- YouTube command builder ---
  function buildYoutube(host) {
    const url = el("input", { type: "url", class: "mm-input mm-grow", placeholder: "https://www.youtube.com/watch?v=…", spellcheck: "false", autocomplete: "off" });
    const fmt = el("select", { class: "mm-input" }, [
      ["best", "Best video + best audio (largest)"],
      ["mp4", "Best MP4-compatible (largest)"],
      ["audio", "Audio only (best, mp3)"],
    ].map(([v, t]) => el("option", { value: v }, t)));
    const subs = el("label", { class: "mm-check" }, [el("input", { type: "checkbox" }), el("span", null, "Also download subtitles")]);
    const out = el("pre", { class: "mm-pre mm-cmd" }, "");
    const copyBtn = el("button", { type: "button", class: "mm-btn" }, "Copy command");
    const note = el("p", { class: "mm-muted" }, "Generated locally — your URL is never sent anywhere. Run the command in a terminal where yt-dlp and ffmpeg are installed.");

    function shellQuote(s) {
      // Single-quote for POSIX safety; escape embedded single quotes.
      return "'" + String(s).replace(/'/g, "'\\''") + "'";
    }

    function build() {
      const u = url.value.trim();
      if (!u) { out.textContent = "(enter a YouTube URL)"; return; }
      const subFlag = subs.querySelector("input").checked
        ? " --write-subs --write-auto-subs --sub-langs 'all' --convert-subs srt"
        : "";
      let fmtFlag;
      if (fmt.value === "mp4") {
        fmtFlag = ' -f "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b" --merge-output-format mp4';
      } else if (fmt.value === "audio") {
        fmtFlag = ' -f "ba/b" -x --audio-format mp3 --audio-quality 0';
      } else {
        // largest possible: prefer highest resolution then bitrate
        fmtFlag = ' -f "bv*+ba/b" -S "res,br,fps" --merge-output-format mkv';
      }
      out.textContent =
        "yt-dlp" + fmtFlag + subFlag +
        ' -o "%(title)s [%(id)s].%(ext)s" ' + shellQuote(u);
    }

    [url, fmt, subs.querySelector("input")].forEach((node) => node.addEventListener("input", build));
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(out.textContent);
        copyBtn.textContent = "Copied!";
        setTimeout(() => (copyBtn.textContent = "Copy command"), 1200);
      } catch (_) {
        copyBtn.textContent = "Copy failed";
        setTimeout(() => (copyBtn.textContent = "Copy command"), 1200);
      }
    });

    build();

    host.appendChild(el("div", { class: "mm-row" }, [url, fmt]));
    host.appendChild(el("div", { class: "mm-row" }, [subs, copyBtn]));
    host.appendChild(out);
    host.appendChild(note);
  }

  // --- Section helper ---
  function section(title, body) {
    const sec = el("section", { class: "mm-section" }, [el("h3", { class: "mm-h3" }, title)]);
    const inner = el("div", { class: "mm-section-body" });
    sec.appendChild(inner);
    body(inner);
    return sec;
  }

  function buildPrivacyBanner() {
    return el("div", { class: "mm-banner", role: "note" }, [
      el("strong", null, "No history. "),
      "Files stay in your browser tab. This module avoids localStorage / sessionStorage / IndexedDB and never uploads media.",
    ]);
  }

  function mount(container) {
    container.classList.add("mm-root");
    container.replaceChildren();
    container.appendChild(buildPrivacyBanner());

    const playerSection = section("Player", (host) => buildPlayer(host));
    container.appendChild(playerSection);

    const subsSection = section("Subtitles", (host) => buildSubtitles(host, container));
    container.appendChild(subsSection);

    const v2tSection = section("Voice to text", (host) => buildVoiceToText(host));
    container.appendChild(v2tSection);

    const cutSection = section("Cut audio / video", (host) => buildCutter(host, container));
    container.appendChild(cutSection);

    const ytSection = section("YouTube download (largest resolution)", (host) => buildYoutube(host));
    container.appendChild(ytSection);
  }

  function unmount(container) {
    if (state.recognition) {
      try { state.recognition.stop(); } catch (_) {}
      state.recognition = null;
      state.recognitionActive = false;
    }
    if (state.objectUrl) {
      URL.revokeObjectURL(state.objectUrl);
      state.objectUrl = null;
    }
    if (state.audioCtx && state.audioCtx.state !== "closed") {
      try { state.audioCtx.close(); } catch (_) {}
      state.audioCtx = null;
    }
    state.file = null;
    state.kind = null;
    if (container) {
      container.classList.remove("mm-root");
      container.replaceChildren();
    }
  }

  window.WeToolsMediaManager = { mount, unmount };
})();
