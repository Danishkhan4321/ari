# Ari Electron Desktop Design

## Goal

Create an Electron desktop companion for Ari on Windows and macOS. The first working version will be tested on the current Windows computer and may use the existing Supabase database and configured third-party cloud services.

No source code, installer, release, or update will be pushed or published during this work.

## Scope

The desktop conversion will add an isolated `desktop/` workspace to the existing repository. It will reuse the current Next.js dashboard interface and Express backend instead of rewriting them.

The first version will provide:

- A native Electron window running the Ari dashboard.
- Automatic local startup of the required dashboard and backend services.
- Local-only addresses bound to the loopback interface.
- Safe shutdown of child services when Electron exits.
- Secure renderer settings and restricted navigation.
- Friendly startup and service-failure feedback.
- Windows and macOS packaging configuration.
- Automated checks plus a Windows launch smoke test.

Installer distribution, code signing, notarization, automatic updates, offline data storage, and production hosting are deferred until the desktop companion has been evaluated.

## Architecture

### Desktop workspace

The new `desktop/` workspace owns Electron-specific dependencies, commands, configuration, and tests. Keeping it separate prevents the root backend package and `dashboard/` package from acquiring conflicting entry points or lifecycle responsibilities.

The Electron main process will:

1. Start the local Express backend when dashboard features require it.
2. Start the local Next.js dashboard.
3. Wait for local health checks to succeed.
4. Create the native application window and load the local dashboard URL.
5. Stop only the processes it started when the application quits.

Development and packaged execution will use the same service-controller boundary, with environment-specific commands and file locations kept behind configuration.

### Dashboard and backend

The existing dashboard remains the renderer UI and continues to use its Next.js server routes. The existing Express application remains the local backend for capabilities that cannot be fulfilled by the dashboard alone.

Desktop mode will be explicit. When enabled, the backend will not run duplicate schedulers, queue consumers, meeting workers, webhook jobs, or other autonomous background work that could create side effects alongside an already-running deployment. Normal web behavior will remain unchanged when desktop mode is absent.

The services will bind to `127.0.0.1`, not all network interfaces. Ports will be configurable, with the initial defaults matching the existing development setup: backend `3000` and dashboard `3001`.

### Renderer security

The BrowserWindow will use:

- `contextIsolation: true`
- `nodeIntegration: false`
- Chromium sandboxing where compatible with the local application flow
- No remote module or direct filesystem access
- A minimal preload bridge only if a concrete native capability requires it
- Navigation restricted to the expected local dashboard origin
- External HTTP and HTTPS links opened in the operating system browser
- Permission requests denied unless an Ari feature explicitly requires and handles one

Secrets will remain in local server-process environment variables. They will not be copied into renderer code, preload globals, or client-exposed Next.js variables.

## Data flow

```text
Electron window
    -> local Next.js dashboard (127.0.0.1)
        -> Next.js API routes and server components
            -> existing Supabase database and configured cloud services
            -> local Express backend when required
                -> existing Supabase database and configured cloud services
```

No request will intentionally use a hosted dashboard or API address. Desktop startup will override local base URLs so that internal dashboard-to-backend traffic remains on the computer.

## Startup, errors, and shutdown

The window will initially show a small local startup page while services initialize. The controller will capture service exit codes and readiness timeouts without exposing environment values or secrets.

If startup fails, the user will see which local service failed and can retry or quit. Unexpected navigation will be blocked. A backend failure after launch will not crash Electron; the existing dashboard error handling will remain visible and diagnostic information will be written to a local desktop log.

On quit, Electron will gracefully terminate the child processes it created and then force-close only those children if they do not exit within a short timeout. It will not terminate unrelated Node.js processes.

## Packaging

The desktop workspace will configure:

- Windows x64 packaging and an installer target suitable for local testing.
- macOS Apple Silicon and Intel targets, with universal packaging considered later if required.
- Product name, application identifier, icons, bundled service files, and output directories kept within the desktop workspace.

The current Windows computer can validate development startup and Windows packaging. A real macOS artifact must be built and tested on macOS later. Signing, notarization, and public distribution are not part of this local phase.

## Testing

Verification will cover:

- Desktop configuration and service-controller unit tests.
- Readiness success, readiness timeout, early process exit, and graceful shutdown.
- Navigation allow-list and external-link behavior.
- Confirmation that desktop mode disables autonomous backend jobs without changing normal mode.
- Existing dashboard type-check and relevant tests.
- Existing backend tests affected by the desktop-mode boundary.
- A Windows development-launch smoke test.
- A Windows packaged-build check if the current application state permits it.

macOS packaging configuration will be inspected locally, but execution testing is deferred until a Mac is available.

## Repository safety

The repository already has many uncommitted user changes. Desktop work will avoid overwriting or reverting them, and changes to existing files will be limited to the smallest integration points needed for desktop mode.

No GitHub push, deployment, release creation, or hosted update is authorized.

## Success criteria

The local phase is successful when:

1. One local command starts Ari in an Electron window on Windows.
2. The window loads only the locally served dashboard.
3. Existing configured data and cloud integrations remain available through local server processes.
4. Closing Electron stops only its managed local services.
5. Desktop mode avoids duplicate autonomous jobs.
6. Windows and macOS packaging targets are defined, with Windows validated on the current computer.
7. No source or artifact is pushed, deployed, or published.
