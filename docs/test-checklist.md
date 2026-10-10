# Interactive Podcast test checklist

Setup: restart the server (Ctrl+C, then `npm start`), open http://localhost:3000 in Chrome, and press Ctrl+Shift+R. Keep the terminal visible. It prints `Heard: "…"`, `Answer: first sentence after … ms` and `Jump: … -> line N`, which show what the app understood.

For each test, note whether it passed, and for any failure write down what you said and what the terminal showed.

## 1. Startup and echo
| # | Do | Expect |
|---|----|--------|
| 1.1 | Press Play and stay silent through the first two lines | It doesn't interrupt itself. No `Heard:` lines show up for the narrator's own words. |
| 1.2 | Press Play and say "wait" in the first 3 seconds | It stops and listens |
| 1.3 | Stay silent for the whole episode, over speakers | It plays to the end without stopping on its own |

## 2. Questions about the episode (after line 3, the Sunrunner)
| # | Say | Expect |
|---|-----|--------|
| 2.1 | "Wait, how many passengers?" | It answers "a hundred and forty" in its own words, without reading the script line back |
| 2.2 | "Sorry, what was the ferry called?" | It says "the Sunrunner", then carries on |
| 2.3 | After the answer, stay silent | About 1.5 seconds later it resumes and re-reads the line you interrupted. It doesn't say that line twice. |
| 2.4 | Ask a follow-up right after an answer, like "and how long is the trip?" | It answers the follow-up |
| 2.5 | Check the terminal | `first sentence after` is under about 1500 ms |

## 3. Talking over an answer
| # | Say while it's answering | Expect |
|---|-----|--------|
| 3.1 | "Got it, you can continue" | It stops mid-answer and goes back to the episode |
| 3.2 | "Okay" | It stops and resumes |
| 3.3 | A new question, like "who's the mayor?" | It drops the old answer and answers the new question |

## 4. General and silly questions
| # | Say | Expect |
|---|-----|--------|
| 4.1 | "How do solar panels work?" | A short answer flagged as not part of the story |
| 4.2 | "What's your favorite pizza?" | One light line, then it resumes |
| 4.3 | Ask two silly questions in a row | It offers to keep going or pause. Saying "pause" pauses it, and Play resumes it. |

## 5. Jumping around
| # | Do or say | Expect |
|---|-----|--------|
| 5.1 | Click any line in the script | It plays from that line |
| 5.2 | "Go back to the part about the cost" | It jumps to the "eleven point four million" line |
| 5.3 | "Skip ahead" | It moves one line forward |
| 5.4 | "Go back" | It moves one line back |
| 5.5 | "Start over" | It goes back to the first line |
| 5.6 | Type "jump to 0:40" and press Enter | It jumps to the line marked closest to 0:40 |
| 5.7 | "Skip to the part about the mayor" (said early) | It jumps forward to the Dana Ortiz line |

## 6. Previews and summaries (ask early, around line 3)
| # | Say | Expect |
|---|-----|--------|
| 6.1 | "What's coming up?" | One line saying what's next, without the facts, then "Want me to skip ahead?" |
| 6.2 | Then "yes" | It jumps to that part |
| 6.3 | Ask 6.1 again, then say "no thanks" | It goes back to where you were |
| 6.4 | Ask 6.1 again, then say "no, just give me the gist" | A quick two or three sentence summary |
| 6.5 | "Can you recap what I've heard so far?" | A short recap of the heard part only, with nothing from later |

## 7. Controls
| # | Do | Expect |
|---|----|--------|
| 7.1 | Press Space while it's narrating | It stops and listens |
| 7.2 | Type a question and press Enter | It answers like a spoken question |
| 7.3 | Press Restart several times, then talk | It still understands you, with `Heard:` lines in the terminal |
| 7.4 | Let it finish, then press "Play again" | It starts over and talking still works |
| 7.5 | Leave it paused for 2 minutes, then resume and talk | It still hears you |

