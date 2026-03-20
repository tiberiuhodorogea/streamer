#pragma once
#include <napi.h>

namespace wgc_capture {
  Napi::Value IsSupported(const Napi::CallbackInfo& info);
  Napi::Value StartCapture(const Napi::CallbackInfo& info);
  Napi::Value StopCapture(const Napi::CallbackInfo& info);

  /**
   * Register a JS callback to receive captured frames.
   * Args: callback(buffer, {width, height, frameIndex})
   * The callback is invoked on the Node.js main thread via ThreadSafeFunction
   * each time WGC delivers a new frame. Frames are BGRA pixel buffers.
   */
  Napi::Value RegisterFrameCallback(const Napi::CallbackInfo& info);
}
