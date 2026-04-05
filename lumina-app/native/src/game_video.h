#pragma once
#include <napi.h>

namespace game_video {
  /**
   * startCapture() — Initialises DXGI Desktop Duplication on the primary
   * monitor and spins up a capture thread that delivers BGRA frames via
   * a registered callback at up to monitor-refresh-rate FPS.
   *
   * Returns a JS object { success, width, height } on the calling thread.
   */
  Napi::Value StartCapture(const Napi::CallbackInfo& info);

  /**
   * stopCapture() — Tears down the capture thread and releases all
   * DXGI / D3D11 resources.  Safe to call even when not capturing.
   */
  Napi::Value StopCapture(const Napi::CallbackInfo& info);

  /**
   * registerVideoCallback(fn) — Sets the JS function that will receive
   * (Uint8Array pixels, Object meta) for every captured frame.
   * Must be called BEFORE startCapture().
   */
  Napi::Value RegisterVideoCallback(const Napi::CallbackInfo& info);

  /**
   * isCapturing() — Returns true if capture thread is running.
   */
  Napi::Value IsCapturing(const Napi::CallbackInfo& info);
}
