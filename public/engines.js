// Voice engines: how the narrator talks and how the page hears you.
// Both expose the same interface so app.js doesn't care which one is running:
//   init()                     call from a click (browsers require it for audio and the mic)
//   speak(text) -> Promise     resolves when the clip ends or is stopped
//   prefetch(text)             warm the cache so the next sentence starts without a gap
//   stop()                     cut the narrator off immediately
//   duck(on)                   lower the narrator's volume while you might be talking
//   startMic({ onHeard, onLevel, onError }) / stopMic()
//     onHeard(text, isFinal)   what you said so far; isFinal once you've finished the sentence
//     onLevel(level)           mic loudness after echo cancellation, about every 100 ms

// ---------- cloud engine: narrator audio played by the page, echo-cancelled mic streamed to the server ----------
export function createCloudEngine() {
  let ctx = null;
  let gain = null;
  let current = null;
  let playToken = 0;
  const cache = new Map();
  let micStream = null;
  let ws = null;
  let micOn = false;
  let micNodes = [];
  let muted = false;
  let keepAlive = null;
  let handlers = {};
  const keep = []; // loopback peer connections and <audio> element must stay referenced

  async function init() {
    if (ctx) return;
    ctx = new AudioContext();
    await ctx.resume();
    gain = ctx.createGain();
    gain.connect(await loopbackOutput());
  }

  // Chrome only cancels echo for audio it knows is going to the speakers, which is audio from a WebRTC
  // call. Sending the narrator through a local WebRTC loopback gives the echo canceller that reference,
  // so your mic can stay open over speakers. Falls back to plain playback if WebRTC isn't available.
  async function loopbackOutput() {
    const dest = ctx.createMediaStreamDestination();
    try {
      const a = new RTCPeerConnection();
      const b = new RTCPeerConnection();
      a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
      b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
      const remote = new Promise((resolve) => {
        b.ontrack = (e) => resolve(e.streams[0] || new MediaStream([e.track]));
      });
      for (const track of dest.stream.getTracks()) a.addTrack(track, dest.stream);
      const offer = await a.createOffer();
      await a.setLocalDescription(offer);
      await b.setRemoteDescription(offer);
      const answer = await b.createAnswer();
      await b.setLocalDescription(answer);
      await a.setRemoteDescription(answer);
      const stream = await Promise.race([remote, new Promise((_, reject) => setTimeout(() => reject(new Error("loopback timeout")), 3000))]);
      const el = new Audio();
      el.srcObject = stream;
      await el.play();
      keep.push(a, b, el);
      return dest;
    } catch (err) {
      console.warn("WebRTC loopback unavailable, playing directly (less echo protection):", err);
      return ctx.destination;
    }
  }

  function load(text) {
    if (!cache.has(text)) {
      const p = fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      })
        .then((r) => {
          if (!r.ok) throw new Error(`TTS failed (${r.status})`);
          return r.arrayBuffer();
        })
        .then((bytes) => ctx.decodeAudioData(bytes));
      p.catch(() => cache.delete(text));
      cache.set(text, p);
    }
    return cache.get(text);
  }

  async function speak(text) {
    const token = ++playToken;
    const buffer = await load(text);
    if (token !== playToken) return; // stopped while loading
    await new Promise((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(gain);
      src.onended = () => {
        if (current === src) current = null;
        resolve();
      };
      current = src;
      src.start();
    });
  }

  function prefetch(text) {
    if (text && ctx) load(text).catch(() => {});
  }

  function stop() {
    playToken++;
    const src = current;
    current = null;
    try { src?.stop(); } catch {}
    duck(false);
  }

  function duck(on) {
    if (gain) gain.gain.setTargetAtTime(on ? 0.25 : 1, ctx.currentTime, 0.05);
  }

  async function startMic(h) {
    handlers = h;
    if (micOn) return;
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    await ctx.audioWorklet.addModule("pcm-worklet.js");
    const node = new AudioWorkletNode(ctx, "pcm-capture");
    const silent = ctx.createGain();
    silent.gain.value = 0;
    const source = ctx.createMediaStreamSource(micStream);
    source.connect(node).connect(silent).connect(ctx.destination);
    micNodes = [source, node, silent];
    node.port.onmessage = (e) => {
      if (!muted && ws?.readyState === WebSocket.OPEN) ws.send(e.data.pcm);
      handlers.onLevel?.(e.data.level);
    };
    micOn = true;
    openSocket();
  }

  function openSocket() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(`${proto}://${location.host}/api/listen?rate=${ctx.sampleRate}`);
    ws = sock;
    let utterance = "";
    const finish = () => {
      if (utterance) handlers.onHeard(utterance, true);
      utterance = "";
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      const msg = JSON.parse(ev.data);
      if (msg.type === "Results") {
        const text = msg.channel?.alternatives?.[0]?.transcript || "";
        if (msg.is_final) {
          if (text) utterance = `${utterance} ${text}`.trim();
          if (msg.speech_final) finish();
          else if (text) handlers.onHeard(utterance, false);
        } else if (text) {
          handlers.onHeard(`${utterance} ${text}`.trim(), false);
        }
      } else if (msg.type === "UtteranceEnd") {
        finish();
      } else if (msg.type === "Error") {
        handlers.onError?.(msg.message);
      }
    };
    // Only the current socket reconnects; an old one closing late (after Restart) must not replace it.
    sock.onclose = () => {
      if (micOn && ws === sock) setTimeout(() => { if (micOn && ws === sock) openSocket(); }, 1000);
    };
  }

  // Mic off: stop sending audio, but keep the speech connection alive so turning it back on is instant.
  function setMuted(on) {
    muted = on;
    clearInterval(keepAlive);
    if (on) keepAlive = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "KeepAlive" })), 5000);
  }

  function stopMic() {
    micOn = false;
    setMuted(false);
    // Fully detach the old capture node: left connected, it keeps streaming silence into the next
    // session's socket, interleaved with your voice, and speech recognition stops understanding you.
    const [, node] = micNodes;
    if (node) node.port.onmessage = null;
    micNodes.forEach((n) => { try { n.disconnect(); } catch {} });
    micNodes = [];
    const old = ws;
    ws = null;
    try { old?.close(); } catch {}
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = null;
  }

  return { name: "cloud", init, speak, prefetch, stop, duck, startMic, stopMic, setMuted };
}

