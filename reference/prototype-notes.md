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
  interleave(left, right, frames): Uint8Array of packed little-endian 24-bit samples
  24 bit, not 16, because the Sidekick converts at 24 and anything narrower is loss we
  inflict on ourselves. Quantise with Math.round, never a truncating cast: truncation
  produces signal-correlated error rather than noise, and it costs nothing to avoid.
  Measured on a sine sweep, rounded 24 bit sits at -144 dBFS of error against -87 dBFS
  for the truncating 16 bit version the first prototype used, which puts our conversion
  well under the Sidekick's own 105 dBA noise floor instead of on top of it.
  Both functions are lifted from the prototype, which is verified correct.

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
- WAV header field offsets and byte order, including blockAlign and byteRate at 24 bit
- a full-scale sine round-trips through interleave with error below -140 dBFS
- values beyond +/-1 clamp to the 24 bit rails without wrapping to the opposite sign
- dmText advance width matches dmWidth for a range of strings and scales, so right
  alignment never overflows the 96 column grid
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

Ask the platform not to treat this as a phone call. Beyond the three processing flags,
set voiceIsolation false in the constraints and set track.contentHint to 'music' on the
resolved track. Neither is guaranteed to be honoured, but where they are, they keep the
input off the voice-communication path and its processing.

NOTHING IN THE WORKLET MAY ALLOCATE

The processor holds a pool of pre-allocated buffer pairs, hands one to the main thread by
transfer when it fills, and takes the next from the pool. The main thread transfers the
buffers straight back after converting. In steady state this allocates nothing, because
allocation and the garbage collection behind it happen on the audio rendering thread and
that is what crackle sounds like. Count pool starvation and surface it: running dry means
the main thread fell behind.

Copy samples in runs rather than one at a time, and re-read the current buffer references
after every flush. A cached reference to a transferred buffer is stale, and the naive fix
of returning early from process() silently discards the rest of that render quantum, which
is a periodic click every 8192 frames. Test it: feed a counting ramp through several
hundred render quanta and assert that every frame arrives and that the sequence is unbroken
across chunk boundaries.

Use latencyHint 'playback', not 'interactive'. We are recording, not monitoring, so
latency costs nothing and underruns cost everything.

MEASURE WHAT THE PLATFORM ACTUALLY GAVE US

Constraints are requests, not guarantees, so the signal panel has to report reality:

- bandwidth, from an AnalyserNode, as the highest bin within about 40 dB of the loudest.
  A full-range source reading 7 or 8 kHz on a 48 kHz input means Android opened a
  voice-communication path and band-limited it. Flag it when the measurement falls below
  two thirds of Nyquist.
- resampling, by comparing the track's reported sample rate against the AudioContext rate.
- stereo, from a running mean absolute difference between channels computed in the worklet.
  A ratio at zero means the channels are identical and the input is really mono.
- dropouts, from pool starvation plus failed writes.

Each row must say what to do about it, not just that something is wrong.

QUALITY IS ALSO ABOUT NOT DROPPING SAMPLES

Move PCM conversion and file writing into a dedicated Worker using OPFS
createSyncAccessHandle, which is worker-only and substantially faster than
createWritable from the main thread. The main thread then only handles UI, so a slow
render can never stall a disk write. This is the single biggest robustness change
available and it is worth doing properly rather than porting the prototype's main-thread
writer.

Never swallow a write error. Count failures and report them on the take: a silently
dropped chunk is a gap in a recording someone thought they had. Same for underruns, have
the worklet count render quanta and compare against frames delivered, and record any
discontinuity in the take metadata rather than hiding it.

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
same CC numbers mean nothing in particular coming from anything else. Classify Roland Aira
Compact ports separately as well: they need no special decoding, but their notes must not
reach the library tab's pad binding, because an Aira note is not a K.O. II pad hit.

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
  23-29   L label, level bar on rows 25-27 running to column 70, and a right aligned
          peak hold value in dBFS in the remaining columns
  31-37   R label and level bar, same arrangement
  39-45   BPM from MIDI clock with its three states from prompt 5, right aligned event
          count
  47-53   the last MIDI message, truncated to 16 characters

Level bars run from column 8 to 70 with a permanent end-of-scale tick so the ceiling is
always visible, the top 14% of the scale lit in signal, and a slow-falling peak hold dot in
signal that decays at 0.985 per frame. Peaks decay at 0.72 per frame so the meter has
ballistics rather than snapping.

The numeric readout is what makes gain staging possible, so it has to fit: four characters
maximum, -INF below -60, whole numbers below -10, one decimal above that. Target for the
user is peaks around -6 dBFS, set on the Sidekick's gain knobs. After a take that never
exceeded -30 dBFS, say so, because a quiet take is a wasted one and the user cannot tell
from the bars alone.

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

Four exports per take: the WAV straight from storage, an MP3 encoded on demand, an SMF
built on demand from the stored events using the take's BPM and the current offset value,
and the raw JSON payload.
The JSON is where the Sidekick's mixer automation lives, decoded alongside the raw bytes,
so it is the export that carries the performance rather than just the result. Say so in
the UI, one short line, because it is not obvious that json is the interesting one.
Building the MIDI on demand rather than at stop time means changing the offset lets me
re-export an old take correctly, so make sure the UI reflects that.

