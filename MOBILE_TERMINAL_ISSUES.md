# Mobile Terminal Input Issues

## The Problem

**Symptoms:**
- Keys sometimes don't register
- Sudden bursts of repeated/jumbled text
- Input feels inconsistent and laggy
- Keyboard shows suggestions but they don't work

**Root Cause:**

This is an **architectural issue** in how xterm.js handles mobile keyboard input via IME (Input Method Editor) composition events, compounded by WebSocket latency.

### Technical Details

xterm.js uses a hidden textarea (`.xterm-helper-textarea`) to capture input:

```css
/* The textarea is hidden way off-screen */
position: absolute;
left: -9999em;
width: 0;
height: 0;
opacity: 0;
```

When you type on mobile:

1. **compositionstart** fires → xterm starts buffering input
2. The CompositionHelper **dynamically moves the textarea** to cursor position (for IME positioning)
3. **compositionupdate** fires multiple times as you type
4. Mobile keyboard loses track of input element due to repositioning
5. **WebSocket latency** means terminal output is delayed
6. Textarea value and composition position tracking get out of sync
7. When **compositionend** fires, it either:
   - Misses characters (wrong position tracking)
   - Dumps all buffered input at once (buffer release)
   - Or sends jumbled/repeated text (race condition)

**From xterm.js source (CompositionHelper.ts:154-176):**
```typescript
setTimeout(() => {
  // Tries to extract input from textarea.value based on tracked positions
  // But positions can be wrong due to race conditions with mobile + WebSocket
  input = this._textarea.value.substring(currentCompositionPosition.start, ...);
  this._coreService.triggerDataEvent(input, true);
}, 0); // 0ms timeout is too short for mobile + WebSocket latency
```

## Current Mitigations (Already Applied)

In `terminal/src/lib.rs`, we've added:

```rust
"-t", "screenReaderMode=true",  // Adds stable visible DOM elements
"-t", "allowTransparency=true", // Reduces rendering lag
"-t", "fontSize=16",            // Prevents iOS auto-zoom
```

These help but **don't fix the fundamental issue**.

## Practical Workarounds

### 1. **Type Slower / Shorter Bursts**
- Don't type long sentences without pausing
- Let each word "settle" before typing the next
- Watch for characters to appear before continuing

### 2. **Tap to Refocus When Stuck**
- If input stops registering, **tap the terminal once** to refocus
- This resets the composition state
- Then continue typing

### 3. **Disable Keyboard Suggestions**
- iOS: Settings → General → Keyboard → Turn off "Predictive"
- Android: Keyboard settings → Turn off "Show suggestion strip"
- This forces simpler input mode (less IME complexity)

### 4. **Use Desktop for Heavy Typing**
- Mobile is fine for quick commands, cd'ing, ls, etc.
- For long terminal sessions, use desktop browser
- Desktop keyboards don't use IME composition, so no buffer issues

### 5. **Force Keyboard to "Simple" Mode**
- Use a **basic keyboard app** without autocorrect/suggestions
- iOS: Try "Classic QWERTY" keyboard style
- Android: Try "Gboard" in basic mode or Hacker's Keyboard

### 6. **Clear Stuck State**
- If terminal is completely stuck:
  1. Hide mobile keyboard (swipe down / back button)
  2. Wait 1 second
  3. Tap terminal again
  4. Keyboard reappears fresh

## Why This Is Hard to Fix

xterm.js expects:
- Stable, visible input elements
- Fast, synchronous event handling
- Desktop-style keyboard behavior

Mobile provides:
- Virtual keyboards that reposition themselves
- IME composition with async events
- Prediction/autocomplete that fires extra events

Combined with WebSocket latency, the timing assumptions break down.

### Potential Real Fixes (Not Yet Implemented)

1. **Patch xterm.js CompositionHelper**
   - Increase setTimeout from 0ms to 100ms
   - Clear textarea more aggressively
   - Add debouncing to composition events
   - Requires: Rebuilding ttyd with patched xterm.js

2. **Mobile-Specific Input Mode**
   - Detect mobile and use different input handling
   - Disable IME composition entirely on mobile
   - Force direct keypress events
   - Requires: Major xterm.js modifications

3. **Server-Side Input Buffering**
   - Add debouncing/deduplication on ttyd server
   - Detect and drop duplicate input
   - Requires: Modifying ttyd C code

All of these require significant development effort and wouldn't eliminate the fundamental architectural mismatch.

## Related Documentation

- **xterm.js CompositionHelper source**: https://github.com/xtermjs/xterm.js/blob/master/src/browser/input/CompositionHelper.ts
- **Git history of IME fixes**: Constant battle since 2018, dozens of composition-related patches in xterm.js repo

## Bottom Line

Mobile terminal input is **usable but imperfect** due to fundamental architecture issues in xterm.js. Use the workarounds above, and switch to desktop for extended terminal sessions.

The screenReaderMode + allowTransparency tweaks we've applied are **pragmatic mitigations** that improve stability, but can't fully solve the timing issues inherent in mobile IME + WebSocket + xterm's hidden textarea architecture.
