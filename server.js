// Tiny local server for the interactive podcast prototype.
// Serves ./public, answers listener questions via Claude (POST /api/answer), and, when DEEPGRAM_API_KEY
// is set, renders the narrator's voice (POST /api/tts) and relays the mic to speech recognition (WS /api/listen)
// so the API key never reaches the browser.
// Run: npm install && ANTHROPIC_API_KEY=... DEEPGRAM_API_KEY=... npm start   (then open http://localhost:3000 in Chrome)
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { WebSocketServer, WebSocket } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));

// Load keys from prototype/.env if it exists (KEY=value per line), so they don't have to be typed each run.
// Anything already exported in the terminal wins.
try {
  for (const line of (await fs.readFile(path.join(here, ".env"), "utf8")).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}
const PUBLIC_DIR = path.join(here, "public");
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";
const FALLBACK_MODEL = process.env.CLAUDE_FALLBACK_MODEL || "claude-sonnet-5-5";

const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;
const VOICE = process.env.DEEPGRAM_VOICE || "aura-2-thalia-en";
const DEEPGRAM_URL = process.env.DEEPGRAM_URL || "https://api.deepgram.com"; // override for self-hosted Deepgram or tests
const TTS_CACHE = path.join(here, ".cache", "tts");

const hasCredentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const client = hasCredentials ? new Anthropic() : null;

const SYSTEM_PROMPT = `You are the host of a podcast episode. A listener just cut in while you were talking.
Sound like a warm, quick, genuinely friendly host who enjoys the interruption: natural, conversational, a little personality, never stiff.
Keep it short: one to three spoken sentences, and put the actual answer in the first sentence.

Start your reply with one tag on its own line, then what you say out loud:
- EPISODE: about the episode (a missed detail, a "say that again", a "what does that mean", a quick recap of what they have heard so far). The script is the source of truth; repeat the facts exactly as the script gives them.
- RELATED: related but not in the script. Answer from general knowledge in a sentence or two and flag it lightly, for example "That's not in today's story, but generally..."
- OFF_TOPIC: off-topic, silly or trolling. One light, good-natured line. Don't lecture.
- PREVIEW n: they want to know what's coming, or a summary or "the gist" of parts they haven't heard yet. Put the line number n where that part starts (from "Rest of the episode") after the tag, e.g. "PREVIEW 9". Say what the part is about in one line without giving away its facts, then offer to skip there, e.g. "Coming up, the mayor weighs in on the launch. Want me to skip ahead to that?"
- SUMMARY: only when you already offered a preview earlier in this interruption and the listener still insists on just hearing the gist. Give a quick two or three sentence version of the parts they asked about.
- BACKGROUND: the words don't sound addressed to you at all: a TV, a video, song lyrics, or someone talking to another person. Say nothing after the tag.
- RESUME: the listener wants the episode to start playing again, in any wording ("ok, proceed", "let's get back to it", "roll on"). Say nothing after the tag.
- PAUSE: the listener wants the episode to stop and wait, in any wording ("give me a breather", "hang tight until I'm back"). Say nothing after the tag.
- CONTINUE: the listener is done and just wants you to carry on ("okay got it", "no that's fine", "you can resume"). Say only a short acknowledgment of a few words, like "Glad that helped!"

Rules:
- Never reveal facts from parts of the script the listener hasn't reached yet, except in a SUMMARY.
- Never repeat or paraphrase the line you were interrupted on, and never say you're picking back up or ask if they have more questions or want you to keep going. The app resumes the episode itself and asks those questions when needed, so don't end with a question unless it's the PREVIEW offer.
- If asked about yourself (your name, gender, age, whether you're a real person), say lightly that you're the show's AI host. Don't claim a gender, a body or a human life, then get back to the listener.
- The text is read aloud by text-to-speech: plain sentences only. No lists, markdown, emoji or stage directions.

Examples:
Listener: "Wait, how many people does it carry?"
EPISODE
Up to a hundred and forty passengers per trip.

Listener: "How do solar panels even work?"
RELATED
Not from today's story, but in short, the panels turn sunlight into electricity that charges the boat's batteries.

Listener: "What's your favorite pizza topping?"
OFF_TOPIC
Ha, pineapple, and I'll defend it.

Listener: "Can you just sum up the rest for me?"
PREVIEW 9
Sure. Still to come, the mayor's take, some unhappy commuters, and what's next for the city's other ferries. Want me to skip ahead to the highlights?

Listener: "and in other news tonight the senate voted to"
BACKGROUND

Listener: "Okay yeah, gotcha, you can keep going."
CONTINUE
You got it.`;

const KINDS = { RESUME: "resume", PAUSE: "pause", BACKGROUND: "background", PREVIEW: "preview", SUMMARY: "summary", EPISODE: "episode", RELATED: "related", OFF_TOPIC: "off_topic", CONTINUE: "continue" };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
};

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 200_000) throw new Error("Request too large");
  }
  return JSON.parse(body || "{}");
}

