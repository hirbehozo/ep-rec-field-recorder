# EP-REC field recorder: Claude Code build sequence

Nine prompts that take you from an empty directory to a public Vercel URL you can send to
anyone. Each one is self contained, ends in a commit, and states what "done" means so you
can check before moving on.

## Before you start

Put the prototype and the hardware notes somewhere Claude Code can read them. The
prototype is the reference implementation and the prompts refer to it constantly.
reference/hardware.md carries the researched EP-136 and EP-133 findings, including the
MIDI CC table, and prompts 2, 5 and 7 all depend on it.

```bash
mkdir -p ~/code/ep-rec && cd ~/code/ep-rec
mkdir reference
cp ~/Downloads/ep-rec/index.html reference/prototype.html
cp ~/Downloads/ep-rec/icon-*.png reference/
cp ~/Downloads/ep-rec/HARDWARE.md reference/hardware.md
claude
```

Have `gh auth status` and `vercel whoami` both returning cleanly first, otherwise prompts
1 and 9 will stall waiting on a browser login.

---

## 1. Scaffold, repo, first deploy

```
Set up a new project in this directory. Read reference/prototype.html and
reference/prototype-notes.md first: that prototype is the reference implementation for
everything we are about to build, and it is known working. Do not start rewriting it yet.

Stack:
- Next.js 15 App Router, React 19, TypeScript strict mode
- Tailwind v4
- Jest plus ts-jest for unit tests, jsdom environment
- ESLint and Prettier, no semicolon-free style, single quotes
- Husky pre-push hook running lint, typecheck and tests

This app is entirely client side. There is no database, no API route, no auth, no server
state. Recordings never leave the device. Configure next.config.ts for static export
(output: 'export') so it deploys as pure static files.

Then:
1. git init, sensible .gitignore
2. gh repo create ep-rec-field-recorder --public --source=. --remote=origin
3. vercel link and vercel deploy --prod
4. Put the live URL in the README

Commit as "chore: scaffold next.js app with static export and ci hooks".

Done when: pnpm build succeeds, pnpm test runs with zero tests and does not error,
the pre-push hook fires, and the Vercel URL serves the default page over https.
```

---

## 2. Prove the hardware path before building on it

This is the risky step. Do it second, not last.

```
Build a single diagnostics page at app/page.tsx that answers one question: does this
Android phone actually expose the K.O. Sidekick as an audio input to Chrome?

It must be a client component. It shows:
- a Connect button that requests navigator.requestMIDIAccess({ sysex: false }) and
  getUserMedia({ audio: true })
- the full list of enumerateDevices() audioinput entries with their labels and deviceIds
- the list of Web MIDI input ports with names and manufacturers
- for the selected audio device, the resolved MediaTrackSettings: sampleRate,
  channelCount, and whether echoCancellation, noiseSuppression and autoGainControl were
  successfully disabled
- a live peak meter so I can confirm real samples are arriving, not silence
- secure context, OPFS availability, and Wake Lock availability as pass or fail lines

Every failure must say what to do about it, not just that it failed. Copy the constraint
handling from the prototype's openAudio(): the three processing flags go off explicitly,
channelCount is ideal 2, and the AudioContext is constructed at the track's own sampleRate
so nothing gets resampled.

Add one more panel, a channel identity test, because the answer is documented nowhere.
The Sidekick presents four stereo pairs over USB (channel 1, channel 2, aux, main output)
and Android only ever hands the browser the first pair. Which pair that is decides whether
we capture the finished mix or just whatever happens to be plugged into channel one. The
panel shows independent L and R peak meters plus a plain instruction: plug a source into
CH2 only, play it, and watch. Signal means the first pair is the main mix and we are fine.
Silence means the first pair is CH1 and the rig has to be re-patched so that the source
that matters lands on channel one. See reference/hardware.md.

Add a Copy report button that puts the whole diagnostic dump on the clipboard as text.

Commit as "feat: hardware diagnostics page".

Done when: deployed, and I can load it on my phone with the Sidekick plugged in over
USB-C and read a definitive answer.
```

