# EP-REC field recorder

A client-side field recorder PWA for capturing synced audio and MIDI takes over USB from
hardware like the K.O. Sidekick. Everything happens on-device: no server, no database, no
account.

Live: https://ep-rec-field-recorder.vercel.app

Full documentation lands in a later build step. See `reference/prototype-notes.md` for the
build sequence this project follows.

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
