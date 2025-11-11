# ttyd Architecture Deep Dive

Complete investigation of ttyd internals - how it shares terminals over the web.

## High-Level Architecture

```
Browser (xterm.js) ←→ WebSocket ←→ libwebsockets ←→ libuv ←→ PTY ←→ Shell Process
```

### Technology Stack

**Backend (C):**
- **libwebsockets**: WebSocket server + HTTP server
- **libuv**: Async I/O event loop
- **forkpty()**: Create pseudo-terminal + fork child process (Unix)
- **ConPTY**: Windows pseudo-console API

**Frontend (TypeScript + Preact):**
- **xterm.js v5.5**: Terminal emulator with WebGL/Canvas rendering
- **Preact**: Lightweight React alternative
- **Webpack**: Build system (bundles to single inline HTML → gzipped → embedded in C header)

---

## Component Architecture

### 1. Main Entry Point (`server.c`)

**Initialization Flow:**
```
main()
  ├─ Parse command-line options
  ├─ server_new()
  │   └─ Initialize libuv event loop (uv_loop_init)
  ├─ Configure libwebsockets context
  │   ├─ Set protocols: ["http-only", "tty"]
  │   ├─ Integrate libuv as foreign loop
  │   └─ Create vhost
  ├─ Setup signal handlers (SIGINT, SIGTERM via libuv)
  ├─ lws_service(context, 0)  ← Start event loop
  └─ Cleanup on exit
```

**Key Data Structures:**

```c
struct server {
    int client_count;
    char **argv;              // Command to execute
    int argc;
    char *cwd;                // Working directory
    int sig_code;             // Signal to send on close
    bool writable;            // Allow client input
    int max_clients;
    uv_loop_t *loop;          // libuv event loop
    // ... auth, SSL, etc.
};

struct pss_tty {              // Per-session state
    bool initialized;
    bool authenticated;
    struct lws *wsi;          // WebSocket connection
    pty_process *process;     // PTY process
    pty_buf_t *pty_buf;       // Pending output buffer
    int lws_close_status;
    char **args;              // Additional arguments from URL
    int argc;
};
```

---

### 2. WebSocket Protocol (`protocol.c`)

**Protocol Messages:**

```c
// Client → Server
#define INPUT '0'              // User input
#define RESIZE_TERMINAL '1'    // Terminal resize (JSON: {columns, rows})
#define PAUSE '2'              // Pause output (flow control)
#define RESUME '3'             // Resume output (flow control)
#define JSON_DATA '{'          // Initial handshake (auth + size)

// Server → Client
#define OUTPUT '0'             // Terminal output
#define SET_WINDOW_TITLE '1'   // Set window title
#define SET_PREFERENCES '2'    // Send preferences (JSON)
```

**Connection Lifecycle:**

```
LWS_CALLBACK_FILTER_PROTOCOL_CONNECTION
  ├─ Check client limit (--once, --max-clients)
  ├─ Verify authentication (basic auth or auth header)
  ├─ Validate WebSocket path
  └─ Check origin (if --check-origin)

LWS_CALLBACK_ESTABLISHED
  ├─ Initialize session state (pss)
  ├─ Parse URL arguments (if --url-arg)
  └─ Increment client count

LWS_CALLBACK_SERVER_WRITEABLE
  ├─ Send initial messages (title, preferences)
  ├─ Mark initialized → resume PTY
  └─ Send buffered PTY output → client

LWS_CALLBACK_RECEIVE
  ├─ Buffer incoming data (handle fragmentation)
  └─ Process command:
      ├─ INPUT: pty_write() → PTY stdin
      ├─ RESIZE_TERMINAL: pty_resize()
      ├─ PAUSE/RESUME: pty_pause()/pty_resume()
      └─ JSON_DATA: spawn_process() (first message only)

LWS_CALLBACK_CLOSED
  ├─ Decrement client count
  ├─ Kill PTY process (if running)
  ├─ Free resources
  └─ Exit (if --once or --exit-no-conn and no clients)
```

**PTY Integration:**