**Stop here and actually test it on the phone.** If the audio input list only ever shows
the built in microphone, the browser route is dead on that handset and the remaining
prompts are wasted effort. Everything else in the sequence assumes this step passed.

Run the channel identity test at the same time and write the answer down. It does not
change, and every later decision about patching the rig depends on it.

---

## 3. Pure logic modules with tests

```
Port the format and storage logic out of reference/prototype.html into typed, tested
modules under lib/. No React, no DOM APIs beyond Blob and File, no side effects.

lib/wav.ts
  wavHeader(dataBytes, sampleRate, channels): Uint8Array
  interleave(left, right, frames): Int16Array with clamping
  Both lifted from the prototype, which is verified correct.

lib/smf.ts
  buildSMF(events: MidiEvent[], bpm: number, offsetMs: number): Blob
  Format 1, PPQ 480, tempo track plus one track per MIDI port, variable length
  quantities, zero velocity note-ons rewritten as note-offs, and any note left hanging
  at the end of a take closed with an explicit note-off. The prototype's version is
  verified against a parser, so match its behaviour exactly.

lib/tempo.ts
  bpmFromClocks(timestamps: number[]): number | null
  24 clocks per quarter note. Returns null outside 20 to 400 BPM or with too few samples.
  Note the prototype has two call sites with different window lengths, reconcile them
  into one function.

lib/store.ts
  An OPFS backed session store under a koii-rec directory: readIndex, writeIndex,
  putFile, getBlob, removeSession, plus an in-memory fallback that is used transparently
  when OPFS is unavailable. Each session record carries a flag saying where its bytes
  actually live, so exports never look in the wrong place.

lib/dotmatrix.ts
  The display renderer from the prototype, framework free. A 96 by 54 dot buffer, a 5x7
  bitmap font as column bytes, and plot / char / text / right / bar / clear / fill
  primitives. Rendering draws the unlit dot field once as a canvas pattern and then batches
  all lit dots into two paths, one ink and one orange, filled in a single call each. Do not
  replace this with per-dot fillRect, it will not hold frame rate on a phone.
  The font data in the prototype is already proof-read glyph by glyph, copy it verbatim.

Types go in lib/types.ts: MidiEvent, SessionMeta, SessionPayload.

Write Jest tests for all of it. Specifically assert:
- a generated SMF parses back to the right tick positions: 250ms at 120 BPM is 240 ticks
- hanging notes get closed
- the MThd chunk is exactly 6 data bytes and the track count matches
- WAV header field offsets and byte order
- dmText advance width matches dmWidth for a range of strings and scales, so right
  alignment never overflows the 96 column grid
- interleave clamps beyond +/-1 without wrapping
- bpmFromClocks returns null on insufficient or nonsense input
Write a minimal SMF parser in the test file rather than pulling in a dependency.

Commit as "feat: wav, smf, tempo and opfs modules with tests".

Done when: pnpm test is green with meaningful coverage of every branch above.
```

---

## 4. Audio capture engine

```
Build the audio capture layer.

public/rec-worklet.js
  The AudioWorkletProcessor from reference/prototype.html, as a real file rather than a
  blob URL. It buffers to 8192 frame chunks before posting, transfers the buffers rather
  than copying them, and emits a throttled meter message every 8 render quanta.

lib/audio/useRecorder.ts
  A hook owning the AudioContext, MediaStreamSource, AudioWorkletNode and the zero gain
  sink that keeps the graph pulling. Exposes: openDevice(deviceId), close(), start(),
  stop(), and reactive state for peaks, elapsed frames, sample rate, channel count,
  device label and clip latch.

Two things in the prototype exist because they are bugs I already hit, keep them:
1. The node must connect to destination through a zero gain node or process() never runs.
2. On stop, the worklet's final partial buffer is flushed asynchronously and arrives
   after the recording flag has already flipped. The message handler must accept PCM
   based on whether a writer or memory buffer is still open, not on the recording flag,
   otherwise every take loses its last fraction of a second. Write a test that proves the
   final chunk is retained.

Elapsed time comes from the sample count, never from a wall clock timer.

Handle track.onended by stopping the take cleanly and surfacing a message, since yanking
the USB cable mid-take is a realistic failure.

Commit as "feat: audio worklet capture engine".
```