// Without an API key, fall back to repeating the script sentence that best matches the question.
function offlineAnswer(question, heard) {
  const words = (s) => s.toLowerCase().match(/[a-z0-9']+/g) || [];
  const stop = new Set(["the", "a", "an", "what", "was", "is", "did", "you", "say", "about", "that", "again", "repeat", "can", "it", "of", "to", "and", "in", "how", "many", "much", "who", "when", "where", "why"]);
  const q = new Set(words(question).filter((w) => !stop.has(w)));
  let best = null;
  let bestScore = 0;
  for (const sentence of heard) {
    const score = words(sentence).filter((w) => q.has(w)).length;
    if (score > bestScore) {
      best = sentence;
      bestScore = score;
    }
  }
  if (!best) return "Sorry, I'm not sure which part you mean. Here's the last bit again: " + (heard.at(-1) || "");
  return "Sure. " + best;
}

// Streams the answer as NDJSON events so the browser can start speaking the first sentence
// while Claude is still writing the rest: {type:"kind"}, then {type:"sentence"} per sentence, then {type:"done"}.
async function streamAnswer({ title, heard = [], current = "", upcoming = [], question = "", history = [], paused = false }, emit) {
  if (!client) {
    emit({ type: "kind", kind: "episode" });
    emit({ type: "sentence", text: offlineAnswer(question, heard) });
    return;
  }

  const transcript = heard.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const priorQA = history.map((h) => `Listener: ${h.q}\nYou: ${h.a}`).join("\n");
  const prompt = `Episode: ${title}

Script so far (what the listener has heard):
${transcript}

You were interrupted while saying: "${current}"
${upcoming.length ? `\nRest of the episode (not heard yet; follow the rules before using it):\n${upcoming.map((s, i) => `${heard.length + i + 1}. ${s}`).join("\n")}\n` : ""}
${priorQA ? `\nEarlier in this interruption:\n${priorQA}\n` : ""}
${paused ? "\nThe episode is paused (or finished) right now and the listener is chatting with you, so what they say is almost certainly meant for you, even jokes, reactions or quotes. Reply to it; only use BACKGROUND for unmistakable TV or video audio.\n" : ""}
Listener says: "${question}"`;

  // Haiku first for speed; retry on Sonnet if Haiku errors or declines before saying anything.
  for (const model of [MODEL, FALLBACK_MODEL]) {
    let buffer = "";
    let kindSent = false;
    let spoke = false;
    const sendKind = (kind, target) => {
      if (!kindSent) emit({ type: "kind", kind, ...(target ? { target } : {}) });
      if (["background", "resume", "pause"].includes(kind)) spoke = true; // staying quiet is the answer
      kindSent = true;
    };
    // Emit each complete sentence as soon as it's written.
    const flush = (final) => {
      if (!kindSent) {
        const nl = buffer.indexOf("\n");
        if (nl === -1 && !final && buffer.length < 40) return;
        const line = (nl === -1 ? buffer : buffer.slice(0, nl)).trim().toUpperCase();
        const tag = line.replace(/[^A-Z_]/g, "");
        const target = Number(line.match(/\d+/)?.[0]) || undefined; // PREVIEW n: 1-based line to skip to
        if (KINDS[tag]) {
          sendKind(KINDS[tag], target);
          buffer = nl === -1 ? "" : buffer.slice(nl + 1);
        } else {
          sendKind("episode"); // no tag: treat the whole thing as the answer
        }
      }
      const re = /^(.+?[.!?]["')\]]*)\s+/s;
      let m;
      while ((m = buffer.match(re))) {
        emit({ type: "sentence", text: m[1].trim() });
        spoke = true;
        buffer = buffer.slice(m[0].length);
      }
      if (final && buffer.trim()) {
        emit({ type: "sentence", text: buffer.trim() });
        spoke = true;
        buffer = "";
      }
    };
    try {
      const stream = client.messages.stream({
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        // Short spoken replies don't need extended reasoning, and skipping it cuts the wait.
        thinking: model.includes("sonnet-5-5") ? { type: "between_tools" } : { type: "disabled" },
        output_config: { effort: "low" },
        messages: [{ role: "user", content: prompt }],
      });
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          buffer += event.delta.text;
          flush(false);
        }
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal" && !spoke) continue;
      flush(true);
      if (spoke) return;
    } catch (err) {
      console.error(`${model} failed:`, err.message || err);
      if (spoke) return;
    }
  }
  emit({ type: "kind", kind: "off_topic" });
  emit({ type: "sentence", text: "Sorry, I lost my train of thought there. Let's keep going." });
}

// "Go back to the part about the mayor", "skip to 1:30": pick which script sentence to jump to.
// Returns a 0-based sentence index, or null when the request isn't really about moving around.
async function locate({ sentences = [], times = [], current = 0, request = "" }) {
  const listing = sentences.map((s, i) => `${i + 1}. [${times[i] || ""}] ${s}`).join("\n");
  if (client) {
    try {
      const msg = await client.messages.create({
        model: MODEL,
        max_tokens: 16,
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
        system: "You map a podcast listener's navigation request to a line of the script. Reply with only the line number to start playing from, or NONE if the request is not asking to move to a different part of the episode.",
        messages: [{ role: "user", content: `Script (line number, [start time], text):\n${listing}\n\nThe listener is currently at line ${current + 1}.\nListener says: "${request}"` }],
      });
      const out = msg.content.find((b) => b.type === "text")?.text || "";
      const n = parseInt(out.match(/\d+/)?.[0], 10);
      if (/NONE/i.test(out) || !n) return null;
      return Math.min(Math.max(n - 1, 0), sentences.length - 1);
    } catch (err) {
      console.error("locate failed:", err.message || err);
    }
  }
  // Offline: the sentence sharing the most words with the request.
  const words = (t) => (t.toLowerCase().match(/[a-z0-9']{4,}/g) || []).filter((w) => !["part", "back", "skip", "jump", "about", "where", "said", "that", "talked", "talks", "going"].includes(w));
  const want = new Set(words(request));
  let best = null;
  let bestScore = 0;
  sentences.forEach((s, i) => {
    const score = words(s).filter((w) => want.has(w)).length;
    if (score > bestScore) [best, bestScore] = [i, score];
  });
  return best;
}

// Narrator voice. Clips are cached on disk, so each episode sentence is only rendered once.
async function tts(text) {
  const file = path.join(TTS_CACHE, `${crypto.createHash("sha1").update(`${VOICE}\n${text}`).digest("hex")}.mp3`);
  try {
    return await fs.readFile(file);
  } catch {}
  const r = await fetch(`${DEEPGRAM_URL}/v1/speak?model=${encodeURIComponent(VOICE)}`, {
    method: "POST",
    headers: { Authorization: `Token ${DEEPGRAM_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`Deepgram TTS ${r.status}: ${await r.text()}`);
  const audio = Buffer.from(await r.arrayBuffer());
  await fs.mkdir(TTS_CACHE, { recursive: true });
  await fs.writeFile(file, audio);
  return audio;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/answer") {
      const body = await readJson(req);
      const started = Date.now();
      let firstSentence = null;
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
      await streamAnswer(body, (event) => {
        if (event.type === "sentence" && firstSentence === null) firstSentence = Date.now() - started;
        res.write(JSON.stringify(event) + "\n");
      });
      res.end(JSON.stringify({ type: "done" }) + "\n");
      console.log(`Answer: first sentence after ${firstSentence} ms, done after ${Date.now() - started} ms ("${body.question}")`);
      return;
    }
    if (req.method === "POST" && req.url === "/api/locate") {
      const body = await readJson(req);
      const index = await locate(body);
      console.log(`Jump: "${body.request}" -> line ${index === null ? "none" : index + 1}`);
      res.writeHead(200, { "Content-Type": MIME[".json"] });
      res.end(JSON.stringify({ index }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/tts" && DEEPGRAM_KEY) {
      const { text } = await readJson(req);
      if (!text || text.length > 2000) {
        res.writeHead(400).end();
        return;
      }
      const audio = await tts(text);
      res.writeHead(200, { "Content-Type": MIME[".mp3"] });
      res.end(audio);
      return;
    }
    if (req.method === "GET" && req.url === "/api/status") {
      res.writeHead(200, { "Content-Type": MIME[".json"] });
      res.end(JSON.stringify({
        mode: client ? "claude" : "offline",
        model: client ? MODEL : null,
        voice: DEEPGRAM_KEY ? "cloud" : "browser",
      }));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const filePath = path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end();
      return;
    }
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch (err) {
    if (err.code === "ENOENT") {
      res.writeHead(404).end("Not found");
      return;
    }
    console.error(err);
    res.writeHead(500, { "Content-Type": MIME[".json"] });
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
});

// Mic relay: browser sends 16-bit PCM, Deepgram sends back live transcripts.
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/api/listen" || !DEEPGRAM_KEY) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (browser) => {
    const rate = Number(url.searchParams.get("rate")) || 48000;
    const params = new URLSearchParams({
      model: "nova-3",
      encoding: "linear16",
      sample_rate: String(rate),
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      endpointing: "250",
      utterance_end_ms: "1000",
    });
    const upstream = new WebSocket(`${DEEPGRAM_URL.replace(/^http/, "ws")}/v1/listen?${params}`, {
      headers: { Authorization: `Token ${DEEPGRAM_KEY}` },
    });
    const pending = [];
    upstream.on("open", () => {
      for (const chunk of pending) upstream.send(chunk);
      pending.length = 0;
    });
    upstream.on("message", (data) => {
      const text = data.toString();
      if (browser.readyState === WebSocket.OPEN) browser.send(text);
      try {
        const msg = JSON.parse(text);
        const heard = msg.channel?.alternatives?.[0]?.transcript;
        if (msg.is_final && heard) console.log(`Heard: "${heard}"`);
      } catch {}
    });
    upstream.on("error", (err) => {
      console.error("Deepgram listen error:", err.message);
      if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify({ type: "Error", message: `Speech recognition error: ${err.message}` }));
    });
    upstream.on("close", (code, reason) => {
      if (code !== 1000) console.error(`Speech recognition connection closed (${code} ${reason})`);
      browser.close();
    });
    browser.on("message", (data, isBinary) => {
      if (!isBinary) data = data.toString(); // control messages like KeepAlive must stay text
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
      else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 50) pending.push(data);
    });
    browser.on("close", () => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: "CloseStream" }));
      upstream.close();
    });
  });
});

server.listen(PORT, () => {
  console.log(`InteraCast: http://localhost:${PORT}`);
  console.log(DEEPGRAM_KEY ? `Voice: Deepgram ${VOICE} with echo-cancelled mic` : "No DEEPGRAM_API_KEY set: using the browser's built-in voice and speech recognition (wear headphones).");
  console.log(client ? `Answers by ${MODEL} (fallback ${FALLBACK_MODEL})` : "No ANTHROPIC_API_KEY set: running in offline mode (repeats the best-matching sentence).");
});