```c
typedef struct {
    struct pss_tty *pss;
    bool ws_closed;
} pty_ctx_t;

// PTY read callback (when PTY has output)
process_read_cb(pty_process *process, pty_buf_t *buf, bool eof)
  ├─ Check if WebSocket closed
  ├─ Buffer data in pss->pty_buf
  └─ lws_callback_on_writable()  ← Trigger server writable

// PTY exit callback (when process exits)
process_exit_cb(pty_process *process)
  ├─ Set close status (1000 = normal, 1006 = abnormal)
  └─ lws_callback_on_writable()  ← Trigger close
```

---

### 3. PTY Management (`pty.c`)

**Data Structures:**

```c
struct pty_process_ {
    int pid, exit_code, exit_signal;
    uint16_t columns, rows;

    // Unix: master PTY fd, background thread
    pid_t pty;
    uv_thread_t tid;

    char **argv;              // Command + args
    char **envp;              // Environment (TERM, TTYD_USER)
    char *cwd;                // Working directory

    uv_loop_t *loop;
    uv_async_t async;         // Exit notification (thread → main loop)
    uv_pipe_t *in;            // Write to PTY
    uv_pipe_t *out;           // Read from PTY
    bool paused;              // Flow control

    pty_read_cb read_cb;      // Data available callback
    pty_exit_cb exit_cb;      // Process exit callback
    void *ctx;                // User context (pty_ctx_t)
};
```

**Unix PTY Spawn Flow:**

```c
pty_spawn()
  ├─ forkpty(&master, NULL, NULL, &size)
  │   ├─ Creates pseudo-terminal pair (master/slave)
  │   ├─ Forks child process
  │   └─ Child: stdin/stdout/stderr → slave PTY
  │
  ├─ Child process (pid == 0):
  │   ├─ setsid()           ← New session
  │   ├─ chdir(cwd)         ← Change directory
  │   ├─ putenv(envp)       ← Set environment
  │   └─ execvp(argv)       ← Execute command
  │
  └─ Parent process:
      ├─ Set master FD non-blocking + CLOEXEC
      ├─ Create two libuv pipes (in, out) from master FD
      ├─ Initialize async handle (for exit notification)
      └─ uv_thread_create(&tid, wait_cb, process)
          └─ Background thread:
              ├─ waitpid(pid, &stat, 0)  ← Wait for child
              └─ uv_async_send(&async)   ← Notify main loop
                  └─ Main loop: async_cb() → exit_cb()
```

**I/O Operations:**

```c
// Write to PTY (user input)
pty_write(process, buf)
  └─ uv_write(req, process->in, buf, 1, write_cb)

// Read from PTY (automatically via libuv)
pty_resume(process)
  └─ uv_read_start(process->out, alloc_cb, read_cb)
      └─ read_cb(stream, n, buf)
          └─ process->read_cb(process, buf, false)

// Resize terminal
pty_resize(process)
  └─ ioctl(process->pty, TIOCSWINSZ, &size)

// Kill process
pty_kill(process, sig)
  └─ uv_kill(-process->pid, sig)  // Negative PID = process group
```

**Flow Control:**

```c
pty_pause(process)   → uv_read_stop()   ← Stop reading from PTY
pty_resume(process)  → uv_read_start()  ← Resume reading from PTY
```

---

### 4. HTTP Server (`http.c`)

**Endpoints:**

```c
GET /token          → {"token": "base64_credential"}
GET /               → index.html (embedded or custom)
GET /base-path      → 302 redirect to /base-path/
GET /base-path/     → index.html
```

**HTML Serving:**

1. **Embedded HTML** (default):
   - Frontend built with webpack → single inline HTML file
   - Gzipped at build time → embedded in `src/html.h` (16K lines)
   - First request: uncompress with zlib → cache in memory
   - Supports Accept-Encoding: gzip (send compressed or uncompressed)

2. **Custom HTML** (--index flag):
   - Serve file from disk with `lws_serve_http_file()`

**Authentication:**

```c
check_auth(wsi, pss)
  ├─ Auth proxy header: Check for custom header
  ├─ Basic auth: Check Authorization header
  └─ Return: AUTH_OK, AUTH_FAIL, AUTH_ERROR
```

---

### 5. Frontend (`html/src/`)

**Build System:**

```
TypeScript + Preact
  ↓ webpack (bundle)
  ↓ gulp inline (inline CSS/JS into single HTML)
  ↓ gulp gzip (compress)
  ↓ gulp html2h (convert to C header)
  → src/html.h
```