---

## 5. MIDI capture engine

```
Build lib/midi/useMidi.ts. Read reference/hardware.md first, it documents what these two
devices actually send and the answer is not what you would assume.

It owns the MIDIAccess object, tracks input ports reactively through onstatechange, and
lets each port be armed or disarmed individually. Every incoming message is stamped with
event.timeStamp, falling back to performance.now() when the browser reports zero.

Filtering rules from the prototype: drop active sensing (0xFE) entirely, route clock
(0xF8) into a rolling window used for live BPM display and into the take's clock array
when recording, and store everything else as { t, port, data } where t is milliseconds
relative to the recording start instant.

CLOCK COMES FROM THE K.O. II, NOT THE SIDEKICK

There is no evidence the EP-136 transmits MIDI clock, and it is a USB device rather than
a host, so nothing patched into it reaches the phone. Tempo only exists when the EP-133 is
on the bus through a powered hub and has clock enabled in its system settings.

So the BPM readout has three honest states, not two: a real value, "NO CLK" when MIDI is
arriving but no 0xF8 has been seen, and "---" when no MIDI port is armed at all. Never
show a fallback tempo as though it were measured. Takes recorded without clock are stored
with bpm null and exported at 120 BPM with that fact recorded in the metadata.

DECODING THE EP-136

lib/midi/ep136.ts turns the Sidekick's raw CC stream into something readable and
replayable. Mixer channels map to MIDI channels: CH1 is 1, CH2 is 2, AUX is 3.

  CC1   FX force pad     continuous pressure 0-127
  CC3   cue button       127 on, 0 off
  CC7   channel fader    absolute
  CC14  FX button        127 on, 0 off
  CC20  gain encoder     relative, two's complement
  CC22  EQ high          absolute, 64 flat
  CC23  EQ mid           absolute, 64 flat
  CC24  EQ low           absolute, 64 flat
  pitch bend             MOD+ lever, 14-bit, 8192 centre

CC20 needs decoding rather than reading: values 1 to 63 are positive increments, 64 and 0
mean no change, and 65 to 127 decode as value minus 128. Accumulate and clamp to 0-127.
Be explicit in the type that accumulated gain is a delta from an unknown starting point,
because the encoder never reports where the knob actually was. Do not present it as an
absolute value in the UI.

Detect a Sidekick by port name and only apply this decoding to ports that match, since the
same CC numbers mean nothing in particular coming from anything else.

This table is community derived from monitoring a real unit, not vendor documentation, so
treat it as a strong hypothesis. Structure the module so a single wrong CC number is a one
line fix, and keep the raw bytes in the take's JSON regardless of how they were decoded.

describeMessage(data, portKind) feeds the display ticker: note on and off with note names,
CC, program change, aftertouch, pitch bend and transport for a generic port, and the
decoded control names for a Sidekick, for example "CH1 FADER 98" or "CH2 EQ LOW -12".
Sixteen characters is the display width, so keep the strings short. Unit test both paths
against a table of known messages, including the relative encoder wrapping across zero.

The recording start instant is a single performance.now() captured in the transport layer
and shared by both engines. That shared origin is the entire sync mechanism, so make it
an explicit parameter rather than something each hook reads independently.

Commit as "feat: web midi capture with ep-136 control decoding".
```

---

## 6. Transport and session assembly

```
Wire the two engines together in lib/useSession.ts.

start(): generate a take id, open the OPFS writable and write a placeholder WAV header,
acquire a screen Wake Lock, capture t0 = performance.now(), then enable both engines in
that order.

stop(): disable the worklet, wait for the drain, rewrite the WAV header at position 0 with
the real byte counts, close the writer, derive the take BPM from the collected clocks,
assemble SessionMeta and SessionPayload, persist both, release the Wake Lock.

Re-acquire the Wake Lock on visibilitychange when the document becomes visible and a take
is in progress. Warn on beforeunload during a take.

If a take ends with zero frames captured, say so plainly in the UI: the input was not
delivering samples.

Commit as "feat: transport, wake lock and session persistence".
```

