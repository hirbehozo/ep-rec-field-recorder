# Hardware reference: EP-136 K.O. Sidekick and EP-133 K.O. II over USB-C

Researched August 2026. Everything here either comes from Teenage Engineering's own
documentation or is flagged as community derived. Read this before touching the MIDI or
audio code, because several of the obvious assumptions are wrong.

## The rig

The one-cable version, which gets you audio and the mixer's own control data:

```
EP-133 K.O. II  --3.5mm-->  Sidekick CH1
other gear      --3.5mm-->  Sidekick CH2
Sidekick        --USB-C-->  Android phone
```

This is not enough for a MIDI recorder. The Sidekick sends its own controls as CC, but
there is no evidence it transmits MIDI clock, and it is a USB device rather than a host,
so nothing patched into it reaches the phone. No notes, no clock, no tempo.

The full version needs a powered OTG hub:

```
EP-133 K.O. II  --3.5mm-->  Sidekick CH1     audio
EP-133 K.O. II  --USB-C-->  powered hub      notes and clock
Sidekick        --USB-C-->  powered hub      audio and mixer CC
powered hub     --USB-C-->  Android phone
```

Web MIDI then lists two input ports. Enable clock out on the K.O. II in system settings
before trusting any tempo readout. The hub also stops the phone bus-powering the Sidekick,
which otherwise drains the phone across a long session even though the Sidekick has AAAs.

## Audio

The Sidekick is a class compliant USB 2.0 interface, 8 in and 4 out, 48 kHz and 24 bit.
No drivers on any host.

The eight inputs are four stereo pairs: channel one, channel two, aux, and the main
output. Host playback returns on its own dedicated stereo channel.

None of that multichannel capability survives the trip to Android. Android's audio
documentation states that stereo content lands on the peripheral's first two channels and
that there are no USB-audio-specific APIs. Interface vendors are blunter: Android does not
support more than two-channel stereo, so a larger interface gives you channels 1 and 2 at
best, and sometimes is not recognised at all. Chrome adds its own ceiling, since the
multichannel getUserMedia bug has been open since 2015 and getUserMedia delivers a summed
stereo regardless.

So: one stereo pair, always. Multitrack in a browser on Android is not a roadmap item, it
is impossible.

### The one open question

Which pair is first is documented nowhere. If pair one is the main mix, we capture the
finished sum and everything is fine. If pair one is CH1, we capture only whatever is
plugged into channel one and the rest of the mix is missing.

Test: plug a source into CH2 only, record, and see whether anything arrives. Thirty
seconds, answered permanently. The diagnostics page in prompt 2 exists partly for this.

## MIDI from the Sidekick

There is no official MIDI documentation for the EP-136. The table below is community
derived by monitoring a real unit with a Web MIDI monitor in May 2026, using the TX-6 as a
starting reference. Treat it as a strong hypothesis, not vendor truth, and keep the raw
bytes in every take so a wrong CC number is recoverable after the fact.

Mixer channels map onto MIDI channels: CH1 is 1, CH2 is 2, AUX is 3. Master is unconfirmed.

| CC | Control | Type | Notes |
|----|---------|------|-------|
| 1 | FX force pad | absolute | continuous pressure, sent as mod wheel |
| 3 | Cue button | absolute | 127 on, 0 off |
| 7 | Channel fader | absolute | standard volume, 0 bottom |
| 14 | FX button | absolute | 127 on, 0 off |
| 20 | Gain encoder | relative | two's complement, see below |
| 22 | EQ high | absolute | 64 is flat |
| 23 | EQ mid | absolute | 64 is flat |
| 24 | EQ low | absolute | 64 is flat |

Pitch bend carries the MOD+ lever as a 14-bit value, 0 to 16383, centred at 8192.

### Decoding CC20

```js
const delta = value < 64 ? value : value - 128;
accumulated = Math.max(0, Math.min(127, accumulated + delta));
```

Values 1 to 63 are positive increments, 0 and 64 mean no change, 65 to 127 are negative.
Because it is relative, the absolute knob position is unknowable: we only ever see change
from an unknown start. Type it as a delta and never present it as a gain value.

