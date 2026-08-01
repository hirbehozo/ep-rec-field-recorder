# EP-REC field recorder

A client-side field recorder PWA for capturing synced audio and MIDI takes over USB from
hardware like the K.O. Sidekick. Everything happens on-device: no server, no database, no
account. Recordings never leave the phone unless you explicitly export or share them.

Live: https://ep-rec-field-recorder.vercel.app

Requires Chrome or Edge on Android. Firefox and iOS Safari have no Web MIDI, so they cannot
see the hardware at all.

## The rig

```
┌────────────────────┐   USB-C    ┌───────────────────────────┐
│  Android phone      │◄──────────►│  K.O. Sidekick, or any     │
│  Chrome or Edge      │  audio +   │  class-compliant USB audio  │
│  this app, installed │  MIDI      │  + MIDI interface           │
│  as a PWA             │           │                             │
└────────────────────┘            └───────────────────────────┘
```

The phone is the only compute involved. The interface just needs to present itself as a
standard USB audio class device and a standard USB MIDI class device at the same time,
which is exactly what the Sidekick (and most small USB audio interfaces with a MIDI port)
does.

## First run checklist

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
5. If you only ever see the phone's built-in microphone in the input list, or the Signal
   section at the bottom reports **audio in: not open**, the browser is not being handed a
   USB audio device on this phone. Check `/diagnostics` for a lower-level read on exactly
   what Chrome can see (MIDI ports, audio devices, resolved track settings, a live peak
   meter) and what to do about each failure.

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
that gap can vary by device. The **Midi offset** control (&minus;5/+5 ms, up to &plusmn;500 ms)
exists to correct for it after the fact: listen back, nudge until note hits line up with
the transients in the waveform, and leave it there. The offset is not baked into a take at
record time — the SMF file is rebuilt on demand from the raw stored MIDI events using
whatever offset is currently set, so you can go back and re-tune an old take's export
without re-recording anything.

## Known limits

- **Stereo only.** Android will not give a browser more than the default two-channel pair,
  even if the interface itself exposes more inputs.
- **Foreground only.** There is no background recording. Backgrounding the tab or letting
  the phone sleep mid-take will interrupt capture; a screen Wake Lock is held during a take
  specifically to make phone-sleep the less likely of those two failure modes, but the tab
  itself still has to stay in front.
- **16-bit.** WAV output is always 16-bit PCM regardless of the source interface's native
  bit depth.

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