---

## 7. The interface

This is the prompt to be fussy about. The app has to read as another unit in the EP stack,
not as a phone app with a hardware theme.

```
Build the UI. reference/prototype.html is the agreed design, not a placeholder. Match it.

DESIGN SYSTEM

Palette, as Tailwind v4 theme variables. This is a light grey instrument panel. Do not
invert it to dark, and do not add a second accent colour.
  case      #C9C7C2   the body
  face      #DEDCD7   raised key faces
  face-hi   #F1EFEA   key highlight, knocked-out type
  edge      #A8A59E   key drop shadow, panel edges
  rule      #B3B0A9   hairline separators
  ink       #14130F   silkscreen black, all borders
  legend    #6F6C64   secondary silkscreen
  signal    #F24E00   the record key, armed LEDs, clip and peak hold. Nothing else.
  lcd       #A7B79C   display glass
  lcd-ink   #141C0E   lit dots

Type. Self host Archivo as a variable font through @fontsource-variable/archivo, bundled
not CDN linked, because this has to work with no network. Fall back to Roboto Condensed,
which ships on Android. Three roles only:
  identity   23px / 800 / -0.035em tracking, tight and compressed
  legend     9px / 700 / 0.19em tracking / uppercase, in legend colour
  readout    tabular numerals, 700, for durations and offset values
No other sizes. Every label on this panel is a silkscreen legend, so uppercase and
letterspaced, never sentence case body text.

Structure. Sections are separated by a hairline rule with a knocked-out tag sitting on it:
a solid ink rectangle with face-hi text at 9px. Tags read INPUT, TAKES, SIGNAL. Input rows
carry a numbered ink square, 1 to 3, because they are channel strips. Takes carry a
zero-padded take number that persists across sessions, because they are numbered slots.
Numbering appears nowhere else, it is not decoration.

Keys. Every interactive control is a physical key:
  background linear-gradient 180deg face-hi 0%, face 52%, #D2CFC8 100%
  1px ink border, 3px radius
  box-shadow 0 3px 0 edge, 0 3px 0 1px ink
  active state translateY(3px) with the shadow collapsed, 50ms linear
  focus-visible is a 2px signal outline at 3px offset
Three sizes: wide (the transport), default, mini (take actions and nudges). The record key
is the only signal-coloured surface on the panel and it reverts to a grey key labelled Stop
while recording, so the orange means "press this to start" and never anything else.
MIDI port chips are mini keys carrying a 7px round LED that glows signal when armed.
Fire navigator.vibrate on record, stop, arming and nudges. It is a hardware control.

THE DISPLAY

This is the one bold element and everything else stays quiet around it. It is a real dot
matrix, not a font behind a scanline filter. A 96 by 54 grid on a canvas, unlit dots
visible at 11% opacity so the glass reads as glass, lit dots in lcd-ink, peak hold and clip
in signal. Dot size is 72% of pitch, pitch is container width over 96, sized for
devicePixelRatio and recomputed on resize.

Row allocation:
   0-6    status: a filled dot marker then REC / RDY / OFF, right aligned sample rate and
          channel count, replaced by a blinking CLIP when the latch is set
   8-21   elapsed time, HH:MM:SS at double scale, x=1, which spans the full 96 columns
  23-29   L label and level bar, bar rows 25-27
  31-37   R label and level bar, bar rows 33-35
  39-45   BPM from MIDI clock with its three states from prompt 5, right aligned event
          count
  47-53   the last MIDI message, truncated to 16 characters

Level bars run from column 8 to 95 with a permanent end-of-scale tick so the ceiling is
always visible, the top 14% of the scale lit in signal, and a slow-falling peak hold dot in
signal that decays at 0.985 per frame. Peaks decay at 0.72 per frame so the meter has
ballistics rather than snapping.

Paint at 30fps, not 60. It is dense enough that 60 costs battery for no visible gain.

MOTION

One orchestrated moment: on load the display lamp-tests, every dot lit for 240ms, then a
wipe down over 220ms, then live. That is the only entrance animation in the app. Key
presses and the 1Hz record blink are the only other motion. prefers-reduced-motion skips
the lamp test and the blink and removes the key transitions.

INTERACTION

One tap from cold to recording. If the record key is pressed before anything is connected,
it requests MIDI and audio permission, opens the device, and starts the take, showing WAIT
on the key while it does. The separate Scan key is for re-detecting hardware, not for
first run. Nobody should have to press two things to catch a jam.

Guess the right audio device rather than defaulting to the phone microphone: prefer a
device whose label matches usb, sidekick, ep-1, interface or teenage. If the resolved
device still looks like the built in mic, say so in a message directly under the transport.

Empty state: Nothing recorded yet. Plug the Sidekick into the USB-C port and press record.

QUALITY FLOOR

Mobile first at 390px, single column, every control at least 44px tall. Visible keyboard
focus. user-select none on the chrome, because this is a control surface and text selection
on a long press feels broken.

Commit as "feat: instrument panel interface with dot matrix display".

Done when: it is side by side indistinguishable from the prototype on a phone, and the
display holds 30fps while recording with meters moving.
```