## MIDI from the K.O. II

Class compliant USB MIDI, plus 3.5 mm TRS Type A. Both work at once.

Clock is configurable in system settings under MIDI as off, on, or out, so the K.O. II can
be the master and is the only clock source in this rig. It also receives clock, song
position pointer and start / continue / stop.

Pads send notes on a per-pad MIDI channel set in sound edit, and a pad with its sample set
to 000 sends MIDI without consuming a voice, which is how it drives external gear silently.

## Reading the sample library

The short version: it is possible, it is undocumented on purpose, and it is not where you
should start.

TE's own EP Sample Tool is a web app at teenage.engineering/apps/ep-sample-tool that talks
to the device over MIDI SysEx. That alone proves a browser can do this, since Web MIDI with
sysex enabled is the only transport it could be using.

The protocol is deliberately closed. Wade Mealing asked TE directly in February 2024 for
SysEx documentation to build his own tools, and was told they could not share any details,
while being encouraged to keep exploring. Everything below is community reverse engineering.

What is known:

- **wmealing/KO2-SYSEX** documents the message framing: TE's manufacturer ID is 00 20 76,
  there is a command set including GREET, ECHO, DFU and PRODUCT_SPECIFIC, status codes for
  ok / error / command-not-found / bad-request, and payloads use a 7-bit packing scheme
  where the high bits of each run of seven bytes are gathered into a leading byte.
- **garrettjwilke/ep_133_sysex_thingy** has working .syx files that trigger sounds, delete
  a sample from a slot, switch projects, and transfer a WAV into a slot. Samples on the
  device carry a small JSON header with playmode, rootnote, pitch, pan, amplitude, envelope
  and time mode, and transferred WAVs must be at the 46875 Hz native rate. That repo is
  archived, and its delete commands are genuinely destructive.
- **phones24/ep133-export-to-daw** is the serious one: an actively maintained PWA that
  reads whole projects and samples off the device over Web MIDI, and can also work offline
  from .pak and .ppak backup files. It is AGPL-3.0.

That licence matters. Lifting its SysEx implementation into EP-REC would require releasing
EP-REC under AGPL as well, since the app is served over a network. The protocol facts are
not copyrightable and can be reimplemented, but the code cannot simply be copied in.

Three further reasons not to make live enumeration the first move: firmware 2.5 landed in
June 2026 and changed the USB stack, so anything reverse engineered before that needs
re-verifying; the same command surface that reads samples can also erase them; and the
device is busy being played during the exact sessions where the library view is wanted.

The conclusion for this app is that the pad map should be built by playing rather than
read from the device. A pad hit is already a MIDI note we receive, so binding notes to pad
names costs nothing, sends nothing, and cannot damage anything. Reading the real library
stays available as a later addition once there is a reason to take the risk.

## What is not available

- **No clock from the Sidekick.** It detects BPM per channel internally and displays it,
  but nothing suggests it transmits that. Tempo comes from the K.O. II or nowhere.
- **No state readback.** MIDI here is a one-way controller stream. You cannot ask which EQ
  style is loaded, which FX is selected, or where the faders currently sit. You only see
  things move.
- **No SysEx.** Nothing was found in community testing and no dump format is documented.

## What this is worth

The Sidekick's CC stream is the mix performance: fader rides, force pad pressure curves,
EQ sweeps, cue toggles, all timestamped. Recorded next to the audio, a take carries the
gestures and not just the result. That is the feature no other recorder on this rig gives
you, and it is the reason the raw JSON export matters more than it looks.

## Sources

- teenage.engineering EP-136 guide, hardware overview and product specifications
- teenage.engineering EP-133 guide, system settings and how-to
- Android Open Source Project, USB digital audio
- Chromium issue 40403559, multichannel input via getUserMedia
- Community MIDI CC spec for the EP-136, gist by GOROman, May 2026
- wmealing/KO2-SYSEX, protocol notes and TE's reply declining to document it
- garrettjwilke/ep_133_sysex_thingy, working SysEx captures and sample header format
- phones24/ep133-export-to-daw, AGPL-3.0 Web MIDI implementation
