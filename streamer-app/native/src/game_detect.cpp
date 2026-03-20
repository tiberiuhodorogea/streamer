#include "game_detect.h"
#include <windows.h>
#include <psapi.h>
#include <string>
#include <vector>
#include <unordered_set>
#include <algorithm>
#include <cwctype>

// Well-known non-game process names (lowercase).
// These load d3d11/dxgi for hardware-accelerated UI, not game rendering.
static const std::unordered_set<std::wstring> kNonGameProcesses = {
    L"chrome.exe", L"msedge.exe", L"firefox.exe", L"opera.exe", L"brave.exe",
    L"electron.exe", L"code.exe", L"explorer.exe",
    L"slack.exe", L"discord.exe", L"teams.exe", L"spotify.exe", L"zoom.exe",
    L"devenv.exe", L"mspaint.exe", L"notepad.exe",
    // Capture/overlay tools
    L"snippingtool.exe", L"obs64.exe", L"obs32.exe", L"sharex.exe",
    L"nvcontainer.exe", L"nvosd.exe", L"nvspcaps64.exe",
    L"nvidia share.exe", L"nvidia overlay.exe", L"overlay.exe",
    L"steamwebhelper.exe", L"gamebar.exe", L"gamebarft.exe",
    L"gamebarpresencewriter.exe", L"radeonsoftware.exe",
    // System processes
    L"powershell.exe", L"pwsh.exe", L"cmd.exe", L"conhost.exe",
    L"windowsterminal.exe", L"wt.exe",
    L"dwm.exe", L"csrss.exe", L"svchost.exe", L"taskhostw.exe",
    L"searchhost.exe", L"applicationframehost.exe",
    L"shellexperiencehost.exe", L"lockapp.exe",
    L"textinputhost.exe", L"systemsettings.exe",
    L"startmenuexperiencehost.exe", L"runtimebroker.exe",
    L"sihost.exe", L"widgets.exe", L"phoneexperiencehost.exe",
};

// Path fragments that indicate a game installation directory.
static const std::vector<std::wstring> kGamePathHints = {
    L"\\steamapps\\common\\",
    L"\\epic games\\",
    L"\\riot games\\",
    L"\\ubisoft\\ubisoft game launcher\\",
    L"\\ea games\\",
    L"\\origin games\\",
    L"\\battle.net\\",
    L"\\gog galaxy\\games\\",
    L"\\xbox games\\",
};

// DirectX / Vulkan module names that indicate a game process.
static const std::vector<std::wstring> kGameModules = {
    L"d3d11.dll", L"d3d12.dll", L"vulkan-1.dll"
};

struct GameWindow {
    HWND hwnd;
    DWORD pid;
    std::wstring processName;
};

static std::wstring toLower(const std::wstring& s) {
    std::wstring out = s;
    std::transform(out.begin(), out.end(), out.begin(), std::towlower);
    return out;
}

/**
 * Check if a process has any of the game-indicating DLLs loaded.
 */
static bool processHasGameModules(DWORD pid) {
    HANDLE hProcess = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
    if (!hProcess) return false;

    HMODULE modules[512];
    DWORD cbNeeded = 0;

    BOOL ok = EnumProcessModulesEx(hProcess, modules, sizeof(modules), &cbNeeded, LIST_MODULES_ALL);
    if (!ok) {
        CloseHandle(hProcess);
        return false;
    }

    DWORD count = cbNeeded / sizeof(HMODULE);
    bool found = false;

    for (DWORD i = 0; i < count && !found; ++i) {
        wchar_t modName[MAX_PATH];
        if (GetModuleBaseNameW(hProcess, modules[i], modName, MAX_PATH)) {
            std::wstring lower = toLower(modName);
            for (const auto& gm : kGameModules) {
                if (lower == gm) { found = true; break; }
            }
        }
    }

    CloseHandle(hProcess);
    return found;
}