## 8. Room conditions
| # | Do | Expect |
|---|----|--------|
| 8.1 | Turn the speakers up loud | It doesn't trigger itself |
| 8.2 | Play music or a TV in the background | Note how often it falsely stops |
| 8.3 | Talk quietly from across the room | Note whether it still hears you |

## 9. Added after round 1
| # | Do or say | Expect |
|---|----|--------|
| 9.1 | Right after an answer, ask a follow-up | It waits while you talk, then answers the follow-up |
| 9.2 | Say "pause, don't resume until I tell you" and wait 30 seconds | It stays paused. Saying "resume" brings it back. |
| 9.3 | Ask two silly questions in separate interruptions | The second one gets "keep going or pause?" |
| 9.4 | Say "that's cool" or "wow" while it narrates | It keeps narrating |
| 9.5 | Play a talk video on the same computer | The first time, it ignores it and carries on. The second time, it pauses itself. |
| 9.6 | Turn the volume up a lot mid-sentence | Little or no ducking |
| 9.7 | Press M, then talk | Nothing interrupts it. Press M again and talking works. |
| 9.8 | Press Pause, then Resume | It stops, then picks up the same sentence |

## 10. Added after round 2
| # | Do or say | Expect |
|---|----|--------|
| 10.1 | Say "wait a minute" and stay quiet | It says "Sure, take your time", waits about 12 seconds, asks "Did you have something for me, or should I keep going?", then carries on about 10 seconds later |
| 10.2 | During that check-in, say "yes" and then ask something | It says "Go ahead" and answers your question |
| 10.3 | Say "stop" | It pauses until you say "resume" |
| 10.4 | Ask two silly questions, then answer "no thanks" to "keep going?" | It pauses |
| 10.5 | After an answer, say "okay, and how long is the trip?" | It answers the follow-up instead of resuming |
| 10.6 | Ask "are you a guy or a girl?" | It says it's the show's AI host, without claiming a gender |

## 11. Talking while paused
| # | Do or say | Expect |
|---|----|--------|
| 11.1 | Say "wait a minute", then "actually, pause" | It switches to a full pause |
| 11.2 | While paused, ask a question about the episode | It answers and stays paused, with no auto-resume |
| 11.3 | While paused, ask a silly question | A light answer, still paused |
| 11.4 | Ask a third question while paused | It asks "Want to get back to the episode?" "No" keeps it paused; "yes" resumes. |
| 11.5 | While paused, say "go back to the part about the mayor" | It plays from that part |
| 11.6 | While paused, type a question | It answers, still paused |
| 11.7 | Let the episode finish, then make a comment or ask something | It replies. Saying "play again" starts it over. |
| 11.8 | While paused, say "that's cool" | It replies, still paused |

## 12. Resume and stop phrases, and speed
| # | Do or say | Expect |
|---|----|--------|
| 12.1 | While paused, say "ok, proceed", "let's get back to it", "I'm ready" or "roll on" | It resumes |
| 12.2 | While narrating, say "that's enough", "hold it" or "give me a breather" | It pauses |
| 12.3 | Say "pause" | It stops almost as soon as you finish the word |
| 12.4 | Ask a question and listen to the gap | A short "Mm-hm." or "Sure." if the answer takes a moment, then the answer |
| 12.5 | Check the terminal | Note the `first sentence after` numbers |

## 13. Typing
| # | Type | Expect |
|---|----|--------|
| 13.1 | "pause" while it narrates | It pauses with a spoken reply |
| 13.2 | "pause" while already paused | It says "Still paused…" |
| 13.3 | "no" while paused | A spoken reply, still paused |
| 13.4 | "no thanks" while it answers | It stops the answer and stays put |
| 13.5 | "ok proceed" while paused | It resumes |
| 13.6 | "wait a minute" while it narrates | A short hold, same as saying it |