**Client-Side WebSocket Flow:**

```typescript
// Connection
connect()
  ├─ new WebSocket(wsUrl, ['tty'])
  └─ socket.binaryType = 'arraybuffer'

// On open
onSocketOpen()
  ├─ Send JSON: {AuthToken, columns, rows}
  ├─ Initialize terminal event listeners
  └─ terminal.focus()

// Receive data
onSocketData(event)
  ├─ Read first byte as command
  └─ Switch:
      ├─ OUTPUT ('0'): terminal.write(data)
      ├─ SET_WINDOW_TITLE ('1'): document.title = data
      └─ SET_PREFERENCES ('2'): applyPreferences(JSON.parse(data))

// Send data
sendData(data)
  ├─ Prepend INPUT ('0') command byte
  └─ socket.send(payload)

// Terminal events
terminal.onData(data)           → sendData(data)
terminal.onResize({cols, rows}) → send RESIZE_TERMINAL + JSON
terminal.onBinary(data)         → sendData(data)
```

**Flow Control:**

```typescript
writeData(data)
  ├─ Track bytes written
  ├─ If written > limit:
  │   ├─ Increment pending counter
  │   └─ If pending > highWater: send PAUSE
  └─ In write callback:
      └─ If pending < lowWater: send RESUME
```

**Reconnection Logic:**

```typescript
onSocketClose(event)
  ├─ Show overlay: "Connection Closed"
  ├─ Dispose listeners
  └─ If event.code !== 1000 && doReconnect:
      ├─ Show overlay: "Reconnecting..."
      └─ refreshToken().then(connect)
    Else:
      └─ Show overlay: "Press ⏎ to Reconnect"
```

**xterm.js Addons:**

- **FitAddon**: Auto-resize terminal to fit container
- **WebglAddon**: GPU-accelerated rendering (fallback to Canvas → DOM)
- **CanvasAddon**: Canvas-based rendering (fallback to DOM)
- **ClipboardAddon**: Copy/paste support
- **WebLinksAddon**: Clickable URLs
- **ImageAddon**: Sixel image support
- **Unicode11Addon**: Unicode 11 support
- **ZmodemAddon**: File transfer (ZMODEM + trzsz)
- **OverlayAddon**: Show notifications (resize, reconnect, etc.)

---

## Complete Data Flow

### User Types in Browser → Shell

```
1. User types 'ls'
   ↓
2. xterm.js: terminal.onData('ls')
   ↓
3. Xterm.sendData('ls')
   ├─ Prepend INPUT ('0')
   └─ WebSocket.send(['0', 'l', 's'])
   ↓
4. libwebsockets: LWS_CALLBACK_RECEIVE
   ↓
5. protocol.c: callback_tty()
   ├─ Parse INPUT command
   └─ pty_write(process, buf)
   ↓
6. pty.c: uv_write(process->in, buf)
   ↓
7. PTY master FD
   ↓
8. Shell process reads from stdin
```

### Shell Outputs → Browser

```
1. Shell process writes to stdout
   ↓
2. PTY slave FD → PTY master FD
   ↓
3. libuv: uv_read_start() callback
   ↓
4. pty.c: read_cb()
   └─ process->read_cb(process, buf, false)
   ↓
5. protocol.c: process_read_cb()
   ├─ Store buf in pss->pty_buf
   └─ lws_callback_on_writable(pss->wsi)
   ↓
6. libwebsockets: LWS_CALLBACK_SERVER_WRITEABLE
   ↓
7. protocol.c: callback_tty()
   ├─ wsi_output(wsi, pss->pty_buf)
   │   ├─ Prepend OUTPUT ('0')
   │   └─ lws_write(wsi, buf, LWS_WRITE_BINARY)
   └─ pty_resume(process)
   ↓
8. WebSocket → Browser
   ↓
9. Xterm.onSocketData(event)
   ├─ Parse OUTPUT command
   └─ terminal.write(data)
   ↓
10. xterm.js renders to screen
```

---

## Process Lifecycle

### Startup

