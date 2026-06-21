use std::{
    fs,
    path::PathBuf,
    sync::{
        mpsc::{self, Receiver, Sender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use std::os::raw::{c_char, c_int, c_void};

use crate::paths::lmp_data_dir;

pub fn runtime_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["mpv-2.dll", "libmpv-2.dll", "libmpv.dll"]
    } else if cfg!(target_os = "macos") {
        &["libmpv.2.dylib", "libmpv.dylib"]
    } else {
        &["libmpv.so.2", "libmpv.so"]
    }
}

pub(crate) fn trace_libmpv_event(phase: &str, detail: &str) {
    if !cfg!(debug_assertions) {
        return;
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    let pid = std::process::id();
    let line = format!(
        "{timestamp} phase=libmpv-{phase} pid={pid} {}\n",
        compact_log_value(detail)
    );

    if let Ok(log_dir) = lmp_data_dir().map(|dir| dir.join("logs")) {
        let _ = fs::create_dir_all(&log_dir);
        if let Ok(mut file) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("routing.log"))
        {
            use std::io::Write;
            let _ = file.write_all(line.as_bytes());
        }
    }
}

fn compact_log_value(value: &str) -> String {
    value
        .replace('\r', " ")
        .replace('\n', " ")
        .replace('"', "'")
}

#[derive(Clone, Debug, Default)]
pub struct SessionSnapshot {
    pub active: bool,
    pub path: String,
    pub started_at: u64,
    pub ready: bool,
    pub paused: bool,
    pub position: f64,
    pub duration: f64,
    pub width: f64,
    pub height: f64,
    pub volume: f64,
    pub speed: f64,
    pub ended: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct RenderApiProbe {
    pub symbols_loaded: bool,
    pub software_context: bool,
    pub opengl_symbols: bool,
    pub summary: String,
}

#[derive(Clone, Debug, Default)]
pub struct RenderFrameProbe {
    pub width: i32,
    pub height: i32,
    pub stride: usize,
    pub touched_bytes: usize,
    pub elapsed_ms: u128,
    pub summary: String,
}

pub struct PlaybackOptions {
    pub path: PathBuf,
    pub start_seconds: Option<f64>,
    pub volume: f64,
    pub speed: f64,
    pub started_at: u64,
    pub output: PlaybackOutput,
    pub autoplay: bool,
}

#[derive(Clone, Copy, Debug)]
pub enum PlaybackOutput {
    HeadlessCore,
    NativeSurface { hwnd: usize },
}

pub struct PlaybackSession {
    commands: Sender<SessionCommand>,
    snapshot: Arc<Mutex<SessionSnapshot>>,
    worker: Option<JoinHandle<()>>,
}

impl PlaybackSession {
    pub fn start(runtime_path: PathBuf, options: PlaybackOptions) -> Result<Self, String> {
        let path = options.path.display().to_string();
        let snapshot = Arc::new(Mutex::new(SessionSnapshot {
            active: true,
            path,
            started_at: options.started_at,
            paused: true,
            volume: options.volume,
            speed: options.speed,
            ..SessionSnapshot::default()
        }));

        let (commands, command_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker_snapshot = Arc::clone(&snapshot);
        let worker = thread::spawn(move || {
            platform::run_playback(runtime_path, options, command_rx, worker_snapshot, ready_tx);
        });

        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Self {
                commands,
                snapshot,
                worker: Some(worker),
            }),
            Ok(Err(error)) => {
                let _ = worker.join();
                Err(error)
            }
            Err(_) => {
                let _ = commands.send(SessionCommand::Stop);
                let _ = worker.join();
                Err("Embedded MPV core did not finish startup in time.".to_string())
            }
        }
    }

    pub fn snapshot(&self) -> SessionSnapshot {
        self.snapshot
            .lock()
            .map(|snapshot| snapshot.clone())
            .unwrap_or_default()
    }

    pub fn pause(&self, paused: bool) -> Result<(), String> {
        self.send(SessionCommand::Pause(paused))
    }

    pub fn seek(&self, seconds: f64) -> Result<(), String> {
        if !seconds.is_finite() || seconds < 0.0 {
            return Err("Seek target is not valid.".to_string());
        }
        self.send(SessionCommand::Seek(seconds))
    }

    pub fn set_volume(&self, volume: f64) -> Result<(), String> {
        if !volume.is_finite() {
            return Err("Volume is not valid.".to_string());
        }
        self.send(SessionCommand::Volume(volume.clamp(0.0, 100.0)))
    }

    pub fn set_speed(&self, speed: f64) -> Result<(), String> {
        if !speed.is_finite() || speed <= 0.0 {
            return Err("Speed is not valid.".to_string());
        }
        self.send(SessionCommand::Speed(speed.clamp(0.25, 4.0)))
    }

    fn send(&self, command: SessionCommand) -> Result<(), String> {
        self.commands
            .send(command)
            .map_err(|_| "Embedded MPV core is no longer running.".to_string())
    }
}

impl Drop for PlaybackSession {
    fn drop(&mut self) {
        let _ = self.commands.send(SessionCommand::Stop);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub struct RenderPlaybackSession {
    commands: Sender<SessionCommand>,
    snapshot: Arc<Mutex<SessionSnapshot>>,
    worker: Option<JoinHandle<()>>,
}

impl RenderPlaybackSession {
    pub fn start(runtime_path: PathBuf, options: PlaybackOptions) -> Result<Self, String> {
        let path = options.path.display().to_string();
        let snapshot = Arc::new(Mutex::new(SessionSnapshot {
            active: true,
            path,
            started_at: options.started_at,
            paused: !options.autoplay,
            volume: options.volume,
            speed: options.speed,
            ..SessionSnapshot::default()
        }));

        let (commands, command_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker_snapshot = Arc::clone(&snapshot);
        let worker = thread::spawn(move || {
            platform::run_render_playback(
                runtime_path,
                options,
                command_rx,
                worker_snapshot,
                ready_tx,
            );
        });

        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Self {
                commands,
                snapshot,
                worker: Some(worker),
            }),
            Ok(Err(error)) => {
                let _ = worker.join();
                Err(error)
            }
            Err(_) => {
                let _ = commands.send(SessionCommand::Stop);
                let _ = worker.join();
                Err("Embedded MPV renderer did not finish startup in time.".to_string())
            }
        }
    }

    pub fn snapshot(&self) -> SessionSnapshot {
        self.snapshot
            .lock()
            .map(|snapshot| snapshot.clone())
            .unwrap_or_default()
    }

    pub fn pause(&self, paused: bool) -> Result<(), String> {
        self.send(SessionCommand::Pause(paused))
    }

    pub fn seek(&self, seconds: f64) -> Result<(), String> {
        if !seconds.is_finite() || seconds < 0.0 {
            return Err("Seek target is not valid.".to_string());
        }
        self.send(SessionCommand::Seek(seconds))
    }

    pub fn set_volume(&self, volume: f64) -> Result<(), String> {
        if !volume.is_finite() {
            return Err("Volume is not valid.".to_string());
        }
        self.send(SessionCommand::Volume(volume.clamp(0.0, 100.0)))
    }

    pub fn set_speed(&self, speed: f64) -> Result<(), String> {
        if !speed.is_finite() || speed <= 0.0 {
            return Err("Speed is not valid.".to_string());
        }
        self.send(SessionCommand::Speed(speed.clamp(0.25, 4.0)))
    }

    fn send(&self, command: SessionCommand) -> Result<(), String> {
        self.commands
            .send(command)
            .map_err(|_| "Embedded MPV renderer is no longer running.".to_string())
    }
}

impl Drop for RenderPlaybackSession {
    fn drop(&mut self) {
        let _ = self.commands.send(SessionCommand::Stop);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

enum SessionCommand {
    Stop,
    Pause(bool),
    Seek(f64),
    Volume(f64),
    Speed(f64),
}

#[cfg(windows)]
mod platform {
    use super::{
        c_char, c_int, c_void, mpsc, trace_libmpv_event, Arc, Duration, Instant, Mutex,
        PlaybackOptions, PlaybackOutput, Receiver, RenderApiProbe, RenderFrameProbe, Sender,
        SessionCommand, SessionSnapshot,
    };
    use std::{
        ffi::{CStr, CString},
        path::{Path, PathBuf},
        ptr,
    };

    use windows_sys::Win32::{
        Foundation::{FreeLibrary, HMODULE, HWND, RECT},
        Graphics::{
            Gdi::{GetDC, ReleaseDC, HDC},
            OpenGL::{
                glClear, glClearColor, glViewport, wglCreateContext, wglDeleteContext,
                wglGetProcAddress, wglMakeCurrent, ChoosePixelFormat, SetPixelFormat, SwapBuffers,
                GL_COLOR_BUFFER_BIT, HGLRC, PFD_DOUBLEBUFFER, PFD_DRAW_TO_WINDOW, PFD_MAIN_PLANE,
                PFD_SUPPORT_OPENGL, PFD_TYPE_RGBA, PIXELFORMATDESCRIPTOR,
            },
        },
        System::LibraryLoader::{GetModuleHandleW, GetProcAddress, LoadLibraryW},
        UI::WindowsAndMessaging::GetClientRect,
    };

    const MPV_FORMAT_FLAG: c_int = 3;
    const MPV_FORMAT_DOUBLE: c_int = 5;

    const MPV_RENDER_PARAM_INVALID: c_int = 0;
    const MPV_RENDER_PARAM_API_TYPE: c_int = 1;
    const MPV_RENDER_PARAM_OPENGL_INIT_PARAMS: c_int = 2;
    const MPV_RENDER_PARAM_OPENGL_FBO: c_int = 3;
    const MPV_RENDER_PARAM_FLIP_Y: c_int = 4;
    const MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME: c_int = 12;
    const MPV_RENDER_PARAM_SW_SIZE: c_int = 17;
    const MPV_RENDER_PARAM_SW_FORMAT: c_int = 18;
    const MPV_RENDER_PARAM_SW_STRIDE: c_int = 19;
    const MPV_RENDER_PARAM_SW_POINTER: c_int = 20;

    const MPV_RENDER_UPDATE_FRAME: u64 = 1;

    const MPV_EVENT_NONE: c_int = 0;
    const MPV_EVENT_SHUTDOWN: c_int = 1;
    const MPV_EVENT_END_FILE: c_int = 7;
    const MPV_EVENT_FILE_LOADED: c_int = 8;
    const MPV_EVENT_PLAYBACK_RESTART: c_int = 21;

    type MpvClientApiVersion = unsafe extern "C" fn() -> u64;
    type MpvCreate = unsafe extern "C" fn() -> *mut c_void;
    type MpvInitialize = unsafe extern "C" fn(*mut c_void) -> c_int;
    type MpvTerminateDestroy = unsafe extern "C" fn(*mut c_void);
    type MpvSetOptionString =
        unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int;
    type MpvCommand = unsafe extern "C" fn(*mut c_void, *const *const c_char) -> c_int;
    type MpvSetProperty =
        unsafe extern "C" fn(*mut c_void, *const c_char, c_int, *mut c_void) -> c_int;
    type MpvGetProperty =
        unsafe extern "C" fn(*mut c_void, *const c_char, c_int, *mut c_void) -> c_int;
    type MpvWaitEvent = unsafe extern "C" fn(*mut c_void, f64) -> *mut MpvEvent;
    type MpvWakeup = unsafe extern "C" fn(*mut c_void);
    type MpvErrorString = unsafe extern "C" fn(c_int) -> *const c_char;
    type MpvRenderContextCreate =
        unsafe extern "C" fn(*mut *mut c_void, *mut c_void, *mut MpvRenderParam) -> c_int;
    type MpvRenderContextFree = unsafe extern "C" fn(*mut c_void);
    type MpvRenderContextSetUpdateCallback =
        unsafe extern "C" fn(*mut c_void, Option<unsafe extern "C" fn(*mut c_void)>, *mut c_void);
    type MpvRenderContextUpdate = unsafe extern "C" fn(*mut c_void) -> u64;
    type MpvRenderContextRender = unsafe extern "C" fn(*mut c_void, *mut MpvRenderParam) -> c_int;

    #[repr(C)]
    struct MpvEvent {
        event_id: c_int,
        error: c_int,
        reply_userdata: u64,
        data: *mut c_void,
    }

    #[repr(C)]
    struct MpvRenderParam {
        param_type: c_int,
        data: *mut c_void,
    }

    #[repr(C)]
    struct MpvOpenGlInitParams {
        get_proc_address: Option<unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void>,
        get_proc_address_ctx: *mut c_void,
    }

    #[repr(C)]
    struct MpvOpenGlFbo {
        fbo: c_int,
        w: c_int,
        h: c_int,
        internal_format: c_int,
    }

    pub fn validate(path: &Path) -> Result<String, String> {
        let mut core = MpvCore::new(path)?;
        core.set_option_string("config", "no")?;
        core.initialize()?;
        Ok(core.api.version_label.clone())
    }

    pub fn probe_render_api(path: &Path) -> Result<RenderApiProbe, String> {
        let mut core = MpvCore::new(path)?;
        core.set_option_string("config", "no")?;
        core.set_option_string("terminal", "no")?;
        core.set_option_string("idle", "yes")?;
        core.initialize()?;

        let context = MpvRenderContext::software(&core)?;
        let _ = context.update();

        Ok(RenderApiProbe {
            symbols_loaded: true,
            software_context: true,
            opengl_symbols: true,
            summary: "Render API ready; software context OK; OpenGL needs a native surface."
                .to_string(),
        })
    }

    pub fn probe_render_frame(
        runtime_path: &Path,
        media_path: &Path,
    ) -> Result<RenderFrameProbe, String> {
        let started = Instant::now();
        let mut core = MpvCore::new(runtime_path)?;
        configure_render_probe_core(&mut core)?;
        core.initialize()?;
        let context = MpvRenderContext::software(&core)?;
        core.load_file(media_path)?;

        let width = 320;
        let height = 180;
        let stride = (width as usize) * 4;
        let mut buffer = vec![0x4d; stride * height as usize];
        let format = c_string("bgr0")?;
        let mut size = [width, height];
        let mut stride_param = stride;
        let mut block_for_target_time: c_int = 0;
        let timeout = Duration::from_secs(5);

        while started.elapsed() < timeout {
            drain_probe_events(&mut core)?;
            let update = context.update();
            if update & MPV_RENDER_UPDATE_FRAME != 0 {
                let mut params = [
                    MpvRenderParam {
                        param_type: MPV_RENDER_PARAM_SW_SIZE,
                        data: size.as_mut_ptr().cast(),
                    },
                    MpvRenderParam {
                        param_type: MPV_RENDER_PARAM_SW_FORMAT,
                        data: format.as_ptr() as *mut c_void,
                    },
                    MpvRenderParam {
                        param_type: MPV_RENDER_PARAM_SW_STRIDE,
                        data: (&mut stride_param as *mut usize).cast(),
                    },
                    MpvRenderParam {
                        param_type: MPV_RENDER_PARAM_SW_POINTER,
                        data: buffer.as_mut_ptr().cast(),
                    },
                    MpvRenderParam {
                        param_type: MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME,
                        data: (&mut block_for_target_time as *mut c_int).cast(),
                    },
                    MpvRenderParam {
                        param_type: MPV_RENDER_PARAM_INVALID,
                        data: ptr::null_mut(),
                    },
                ];
                let result =
                    unsafe { (core.api.render.render)(context.handle, params.as_mut_ptr()) };
                if result < 0 {
                    return Err(core.error_message(result));
                }
                let touched_bytes = buffer.iter().filter(|byte| **byte != 0x4d).count();
                if touched_bytes == 0 {
                    return Err("Render API produced an unchanged frame buffer.".to_string());
                }
                let elapsed_ms = started.elapsed().as_millis();
                return Ok(RenderFrameProbe {
                    width,
                    height,
                    stride,
                    touched_bytes,
                    elapsed_ms,
                    summary: format!(
                        "Rendered one software probe frame at {width}x{height} in {elapsed_ms} ms."
                    ),
                });
            }
            std::thread::sleep(Duration::from_millis(20));
        }

        Err("Timed out waiting for a renderable MPV frame.".to_string())
    }

    pub fn run_playback(
        runtime_path: PathBuf,
        options: PlaybackOptions,
        commands: Receiver<SessionCommand>,
        snapshot: Arc<Mutex<SessionSnapshot>>,
        ready: Sender<Result<(), String>>,
    ) {
        trace_libmpv_event(
            "core-run-begin",
            &format!(
                "output={:?} path=\"{}\" start={:?} autoplay={}",
                options.output,
                options.path.display(),
                options.start_seconds,
                options.autoplay
            ),
        );
        let mut core = match start_core(&runtime_path, &options) {
            Ok(core) => core,
            Err(error) => {
                trace_libmpv_event("core-run-fail", &format!("error=\"{error}\""));
                let _ = ready.send(Err(error));
                mark_stopped(&snapshot);
                return;
            }
        };
        mark_ready(&snapshot, false);

        let mut last_poll = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .unwrap_or_else(Instant::now);
        let mut should_stop = false;

        while !should_stop {
            loop {
                match commands.try_recv() {
                    Ok(command) => match handle_command(&mut core, &snapshot, command) {
                        Ok(true) => {
                            should_stop = true;
                            break;
                        }
                        Ok(false) => {}
                        Err(error) => {
                            set_error(&snapshot, error);
                        }
                    },
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        should_stop = true;
                        break;
                    }
                }
            }

            if let Err(error) = drain_events(&mut core, &snapshot, &mut should_stop) {
                set_error(&snapshot, error);
            }
            if last_poll.elapsed() >= Duration::from_millis(180) {
                poll_properties(&mut core, &snapshot);
                last_poll = Instant::now();
            }

            if should_stop {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }

        let _ = core.command(&["stop"]);
        mark_stopped(&snapshot);
    }

    pub fn run_render_playback(
        runtime_path: PathBuf,
        options: PlaybackOptions,
        commands: Receiver<SessionCommand>,
        snapshot: Arc<Mutex<SessionSnapshot>>,
        ready: Sender<Result<(), String>>,
    ) {
        trace_libmpv_event(
            "render-run-begin",
            &format!(
                "path=\"{}\" start={:?} autoplay={}",
                options.path.display(),
                options.start_seconds,
                options.autoplay
            ),
        );
        let hwnd = match options.output {
            PlaybackOutput::NativeSurface { hwnd } => hwnd as HWND,
            PlaybackOutput::HeadlessCore => {
                let _ = ready.send(Err(
                    "Embedded MPV renderer needs a native video surface.".to_string()
                ));
                mark_stopped(&snapshot);
                return;
            }
        };

        let mut core = match start_render_core(&runtime_path, &options) {
            Ok(core) => core,
            Err(error) => {
                trace_libmpv_event("render-start-core-fail", &format!("error=\"{error}\""));
                let _ = ready.send(Err(error));
                mark_stopped(&snapshot);
                return;
            }
        };

        let gl_surface = match OpenGlSurface::new(hwnd) {
            Ok(surface) => surface,
            Err(error) => {
                trace_libmpv_event("render-opengl-surface-fail", &format!("error=\"{error}\""));
                let _ = ready.send(Err(error));
                mark_stopped(&snapshot);
                return;
            }
        };

        let render_context = match MpvRenderContext::opengl(&core) {
            Ok(context) => context,
            Err(error) => {
                trace_libmpv_event("render-context-fail", &format!("error=\"{error}\""));
                let _ = ready.send(Err(error));
                mark_stopped(&snapshot);
                return;
            }
        };

        if let Err(error) = core.load_file(&options.path) {
            trace_libmpv_event("render-loadfile-fail", &format!("error=\"{error}\""));
            let _ = ready.send(Err(error));
            mark_stopped(&snapshot);
            return;
        }
        if let Err(error) = core.set_property_flag("pause", !options.autoplay) {
            trace_libmpv_event("render-pause-fail", &format!("error=\"{error}\""));
            let _ = ready.send(Err(error));
            mark_stopped(&snapshot);
            return;
        }

        let _ = ready.send(Ok(()));
        mark_ready(&snapshot, false);

        let mut last_poll = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .unwrap_or_else(Instant::now);
        let mut last_render = Instant::now()
            .checked_sub(Duration::from_millis(33))
            .unwrap_or_else(Instant::now);
        let mut render_attempts: u64 = 0;
        let mut render_successes: u64 = 0;
        let mut ready_sent = false;
        let mut should_stop = false;

        while !should_stop {
            loop {
                match commands.try_recv() {
                    Ok(command) => match handle_command(&mut core, &snapshot, command) {
                        Ok(true) => {
                            should_stop = true;
                            break;
                        }
                        Ok(false) => {}
                        Err(error) => set_error(&snapshot, error),
                    },
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        should_stop = true;
                        break;
                    }
                }
            }

            if let Err(error) = drain_events(&mut core, &snapshot, &mut should_stop) {
                set_error(&snapshot, error);
            }

            let update = render_context.update();
            let frame_available = update & MPV_RENDER_UPDATE_FRAME != 0;
            if frame_available || last_render.elapsed() >= Duration::from_millis(33) {
                render_attempts += 1;
                match render_opengl_frame(&core, &render_context, &gl_surface) {
                    Ok((width, height)) => {
                        render_successes += 1;
                        if !ready_sent && frame_available && render_session_ready(&snapshot) {
                            let _ = ready.send(Ok(()));
                            ready_sent = true;
                            trace_libmpv_event(
                                "render-ready",
                                &format!(
                                    "attempt={render_attempts} success={render_successes} size={width}x{height}"
                                ),
                            );
                        }
                        if render_attempts <= 12 || render_attempts % 120 == 0 {
                            trace_libmpv_event(
                                "render-frame-ok",
                                &format!(
                                    "attempt={render_attempts} success={render_successes} frameAvailable={frame_available} update={update} size={width}x{height}"
                                ),
                            );
                        }
                    }
                    Err(error) => {
                        trace_libmpv_event(
                            "render-frame-fail",
                            &format!(
                                "attempt={render_attempts} frameAvailable={frame_available} update={update} error=\"{error}\""
                            ),
                        );
                        set_error(&snapshot, error);
                    }
                }
                last_render = Instant::now();
            }

            if last_poll.elapsed() >= Duration::from_millis(180) {
                poll_properties(&mut core, &snapshot);
                last_poll = Instant::now();
            }

            if should_stop {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        if !ready_sent {
            let message = snapshot
                .lock()
                .ok()
                .and_then(|snapshot| snapshot.error.clone())
                .unwrap_or_else(|| {
                    "Embedded MPV renderer stopped before playback became ready.".to_string()
                });
            let _ = ready.send(Err(message));
        }

        let _ = core.command(&["stop"]);
        mark_stopped(&snapshot);
    }

    fn start_core(runtime_path: &Path, options: &PlaybackOptions) -> Result<MpvCore, String> {
        trace_libmpv_event(
            "core-start",
            &format!(
                "runtime=\"{}\" output={:?}",
                runtime_path.display(),
                options.output
            ),
        );
        let mut core = MpvCore::new(runtime_path)?;
        match options.output {
            PlaybackOutput::HeadlessCore => configure_core(&mut core)?,
            PlaybackOutput::NativeSurface { hwnd } => {
                configure_native_surface_core(&mut core, hwnd)?
            }
        }
        configure_start_position(&mut core, options.start_seconds)?;
        core.initialize()?;
        core.set_property_double("volume", options.volume.clamp(0.0, 100.0))?;
        core.set_property_double("speed", options.speed.clamp(0.25, 4.0))?;
        core.load_file(&options.path)?;
        core.set_property_flag("pause", !options.autoplay)?;
        Ok(core)
    }

    fn start_render_core(
        runtime_path: &Path,
        options: &PlaybackOptions,
    ) -> Result<MpvCore, String> {
        trace_libmpv_event(
            "render-start",
            &format!("runtime=\"{}\"", runtime_path.display()),
        );
        let mut core = MpvCore::new(runtime_path)?;
        configure_render_core(&mut core)?;
        configure_start_position(&mut core, options.start_seconds)?;
        core.initialize()?;
        core.set_property_double("volume", options.volume.clamp(0.0, 100.0))?;
        core.set_property_double("speed", options.speed.clamp(0.25, 4.0))?;
        Ok(core)
    }

    fn configure_core(core: &mut MpvCore) -> Result<(), String> {
        for (name, value) in [
            ("config", "no"),
            ("terminal", "no"),
            ("input-default-bindings", "no"),
            ("input-vo-keyboard", "no"),
            ("idle", "yes"),
            ("keep-open", "no"),
            ("osc", "no"),
            ("osd-level", "0"),
            ("msg-level", "all=no"),
            ("hwdec", "auto-safe"),
            ("pause", "yes"),
            ("ao", "null"),
            ("video", "no"),
        ] {
            core.set_option_string(name, value)?;
        }
        Ok(())
    }

    fn configure_start_position(
        core: &mut MpvCore,
        start_seconds: Option<f64>,
    ) -> Result<(), String> {
        if let Some(start_seconds) = start_seconds.filter(|value| value.is_finite() && *value > 0.5)
        {
            core.set_option_string("start", &format!("{start_seconds:.3}"))?;
        }
        Ok(())
    }

    fn configure_native_surface_core(core: &mut MpvCore, hwnd: usize) -> Result<(), String> {
        let hwnd = hwnd.to_string();
        for (name, value) in [
            ("config", "no"),
            ("terminal", "no"),
            ("input-default-bindings", "no"),
            ("input-vo-keyboard", "no"),
            ("idle", "yes"),
            ("keep-open", "no"),
            ("osc", "no"),
            ("osd-level", "0"),
            ("msg-level", "all=no"),
            ("hwdec", "auto-safe"),
            ("pause", "yes"),
            ("wid", hwnd.as_str()),
            ("vo", "gpu-next,gpu"),
            ("force-window", "yes"),
        ] {
            core.set_option_string(name, value)?;
        }
        Ok(())
    }

    fn configure_render_core(core: &mut MpvCore) -> Result<(), String> {
        for (name, value) in [
            ("config", "no"),
            ("terminal", "no"),
            ("input-default-bindings", "no"),
            ("input-vo-keyboard", "no"),
            ("idle", "yes"),
            ("keep-open", "no"),
            ("osc", "no"),
            ("osd-level", "0"),
            ("msg-level", "all=no"),
            ("hwdec", "no"),
            ("vo", "libmpv"),
            ("force-window", "no"),
            ("pause", "yes"),
        ] {
            core.set_option_string(name, value)?;
        }
        Ok(())
    }

    fn render_opengl_frame(
        core: &MpvCore,
        context: &MpvRenderContext,
        surface: &OpenGlSurface,
    ) -> Result<(c_int, c_int), String> {
        surface.make_current()?;
        let (width, height) = surface.client_size()?;
        if width <= 0 || height <= 0 {
            return Ok((width, height));
        }

        unsafe {
            glViewport(0, 0, width, height);
            glClearColor(0.0, 0.0, 0.0, 1.0);
            glClear(GL_COLOR_BUFFER_BIT);
        }

        let mut fbo = MpvOpenGlFbo {
            fbo: 0,
            w: width,
            h: height,
            internal_format: 0,
        };
        let mut flip_y: c_int = 1;
        let mut block_for_target_time: c_int = 1;
        let mut params = [
            MpvRenderParam {
                param_type: MPV_RENDER_PARAM_OPENGL_FBO,
                data: (&mut fbo as *mut MpvOpenGlFbo).cast(),
            },
            MpvRenderParam {
                param_type: MPV_RENDER_PARAM_FLIP_Y,
                data: (&mut flip_y as *mut c_int).cast(),
            },
            MpvRenderParam {
                param_type: MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME,
                data: (&mut block_for_target_time as *mut c_int).cast(),
            },
            MpvRenderParam {
                param_type: MPV_RENDER_PARAM_INVALID,
                data: ptr::null_mut(),
            },
        ];

        let result = unsafe { (core.api.render.render)(context.handle, params.as_mut_ptr()) };
        if result < 0 {
            return Err(core.error_message(result));
        }
        surface.swap_buffers()?;
        Ok((width, height))
    }

    fn configure_render_probe_core(core: &mut MpvCore) -> Result<(), String> {
        for (name, value) in [
            ("config", "no"),
            ("terminal", "no"),
            ("input-default-bindings", "no"),
            ("input-vo-keyboard", "no"),
            ("idle", "yes"),
            ("keep-open", "no"),
            ("osc", "no"),
            ("osd-level", "0"),
            ("msg-level", "all=no"),
            ("pause", "yes"),
            ("ao", "null"),
            ("hwdec", "no"),
            ("untimed", "yes"),
        ] {
            core.set_option_string(name, value)?;
        }
        Ok(())
    }

    fn handle_command(
        core: &mut MpvCore,
        snapshot: &Arc<Mutex<SessionSnapshot>>,
        command: SessionCommand,
    ) -> Result<bool, String> {
        match command {
            SessionCommand::Stop => Ok(true),
            SessionCommand::Pause(paused) => {
                core.set_property_flag("pause", paused)?;
                if let Ok(mut snapshot) = snapshot.lock() {
                    snapshot.paused = paused;
                }
                Ok(false)
            }
            SessionCommand::Seek(seconds) => {
                core.command(&["seek", &format!("{seconds:.3}"), "absolute", "exact"])?;
                if let Ok(mut snapshot) = snapshot.lock() {
                    snapshot.position = seconds;
                }
                Ok(false)
            }
            SessionCommand::Volume(volume) => {
                core.set_property_double("volume", volume)?;
                if let Ok(mut snapshot) = snapshot.lock() {
                    snapshot.volume = volume;
                }
                Ok(false)
            }
            SessionCommand::Speed(speed) => {
                core.set_property_double("speed", speed)?;
                if let Ok(mut snapshot) = snapshot.lock() {
                    snapshot.speed = speed;
                }
                Ok(false)
            }
        }
    }

    fn drain_events(
        core: &mut MpvCore,
        snapshot: &Arc<Mutex<SessionSnapshot>>,
        should_stop: &mut bool,
    ) -> Result<(), String> {
        loop {
            let Some(event) = core.wait_event(0.0) else {
                break;
            };

            match event.event_id {
                MPV_EVENT_NONE => break,
                MPV_EVENT_SHUTDOWN => {
                    *should_stop = true;
                    break;
                }
                MPV_EVENT_FILE_LOADED | MPV_EVENT_PLAYBACK_RESTART => {
                    mark_ready(snapshot, true);
                }
                MPV_EVENT_END_FILE => {
                    if let Ok(mut snapshot) = snapshot.lock() {
                        snapshot.ended = true;
                    }
                    *should_stop = true;
                    break;
                }
                _ => {
                    if event.error < 0 {
                        set_error(snapshot, core.error_message(event.error));
                    }
                }
            }
        }

        Ok(())
    }

    fn drain_probe_events(core: &mut MpvCore) -> Result<(), String> {
        loop {
            let Some(event) = core.wait_event(0.0) else {
                break;
            };

            match event.event_id {
                MPV_EVENT_NONE => break,
                MPV_EVENT_SHUTDOWN => {
                    return Err("MPV shut down before a frame could be rendered.".to_string());
                }
                _ => {
                    if event.error < 0 {
                        return Err(core.error_message(event.error));
                    }
                }
            }
        }

        Ok(())
    }

    fn poll_properties(core: &mut MpvCore, snapshot: &Arc<Mutex<SessionSnapshot>>) {
        let position = core.get_property_double("time-pos").ok();
        let duration = core.get_property_double("duration").ok();
        let width = core
            .get_property_double("width")
            .or_else(|_| core.get_property_double("dwidth"))
            .ok();
        let height = core
            .get_property_double("height")
            .or_else(|_| core.get_property_double("dheight"))
            .ok();
        let paused = core.get_property_flag("pause").ok();
        let volume = core.get_property_double("volume").ok();
        let speed = core.get_property_double("speed").ok();

        if let Ok(mut snapshot) = snapshot.lock() {
            if let Some(position) = position.filter(|value| value.is_finite()) {
                snapshot.position = position.max(0.0);
            }
            if let Some(duration) = duration.filter(|value| value.is_finite()) {
                snapshot.duration = duration.max(0.0);
            }
            if let Some(width) = width.filter(|value| value.is_finite() && *value > 0.0) {
                snapshot.width = width;
            }
            if let Some(height) = height.filter(|value| value.is_finite() && *value > 0.0) {
                snapshot.height = height;
            }
            if let Some(paused) = paused {
                snapshot.paused = paused;
            }
            if let Some(volume) = volume.filter(|value| value.is_finite()) {
                snapshot.volume = volume;
            }
            if let Some(speed) = speed.filter(|value| value.is_finite()) {
                snapshot.speed = speed;
            }
        }
    }

    fn mark_ready(snapshot: &Arc<Mutex<SessionSnapshot>>, ready: bool) {
        if let Ok(mut snapshot) = snapshot.lock() {
            snapshot.ready = ready;
        }
    }

    fn render_session_ready(snapshot: &Arc<Mutex<SessionSnapshot>>) -> bool {
        snapshot
            .lock()
            .map(|snapshot| snapshot.ready && snapshot.error.is_none())
            .unwrap_or(false)
    }

    fn mark_stopped(snapshot: &Arc<Mutex<SessionSnapshot>>) {
        if let Ok(mut snapshot) = snapshot.lock() {
            snapshot.active = false;
        }
    }

    fn set_error(snapshot: &Arc<Mutex<SessionSnapshot>>, error: String) {
        if let Ok(mut snapshot) = snapshot.lock() {
            snapshot.error = Some(error);
        }
    }

    struct MpvCore {
        api: MpvApi,
        handle: *mut c_void,
        initialized: bool,
    }

    impl MpvCore {
        fn new(path: &Path) -> Result<Self, String> {
            let api = MpvApi::load(path)?;
            let handle = unsafe { (api.create)() };
            if handle.is_null() {
                return Err("mpv_create returned no handle".to_string());
            }
            Ok(Self {
                api,
                handle,
                initialized: false,
            })
        }

        fn initialize(&mut self) -> Result<(), String> {
            let result = unsafe { (self.api.initialize)(self.handle) };
            if result < 0 {
                return Err(self.error_message(result));
            }
            self.initialized = true;
            Ok(())
        }

        fn set_option_string(&mut self, name: &str, value: &str) -> Result<(), String> {
            let raw_name = name;
            let raw_value = value;
            let name = c_string(raw_name)?;
            let value = c_string(raw_value)?;
            let result = self.check(unsafe {
                (self.api.set_option_string)(self.handle, name.as_ptr(), value.as_ptr())
            });
            match result {
                Ok(()) => {
                    trace_libmpv_event(
                        "option-ok",
                        &format!("name={raw_name} value=\"{raw_value}\""),
                    );
                    Ok(())
                }
                Err(error) => {
                    trace_libmpv_event(
                        "option-fail",
                        &format!("name={raw_name} value=\"{raw_value}\" error=\"{error}\""),
                    );
                    Err(format!("mpv option {raw_name}={raw_value} failed: {error}"))
                }
            }
        }

        fn command(&mut self, args: &[&str]) -> Result<(), String> {
            let command = CommandArgs::new(args)?;
            let label = args.join(" ");
            let result = self.check(unsafe { (self.api.command)(self.handle, command.as_ptr()) });
            match result {
                Ok(()) => {
                    trace_libmpv_event("command-ok", &format!("command=\"{label}\""));
                    Ok(())
                }
                Err(error) => {
                    trace_libmpv_event(
                        "command-fail",
                        &format!("command=\"{label}\" error=\"{error}\""),
                    );
                    Err(format!("mpv command {label} failed: {error}"))
                }
            }
        }

        fn load_file(&mut self, path: &Path) -> Result<(), String> {
            let path = path.display().to_string();
            self.command(&["loadfile", &path, "replace"])
        }

        fn set_property_flag(&mut self, name: &str, value: bool) -> Result<(), String> {
            let raw_name = name;
            let name = c_string(raw_name)?;
            let mut value: c_int = if value { 1 } else { 0 };
            self.check(unsafe {
                (self.api.set_property)(
                    self.handle,
                    name.as_ptr(),
                    MPV_FORMAT_FLAG,
                    (&mut value as *mut c_int).cast(),
                )
            })
            .map_err(|error| format!("mpv property {raw_name} failed: {error}"))
        }

        fn set_property_double(&mut self, name: &str, value: f64) -> Result<(), String> {
            let raw_name = name;
            let name = c_string(raw_name)?;
            let mut value = value;
            self.check(unsafe {
                (self.api.set_property)(
                    self.handle,
                    name.as_ptr(),
                    MPV_FORMAT_DOUBLE,
                    (&mut value as *mut f64).cast(),
                )
            })
            .map_err(|error| format!("mpv property {raw_name} failed: {error}"))
        }

        fn get_property_flag(&mut self, name: &str) -> Result<bool, String> {
            let name = c_string(name)?;
            let mut value: c_int = 0;
            self.check(unsafe {
                (self.api.get_property)(
                    self.handle,
                    name.as_ptr(),
                    MPV_FORMAT_FLAG,
                    (&mut value as *mut c_int).cast(),
                )
            })?;
            Ok(value != 0)
        }

        fn get_property_double(&mut self, name: &str) -> Result<f64, String> {
            let name = c_string(name)?;
            let mut value = 0.0_f64;
            self.check(unsafe {
                (self.api.get_property)(
                    self.handle,
                    name.as_ptr(),
                    MPV_FORMAT_DOUBLE,
                    (&mut value as *mut f64).cast(),
                )
            })?;
            Ok(value)
        }

        fn wait_event(&mut self, timeout: f64) -> Option<MpvEvent> {
            let event = unsafe { (self.api.wait_event)(self.handle, timeout) };
            if event.is_null() {
                return None;
            }
            Some(unsafe { ptr::read(event) })
        }

        fn check(&self, code: c_int) -> Result<(), String> {
            if code < 0 {
                Err(self.error_message(code))
            } else {
                Ok(())
            }
        }

        fn error_message(&self, code: c_int) -> String {
            mpv_error_message(self.api.error_string, code)
        }
    }

    impl Drop for MpvCore {
        fn drop(&mut self) {
            if !self.handle.is_null() {
                unsafe {
                    (self.api.wakeup)(self.handle);
                    (self.api.terminate_destroy)(self.handle);
                }
                self.handle = ptr::null_mut();
            }
        }
    }

    struct OpenGlSurface {
        hwnd: HWND,
        hdc: HDC,
        context: HGLRC,
    }

    impl OpenGlSurface {
        fn new(hwnd: HWND) -> Result<Self, String> {
            let hdc = unsafe { GetDC(hwnd) };
            if hdc.is_null() {
                return Err("Could not get a device context for the video surface.".to_string());
            }

            let pfd = PIXELFORMATDESCRIPTOR {
                nSize: std::mem::size_of::<PIXELFORMATDESCRIPTOR>() as u16,
                nVersion: 1,
                dwFlags: PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER,
                iPixelType: PFD_TYPE_RGBA,
                cColorBits: 32,
                cAlphaBits: 8,
                cDepthBits: 24,
                cStencilBits: 8,
                iLayerType: PFD_MAIN_PLANE as u8,
                ..PIXELFORMATDESCRIPTOR::default()
            };

            let pixel_format = unsafe { ChoosePixelFormat(hdc, &pfd) };
            if pixel_format == 0 {
                unsafe {
                    ReleaseDC(hwnd, hdc);
                }
                return Err("Could not choose an OpenGL pixel format.".to_string());
            }

            let ok = unsafe { SetPixelFormat(hdc, pixel_format, &pfd) };
            if ok == 0 {
                unsafe {
                    ReleaseDC(hwnd, hdc);
                }
                return Err("Could not set the OpenGL pixel format.".to_string());
            }

            let context = unsafe { wglCreateContext(hdc) };
            if context.is_null() {
                unsafe {
                    ReleaseDC(hwnd, hdc);
                }
                return Err("Could not create an OpenGL context.".to_string());
            }

            let surface = Self { hwnd, hdc, context };
            surface.make_current()?;
            Ok(surface)
        }

        fn make_current(&self) -> Result<(), String> {
            let ok = unsafe { wglMakeCurrent(self.hdc, self.context) };
            if ok == 0 {
                return Err("Could not make the OpenGL context current.".to_string());
            }
            Ok(())
        }

        fn client_size(&self) -> Result<(c_int, c_int), String> {
            let mut rect = RECT::default();
            let ok = unsafe { GetClientRect(self.hwnd, &mut rect) };
            if ok == 0 {
                return Err("Could not read the native video surface size.".to_string());
            }
            Ok((
                (rect.right - rect.left).max(0),
                (rect.bottom - rect.top).max(0),
            ))
        }

        fn swap_buffers(&self) -> Result<(), String> {
            let ok = unsafe { SwapBuffers(self.hdc) };
            if ok == 0 {
                return Err("Could not present the OpenGL frame.".to_string());
            }
            Ok(())
        }
    }

    impl Drop for OpenGlSurface {
        fn drop(&mut self) {
            unsafe {
                wglMakeCurrent(ptr::null_mut(), ptr::null_mut());
                if !self.context.is_null() {
                    wglDeleteContext(self.context);
                }
                if !self.hdc.is_null() {
                    ReleaseDC(self.hwnd, self.hdc);
                }
            }
        }
    }

    struct MpvApi {
        _library: Library,
        version_label: String,
        render: MpvRenderApi,
        create: MpvCreate,
        initialize: MpvInitialize,
        terminate_destroy: MpvTerminateDestroy,
        set_option_string: MpvSetOptionString,
        command: MpvCommand,
        set_property: MpvSetProperty,
        get_property: MpvGetProperty,
        wait_event: MpvWaitEvent,
        wakeup: MpvWakeup,
        error_string: Option<MpvErrorString>,
    }

    impl MpvApi {
        fn load(path: &Path) -> Result<Self, String> {
            let library = Library::load(path)?;
            let client_api_version: MpvClientApiVersion =
                unsafe { load_symbol(library.module, b"mpv_client_api_version\0")? };
            let render = MpvRenderApi::load(library.module)?;
            let create = unsafe { load_symbol(library.module, b"mpv_create\0")? };
            let initialize = unsafe { load_symbol(library.module, b"mpv_initialize\0")? };
            let terminate_destroy =
                unsafe { load_symbol(library.module, b"mpv_terminate_destroy\0")? };
            let set_option_string =
                unsafe { load_symbol(library.module, b"mpv_set_option_string\0")? };
            let command = unsafe { load_symbol(library.module, b"mpv_command\0")? };
            let set_property = unsafe { load_symbol(library.module, b"mpv_set_property\0")? };
            let get_property = unsafe { load_symbol(library.module, b"mpv_get_property\0")? };
            let wait_event = unsafe { load_symbol(library.module, b"mpv_wait_event\0")? };
            let wakeup = unsafe { load_symbol(library.module, b"mpv_wakeup\0")? };
            let error_string = unsafe { load_symbol(library.module, b"mpv_error_string\0").ok() };

            let raw_version = unsafe { client_api_version() };
            let major = raw_version >> 16;
            let minor = raw_version & 0xffff;

            Ok(Self {
                _library: library,
                version_label: format!("client API {major}.{minor}"),
                render,
                create,
                initialize,
                terminate_destroy,
                set_option_string,
                command,
                set_property,
                get_property,
                wait_event,
                wakeup,
                error_string,
            })
        }
    }

    struct MpvRenderContext {
        handle: *mut c_void,
        context_free: MpvRenderContextFree,
        set_update_callback: MpvRenderContextSetUpdateCallback,
        update_fn: MpvRenderContextUpdate,
    }

    impl MpvRenderContext {
        fn opengl(core: &MpvCore) -> Result<Self, String> {
            let mut context = ptr::null_mut();
            let api_type = c_string("opengl")?;
            let mut init_params = MpvOpenGlInitParams {
                get_proc_address: Some(opengl_get_proc_address),
                get_proc_address_ctx: ptr::null_mut(),
            };
            let mut params = [
                MpvRenderParam {
                    param_type: MPV_RENDER_PARAM_API_TYPE,
                    data: api_type.as_ptr() as *mut c_void,
                },
                MpvRenderParam {
                    param_type: MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,
                    data: (&mut init_params as *mut MpvOpenGlInitParams).cast(),
                },
                MpvRenderParam {
                    param_type: MPV_RENDER_PARAM_INVALID,
                    data: ptr::null_mut(),
                },
            ];
            let result = unsafe {
                (core.api.render.context_create)(&mut context, core.handle, params.as_mut_ptr())
            };
            if result < 0 {
                trace_libmpv_event(
                    "opengl-context-create-fail",
                    &format!("error=\"{}\"", core.error_message(result)),
                );
                return Err(format!(
                    "OpenGL render context could not start: {}",
                    core.error_message(result)
                ));
            }
            if context.is_null() {
                trace_libmpv_event("opengl-context-create-null", "error=\"null context\"");
                return Err("Render API returned no OpenGL context.".to_string());
            }
            trace_libmpv_event("opengl-context-create-ok", "api=opengl");

            let render_context = Self {
                handle: context,
                context_free: core.api.render.context_free,
                set_update_callback: core.api.render.set_update_callback,
                update_fn: core.api.render.update,
            };
            unsafe {
                (render_context.set_update_callback)(
                    render_context.handle,
                    Some(render_update_callback),
                    ptr::null_mut(),
                );
            }
            Ok(render_context)
        }

        fn software(core: &MpvCore) -> Result<Self, String> {
            let mut context = ptr::null_mut();
            let api_type = c_string("sw")?;
            let mut params = [
                MpvRenderParam {
                    param_type: MPV_RENDER_PARAM_API_TYPE,
                    data: api_type.as_ptr() as *mut c_void,
                },
                MpvRenderParam {
                    param_type: MPV_RENDER_PARAM_INVALID,
                    data: ptr::null_mut(),
                },
            ];
            let result = unsafe {
                (core.api.render.context_create)(&mut context, core.handle, params.as_mut_ptr())
            };
            if result < 0 {
                trace_libmpv_event(
                    "software-context-create-fail",
                    &format!("error=\"{}\"", core.error_message(result)),
                );
                return Err(format!(
                    "Software render context could not start: {}",
                    core.error_message(result)
                ));
            }
            if context.is_null() {
                trace_libmpv_event("software-context-create-null", "error=\"null context\"");
                return Err("Render API returned no context.".to_string());
            }
            trace_libmpv_event("software-context-create-ok", "api=sw");

            let render_context = Self {
                handle: context,
                context_free: core.api.render.context_free,
                set_update_callback: core.api.render.set_update_callback,
                update_fn: core.api.render.update,
            };
            unsafe {
                (render_context.set_update_callback)(
                    render_context.handle,
                    Some(render_update_callback),
                    ptr::null_mut(),
                );
            }
            Ok(render_context)
        }

        fn update(&self) -> u64 {
            unsafe { (self.update_fn)(self.handle) }
        }
    }

    impl Drop for MpvRenderContext {
        fn drop(&mut self) {
            if !self.handle.is_null() {
                unsafe {
                    (self.set_update_callback)(self.handle, None, ptr::null_mut());
                    (self.context_free)(self.handle);
                }
                self.handle = ptr::null_mut();
            }
        }
    }

    unsafe extern "C" fn render_update_callback(_ctx: *mut c_void) {}

    unsafe extern "C" fn opengl_get_proc_address(
        _ctx: *mut c_void,
        name: *const c_char,
    ) -> *mut c_void {
        if name.is_null() {
            return ptr::null_mut();
        }

        if let Some(proc) = wglGetProcAddress(name.cast()) {
            return std::mem::transmute_copy(&proc);
        }

        let module = GetModuleHandleW(wide_null("opengl32.dll").as_ptr());
        if module.is_null() {
            return ptr::null_mut();
        }

        match GetProcAddress(module, name.cast()) {
            Some(symbol) => std::mem::transmute_copy(&symbol),
            None => ptr::null_mut(),
        }
    }

    struct MpvRenderApi {
        context_create: MpvRenderContextCreate,
        context_free: MpvRenderContextFree,
        set_update_callback: MpvRenderContextSetUpdateCallback,
        update: MpvRenderContextUpdate,
        render: MpvRenderContextRender,
    }

    impl MpvRenderApi {
        fn load(module: HMODULE) -> Result<Self, String> {
            Ok(Self {
                context_create: unsafe { load_symbol(module, b"mpv_render_context_create\0")? },
                context_free: unsafe { load_symbol(module, b"mpv_render_context_free\0")? },
                set_update_callback: unsafe {
                    load_symbol(module, b"mpv_render_context_set_update_callback\0")?
                },
                update: unsafe { load_symbol(module, b"mpv_render_context_update\0")? },
                render: unsafe { load_symbol(module, b"mpv_render_context_render\0")? },
            })
        }
    }

    struct Library {
        module: HMODULE,
    }

    impl Library {
        fn load(path: &Path) -> Result<Self, String> {
            let module = unsafe { LoadLibraryW(encode_wide(path).as_ptr()) };
            if module.is_null() {
                return Err(format!("Windows could not load {}", path.display()));
            }
            Ok(Self { module })
        }
    }

    impl Drop for Library {
        fn drop(&mut self) {
            if !self.module.is_null() {
                unsafe {
                    FreeLibrary(self.module);
                }
            }
        }
    }

    struct CommandArgs {
        _strings: Vec<CString>,
        pointers: Vec<*const c_char>,
    }

    impl CommandArgs {
        fn new(args: &[&str]) -> Result<Self, String> {
            let strings = args
                .iter()
                .map(|arg| c_string(arg))
                .collect::<Result<Vec<_>, _>>()?;
            let mut pointers = strings
                .iter()
                .map(|arg| arg.as_ptr())
                .collect::<Vec<*const c_char>>();
            pointers.push(ptr::null());

            Ok(Self {
                _strings: strings,
                pointers,
            })
        }

        fn as_ptr(&self) -> *const *const c_char {
            self.pointers.as_ptr()
        }
    }

    unsafe fn load_symbol<T: Copy>(module: HMODULE, name: &'static [u8]) -> Result<T, String> {
        let symbol = GetProcAddress(module, name.as_ptr())
            .ok_or_else(|| format!("{} is missing", symbol_name(name)))?;
        Ok(std::mem::transmute_copy(&symbol))
    }

    fn mpv_error_message(error_string: Option<MpvErrorString>, code: c_int) -> String {
        if let Some(error_string) = error_string {
            let message = unsafe { error_string(code) };
            if !message.is_null() {
                if let Ok(message) = unsafe { CStr::from_ptr(message) }.to_str() {
                    return message.to_string();
                }
            }
        }
        format!("mpv command failed with code {code}")
    }

    fn c_string(value: &str) -> Result<CString, String> {
        CString::new(value).map_err(|_| "MPV argument contains an invalid null byte.".to_string())
    }

    fn encode_wide(path: &Path) -> Vec<u16> {
        use std::os::windows::prelude::OsStrExt;
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn wide_null(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    fn symbol_name(name: &[u8]) -> String {
        let end = name
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(name.len());
        String::from_utf8_lossy(&name[..end]).to_string()
    }
}

#[cfg(windows)]
pub use platform::{probe_render_api, probe_render_frame, validate};

#[cfg(not(windows))]
mod platform {
    use super::{
        c_void, Arc, Mutex, PlaybackOptions, Receiver, RenderApiProbe, RenderFrameProbe,
        SessionCommand, SessionSnapshot,
    };
    use std::path::{Path, PathBuf};

    pub fn validate(path: &Path) -> Result<String, String> {
        if path.exists() && path.is_file() {
            Ok("runtime detected".to_string())
        } else {
            Err(format!("Runtime file does not exist: {}", path.display()))
        }
    }

    pub fn probe_render_api(path: &Path) -> Result<RenderApiProbe, String> {
        validate(path).map(|_| RenderApiProbe {
            symbols_loaded: false,
            software_context: false,
            opengl_symbols: false,
            summary: "Render API probing is only wired on Windows right now.".to_string(),
        })
    }

    pub fn probe_render_frame(
        runtime_path: &Path,
        _media_path: &Path,
    ) -> Result<RenderFrameProbe, String> {
        validate(runtime_path)?;
        Err("Embedded MPV frame rendering is only wired on Windows right now.".to_string())
    }

    pub fn run_playback(
        _runtime_path: PathBuf,
        _options: PlaybackOptions,
        _commands: Receiver<SessionCommand>,
        _snapshot: Arc<Mutex<SessionSnapshot>>,
        ready: super::Sender<Result<(), String>>,
    ) {
        let _ = std::ptr::null::<c_void>();
        let _ = ready.send(Err(
            "Embedded MPV runtime playback is only wired on Windows right now.".to_string(),
        ));
    }

    pub fn run_render_playback(
        _runtime_path: PathBuf,
        _options: PlaybackOptions,
        _commands: Receiver<SessionCommand>,
        _snapshot: Arc<Mutex<SessionSnapshot>>,
        ready: super::Sender<Result<(), String>>,
    ) {
        let _ = std::ptr::null::<c_void>();
        let _ = ready.send(Err(
            "Embedded MPV rendering is only wired on Windows right now.".to_string(),
        ));
    }
}

#[cfg(not(windows))]
pub use platform::{probe_render_api, probe_render_frame, validate};
