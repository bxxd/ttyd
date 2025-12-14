# ttyd Developer Guide

Technical documentation for developing and maintaining this ttyd fork.

## Project Structure

```
ttyd/
├── html/                      # Frontend (what we modify)
│   ├── src/
│   │   ├── components/
│   │   │   ├── app.tsx        # Main app, WebSocket URL construction
│   │   │   ├── terminal/
│   │   │   │   ├── index.tsx  # Terminal component, mobile input
│   │   │   │   ├── mobile-input.css
│   │   │   │   └── xterm/
│   │   │   │       └── index.ts  # Xterm wrapper, WebSocket handling
│   │   │   └── modal/
│   │   └── index.tsx
│   ├── dist/                  # Build output
│   │   └── inline.html        # Single-file output (deploy this)
│   ├── package.json
│   ├── webpack.config.js
│   └── gulpfile.js            # Inlines JS/CSS into single HTML
├── src/                       # C backend (rarely modified)
│   └── html.h                 # Generated from html/dist/inline.html
└── README.md
```

## Development Workflow

### Building

```bash
cd html
npm install          # First time only
npm run build        # Production build (webpack + gulp inline)
```

Output: `html/dist/inline.html`

### Deploying to alpha-server

```bash
cp html/dist/inline.html /home/ubuntu/idio/dev/alpha-server/static/alpha/ttyd.html
```

### Development Tips

- **Hot reload:** Not set up. Edit → build → hard refresh browser
- **Debug logging:** Add `console.log('[mobile] ...')` statements, check browser devtools
- **Mobile debugging:** Use Chrome's `chrome://inspect` with USB-connected Android device

## Key Implementation Details

### Mobile Input Architecture

The mobile input system works around xterm.js's problematic mobile IME handling.

**Flow:**
1. User taps terminal → `showMobileInput()` triggered
2. Hidden textarea focused → mobile keyboard appears
3. User types → `handleMobileInput()` diffs and sends new chars
4. User presses backspace → sends `\x7f` to terminal
5. User taps elsewhere → `hideMobileInput()` hides keyboard

**Cursor Wake Trick:**
```typescript
// Send zero-width space to trigger cursor redraw, then delete it
this.xterm.sendData('\u200B');  // Zero-width space (invisible)
setTimeout(() => {
    this.xterm.sendData('\x7f');  // Backspace to remove it
}, 10);
```

This causes a subtle flash that confirms focus and makes the cursor visible in Ink-based apps (like Claude Code) that manage their own cursor display.

**Cross-Session Delete:**
```typescript
// In handleMobileKeyDown
if (e.key === 'Backspace' && this.mobileInput?.value === '') {
    // Textarea empty but user wants to delete more
    e.preventDefault();
    this.xterm.sendData('\x7f');
}
```

When user refocuses, textarea is cleared but terminal may have content from before. This allows deleting past what's in the current textarea.

### Reconnect Logic

Located in `html/src/components/terminal/xterm/index.ts`:

```typescript
private attemptReconnect() {
    // If page is hidden (phone asleep), wait for visibility
    if (document.hidden) {
        const onVisible = () => {
            if (!document.hidden) {
                document.removeEventListener('visibilitychange', onVisible);
                this.reconnectAttempt = 0;
                this.attemptReconnect();
            }
        };
        document.addEventListener('visibilitychange', onVisible);
        return;
    }
    // Exponential backoff: 0s, 1s, 2s...
    const delay = this.reconnectAttempt === 0 ? 0 : this.reconnectAttempt * 1000;
    // ...
}
```

### postMessage API

**Inbound (parent → ttyd):**
```javascript
// Scroll to bottom
iframe.contentWindow.postMessage({ action: 'scrollToBottom' }, '*');

// Send input (for drag-and-drop file paths)
iframe.contentWindow.postMessage({ action: 'sendInput', text: '/path/to/file' }, '*');
```

**Outbound (ttyd → parent):**
```javascript
// Request reconnect (when WebSocket dies)
parent.postMessage({ type: 'ttyd_reconnect' }, '*');
```

## Upstream Sync Process

```bash
# Add upstream remote (first time)
git remote add upstream https://github.com/tsl0922/ttyd.git

# Sync main branch
git checkout main
git pull upstream main
git push origin main

# Rebase our changes onto latest upstream
git checkout idio-main
git rebase main
git push origin idio-main --force-with-lease
```

**Note:** The `src/html.h` file is auto-generated and will have conflicts. After rebase, rebuild to regenerate it.

## Testing Checklist

Before committing mobile input changes:

- [ ] Type characters → appear in terminal
- [ ] Backspace → deletes characters
- [ ] Enter → submits command
- [ ] Ctrl+C → sends SIGINT (test with `sleep 100`)
- [ ] Paste → pastes text
- [ ] Refocus after blur → can still type
- [ ] Refocus then backspace → can delete pre-refocus content
- [ ] Phone sleep → wake → reconnects automatically
- [ ] Cursor visible after tap (subtle flash)

## Common Issues

**"TypeError: Cannot read property 'focus' of null"**
- Mobile input textarea not mounted yet. Check `isMobile()` detection.

**Characters doubled or missing**
- IME composition issue. Check diff logic in `handleMobileInput()`.

**Cursor doesn't show after tap**
- Zero-width space trick may have failed. Check timing (50ms + 10ms delays).

**Can't delete past certain point**
- Cross-session delete not working. Check `handleMobileKeyDown` backspace handler.
