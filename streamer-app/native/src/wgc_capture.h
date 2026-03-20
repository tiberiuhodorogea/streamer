#pragma once
#include <napi.h>

namespace wgc_capture {
  /**
   * Check if Windows Graphics Capture API is supported on this system.
   * Requires Windows 10 version 1903 (build 18362) or later.
   */
  Napi::Value IsSupported(const Napi::CallbackInfo& info);

  /**
   * Start capturing a window by HWND using the WGC API.
   * Args: hwnd (number), width (number), height (number), fps (number)
   *
   * Frames are delivered as BGRA pixel buffers through the captured frame pool.
   * Currently logs capture events; frame delivery to JS will be added
   * when the IPC frame transfer pipeline is implemented.
   */
  Napi::Value StartCapture(const Napi::CallbackInfo& info);

  /**
   * Stop the active capture session and release all resources.
   */
  Napi::Value StopCapture(const Napi::CallbackInfo& info);
}
