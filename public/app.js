// Interactive podcast prototype: narrate sentence by sentence, let the listener barge in,
// answer briefly, ask "anything else?", then resume from the interrupted sentence.
import { episode } from "./episode.js";
import { createCloudEngine, createBrowserEngine } from "./engines.js";

const $ = (id) => document.getElementById(id);
const ui = {
  title: $("title"), play: $("play"), interrupt: $("interrupt"), restart: $("restart"),
  dot: $("dot"), status: $("status"), heard: $("heard"), form: $("ask"), question: $("question"),
  script: $("script"), note: $("note"), mic: $("mic"),
};

const LISTEN_TIMEOUT_MS = 8000; // give up waiting for a question after this long
const CHECK_TIMEOUT_MS = 6000;  // silence after an explicit "anything else?" / "keep going or pause?" counts as "carry on"
const FOLLOWUP_WINDOW_MS = 3500; // after an answer, this much silence and it picks the episode back up on its own
const ASK_BEFORE_RESUME = false; // true brings back "Anything else before I carry on?" after every answer
// Short "I heard you" sounds, played only if the real answer isn't ready yet.
const FILLERS = ["Mm-hm.", "Sure.", "Okay."];
const FIXED_LINES = [
  "Sure, take your time.", "Did you have something for me, or should I keep going?", "Want to get back to the episode?",
  "No problem. Ask away.", "Go ahead.", "Sure, go ahead.", "Welcome back.", "Okay.", "Great.", "No worries.", "Sure.", "Paused.",
  "Sure, I'll wait right here. Ask me anything in the meantime, or say resume when you're ready.",
  "Sounds like something else is playing, so I'll pause here. Just say resume, or press Play, when you're ready.",
  "Still paused. Just say resume when you're ready.", "Okay, skipping ahead.", "Sure, from the top.", "Sure, going back.", "Sure, skipping ahead.", "Sure, from right here.",
  "Want me to keep going with the episode, or take a break here?", "Anything else before I carry on?",
];
const RESUME_PHRASES = ["Okay, picking back up.", "Alright, where was I.", "Back to the story.", "So, as I was saying."];
const BARGE_WORDS = /^(wait|stop|pause|hold|hang|what|sorry|huh|repeat|hey|excuse)\b/i;
const NO_MORE = /^(no|nope|nah|that's it|that's all|thats it|i'm good|im good|all good|go on|go ahead and continue|continue|carry on|keep going|resume|ok|okay|thanks|thank you|got it|cool|great)\b/i;
const YES_ONLY = /^(yes|yeah|yep|sure|actually|one more)\W*$/i;
const PAUSE = /\b(pause|stop|later|take a break|hold off)\b/i;
// "You can continue", "okay I got it, go on": anywhere in what they said means carry on.
const KEEP_GOING = /\b(you can (continue|go on|keep going|resume|carry on|move on)|continue|carry on|keep going|go on|go ahead|move on|resume|i (got|get) it|understood|i understand|makes sense|that's fine|sounds good|all good|that helps|that's all)\b/i;
// Short acknowledgments only count on their own ("okay but why..." is a new question).
const SHORT_OK = /^(ok(ay)?|got it|gotcha|cool|great|nice|thanks|thank you|right|sure|alright|perfect|yep|yeah)\b/i;
// "Go back to the part about the mayor", "skip ahead", "jump to 1:30", "start over".
const NAV = /\b(go(ing)? back|rewind|skip|jump|fast[- ]?forward|start over|from the (top|beginning|start)|go to (the )?(part|bit|section|beginning|start|end)|back to the (part|bit|section|beginning|start)|\d+:\d\d)\b/i;
// Chrome's echo canceller needs a few seconds of narration to learn the room. Until then the mic can
// still hear the narrator (e.g. "welcome to Krispy Kreme"), so a barge-in needs a stronger signal.
const ECHO_GRACE_MS = 6000;
// "Pause", "take a break", "don't resume until I tell you": stop and wait, however long it takes.
const PAUSE_CMD = /\b(pause|take a break|break time|give me a (break|breather)|stop for (now|a (bit|sec|second|minute|while))|stop (it )?(right )?there|hold it|freeze|halt|hold (that|everything)|don't (resume|continue|keep going|play)|until i (tell|say|ask)|wait (until|till) i)\b/i;
// While paused, only these bring it back.
const RESUME_CMD = /\b(resume|unpause|un-pause|continue|keep going|go on|carry on|proceed|onward|i'm back|i'm ready|ready|play|keep playing|play on|start (again|back up|it( back)? up)|pick (it )?(back )?up|let's (go|do (it|this)|get back|continue|keep going|roll)|go ahead|get back to (it|the (episode|story|show|podcast))|back to (it|the (episode|story|show|podcast))|roll it|hit it|you can (go|start|continue|resume|keep going))\b/i;
// "That's cool", "wow", "mm-hm" while it narrates: you're reacting, not interrupting.
const BACKCHANNEL = /^(that's (so )?(cool|nice|great|interesting|wild|crazy|awesome|neat|amazing|funny)|(oh )?(wow|cool|nice|neat|awesome|interesting)|mm+[- ]?hm+|uh[- ]huh|yeah|yep|right|ok(ay)?|oh|ha(ha)*|no way|true|sure)[.!?]*$/i;
// "Wait", "hold on", "one sec": a short hold. It waits quietly, checks in, then carries on if nothing comes.
const HOLD_CMD = /^(ok(ay)?,? |um,? |uh,? )?(wait|hold on|hang on|hold up|one (sec|second|moment|minute)|just a (sec|second|moment|minute)|give me a (sec|second|moment|minute)|wait (a|one) (sec|second|moment|minute))[.!,]*( please)?[.!]*$/i;
const FILLER_AFTER_MS = 600; // say "Mm-hm." if the answer hasn't started by then
const HOLD_MS = 12000;       // quiet wait after "wait a minute" before checking in
const HOLD_CHECK_MS = 10000; // then this long after "did you have something for me?" before carrying on
// "Stop" on its own means stop: a full pause, same as "pause".
const STOP_CMD = /^(ok(ay)?,? )?(please )?(stop( it| there| now| talking| the podcast| playing)?|that's enough|enough|quiet|be quiet|shh+|shush|shut up)( please)?[.!]*$/i;
const YES = /^(yes|yeah|yep|yup|sure|ok(ay)?|please|go ahead|keep going|continue|carry on|go on|let's go|sounds good|do it)\b/i;
const NO = /^(no|nope|nah|not (now|yet|really)|no thanks|i'm good|maybe later|later|take a break|pause|stop)\b/i;
const QUESTION = /\?\s*$|^(what|why|how|who|when|where|which|can|could|will|would|is|are|do|does|did|should)\b/i;
const BACKGROUND_PAUSE_COUNT = 2;   // this many "that wasn't meant for me" in...
const BACKGROUND_PAUSE_WINDOW_MS = 90000; // ...this long, and it pauses until you say resume
const WORDS_PER_SECOND = 2.6; // for the estimated timestamps next to each line

let state = "idle";       // idle | narrating | listening | answering | checking | paused | ended
let idx = 0;              // sentence currently being (or about to be) narrated: the resume checkpoint
let runId = 0;            // bumps on every interrupt so stale speech loops stop
let qa = [];              // Q&A for the current interruption, sent as context for follow-ups
let log = [];             // {afterIdx, q, a} for the on-screen transcript
let recentlySpoken = [];  // for filtering the mic hearing the narrator (echo)
let offTopicStreak = 0;   // two off-topic answers in a row -> offer to continue or pause
let timer = null;
let engine = null;        // set from /api/status: cloud voice with echo cancellation, or the browser's own
let micReady = false;
let unduckTimer = null;
let graceUntil = 0;       // see ECHO_GRACE_MS
let micMuted = false;
let backgroundHits = [];  // times it heard speech that wasn't meant for it (TV, a video, someone else)
let echoFloor = 0;        // how loud the leftover narrator echo is right now (see onLevel)
let loudChunks = 0;
let swallowUntil = 0;     // see onHeard
let pausedMode = false;  // paused: answers questions but never resumes on its own
let pausedQuestions = 0;  // questions asked while paused, for the occasional "back to the episode?"
let skipOffer = null;     // line the narrator just offered to skip ahead to ("Want me to skip there?")
const DUCK_LEVEL = 0.02;  // mic loudness (after echo cancellation) that counts as "you might be talking"

// ---------- speech output ----------
let speaking = 0;
let lastSpokeAt = 0;
function speak(text) {
  recentlySpoken = [...recentlySpoken.slice(-2), text];
  speaking++;
  return engine.speak(text).catch((err) => {
    ui.note.textContent = `Couldn't play the narrator's voice: ${err.message}`;
  }).finally(() => {
    speaking--;
    lastSpokeAt = Date.now();
  });
}

// ---------- narration ----------
async function narrate(bridge) {
  const myRun = ++runId;
  pausedMode = false;
  setState("narrating");
  render();
  // Spoken a sentence at a time so "Welcome back." and "Alright, where was I." each come from the cache.
  for (const part of (bridge || "").split(/(?<=[.!?])\s+/).filter(Boolean)) {
    await speak(part);
    if (myRun !== runId) return;
  }
  while (idx < episode.sentences.length) {
    render();
    engine.prefetch(episode.sentences[idx + 1]);
    await speak(episode.sentences[idx]);
    if (myRun !== runId) return; // interrupted mid-sentence: idx still points at it, so we resume there
    idx++;
  }
  render();
  pausedMode = true; // finished, but still happy to chat: questions get answers, "play again" restarts
  pausedQuestions = 0;
  setState("ended");
}

function interrupt(reason) {
  if (state !== "narrating") return;
  runId++;
  engine.stop();
  qa = [];
  setState("listening", reason);
  armTimer(LISTEN_TIMEOUT_MS, checkIn);
}

// "Wait a minute": stay quiet and give them time, rather than jumping back in.
function hold() {
  clearTimer();
  setState("listening", "hold");
  speak("Sure, take your time.");
  armTimer(HOLD_MS, checkIn);
}

// Nothing came after an interruption or a "wait": ask before carrying on, then carry on if still quiet.
async function checkIn() {
  const myRun = runId;
  setState("checking", "holdcheck");
  await speak("Did you have something for me, or should I keep going?");
  if (myRun !== runId || state !== "checking") return;
  armTimer(HOLD_CHECK_MS, () => resume("Okay."));
}

async function handleQuestion(text) {
  text = text.trim();
  if (!text) return;
  if (state === "narrating") interrupt();
  clearTimer();
  if (NAV.test(text)) {
    const myRun = runId;
    if (await handleNav(text)) return;
    if (myRun !== runId) return;
  }
  setState("answering", `“${text}”`);
  skipOffer = null;
  const myRun = runId;
  const entry = { afterIdx: idx, q: text, a: "" };
  log.push(entry);
  render();

  // The server streams the answer a sentence at a time; start speaking the first one right away.
  let kind = "episode";
  let kindKnown = false;
  const sentences = [];
  let streamDone = false;
  let wake = null;
  const notify = () => { wake?.(); wake = null; };
  (async () => {
    try {
      const res = await fetch("/api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: episode.title,
          heard: episode.sentences.slice(0, idx + 1),
          current: episode.sentences[idx] || "",
          upcoming: episode.sentences.slice(idx + 1),
          question: text,
          history: qa,
          paused: pausedMode,
        }),
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const event = JSON.parse(line);
          if (event.type === "kind") {
            kind = event.kind;
            kindKnown = true;
            notify();
            if (kind === "preview" && event.target) skipOffer = event.target - 1;
          }
          if (event.type === "sentence") {
            sentences.push(event.text);
            engine.prefetch(event.text);
            entry.a = `${entry.a} ${event.text}`.trim();
            render();
            notify();
          }
        }
      }
    } catch {
      if (!sentences.length) sentences.push("Sorry, I couldn't reach my notes just now.");
    }
    streamDone = true;
    notify();
  })();

  // If the answer is slow to start, say a quick "Mm-hm." so the pause doesn't feel dead.
  const firstReady = new Promise((resolve) => setTimeout(resolve, FILLER_AFTER_MS));
  const silent = () => kindKnown && ["background", "resume", "pause"].includes(kind);
  await Promise.race([firstReady, new Promise((resolve) => { const check = () => (sentences.length || streamDone || silent() ? resolve() : setTimeout(check, 50)); check(); })]);
  if (myRun !== runId) return;
  if (!sentences.length && !streamDone && !silent()) await speak(FILLERS[Math.floor(Math.random() * FILLERS.length)]);
  if (myRun !== runId) return;
  for (let i = 0; ; i++) {
    if (kind === "resume" || kind === "pause") break;
    while (i >= sentences.length && !streamDone) await new Promise((resolve) => { wake = resolve; });
    if (myRun !== runId) return; // skipped or restarted
    if (i >= sentences.length) break;
    await speak(sentences[i]);
    if (myRun !== runId) return;
  }
  // Claude heard a request to start or stop playing that the app's own phrase lists missed ("ok, proceed").
  if (kind === "resume") {
    log.splice(log.indexOf(entry), 1);
    return resume(pausedMode ? "Welcome back." : "");
  }
  if (kind === "pause") {
    log.splice(log.indexOf(entry), 1);
    return pause();
  }
  // Not meant for us (a TV, a video, someone else in the room): say nothing and pick the sentence back up.
  // A couple of these close together means something is playing, so pause until they say resume.
  if (kind === "background") {
    log.splice(log.indexOf(entry), 1);
    render();
    const now = Date.now();
    backgroundHits = [...backgroundHits.filter((t) => now - t < BACKGROUND_PAUSE_WINDOW_MS), now];
    if (pausedMode) return backToPaused();
    if (backgroundHits.length >= BACKGROUND_PAUSE_COUNT) {
      backgroundHits = [];
      return pause("Sounds like something else is playing, so I'll pause here. Just say resume, or press Play, when you're ready.");
    }
    clearTimer();
    return narrate();
  }
  qa.push({ q: text, a: entry.a });

  // "Got it, you can keep going": the short acknowledgment is enough, straight back to the episode.
  if (kind === "continue") return carryOn();

  // "Want me to skip ahead to that?": wait a little longer for the yes.
  if (kind === "preview" && skipOffer !== null) {
    setState("checking", "skipoffer");
    armTimer(CHECK_TIMEOUT_MS, carryOn);
    return;
  }

  // Paused: stay paused, but every third question ask whether they want to get back to the episode.
  if (pausedMode) {
    pausedQuestions++;
    if (pausedQuestions % 3 === 0 && idx < episode.sentences.length) {
      await speak("Want to get back to the episode?");
      if (myRun !== runId) return;
      setState("checking", "resumeoffer");
      armTimer(CHECK_TIMEOUT_MS, backToPaused);
      return;
    }
    return backToPaused();
  }

  // Two off-topic questions in a row, even across separate interruptions: offer to keep going or pause.
  // Real questions about the episode (or related ones) reset the count.
  offTopicStreak = kind === "off_topic" ? offTopicStreak + 1 : 0;
  if (offTopicStreak >= 2 || ASK_BEFORE_RESUME) {
    const offer = offTopicStreak >= 2;
    offTopicStreak = 0;
    await speak(offer
      ? "Want me to keep going with the episode, or take a break here?"
      : "Anything else before I carry on?");
    if (myRun !== runId) return;
    setState("checking", offer ? "pauseoffer" : undefined);
    armTimer(CHECK_TIMEOUT_MS, () => resume());
    return;
  }
  // No check-in: leave a short beat for a follow-up, then carry on by itself.
  setState("checking", "followup");
  armTimer(FOLLOWUP_WINDOW_MS, carryOn);
}

// After an answer or a timeout: back to the episode, or back to waiting if they paused it.
function carryOn(prefix) {
  if (pausedMode) return backToPaused();
  resume(prefix);
}

function backToPaused() {
  clearTimer();
  skipOffer = null;
  setState(idx >= episode.sentences.length ? "ended" : "paused");
}

function resume(prefix = "") {
  clearTimer();
  skipOffer = null;
  const bridge = RESUME_PHRASES[Math.floor(Math.random() * RESUME_PHRASES.length)];
  narrate(prefix ? `${prefix} ${bridge}` : bridge);
}

async function pause(line = "Sure, I'll wait right here. Ask me anything in the meantime, or say resume when you're ready.") {
  if (pausedMode && state === "paused") {
    if (line) await speak("Still paused. Just say resume when you're ready.");
    return;
  }
  pausedMode = true;
  pausedQuestions = 0;
  runId++;
  engine.stop();
  clearTimer();
  skipOffer = null;
  offTopicStreak = 0;
  setState("paused");
  if (line) await speak(line);
}

// ---------- speech input (barge-in) ----------
async function startMic() {
  try {
    await engine.startMic({
      onHeard,
      onLevel,
      onError: (msg) => { ui.note.textContent = msg; },
    });
    micReady = true;
  } catch (err) {
    ui.note.textContent = `Microphone unavailable (${err.message}), so use the Interrupt button and type your question.`;
  }
}

// Duck the narrator when the mic hears something clearly louder than the leftover echo of the narrator.
// The echo floor adapts, so turning the volume up or the echo canceller re-learning the room doesn't
// count as you talking, and it takes two loud chunks in a row (200 ms) to duck.
function onLevel(level) {
  if (micMuted) return;
  if (state === "narrating") echoFloor += (level - echoFloor) * (level > echoFloor ? 0.03 : 0.15);
  // Someone's talking while it waits for a follow-up: hold off resuming until the words come through.
  if ((state === "checking" || state === "listening") && level >= DUCK_LEVEL) extendTimer(2000);
  const loud = level >= Math.max(DUCK_LEVEL, echoFloor * 3);
  loudChunks = loud ? loudChunks + 1 : 0;
  if (loudChunks < 2) return;
  if (state === "narrating" && Date.now() >= graceUntil) {
    engine.duck(true);
    clearTimeout(unduckTimer);
    unduckTimer = setTimeout(() => engine.duck(false), 1200);
  }
}

const words = (s) => s.toLowerCase().match(/[a-z0-9']+/g) || [];

// True when what the mic heard is mostly the narrator's own voice coming out of the speakers.
// Compares word pairs rather than single words, so a question that reuses a word from the
// script ("how long is the crossing") still counts as the listener.
function isEcho(text) {
  // Once the narrator has been quiet for a moment, nothing can be its echo: "keep going" after
  // "Want me to keep going?" is you answering.
  if (!speaking && Date.now() - lastSpokeAt > 800) return false;
  const heard = words(text);
  if (!heard.length) return true;
  const spokenWords = recentlySpoken.map(words);
  if (heard.length === 1) return spokenWords.some((ws) => ws.includes(heard[0])) && !BARGE_WORDS.test(heard[0]);
  const pairs = (ws) => ws.slice(1).map((w, i) => `${ws[i]} ${w}`);
  const spokenPairs = new Set(spokenWords.flatMap(pairs));
  const heardPairs = pairs(heard);
  return heardPairs.filter((p) => spokenPairs.has(p)).length / heardPairs.length >= 0.5;
}

// Typed messages go through here too (typed = true), so "no", "pause" and "resume" mean the same typed as spoken.
function onHeard(text, final, typed = false) {
  text = text.trim();
  if (!text || !["narrating", "listening", "answering", "checking", "paused", "ended"].includes(state)) return;
  if (!typed && (micMuted || isEcho(text))) return;
  // A command already acted on from a partial transcript: skip the rest of that utterance.
  if (!typed && Date.now() < swallowUntil) {
    if (final) swallowUntil = 0;
    return;
  }
  // Clear short commands don't need to wait for the final transcript.
  if (!final && words(text).length <= 4 && !QUESTION.test(text)) {
    if (state === "paused" && isResumeCmd(text)) {
      swallowUntil = Date.now() + 2500;
      return resume("Welcome back.");
    }
    if (state !== "paused" && state !== "ended" && (PAUSE_CMD.test(text) || /^(please )?pause\b/i.test(text))) {
      swallowUntil = Date.now() + 2500;
      return pause();
    }
  }

  // Paused: wait for "resume" (or Play), and ignore everything else.
  // Paused: "resume" brings it back; anything else is a question to answer (or a place to jump to)
  // without un-pausing. Reactions and repeated "pause"/"wait" are ignored.
  // Finished works the same way, except "play again" starts over.
  // Unlike while narrating, a reaction like "that's cool" gets a reply here: it can only be meant for the host.
  if (state === "paused" || state === "ended") {
    if (!final) return;
    if (isResumeCmd(text) && words(text).length <= 8) {
      return state === "ended" ? start(0) : resume("Welcome back.");
    }
    if (state === "paused" && (PAUSE_CMD.test(text) || STOP_CMD.test(text) || HOLD_CMD.test(text))) return pause();
    if (words(text).length < 2 && !typed) return; // stray single words from the room
    return handleQuestion(text);
  }
  // "Pause", "stop", "don't resume until I tell you": works from anywhere, not just after the pause offer.
  if (final && (PAUSE_CMD.test(text) || STOP_CMD.test(text))) return pause();
  // "Wait a minute", "hold on": a short hold, from anywhere.
  if (final && HOLD_CMD.test(text) && stateDetail !== "holdcheck") {
    if (state === "narrating") interrupt();
    else if (state === "answering") { runId++; engine.stop(); }
    return hold();
  }

  // "Got it" / "keep going" while the narrator is still answering: cut the answer short and carry on.
  // Talking over an answer: "you can continue" cuts it short and goes back to the episode right away
  // (no need to wait for the final transcript), and a real new question replaces the answer.
  if (state === "answering") {
    if (wantsToContinue(text) && (final || words(text).length >= 2)) {
      runId++;
      engine.stop();
      carryOn();
    } else if (final && words(text).length >= 3) {
      runId++;
      engine.stop();
      handleQuestion(text);
    }
    return;
  }

  if (state === "narrating" && typed) return handleQuestion(text);
  if (state === "narrating") {
    if (BACKCHANNEL.test(text)) return; // "that's cool": a reaction, keep narrating
    const w = words(text);
    const needed = Date.now() < graceUntil ? 5 : final ? 2 : 3;
    if (w.length >= needed || BARGE_WORDS.test(text)) interrupt();
    else return;
  }

  ui.heard.textContent = `“${text}”`;
  if (state === "listening") armTimer(LISTEN_TIMEOUT_MS, checkIn);
  if (state === "checking") armTimer(LISTEN_TIMEOUT_MS, carryOn); // they're talking: wait for them to finish
  if (!final) return;

  // Paused, "Want to get back to the episode?": yes resumes, no keeps chatting.
  if (state === "checking" && stateDetail === "resumeoffer" && words(text).length <= 5) {
    if (NO.test(text)) {
      backToPaused();
      speak("No problem. Ask away.");
      return;
    }
    if (YES.test(text)) return resume("Great.");
  }
  // "Want me to keep going, or take a break?": yes carries on, no pauses.
  if (state === "checking" && stateDetail === "pauseoffer" && words(text).length <= 5) {
    if (NO.test(text)) return pause();
    if (YES.test(text)) return resume();
  }
  // "Did you have something for me, or should I keep going?"
  if (state === "checking" && stateDetail === "holdcheck" && words(text).length <= 5) {
    if (/^(yes|yeah|yep|i do|actually|one (thing|question)|hold on|wait)\b/i.test(text) && !/keep going|go ahead|continue/i.test(text)) {
      setState("listening");
      speak("Go ahead.");
      armTimer(LISTEN_TIMEOUT_MS, checkIn);
      return;
    }
    if (NO.test(text) || YES.test(text) || wantsToContinue(text)) return resume();
  }

  if (state === "checking" && skipOffer !== null) {
    const target = skipOffer;
    if (/^(yes|yeah|yep|sure|ok(ay)?|please|do it|go ahead|let's do it|skip|sounds good)\b/i.test(text) && words(text).length <= 5) return jumpTo(target, "Okay, skipping ahead.");
    if (NO_MORE.test(text) && words(text).length <= 2) return carryOn(); // "no thanks": back to where we were
    return handleQuestion(text); // anything longer ("no, just give me the gist") is a follow-up for Claude
  }
  if (state === "checking") {
    if (stateDetail === "pauseoffer" && PAUSE.test(text)) return pause();
    // Only short replies count as "no, carry on": "okay, and how long is the trip?" is a follow-up.
    if ((NO_MORE.test(text) && words(text).length <= 3) || wantsToContinue(text)) return carryOn();
    if (YES_ONLY.test(text)) {
      setState("listening");
      speak("Sure, go ahead.");
      armTimer(LISTEN_TIMEOUT_MS, checkIn);
      return;
    }
  }
  if (state === "listening" || state === "checking") {
    // Bare "wait"/"stop" with nothing after it: keep listening for the real question.
    if (words(text).length === 1 && BARGE_WORDS.test(text) && !typed) return;
    handleQuestion(text);
  }
}

// "Okay, proceed", "let's get back to it". Not "play the part about the mayor" (that's a jump).
function isResumeCmd(text) {
  return RESUME_CMD.test(text) && !PAUSE_CMD.test(text) && !QUESTION.test(text) && !NAV.test(text) && !/\b(part|section|bit|about)\b/i.test(text);
}

function wantsToContinue(text) {
  if (QUESTION.test(text)) return false; // "will they continue the service?" is a question
  return KEEP_GOING.test(text) || BACKCHANNEL.test(text) || ((SHORT_OK.test(text) || NO_MORE.test(text)) && words(text).length <= 3);
}

// ---------- jumping around the episode ----------
// Estimated start time of each line, shown next to it and used for "jump to 1:30".
const startTimes = (() => {
  let t = 0;
  return episode.sentences.map((s) => {
    const start = t;
    t += words(s).length / WORDS_PER_SECOND + 0.4;
    return start;
  });
})();
const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

function jumpTo(i, bridge) {
  runId++;
  skipOffer = null;
  engine.stop();
  clearTimer();
  idx = Math.max(0, Math.min(i, episode.sentences.length - 1));
  qa = [];
  offTopicStreak = 0;
  narrate(bridge);
}

// Returns true when the request was handled as a jump.
async function handleNav(text) {
  const t = text.toLowerCase();
  const time = t.match(/(\d+):(\d\d)/);
  let target = null;
  if (time) {
    const sec = Number(time[1]) * 60 + Number(time[2]);
    target = startTimes.findLastIndex((s) => s <= sec + 0.5);
  } else if (/\b(start over|from the (top|beginning|start)|(go to|back to) the (beginning|start))\b/.test(t)) {
    target = 0;
  } else if (/^\W*(ok(ay)?,? )?(skip( ahead| this( part)?| forward)?|next|fast[- ]?forward)\W*$/.test(t)) {
    target = idx + 1;
  } else if (/^\W*(ok(ay)?,? )?(go back( a bit| one)?|rewind( a bit)?)\W*$/.test(t)) {
    target = idx - 1;
  } else {
    setState("answering", `“${text}”`);
    try {
      const res = await fetch("/api/locate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sentences: episode.sentences, times: startTimes.map(clock), current: idx, request: text }),
      });
      target = (await res.json()).index;
    } catch {}
  }
  if (target === null || target < 0) return false;
  const bridge = target === 0 ? "Sure, from the top." : target < idx ? "Sure, going back." : target > idx ? "Sure, skipping ahead." : "Sure, from right here.";
  jumpTo(target, bridge);
  return true;
}

// ---------- UI ----------
let timerFn = null;
let timerCap = 0;
function armTimer(ms, fn) {
  clearTimer();
  timerFn = fn;
  timerCap = Date.now() + ms + 4000; // talking can push it back, but not forever (a TV in the background)
  timer = setTimeout(fn, ms);
}
// Push the pending timer out to at least `ms` from now, up to its cap.
function extendTimer(ms) {
  if (!timer || !timerFn) return;
  const fn = timerFn;
  const cap = timerCap;
  clearTimeout(timer);
  timer = setTimeout(fn, Math.max(0, Math.min(ms, cap - Date.now())));
}
function clearTimer() { clearTimeout(timer); timer = null; timerFn = null; }

const LABELS = {
  idle: "Ready",
  narrating: "Narrating. Start talking any time to interrupt.",
  listening: "Listening for your question…",
  answering: "Answering",
  checking: "Anything else? Say “no” or just wait to continue.",
  pauseoffer: "Keep going? Say “yes”, or “no” to take a break.",
  hold: "Waiting. Take your time, then ask away.",
  holdcheck: "Anything for me? Ask away, or say “keep going”.",
  skipoffer: "Skip ahead there? Say “yes”, or wait to carry on.",
  followup: "Follow-up? Just ask, or it carries on in a moment (Space to skip).",
  paused: "Paused. Ask anything, or say “resume”.",
  resumeoffer: "Back to the episode? Say “yes”, or keep asking.",
  ended: "Episode finished. Ask anything, or say “play again”.",
};

let stateDetail = null;
function setState(s, detail) {
  state = s;
  stateDetail = detail || null;
  ui.dot.className = `dot ${s}`;
  ui.status.textContent = detail && s === "answering" ? `Answering ${detail}` : LABELS[detail && LABELS[detail] ? detail : s];
  if (s === "narrating") ui.heard.textContent = "";
  ui.interrupt.disabled = s !== "narrating";
  ui.play.textContent = s === "ended" ? "Play again" : s === "paused" ? "Resume" : s === "idle" ? "Play" : "Pause";
  ui.play.disabled = false;
  if (s === "listening" && !micReady) ui.question.focus();
}

function render() {
  ui.script.replaceChildren();
  episode.sentences.forEach((sentence, i) => {
    const p = document.createElement("p");
    const stamp = document.createElement("span");
    stamp.className = "time";
    stamp.textContent = clock(startTimes[i]);
    p.append(stamp, sentence);
    p.title = "Click to play from here";
    p.onclick = () => (["idle", "ended"].includes(state) ? start(i) : jumpTo(i, "Sure."));
    p.className = i < idx ? "" : i === idx && state !== "ended" ? "now" : "todo";
    ui.script.append(p);
    for (const entry of log.filter((l) => l.afterIdx === i)) {
      const div = document.createElement("div");
      div.className = "qa";
      const q = document.createElement("div");
      q.innerHTML = "<b>You:</b> ";
      q.append(entry.q);
      const a = document.createElement("div");
      a.innerHTML = "<b>Narrator:</b> ";
      a.append(entry.a);
      div.append(q, a);
      ui.script.append(div);
    }
  });
}

function reset() {
  runId++;
  clearTimer();
  engine.stop();
  idx = 0;
  qa = [];
  offTopicStreak = 0;
  log = [];
  setState("idle");
  render();
}

let started = false;
async function start(from = 0) {
  if (state === "ended") reset();
  idx = from;
  ui.play.disabled = true;
  await engine.init();
  // Warm every fixed line now (they're cached on disk after the first run), so commands get an instant reply.
  for (const line of [...episode.sentences.slice(from, from + 2), ...RESUME_PHRASES, ...FILLERS, ...FIXED_LINES]) engine.prefetch(line);
  if (!micReady) await startMic();
  // The echo canceller starts fresh with each page load: be stricter about barge-ins at first.
  if (!started && engine.name === "cloud") graceUntil = Date.now() + ECHO_GRACE_MS;
  started = true;
  narrate();
}

ui.play.onclick = () => {
  if (state === "paused") return resume();
  if (state === "idle" || state === "ended") return start(state === "idle" ? idx : 0);
  pause("");
};
// Mic on/off (M): while off, nothing you say or play nearby can interrupt.
function setMuted(on) {
  micMuted = on;
  engine.setMuted?.(on);
  ui.mic.textContent = on ? "Mic off (M)" : "Mic on (M)";
  ui.mic.classList.toggle("off", on);
  if (on) engine.duck(false);
}
ui.mic.onclick = () => setMuted(!micMuted);
ui.interrupt.onclick = () => interrupt();
ui.restart.onclick = () => reset(); // the mic stays on, so Restart never re-asks for it
ui.form.onsubmit = (e) => {
  e.preventDefault();
  const text = ui.question.value;
  ui.question.value = "";
  onHeard(text, true, true);
};
document.addEventListener("keydown", (e) => {
  if (e.target === ui.question) return;
  if (e.code === "KeyM") return setMuted(!micMuted);
  if (e.code !== "Space") return;
  if (state === "narrating") {
    e.preventDefault();
    interrupt();
  } else if (state === "checking" || state === "answering") {
    e.preventDefault(); // skip the rest of the answer
    runId++;
    engine.stop();
    carryOn();
  }
});

ui.title.textContent = episode.title;
const status = await fetch("/api/status").then((r) => r.json()).catch(() => ({}));
engine = status.voice === "cloud" ? createCloudEngine() : createBrowserEngine();
const notes = [];
if (status.voice !== "cloud") notes.push("Using your browser's built-in voice and speech recognition (no DEEPGRAM_API_KEY set), so wear headphones: this mode can't cancel the narrator out of your mic.");
if (status.mode === "offline") notes.push("No ANTHROPIC_API_KEY set, so the narrator just repeats the sentence that best matches your question.");
ui.note.textContent = notes.join(" ");
setState("idle");
render();
