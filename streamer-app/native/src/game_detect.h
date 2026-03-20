#pragma once
#include <napi.h>

namespace game_detect {
  /**
   * Enumerates visible windows and identifies which belong to game processes
   * (processes that have d3d11.dll, d3d12.dll, or vulkan-1.dll loaded).
   *
   * Returns a JS array of { hwnd, pid, name } objects.
   */
  Napi::Value EnumGameWindows(const Napi::CallbackInfo& info);
}