Delivery: navigator.share with files when navigator.canShare accepts them, which is the
good path on Android, falling back to an object URL download. Swallow AbortError silently
since that is just me dismissing the share sheet.

Filenames: <takeid>.wav, <takeid>.mp3, <takeid>.mid, <takeid>.json.

MP3

Vendor @breezystack/lamejs into public/lame.min.js rather than importing it, because the
app has to encode with no network. Keep the LGPL notice at the top of the file. MP3 patents
expired in 2017 so there is nothing else to worry about. Do not reach for MediaRecorder or
WebCodecs first: Chrome encodes Opus and AAC, not MP3, so a JS encoder is the only route.

Encoding runs in public/mp3-worker.js, never on the main thread. It is roughly 3 to 10
times realtime, so a fifteen minute take is a minute of work and the panel has to stay
alive through it.

The main thread streams the stored WAV out of OPFS in blocks of 1152 * 256 frames, converts
24-bit to 16-bit for the encoder with rounding, and sends each block with its buffers
transferred. Critically, it waits for the worker's acknowledgement before sending the next
block. Without that backpressure the reader outruns the encoder and a long take queues the
entire file as Int16 in worker memory, which is how you get an out-of-memory crash on a
phone. Bound it to one block in flight.

Progress replaces the button label with a percentage while encoding and the other buttons
in that row disable, since exporting the same take twice at once helps nobody.

Bitrate is a user control, a fourth channel strip in the input section offering 128, 192,
256 and 320, defaulting to 192. Joint stereo, 48 kHz, matching the source.

Verify the pipeline end to end rather than trusting it: a five second test signal should
convert to exactly 240000 frames, produce a file measuring within a few percent of the
requested bitrate, and parse back to the right MPEG frame count and duration.

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
  a client component. It must survive a cold start with no network. The shell list has to
  include lame.min.js and mp3-worker.js, or MP3 export breaks offline while everything
  else keeps working, which is a confusing failure to debug later.
- README: what it is, the rig diagram, the first run checklist, how the sync works and why
  the offset control exists, known limits (stereo only because Android will not give a
  browser more than the default pair, foreground only, 16 bit), and the live URL

Then commit as "feat: pwa shell and documentation", push, and vercel deploy --prod.

Print the production URL when you are done.
```

---

## 10. The library tab

Read reference/hardware.md, section "Reading the sample library", before starting. The
short version is that the device will not tell us what is loaded without reverse
engineered SysEx that TE declined to document, that the one good open implementation is
AGPL and cannot be copied into this app, and that the same command surface can erase
samples. So the map gets built by playing instead.

```
Add a second tab to the app. The chrome is two keys at the top, RECORD and LIBRARY, styled
as a single segmented control with the selected side knocked out in ink. Switching back to
RECORD must call the display resize, because a canvas inside a hidden element reports zero
width and will render blank otherwise.

The library tab answers one question: while I am playing, where do I find a given sample?

DATA MODEL, in lib/library.ts, persisted to OPFS as library.json

  pads:  { "A1": { name, flag }, ... }   four groups A to D, twelve pads each
  binds: { "10:42": "A1" }               midi channel and note to pad

Nothing is ever transmitted to the K.O. II. Say so in the UI, because a tool that edits
sample names next to a device that stores sample names invites exactly the wrong assumption.

PAD GRID

Twelve pads per group, rendered three across and four down, counting from the bottom left
so that row one is 10 11 12 and the last row is 1 2 3. That is how the K.O. II keypad is
laid out and how its auto-chop fills pads, and getting it upside down would make the whole
feature useless. Pads are physical keys like the rest of the panel. Empty pads read empty
in the edge colour, named pads show the name over two lines, flagged pads take a pale
orange face, the selected pad gets a signal outline.

BINDING BY PLAYING

Select a pad, press bind, hit the pad on the device, done. The incoming note on message
binds and the mode disarms itself. Rebinding must remove any previous note pointing at
that pad, so a pad owns exactly one note and a note maps to exactly one pad. Ignore note
messages from a Sidekick port here, they are not pad hits.

LIVE HIGHLIGHT

An incoming bound note flashes its pad orange for about 260ms, and if the hit belongs to
another group the grid follows it there. This is the feature: glance at the phone, see
which pad just fired and what it is called.

SEARCH AND FLAGS

A search field at the top, styled as an LCD window rather than a form input. Empty search
shows flagged samples only, which makes flagging a shortlist rather than decoration. Typing
filters by name or by pad location. Each result row shows the location as a knocked-out tag,
the name, and its flag state, and tapping one jumps the grid to that pad.

MAP PORTABILITY

Export and import the map as JSON through the same share path as the take exports, plus a
clear-all behind a confirm. The map is the product of many sessions of naming things, so
losing it to a cleared browser storage would be worse than losing a take.

Commit as "feat: sample library tab with play-to-bind pad mapping".
```

If the map ever needs to come from the device rather than from playing, that is a separate
piece of work with its own risk assessment, and it should reimplement the protocol from the
documented facts rather than borrowing AGPL code.

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
