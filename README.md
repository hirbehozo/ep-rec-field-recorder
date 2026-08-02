# EP-REC field recorder

A client-side field recorder PWA for capturing synced audio and MIDI takes over USB from
the K.O. Sidekick (EP-136) and, optionally, the K.O. II (EP-133). Everything happens
on-device: no server, no database, no account. Recordings never leave the phone unless you
explicitly export or share them.

Live: https://ep-rec-field-recorder.vercel.app

Requires Chrome or Edge on Android. Firefox and iOS Safari have no Web MIDI, so they cannot
see the hardware at all.

See `reference/hardware.md` for the full researched writeup of what these two devices
actually put on the wire — several of the obvious assumptions about the rig are wrong, and
that document is the reason this app behaves the way it does in a few places (the BPM
readout's three states, echo cancellation being left on, the EP-136 control decoding).

## The rig

The one-cable version, audio only:

```
K.O. Sidekick  --USB-C-->  Android phone
```

This gets you audio and the Sidekick's own mixer controls (fader rides, EQ, cue, FX) as
MIDI CC, but no notes and no clock — the Sidekick is a USB device, not a host, so nothing
patched into its 3.5mm inputs reaches the phone, and there is no evidence it transmits MIDI
clock at all.

The full version, with a powered USB-C hub:

```
K.O. II  --3.5mm-->  Sidekick CH1        audio
K.O. II  --USB-C-->  powered hub          notes and clock
Sidekick --USB-C-->  powered hub          audio and mixer CC
powered hub --USB-C-->  Android phone
```

Web MIDI then lists two input ports. Enable clock out on the K.O. II in its system settings
before trusting any tempo readout — the hub is also what stops the phone from bus-powering
the Sidekick, which otherwise drains the phone across a long session.

## First run checklist

Work through the **Signal** panel at the bottom of the screen — it exists to tell you
exactly where the chain breaks.

1. Open the live URL above in Chrome or Edge on the phone, with the interface already
   plugged into the USB-C port.
2. Optionally add it to the home screen (share sheet &rarr; "Add to Home Screen") so it
   runs as a standalone app.
3. Press **Record**. On a cold start this does three things in one tap: asks for MIDI and
   audio permission, guesses the right audio input (preferring anything that looks like a
   USB interface over the phone's own microphone), and starts the take. The key shows
   **Wait** while this is happening.
4. If the guess is wrong, or you plug in a different interface later, use **Scan** to
   re-detect hardware without starting a take, then pick the right input from the Audio
   Source list.
5. **audio in** should read `2 ch / 48.0 kHz`-ish with a device label mentioning USB or the
   Sidekick, not the phone microphone. If it only ever shows the built-in mic, or you're not
   sure the right device is armed, check `/diagnostics` for a lower-level read (MIDI ports,
   audio devices, resolved track settings, a live peak meter, and constraint presets for
   re-diagnosing device routing on hardware where it might behave differently).
6. **Channel identity.** The Sidekick presents four stereo pairs over USB and Android only
   ever hands the browser the first one; which pair that is decides whether you're capturing
   the finished mix or just whatever is plugged into channel one, and it's undocumented.
   `/diagnostics` has a dedicated test for this: plug a source into Sidekick CH2 only and
   watch whether the meters move. This doesn't change between sessions on the same phone —
   run it once and remember the answer.

Set levels with the Sidekick's own gain knobs until the numbers beside the meters read
around &minus;6 dBFS. The CLIP flag latches for the whole take once triggered, and a take
that never passed &minus;30 dBFS gets flagged when you stop &mdash; a quiet take is a wasted
one and the bars alone don't make that obvious.

## Reading the display

`BPM ---` means no MIDI has arrived at all. `BPM NO CLK` means MIDI is arriving but no clock
has been seen — the normal state with only the Sidekick connected, since it doesn't
transmit clock. A real number means the K.O. II is on the bus with clock enabled. Takes
recorded without clock are stored with no BPM and export at 120 BPM with that noted.

The bottom line is the last MIDI message. Generic messages decode as note names, CC
numbers, etc.; a recognized Sidekick control decodes to a readable name like `CH1 FADER 98`
or `AUX EQ MID -12`. That decoding is a strong hypothesis derived from monitoring a real
unit, not vendor documentation, so the raw bytes are always kept in the export regardless.

## How the sync works, and why the offset control exists

Audio and MIDI are captured by two independent browser APIs — an `AudioWorklet` graph for
audio, `Web MIDI` for MIDI — and nothing in the platform guarantees they share a clock.
The only synchronization mechanism is a single `performance.now()` timestamp captured once
in the transport layer when you press Record, handed to both engines as an explicit
starting point:

- Audio's elapsed time is derived from the accumulated sample count, never a wall-clock
  timer, so it cannot drift against the actual audio stream.
- Every MIDI message is stamped relative to that same shared origin.

In practice the USB stack still introduces a few milliseconds of jitter between the two
paths — the audio interrupt latency and the MIDI message latency are not identical, and
Android does not report USB input latency honestly, so the gap can't be measured, only
calibrated per phone. The **Midi offset** control (&minus;5/+5 ms, up to &plusmn;500 ms)
exists to correct for it after the fact: record a hard hit, import the WAV and MID into a
DAW, measure the gap, and dial it in. The offset is not baked into a take at record time —
the SMF file is rebuilt on demand from the raw stored MIDI events using whatever offset is
currently set, so you can go back and re-tune an old take's export without re-recording
anything.

## Exports

- **wav** &mdash; stereo 24-bit PCM at the interface's native sample rate, matching the
  Sidekick's own converters. Roughly 17 MB per minute. Quantized with rounding, not a
  truncating cast, since truncation produces signal-correlated error rather than noise;
  measured on a sine sweep this keeps conversion error around &minus;144 dBFS, well under
  the interface's own noise floor.
- **mp3** &mdash; encoded on demand at the bitrate set in input row 4 (128/192/256/320
  kbps, default 192), joint stereo, matching the source sample rate. Encoding runs entirely
  in a worker using a vendored, offline-capable build of the LAME encoder
  (`public/lame.min.js`, LGPL &mdash; MP3 patents expired worldwide in 2017), streamed out
  of the stored WAV in bounded blocks so a long take can't exhaust memory. Runs at roughly
  3&ndash;10x realtime depending on the phone, so a long take takes a while; the button
  shows progress and the rest of that take's actions disable until it's done. MP3 is a
  convenience copy for sharing &mdash; the WAV is the archive. Re-encode from the WAV
  whenever you want a different bitrate rather than keeping the MP3 as your only copy.
- **midi** &mdash; standard MIDI file, format 1, one track per port, hanging notes closed
- **json** &mdash; every byte of every message with millisecond offsets, plus clock
  timestamps. This is the archival copy, and the one that carries the Sidekick's mixer
  automation — fader rides, EQ sweeps, cue toggles, all timestamped next to the audio. That
  performance data is the feature no other recorder on this rig gives you.
- **all** &mdash; zips the WAV, MIDI and JSON together (a from-scratch, stored-only zip
  writer; audio doesn't compress usefully so there's no point adding a dependency for it).
  Does not include the MP3, since that's a separate, slower, opt-in encode.

## Reliability

PCM conversion and the actual disk write both happen off the main thread, in a dedicated
worker using OPFS's synchronous file access handle, so a slow render can never stall a
write mid-take. Write failures are never swallowed: a failed chunk is counted rather than
silently producing a gap, and the take is flagged with how many write errors it had. The
capture worklet separately compares frames actually captured against what the audio clock
says should have arrived, so a dropped render quantum shows up as a recorded fact (a "gap"
flag on the take) instead of a silently shortened recording.

MP3 encoding is verified against the actual vendored encoder rather than trusted blind: a
test loads `public/lame.min.js` for real and confirms a five-second signal converts to
exactly 240,000 frames, encodes to within a few percent of the requested bitrate, and
parses back to the right MPEG frame count and duration through a from-scratch frame reader.

## Known limits

- **Stereo only.** Android will not give a browser more than the default two-channel pair,
  even if the interface itself exposes more inputs. Multitrack capture in a mobile browser
  is not achievable on this platform, not just unimplemented here.
- **Foreground only.** There is no background recording. Backgrounding the tab or letting
  the phone sleep mid-take will interrupt capture; a screen Wake Lock is held during a take
  specifically to make phone-sleep the less likely of those two failure modes, but the tab
  itself still has to stay in front.
- **No SysEx.** Web MIDI access is requested without the sysex flag, and no dump format is
  documented for either device anyway.
- **The remaining quality ceiling is Android's, not this app's.** A browser cannot fully
  select the OS audio source; you get whatever processing the platform applies. Disabling
  noise suppression, auto gain control and voice isolation, and marking the track as music
  via `contentHint`, is the whole of the available influence &mdash; none of it is
  guaranteed to be honored, but none of it costs anything to ask for either.
- **Echo cancellation stays on, deliberately.** Confirmed on real hardware: explicitly
  disabling `echoCancellation` breaks Android's audio device routing outright &mdash;
  `getUserMedia` reports the requested USB device as open with matching settings while
  silently capturing the phone's built-in mic instead. `noiseSuppression`, `autoGainControl`
  and `voiceIsolation` can all be disabled safely; only echo cancellation causes this. It is
  left at the browser's default rather than forced off. For a direct line-in signal there is
  no acoustic echo to cancel in the first place, so in practice this costs nothing. See
  `/diagnostics` for the constraint presets used to isolate this, in case it needs
  re-diagnosing on different hardware.
- **No MIDI clock from the Sidekick, and no state readback.** It detects BPM per channel
  internally and displays it on its own screen, but nothing suggests it transmits that over
  MIDI. MIDI from the Sidekick is a one-way controller stream — this app cannot ask which EQ
  style is loaded or where the faders currently sit, only see things move.

## Sharing it

The deployed app is static and entirely client-side, so there is nothing to provision and
no per-user cost. Anyone sent the URL gets their own isolated on-device storage and their
own recordings; none of it reaches this Vercel project beyond the initial page load.

## Development

```bash
pnpm install
pnpm dev
```

## Scripts

- `pnpm dev` — local dev server
- `pnpm build` — static export production build
- `pnpm lint` / `pnpm typecheck` / `pnpm test` — checks run by the pre-push hook
- `pnpm format` — apply Prettier
- `pnpm icons` — regenerate `public/icon-*.png` from `scripts/generate-icons.ts`