// ---------- browser engine: built-in voices and Chrome's speech recognition (no keys, no echo cancellation) ----------
export function createBrowserEngine() {
  let voice = null;
  let current = null; // keep a reference: Chrome can drop events for garbage-collected utterances
  let rec = null;
  let micWanted = false;
  let handlers = {};

  function pickVoice() {
    const voices = speechSynthesis.getVoices().filter((v) => v.lang?.startsWith("en"));
    voice = voices.find((v) => /natural|neural|google us/i.test(v.name)) || voices.find((v) => v.default) || voices[0] || null;
  }
  speechSynthesis.onvoiceschanged = pickVoice;
  pickVoice();

  function speak(text) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      if (voice) u.voice = voice;
      u.rate = 1.02;
      u.onend = u.onerror = () => resolve();
      current = u;
      speechSynthesis.speak(u);
    });
  }

  async function startMic(h) {
    handlers = h;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      handlers.onError?.("This browser has no speech recognition, so use the Interrupt button and type your question. Google Chrome or Edge support talking.");
      return;
    }
    if (rec) return;
    rec = new SR();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = "";
      let final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t; else interim += t;
      }
      const text = (final || interim).trim();
      if (text) handlers.onHeard(text, Boolean(final));
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        micWanted = false;
        handlers.onError?.("Microphone access was blocked, so use the Interrupt button and type your question.");
      } else if (e.error === "network") {
        micWanted = false;
        handlers.onError?.("Speech recognition isn't available in this browser build (common in Chromium on Linux). Use Google Chrome, or the Interrupt button and typing.");
      }
    };
    rec.onend = () => { if (micWanted) try { rec.start(); } catch {} };
    micWanted = true;
    try { rec.start(); } catch {}
  }

  function stopMic() {
    micWanted = false;
    try { rec?.stop(); } catch {}
    rec = null;
  }

  return {
    name: "browser",
    init: async () => {},
    speak,
    prefetch: () => {},
    stop: () => speechSynthesis.cancel(),
    duck: () => {},
    startMic,
    stopMic,
  };
}
