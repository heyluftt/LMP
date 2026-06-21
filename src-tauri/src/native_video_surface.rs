use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVideoSurfaceRect {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVideoSurfaceStatus {
    pub available: bool,
    pub active: bool,
    pub label: String,
    pub hwnd: Option<usize>,
    pub rect: NativeVideoSurfaceRect,
    pub visible: bool,
    pub summary: String,
}

#[cfg(windows)]
mod platform {
    use super::{NativeVideoSurfaceRect, NativeVideoSurfaceStatus};
    use crate::libmpv_runtime::trace_libmpv_event;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use std::{
        collections::HashMap,
        ptr,
        sync::{Mutex, OnceLock},
    };
    use tauri::WebviewWindow;
    use windows_sys::Win32::{
        Foundation::{GetLastError, ERROR_CLASS_ALREADY_EXISTS, HWND, LPARAM, LRESULT, WPARAM},
        Graphics::Gdi::HBRUSH,
        System::LibraryLoader::GetModuleHandleW,
        UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, SetWindowPos,
            ShowWindow, CS_HREDRAW, CS_OWNDC, CS_VREDRAW, HWND_TOP, SWP_HIDEWINDOW, SWP_NOACTIVATE,
            SWP_SHOWWINDOW, SW_HIDE, SW_SHOW, WNDCLASSW, WS_CHILD, WS_CLIPCHILDREN,
            WS_CLIPSIBLINGS, WS_VISIBLE,
        },
    };

    const SURFACE_CLASS_NAME: &str = "LMPNativeVideoSurface";
    static CLASS_REGISTERED: OnceLock<Result<(), String>> = OnceLock::new();

    #[derive(Default)]
    pub struct NativeVideoSurfaceStore {
        surfaces: Mutex<HashMap<String, NativeVideoSurface>>,
    }

    #[derive(Clone, Copy)]
    struct NativeVideoSurface {
        hwnd: isize,
        rect: NativeVideoSurfaceRect,
        visible: bool,
    }

    impl NativeVideoSurfaceStore {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn show(
            &self,
            window: &WebviewWindow,
            rect: NativeVideoSurfaceRect,
        ) -> Result<NativeVideoSurfaceStatus, String> {
            let label = window.label().to_string();
            let rect = normalized_rect(rect);
            let hwnd = {
                let mut surfaces = self
                    .surfaces
                    .lock()
                    .map_err(|_| "Could not lock native video surface state.".to_string())?;

                if let Some(surface) = surfaces.get_mut(&label) {
                    update_surface(surface.hwnd as HWND, rect, true)?;
                    trace_libmpv_event(
                        "native-surface-reuse",
                        &format!(
                            "label={label} hwnd={} rect={}x{}+{}+{}",
                            surface.hwnd, rect.width, rect.height, rect.left, rect.top
                        ),
                    );
                    surface.rect = rect;
                    surface.visible = true;
                    surface.hwnd
                } else {
                    let parent = parent_hwnd(window)?;
                    let hwnd = create_surface_window(parent, rect, true)?;
                    trace_libmpv_event(
                        "native-surface-create",
                        &format!(
                            "label={label} parent={parent:p} hwnd={hwnd:p} rect={}x{}+{}+{}",
                            rect.width, rect.height, rect.left, rect.top
                        ),
                    );
                    surfaces.insert(
                        label.clone(),
                        NativeVideoSurface {
                            hwnd: hwnd as isize,
                            rect,
                            visible: true,
                        },
                    );
                    hwnd as isize
                }
            };

            Ok(NativeVideoSurfaceStatus {
                available: true,
                active: true,
                label,
                hwnd: Some(hwnd as usize),
                rect,
                visible: true,
                summary: "Native video surface is ready.".to_string(),
            })
        }

        pub fn hide(&self, label: &str) -> Result<NativeVideoSurfaceStatus, String> {
            let mut surfaces = self
                .surfaces
                .lock()
                .map_err(|_| "Could not lock native video surface state.".to_string())?;

            let Some(surface) = surfaces.get_mut(label) else {
                return Ok(inactive_status(label));
            };

            update_surface(surface.hwnd as HWND, surface.rect, false)?;
            surface.visible = false;

            Ok(NativeVideoSurfaceStatus {
                available: true,
                active: true,
                label: label.to_string(),
                hwnd: Some(surface.hwnd as usize),
                rect: surface.rect,
                visible: false,
                summary: "Native video surface is hidden.".to_string(),
            })
        }

        pub fn destroy_label(&self, label: &str) -> Result<NativeVideoSurfaceStatus, String> {
            let surface = self
                .surfaces
                .lock()
                .map_err(|_| "Could not lock native video surface state.".to_string())?
                .remove(label);

            if let Some(surface) = surface {
                unsafe {
                    DestroyWindow(surface.hwnd as HWND);
                }
                Ok(NativeVideoSurfaceStatus {
                    available: true,
                    active: false,
                    label: label.to_string(),
                    hwnd: None,
                    rect: surface.rect,
                    visible: false,
                    summary: "Native video surface was destroyed.".to_string(),
                })
            } else {
                Ok(inactive_status(label))
            }
        }
    }

    unsafe impl Send for NativeVideoSurfaceStore {}
    unsafe impl Sync for NativeVideoSurfaceStore {}

    fn inactive_status(label: &str) -> NativeVideoSurfaceStatus {
        NativeVideoSurfaceStatus {
            available: true,
            active: false,
            label: label.to_string(),
            hwnd: None,
            rect: NativeVideoSurfaceRect::default(),
            visible: false,
            summary: "Native video surface is not active.".to_string(),
        }
    }

    fn normalized_rect(rect: NativeVideoSurfaceRect) -> NativeVideoSurfaceRect {
        NativeVideoSurfaceRect {
            left: rect.left,
            top: rect.top,
            width: rect.width.max(1),
            height: rect.height.max(1),
        }
    }

    fn register_class() -> Result<(), String> {
        CLASS_REGISTERED
            .get_or_init(|| {
                let class_name = wide_null(SURFACE_CLASS_NAME);
                let instance = unsafe { GetModuleHandleW(ptr::null()) };
                if instance.is_null() {
                    return Err(last_error("GetModuleHandleW"));
                }

                let class = WNDCLASSW {
                    style: CS_HREDRAW | CS_VREDRAW | CS_OWNDC,
                    lpfnWndProc: Some(surface_window_proc),
                    cbClsExtra: 0,
                    cbWndExtra: 0,
                    hInstance: instance,
                    hIcon: ptr::null_mut(),
                    hCursor: ptr::null_mut(),
                    hbrBackground: ptr::null_mut::<std::ffi::c_void>() as HBRUSH,
                    lpszMenuName: ptr::null(),
                    lpszClassName: class_name.as_ptr(),
                };

                let atom = unsafe { RegisterClassW(&class) };
                if atom == 0 {
                    let error = unsafe { GetLastError() };
                    if error != ERROR_CLASS_ALREADY_EXISTS {
                        return Err(format!("RegisterClassW failed ({error})."));
                    }
                }

                Ok(())
            })
            .clone()
    }

    fn parent_hwnd(window: &WebviewWindow) -> Result<HWND, String> {
        let handle = window
            .window_handle()
            .map_err(|error| format!("Could not read Tauri window handle: {error}"))?;

        match handle.as_raw() {
            RawWindowHandle::Win32(handle) => Ok(handle.hwnd.get() as HWND),
            _ => Err("Native video surface is only available on Windows.".to_string()),
        }
    }

    fn create_surface_window(
        parent: HWND,
        rect: NativeVideoSurfaceRect,
        visible: bool,
    ) -> Result<HWND, String> {
        register_class()?;
        let class_name = wide_null(SURFACE_CLASS_NAME);
        let title = wide_null("LMP video surface");
        let instance = unsafe { GetModuleHandleW(ptr::null()) };
        if instance.is_null() {
            return Err(last_error("GetModuleHandleW"));
        }

        let mut style = WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN;
        if visible {
            style |= WS_VISIBLE;
        }

        let hwnd = unsafe {
            CreateWindowExW(
                0,
                class_name.as_ptr(),
                title.as_ptr(),
                style,
                rect.left,
                rect.top,
                rect.width,
                rect.height,
                parent,
                ptr::null_mut(),
                instance,
                ptr::null_mut(),
            )
        };

        if hwnd.is_null() {
            return Err(last_error("CreateWindowExW"));
        }

        update_surface(hwnd, rect, visible)?;
        Ok(hwnd)
    }

    fn update_surface(
        hwnd: HWND,
        rect: NativeVideoSurfaceRect,
        visible: bool,
    ) -> Result<(), String> {
        let flags = SWP_NOACTIVATE
            | if visible {
                SWP_SHOWWINDOW
            } else {
                SWP_HIDEWINDOW
            };
        let ok = unsafe {
            SetWindowPos(
                hwnd,
                HWND_TOP,
                rect.left,
                rect.top,
                rect.width,
                rect.height,
                flags,
            )
        };
        if ok == 0 {
            return Err(last_error("SetWindowPos"));
        }

        unsafe {
            ShowWindow(hwnd, if visible { SW_SHOW } else { SW_HIDE });
        }
        Ok(())
    }

    unsafe extern "system" fn surface_window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        DefWindowProcW(hwnd, message, wparam, lparam)
    }

    fn wide_null(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    fn last_error(context: &str) -> String {
        let error = unsafe { GetLastError() };
        format!("{context} failed ({error}).")
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{NativeVideoSurfaceRect, NativeVideoSurfaceStatus};
    use tauri::WebviewWindow;

    #[derive(Default)]
    pub struct NativeVideoSurfaceStore;

    impl NativeVideoSurfaceStore {
        pub fn new() -> Self {
            Self
        }

        pub fn show(
            &self,
            window: &WebviewWindow,
            rect: NativeVideoSurfaceRect,
        ) -> Result<NativeVideoSurfaceStatus, String> {
            Ok(NativeVideoSurfaceStatus {
                available: false,
                active: false,
                label: window.label().to_string(),
                hwnd: None,
                rect,
                visible: false,
                summary: "Native video surface is only available on Windows.".to_string(),
            })
        }

        pub fn hide(&self, label: &str) -> Result<NativeVideoSurfaceStatus, String> {
            Ok(inactive_status(label))
        }

        pub fn destroy_label(&self, label: &str) -> Result<NativeVideoSurfaceStatus, String> {
            Ok(inactive_status(label))
        }
    }

    fn inactive_status(label: &str) -> NativeVideoSurfaceStatus {
        NativeVideoSurfaceStatus {
            available: false,
            active: false,
            label: label.to_string(),
            hwnd: None,
            rect: NativeVideoSurfaceRect::default(),
            visible: false,
            summary: "Native video surface is only available on Windows.".to_string(),
        }
    }
}

pub use platform::NativeVideoSurfaceStore;
