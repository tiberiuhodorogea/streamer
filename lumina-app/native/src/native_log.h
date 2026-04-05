#pragma once

#include <windows.h>

#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>

namespace native_log {

inline std::mutex g_logMutex;
inline bool g_logInitialised = false;
inline bool g_logEnabled = false;
inline char g_logPath[MAX_PATH] = { 0 };

inline void ensureInitialised() {
    if (g_logInitialised) return;
    const char* path = std::getenv("LUMINA_NATIVE_LOG_PATH");
    if (path && *path) {
        std::strncpy(g_logPath, path, sizeof(g_logPath) - 1);
        g_logEnabled = true;
    }
    g_logInitialised = true;
}

inline void writef(const char* component, const char* format, ...) {
    std::lock_guard<std::mutex> lock(g_logMutex);
    ensureInitialised();
    if (!g_logEnabled) return;

    FILE* file = nullptr;
    if (fopen_s(&file, g_logPath, "a") != 0 || !file) return;

    SYSTEMTIME now;
    GetLocalTime(&now);
    std::fprintf(file,
        "%04u-%02u-%02uT%02u:%02u:%02u.%03u [%s] ",
        now.wYear, now.wMonth, now.wDay,
        now.wHour, now.wMinute, now.wSecond, now.wMilliseconds,
        component ? component : "NATIVE");

    va_list args;
    va_start(args, format);
    std::vfprintf(file, format, args);
    va_end(args);

    std::fputc('\n', file);
    std::fclose(file);
}

}  // namespace native_log