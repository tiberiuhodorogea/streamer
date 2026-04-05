/**
 * game_capture — N-API native addon entry point.
 *
 * Exports:
 *   enumGameWindows()  — detect game windows via loaded DirectX/Vulkan DLLs
 *   startProcessAudioCapture(pid) — WASAPI process-loopback audio capture
 *   stopProcessAudioCapture()     — stop audio capture
 */

#include <napi.h>
#include "game_detect.h"
#include "process_audio.h"
#include "game_video.h"

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("enumGameWindows",
        Napi::Function::New(env, game_detect::EnumGameWindows));

    exports.Set("isProcessAudioSupported",
        Napi::Function::New(env, process_audio::IsSupported));

    exports.Set("startProcessAudioCapture",
        Napi::Function::New(env, process_audio::StartCapture));

    exports.Set("stopProcessAudioCapture",
        Napi::Function::New(env, process_audio::StopCapture));

    exports.Set("registerAudioCallback",
        Napi::Function::New(env, process_audio::RegisterAudioCallback));

    // Native video capture (DXGI Desktop Duplication)
    exports.Set("startVideoCapture",
        Napi::Function::New(env, game_video::StartCapture));

    exports.Set("stopVideoCapture",
        Napi::Function::New(env, game_video::StopCapture));

    exports.Set("registerVideoCallback",
        Napi::Function::New(env, game_video::RegisterVideoCallback));

    exports.Set("isVideoCapturing",
        Napi::Function::New(env, game_video::IsCapturing));

    return exports;
}

NODE_API_MODULE(game_capture, Init)