```
1. ttyd bash
   ↓
2. Parse options, create server struct
   ↓
3. Initialize libuv event loop
   ↓
4. Create libwebsockets context (integrate with libuv)
   ↓
5. Start HTTP server on port 7681
   ↓
6. Wait for connections...
```

### Client Connection

```
1. Browser: GET http://localhost:7681/
   ↓
2. HTTP callback: Serve index.html (gzipped, embedded)
   ↓
3. Browser: Parse HTML, load xterm.js
   ↓
4. xterm.js: GET /token (fetch auth token)
   ↓
5. xterm.js: WebSocket connect ws://localhost:7681/ws
   ↓
6. LWS_CALLBACK_FILTER_PROTOCOL_CONNECTION
   ├─ Verify auth, check limits
   └─ Accept connection
   ↓
7. LWS_CALLBACK_ESTABLISHED
   ├─ Initialize pss (per-session state)
   └─ Increment client_count
   ↓
8. Client: Send JSON {AuthToken, columns, rows}
   ↓
9. LWS_CALLBACK_RECEIVE (JSON_DATA)
   └─ spawn_process(pss, columns, rows)
       ├─ build_args() / build_env()
       ├─ process_init(ctx, loop, argv, envp)
       └─ pty_spawn(process, read_cb, exit_cb)
           ├─ forkpty(&master, ..., &size)
           ├─ Child: execvp("bash", ...)
           └─ Parent: Setup pipes, start wait thread
   ↓
10. LWS_CALLBACK_SERVER_WRITEABLE
    ├─ Send SET_WINDOW_TITLE
    ├─ Send SET_PREFERENCES
    └─ Resume PTY (start reading output)
    ↓
11. Interactive session begins...
```

### Process Exit

```
1. Shell process exits (user types 'exit' or Ctrl+D)
   ↓
2. wait_cb() thread: waitpid() returns
   ├─ Capture exit code
   └─ uv_async_send(&async)
   ↓
3. Main loop: async_cb()
   └─ process->exit_cb(process)
   ↓
4. protocol.c: process_exit_cb()
   ├─ Set lws_close_status (1000 = normal, 1006 = error)
   └─ lws_callback_on_writable(pss->wsi)
   ↓
5. LWS_CALLBACK_SERVER_WRITEABLE
   └─ lws_close_reason(wsi, status)
   ↓
6. WebSocket close
   ↓
7. LWS_CALLBACK_CLOSED
   ├─ Decrement client_count
   ├─ Free resources
   └─ If --once or (--exit-no-conn && client_count == 0):
       └─ exit(0)
   ↓
8. Client: onSocketClose()
   ├─ Show overlay: "Connection Closed"
   └─ If code !== 1000:
       └─ Auto-reconnect
     Else:
       └─ Prompt to press Enter to reconnect
```

---

## Key Design Patterns

### 1. Event-Driven Architecture
- **Single event loop**: libuv handles all I/O (PTY, WebSocket, signals, timers)
- **Non-blocking I/O**: Everything async (no threads except waitpid)
- **Callback-based**: libwebsockets callbacks + libuv callbacks

### 2. Per-Session State (pss)
- libwebsockets allocates pss for each connection
- `struct pss_tty` stores all session state (process, buffers, auth)
- Passed to every callback

### 3. Context Linking
- `pty_ctx_t` links PTY process back to WebSocket session
- Stored in `process->ctx`
- Allows PTY callbacks to trigger WebSocket events

### 4. Binary Protocol
- First byte = command type
- Remaining bytes = payload
- Simple, efficient, extensible

### 5. Flow Control
- Client tracks bytes written
- Sends PAUSE when buffer full → server stops reading PTY
- Sends RESUME when drained → server resumes PTY
- Prevents memory exhaustion on slow connections

### 6. Reconnection
- Client auto-reconnects on abnormal close (code !== 1000)
- Server spawns new PTY on each connection (no session persistence)
- Could be extended with tmux/screen integration for persistence

---

## Security Features

- **Basic authentication**: Username/password (base64 encoded)
- **Auth proxy header**: Delegate to reverse proxy (nginx, etc.)
- **Origin checking**: Prevent CSRF (--check-origin)
- **SSL/TLS**: OpenSSL or mbedTLS support
- **Client certificate verification**: SSL CA validation
- **Read-only mode**: Disable client input (default unless --writable)

