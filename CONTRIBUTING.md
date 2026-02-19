# Contributing

PRs welcome. Keep it simple — zero dependencies.

## Adding a Provider

1. Copy `src/providers/base.js` → `src/providers/yourprovider.js`
2. Implement `validate()`, `read()`, `write()` (optional)
3. Register in `src/daemon.js`

## Adding a Channel

1. Copy `src/channels/base.js` → `src/channels/yourchannel.js`
2. Implement `send()`, `update()`
3. Register in `src/daemon.js`

## Testing

Test on both Linux and macOS before submitting.