/**
 * Get the full image path of a process.
 * Uses PROCESS_QUERY_LIMITED_INFORMATION which works even on
 * anti-cheat protected processes (EAC, BattlEye, Vanguard, etc.).
 */
static std::wstring getProcessImagePath(DWORD pid) {
    HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!hProcess) return L"";
    wchar_t path[MAX_PATH];
    DWORD len = MAX_PATH;
    if (QueryFullProcessImageNameW(hProcess, 0, path, &len)) {
        CloseHandle(hProcess);
        return std::wstring(path, len);
    }
    CloseHandle(hProcess);
    return L"";
}

/**
 * Extract just the filename from a full path.
 */
static std::wstring getProcessName(DWORD pid) {
    std::wstring fullPath = getProcessImagePath(pid);
    if (fullPath.empty()) return L"";
    auto pos = fullPath.find_last_of(L"\\/ ");
    return (pos != std::wstring::npos) ? fullPath.substr(pos + 1) : fullPath;
}

/**
 * Fallback game detection: check if the process executable lives
 * inside a well-known game installation directory.
 * This catches anti-cheat protected games where module enumeration fails.
 */
static bool isGameByPath(DWORD pid) {
    std::wstring fullPath = getProcessImagePath(pid);
    if (fullPath.empty()) return false;
    std::wstring lower = toLower(fullPath);
    for (const auto& hint : kGamePathHints) {
        if (lower.find(hint) != std::wstring::npos) return true;
    }
    return false;
}

struct EnumContext {
    std::vector<GameWindow>* results;
};

static BOOL CALLBACK enumWindowProc(HWND hwnd, LPARAM lParam) {
    if (!IsWindowVisible(hwnd)) return TRUE;

    // Skip windows with no title
    wchar_t title[256];
    if (GetWindowTextW(hwnd, title, 256) == 0) return TRUE;

    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == 0) return TRUE;

    // Get process name and check against non-game list
    std::wstring procName = getProcessName(pid);
    if (procName.empty()) return TRUE;

    std::wstring procLower = toLower(procName);
    if (kNonGameProcesses.count(procLower)) return TRUE;

    // Layer 1: Check if this process loads DirectX/Vulkan modules
    // Layer 2: Check if the exe lives in a known game directory
    //          (catches anti-cheat protected games like EAC/BattlEye)
    if (processHasGameModules(pid) || isGameByPath(pid)) {
        auto* ctx = reinterpret_cast<EnumContext*>(lParam);
        ctx->results->push_back({ hwnd, pid, procName });
    }

    return TRUE;
}

Napi::Value game_detect::EnumGameWindows(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    std::vector<GameWindow> results;
    EnumContext ctx{ &results };
    EnumWindows(enumWindowProc, reinterpret_cast<LPARAM>(&ctx));

    // Deduplicate by PID (a game may have multiple top-level windows)
    std::unordered_set<DWORD> seenPids;
    Napi::Array arr = Napi::Array::New(env);
    uint32_t idx = 0;

    for (const auto& gw : results) {
        if (seenPids.count(gw.pid)) continue;
        seenPids.insert(gw.pid);

        Napi::Object obj = Napi::Object::New(env);
        obj.Set("hwnd", Napi::Number::New(env, static_cast<double>(reinterpret_cast<uintptr_t>(gw.hwnd))));
        obj.Set("pid", Napi::Number::New(env, static_cast<double>(gw.pid)));

        // Convert wstring to UTF-8
        int sizeNeeded = WideCharToMultiByte(CP_UTF8, 0, gw.processName.c_str(),
            static_cast<int>(gw.processName.size()), nullptr, 0, nullptr, nullptr);
        std::string utf8(sizeNeeded, 0);
        WideCharToMultiByte(CP_UTF8, 0, gw.processName.c_str(),
            static_cast<int>(gw.processName.size()), &utf8[0], sizeNeeded, nullptr, nullptr);
        obj.Set("name", Napi::String::New(env, utf8));

        arr.Set(idx++, obj);
    }

    return arr;
}
