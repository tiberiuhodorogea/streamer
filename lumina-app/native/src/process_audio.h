#pragma once
#include <napi.h>

namespace process_audio {
  Napi::Value IsSupported(const Napi::CallbackInfo& info);
  Napi::Value StartCapture(const Napi::CallbackInfo& info);
  Napi::Value StopCapture(const Napi::CallbackInfo& info);
  Napi::Value RegisterAudioCallback(const Napi::CallbackInfo& info);
}