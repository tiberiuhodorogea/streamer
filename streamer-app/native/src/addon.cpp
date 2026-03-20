/**
 * game_capture — N-API native addon entry point.
 *
 * Exports:
 *   enumGameWindows()  — detect game windows via loaded DirectX/Vulkan DLLs
 *   isSupported()      — check WGC API availability
 *   startCapture(hwnd, w, h, fps) — start WGC capture session
 *   stopCapture()      — stop active capture
 */

#include <napi.h>
#include "game_detect.h"
#include "wgc_capture.h"

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("enumGameWindows",
        Napi::Function::New(env, game_detect::EnumGameWindows));

    exports.Set("isSupported",
        Napi::Function::New(env, wgc_capture::IsSupported));

    exports.Set("startCapture",
        Napi::Function::New(env, wgc_capture::StartCapture));

    exports.Set("stopCapture",
        Napi::Function::New(env, wgc_capture::StopCapture));

    return exports;
}

NODE_API_MODULE(game_capture, Init)