---

## Configuration Options

Key command-line options:

```bash
-p, --port <port>              # Port to listen (default: 7681)
-i, --interface <iface>        # Interface or UNIX socket path
-c, --credential <user:pass>   # Basic auth
-W, --writable                 # Allow client input (default: readonly)
-m, --max-clients <num>        # Max concurrent clients
-o, --once                     # Accept one client, exit on disconnect
-q, --exit-no-conn             # Exit when all clients disconnect
-w, --cwd <dir>                # Working directory for command
-t, --client-option <k=v>      # Pass option to client (JSON)
-S, --ssl                      # Enable SSL
-C, --ssl-cert <path>          # SSL certificate
-K, --ssl-key <path>           # SSL private key
```

Client options (via -t or URL query):

```bash
rendererType=webgl             # webgl, canvas, or dom
enableZmodem=true              # Enable ZMODEM file transfer
enableSixel=true               # Enable Sixel image support
disableReconnect=true          # Disable auto-reconnect
closeOnDisconnect=true         # Close window on disconnect
```

---

## Build System

### Backend (C)

```bash
mkdir build && cd build
cmake ..
make
```

Generates:
- `ttyd` binary (statically links html.h)

### Frontend (TypeScript + Preact)

```bash
cd html
yarn install
yarn run build
```

Build steps:
1. **webpack**: Bundle TypeScript → JavaScript
2. **gulp inline**: Inline CSS/JS into single HTML file
3. **gulp gzip**: Compress HTML with zlib
4. **gulp html2h**: Convert to C header (`../src/html.h`)

Result:
- `src/html.h` (16K lines) - gzipped HTML embedded as byte array

---

## Platform Support

### Unix (Linux, macOS, BSD)
- Uses `forkpty()` from `<pty.h>`, `<util.h>`, or `<libutil.h>`
- POSIX PTY interface
- Standard signals (SIGHUP, SIGTERM, etc.)

### Windows
- Uses **ConPTY** (Pseudo Console API) from Windows 10 1809+
- `CreatePseudoConsole()`, `ResizePseudoConsole()`, `ClosePseudoConsole()`
- Named pipes for I/O
- Dynamically loads kernel32.dll functions

---

## Performance Optimizations

1. **WebGL rendering**: GPU acceleration for terminal rendering
2. **Canvas fallback**: Hardware-accelerated 2D canvas
3. **Flow control**: Prevents memory exhaustion on slow connections
4. **Binary protocol**: Minimal overhead (1 byte header)
5. **Gzip compression**: Compressed HTML (embedded at compile time)
6. **Event-driven I/O**: Single-threaded, non-blocking (except waitpid)

---

## Extension Points

### Adding New Protocol Commands

1. Define command in `src/server.h`:
   ```c
   #define MY_COMMAND '4'
   ```

2. Handle in `src/protocol.c`:
   ```c
   case MY_COMMAND:
       // Handle command
       break;
   ```

3. Send from client (`html/src/components/terminal/xterm/index.ts`):
   ```typescript
   enum Command {
       MY_COMMAND = '4',
   }

   socket.send(textEncoder.encode(Command.MY_COMMAND + data));
   ```

### Adding Custom Addons

1. Implement xterm.js addon
2. Load in `applyPreferences()`:
   ```typescript
   case 'enableMyFeature':
       terminal.loadAddon(new MyAddon());
       break;
   ```

3. Pass option via command line:
   ```bash
   ttyd -t enableMyFeature=true bash
   ```

---

## Summary

**ttyd** is a beautifully simple yet powerful architecture:

- **~2000 lines of C** (server, protocol, PTY, HTTP)
- **~600 lines of TypeScript** (xterm.js wrapper, WebSocket client)
- **Single binary** (HTML embedded at compile time)
- **Zero dependencies** at runtime (statically linked)
- **Cross-platform** (Unix PTY, Windows ConPTY)
- **Production-ready** (used by cloud providers, embedded devices)

The key insight: **Minimal protocol** (1-byte commands) + **Event-driven I/O** + **Modern frontend** = Robust, scalable terminal sharing.

Perfect foundation for building terminal-based applications, web-based SSH clients, remote debugging tools, cloud shells, and more.