## 8. Export and share

```
Build lib/export.ts and wire it to the session row actions.

Three exports per take: the WAV straight from storage, an SMF built on demand from the
stored events using the take's BPM and the current offset value, and the raw JSON payload.
The JSON is where the Sidekick's mixer automation lives, decoded alongside the raw bytes,
so it is the export that carries the performance rather than just the result. Say so in
the UI, one short line, because it is not obvious that json is the interesting one.
Building the MIDI on demand rather than at stop time means changing the offset lets me
re-export an old take correctly, so make sure the UI reflects that.

Delivery: navigator.share with files when navigator.canShare accepts them, which is the
good path on Android, falling back to an object URL download. Swallow AbortError silently
since that is just me dismissing the share sheet.

Filenames: <takeid>.wav, <takeid>.mid, <takeid>.json.

Add an Export all action that zips a take's three files together. Use a tiny zip writer
you implement yourself with stored (uncompressed) entries rather than adding a dependency,
audio does not compress usefully anyway.

Commit as "feat: wav, midi and json export via share sheet".
```

---

## 9. PWA, README, ship

```
Finish and publish.

- app/manifest.ts generating the web manifest: name EP-REC field recorder, short name
  EP-REC, standalone, portrait, background and theme #C9C7C2
- Icons at 192 and 512 plus a maskable variant. reference/icon-512.png is the artwork:
  grey case, an LCD window with REC spelled out in real dot matrix glyphs from the same
  font the app uses, and the orange record key below it. Regenerate at each size rather
  than scaling one bitmap.
- public/sw.js caching the app shell, network first with cache fallback, registered from
  a client component. It must survive a cold start with no network.
- README: what it is, the rig diagram, the first run checklist, how the sync works and why
  the offset control exists, known limits (stereo only because Android will not give a
  browser more than the default pair, foreground only, 16 bit), and the live URL

Then commit as "feat: pwa shell and documentation", push, and vercel deploy --prod.

Print the production URL when you are done.
```

---

## Sharing it

The deployed app is static and client only, so there is nothing to provision and no
per-user cost. Anyone you send the URL to gets their own isolated OPFS storage and their
own recordings, and none of it reaches your Vercel project beyond the page load.

Worth putting in the message when you share it: Chrome or Edge on Android only, since
Firefox and iOS Safari have no Web MIDI, and they need their own interface on the USB port.

## Ordering notes

Prompt 2 is a gate, not a formality. Everything after it assumes Android hands Chrome a
real USB audio input, and that is the one claim in this whole build that hardware gets to
veto. If it fails, the salvage is a MIDI only recorder, which needs prompts 3, 5, 6, 7 and
9 with the audio engine dropped, and that is still a genuinely useful thing to have.

Prompts 3 through 6 are logic and have no visual output, so resist checking the browser
until 7 lands. Let the tests carry that stretch.
