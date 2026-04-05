/**
 * game_video — DXGI Desktop Duplication capture for game streaming.
 *
 * Captures the primary desktop output at monitor refresh rate, delivering
 * BGRA frame buffers to JavaScript via a TypedThreadSafeFunction callback.
 *
 * This bypasses Chromium's getUserMedia desktop capture path which is
 * limited to ~30-35 fps on current Electron/Chromium versions.
 */

#include "game_video.h"
#include "native_log.h"

#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <thread>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")

#define VIDEO_LOG(fmt, ...) do { \
    fprintf(stderr, "[GAME-VIDEO] " fmt "\n", ##__VA_ARGS__); \
    native_log::writef("GAME-VIDEO", fmt, ##__VA_ARGS__); \
} while (0)
#define VIDEO_LOG_HR(label, hr) do { \
    fprintf(stderr, "[GAME-VIDEO] %s hr=0x%08lx\n", label, static_cast<unsigned long>(hr)); \
    native_log::writef("GAME-VIDEO", "%s hr=0x%08lx", label, static_cast<unsigned long>(hr)); \
} while (0)

// ────────────────── Frame delivery to JS ──────────────────

struct FrameData {
    uint8_t* pixels;   // BGRA pixel data (caller-allocated, callback frees)
    uint32_t width;
    uint32_t height;
    uint32_t stride;   // bytes per row (width * 4, no padding)
    uint64_t timestamp; // microseconds since epoch
    uint64_t epochTimestampUs; // wall-clock microseconds since epoch
    uint32_t dataSize;  // total byte count (width * height * 4)
};

static void onFrameDelivery(Napi::Env env, Napi::Function fn,
                            std::nullptr_t*, FrameData* data) {
    if (!data) return;

    if (env != nullptr && fn != nullptr) {
        try {
            // Copy into a regular ArrayBuffer (not External) so it survives
            // Electron's structured-clone IPC serialization.
            auto ab = Napi::ArrayBuffer::New(env, data->dataSize);
            std::memcpy(ab.Data(), data->pixels, data->dataSize);
            std::free(data->pixels);

            auto view = Napi::Uint8Array::New(env, data->dataSize, ab, 0);

            auto meta = Napi::Object::New(env);
            meta.Set("width",     Napi::Number::New(env, data->width));
            meta.Set("height",    Napi::Number::New(env, data->height));
            meta.Set("stride",    Napi::Number::New(env, data->stride));
            meta.Set("timestamp", Napi::Number::New(env, static_cast<double>(data->timestamp)));
            meta.Set("epochTimestampUs", Napi::Number::New(env, static_cast<double>(data->epochTimestampUs)));

            fn.Call({ view, meta });
        } catch (...) {
            std::free(data->pixels);
        }
    } else {
        std::free(data->pixels);
    }
    delete data;
}

using VideoTSFN = Napi::TypedThreadSafeFunction<std::nullptr_t, FrameData, onFrameDelivery>;

// ────────────────── Global capture state ──────────────────

static ID3D11Device*           g_device      = nullptr;
static ID3D11DeviceContext*    g_context     = nullptr;
static IDXGIOutputDuplication* g_duplication = nullptr;
static ID3D11Texture2D*        g_staging     = nullptr;

static std::thread         g_captureThread;
static std::atomic<bool>   g_running{false};
static VideoTSFN           g_videoTsfn;
static uint32_t            g_captureWidth  = 0;
static uint32_t            g_captureHeight = 0;
static uint32_t            g_outputWidth   = 0;
static uint32_t            g_outputHeight  = 0;
static uint32_t            g_maxWidth      = 0;
static uint32_t            g_maxHeight     = 0;
static std::atomic<int>    g_targetFps{60};
static std::atomic<uint64_t> g_framesDropped{0};

static void updateOutputSize() {
    if (g_captureWidth == 0 || g_captureHeight == 0) {
        g_outputWidth = 0;
        g_outputHeight = 0;
        return;
    }

    if (g_maxWidth == 0 || g_maxHeight == 0) {
        g_outputWidth = g_captureWidth;
        g_outputHeight = g_captureHeight;
        return;
    }

    const double scaleX = static_cast<double>(g_maxWidth) / static_cast<double>(g_captureWidth);
    const double scaleY = static_cast<double>(g_maxHeight) / static_cast<double>(g_captureHeight);
    const double scale = (scaleX < scaleY ? scaleX : scaleY);

    if (scale >= 1.0) {
        g_outputWidth = g_captureWidth;
        g_outputHeight = g_captureHeight;
        return;
    }

    g_outputWidth = static_cast<uint32_t>(g_captureWidth * scale);
    g_outputHeight = static_cast<uint32_t>(g_captureHeight * scale);
    if (g_outputWidth == 0) g_outputWidth = 1;
    if (g_outputHeight == 0) g_outputHeight = 1;
}

static void downscaleFrameNearest(const uint8_t* srcBase, uint32_t srcWidth, uint32_t srcHeight,
                                  uint32_t srcStride, uint8_t* dstBase, uint32_t dstWidth,
                                  uint32_t dstHeight) {
    for (uint32_t outY = 0; outY < dstHeight; ++outY) {
        const uint32_t inY = static_cast<uint32_t>((static_cast<uint64_t>(outY) * srcHeight) / dstHeight);
        const auto* srcRow = reinterpret_cast<const uint32_t*>(srcBase + (static_cast<size_t>(inY) * srcStride));
        auto* dstRow = reinterpret_cast<uint32_t*>(dstBase + (static_cast<size_t>(outY) * dstWidth * 4));
        for (uint32_t outX = 0; outX < dstWidth; ++outX) {
            const uint32_t inX = static_cast<uint32_t>((static_cast<uint64_t>(outX) * srcWidth) / dstWidth);
            dstRow[outX] = srcRow[inX];
        }
    }
}

// ────────────────── DXGI init / teardown ──────────────────

static void releaseDXGI() {
    if (g_staging)     { g_staging->Release();     g_staging     = nullptr; }
    if (g_duplication) { g_duplication->Release(); g_duplication = nullptr; }
    if (g_context)     { g_context->Release();     g_context     = nullptr; }
    if (g_device)      { g_device->Release();      g_device      = nullptr; }
    g_captureWidth = g_captureHeight = 0;
    g_outputWidth = g_outputHeight = 0;
}

static bool initDXGI() {
    // ── 1. Create D3D11 device ──
    D3D_FEATURE_LEVEL featureLevel;
    HRESULT hr = D3D11CreateDevice(
        nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
        0,       // flags — no debug layer in production
        nullptr, 0,
        D3D11_SDK_VERSION,
        &g_device, &featureLevel, &g_context);

    if (FAILED(hr)) {
        VIDEO_LOG_HR("D3D11CreateDevice failed", hr);
        return false;
    }
    VIDEO_LOG("D3D11 device created (feature level 0x%x)", static_cast<int>(featureLevel));

    // ── 2. Walk DXGI chain: Device → Adapter → Output → Output1 ──
    IDXGIDevice* dxgiDevice = nullptr;
    hr = g_device->QueryInterface(__uuidof(IDXGIDevice), reinterpret_cast<void**>(&dxgiDevice));
    if (FAILED(hr)) { VIDEO_LOG_HR("QI IDXGIDevice", hr); releaseDXGI(); return false; }

    IDXGIAdapter* adapter = nullptr;
    hr = dxgiDevice->GetAdapter(&adapter);
    dxgiDevice->Release();
    if (FAILED(hr)) { VIDEO_LOG_HR("GetAdapter", hr); releaseDXGI(); return false; }

    IDXGIOutput* output = nullptr;
    hr = adapter->EnumOutputs(0, &output);
    adapter->Release();
    if (FAILED(hr)) { VIDEO_LOG_HR("EnumOutputs(0)", hr); releaseDXGI(); return false; }

    DXGI_OUTPUT_DESC outputDesc;
    output->GetDesc(&outputDesc);
    g_captureWidth  = outputDesc.DesktopCoordinates.right  - outputDesc.DesktopCoordinates.left;
    g_captureHeight = outputDesc.DesktopCoordinates.bottom - outputDesc.DesktopCoordinates.top;
    updateOutputSize();
    VIDEO_LOG("Primary output: %ux%u", g_captureWidth, g_captureHeight);

    IDXGIOutput1* output1 = nullptr;
    hr = output->QueryInterface(__uuidof(IDXGIOutput1), reinterpret_cast<void**>(&output1));
    output->Release();
    if (FAILED(hr)) { VIDEO_LOG_HR("QI IDXGIOutput1", hr); releaseDXGI(); return false; }

    // ── 3. Duplicate output ──
    hr = output1->DuplicateOutput(g_device, &g_duplication);
    output1->Release();
    if (FAILED(hr)) {
        VIDEO_LOG_HR("DuplicateOutput", hr);
        releaseDXGI();
        return false;
    }

    // ── 4. CPU-readable staging texture ──
    D3D11_TEXTURE2D_DESC staging{};
    staging.Width            = g_captureWidth;
    staging.Height           = g_captureHeight;
    staging.MipLevels        = 1;
    staging.ArraySize        = 1;
    staging.Format           = DXGI_FORMAT_B8G8R8A8_UNORM;
    staging.SampleDesc.Count = 1;
    staging.Usage            = D3D11_USAGE_STAGING;
    staging.CPUAccessFlags   = D3D11_CPU_ACCESS_READ;

    hr = g_device->CreateTexture2D(&staging, nullptr, &g_staging);
    if (FAILED(hr)) {
        VIDEO_LOG_HR("CreateTexture2D staging", hr);
        releaseDXGI();
        return false;
    }

    VIDEO_LOG("DXGI Desktop Duplication ready: capture=%ux%u output=%ux%u BGRA",
        g_captureWidth, g_captureHeight, g_outputWidth, g_outputHeight);
    return true;
}

// ────────────────── Capture thread ──────────────────

static void captureLoop() {
    VIDEO_LOG("Capture thread started (target %d fps)", g_targetFps.load());

    LARGE_INTEGER freq;
    QueryPerformanceFrequency(&freq);

    uint64_t frameCount     = 0;
    uint64_t skipCount      = 0;
    uint64_t queueDropCount = 0;
    auto     lastLogTime    = std::chrono::steady_clock::now();
    uint64_t lastLogFrameCount = 0;
    uint64_t lastLogSkipCount = 0;
    uint64_t lastLogQueueDropCount = 0;

    // Frame pacing — hold a stable release cadence instead of accepting frames
    // relative to the previous callback time. This reduces early/late clustering.
    const int64_t targetIntervalTicks = static_cast<int64_t>(
        (static_cast<double>(freq.QuadPart) / static_cast<double>(g_targetFps.load())) + 0.5);
    const int64_t earlyAllowanceTicks = targetIntervalTicks / 10;
    const int64_t lateResetTicks = targetIntervalTicks * 3;
    LARGE_INTEGER nextFrameDeadline;
    QueryPerformanceCounter(&nextFrameDeadline);
    nextFrameDeadline.QuadPart += targetIntervalTicks;

    while (g_running.load(std::memory_order_relaxed)) {
        DXGI_OUTDUPL_FRAME_INFO frameInfo{};
        IDXGIResource* desktopResource = nullptr;

        // Timeout 16 ms — up to ~62 fps poll rate
        HRESULT hr = g_duplication->AcquireNextFrame(16, &frameInfo, &desktopResource);

        if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
            continue;   // desktop unchanged
        }

        if (FAILED(hr)) {
            if (hr == DXGI_ERROR_ACCESS_LOST) {
                VIDEO_LOG("Access lost — reinitialising duplication");
                releaseDXGI();
                if (!initDXGI()) {
                    VIDEO_LOG("Reinit failed, stopping capture");
                    break;
                }
                continue;
            }
            VIDEO_LOG_HR("AcquireNextFrame failed", hr);
            break;
        }

        // Skip frames without a visual update (cursor-only, etc.)
        if (frameInfo.LastPresentTime.QuadPart == 0) {
            desktopResource->Release();
            g_duplication->ReleaseFrame();
            ++skipCount;
            continue;
        }

        // ── Frame-pacing gate ──
        LARGE_INTEGER now;
        QueryPerformanceCounter(&now);
        if ((now.QuadPart + earlyAllowanceTicks) < nextFrameDeadline.QuadPart) {
            // Too soon for the next scheduled frame — skip and keep cadence stable.
            desktopResource->Release();
            g_duplication->ReleaseFrame();
            ++skipCount;
            continue;
        }

        if (now.QuadPart > (nextFrameDeadline.QuadPart + lateResetTicks)) {
            nextFrameDeadline = now;
        }

        do {
            nextFrameDeadline.QuadPart += targetIntervalTicks;
        } while (nextFrameDeadline.QuadPart <= now.QuadPart);

        // ── Copy frame texture to staging ──
        ID3D11Texture2D* frameTex = nullptr;
        hr = desktopResource->QueryInterface(__uuidof(ID3D11Texture2D),
                                             reinterpret_cast<void**>(&frameTex));
        desktopResource->Release();
        if (FAILED(hr)) { g_duplication->ReleaseFrame(); continue; }

        g_context->CopyResource(g_staging, frameTex);
        frameTex->Release();

        // ── Map staging → CPU-readable ──
        D3D11_MAPPED_SUBRESOURCE mapped{};
        hr = g_context->Map(g_staging, 0, D3D11_MAP_READ, 0, &mapped);
        if (FAILED(hr)) { g_duplication->ReleaseFrame(); continue; }

        // ── Copy pixels and scale to the active profile before JS/encoder ──
        const uint32_t rowBytes = g_outputWidth * 4;
        const uint32_t dataSize = rowBytes * g_outputHeight;
        uint8_t* pixels = static_cast<uint8_t*>(std::malloc(dataSize));

        if (pixels) {
            const uint8_t* src = static_cast<const uint8_t*>(mapped.pData);
            if (g_outputWidth == g_captureWidth && g_outputHeight == g_captureHeight) {
                uint8_t* dst = pixels;
                if (mapped.RowPitch == rowBytes) {
                    std::memcpy(dst, src, dataSize);
                } else {
                    for (uint32_t y = 0; y < g_captureHeight; ++y) {
                        std::memcpy(dst, src, rowBytes);
                        src += mapped.RowPitch;
                        dst += rowBytes;
                    }
                }
            } else {
                downscaleFrameNearest(src, g_captureWidth, g_captureHeight, mapped.RowPitch,
                    pixels, g_outputWidth, g_outputHeight);
            }

            uint64_t tsUs = static_cast<uint64_t>(
                now.QuadPart * 1000000.0 / freq.QuadPart);
            const uint64_t epochTimestampUs = static_cast<uint64_t>(
                std::chrono::duration_cast<std::chrono::microseconds>(
                    std::chrono::system_clock::now().time_since_epoch()).count());

            auto* fd = new FrameData{ pixels, g_outputWidth, g_outputHeight,
                                      rowBytes, tsUs, epochTimestampUs, dataSize };
            const napi_status queueStatus = g_videoTsfn.NonBlockingCall(fd);
            if (queueStatus == napi_ok) {
                ++frameCount;
            } else {
                ++queueDropCount;
                ++g_framesDropped;
                std::free(fd->pixels);
                delete fd;
            }

            if (frameCount == 1) {
                VIDEO_LOG("First frame: capture=%ux%u output=%ux%u pitch=%u size=%u bytes",
                    g_captureWidth, g_captureHeight, g_outputWidth, g_outputHeight,
                    mapped.RowPitch, dataSize);
            }
        }

        g_context->Unmap(g_staging, 0);
        g_duplication->ReleaseFrame();

        // ── Periodic log ──
        auto elapsed = std::chrono::steady_clock::now() - lastLogTime;
        if (elapsed >= std::chrono::seconds(5)) {
            double secs = std::chrono::duration<double>(elapsed).count();
            const uint64_t framesThisWindow = frameCount - lastLogFrameCount;
            const uint64_t skipsThisWindow = skipCount - lastLogSkipCount;
            const uint64_t queueDropsThisWindow = queueDropCount - lastLogQueueDropCount;
            VIDEO_LOG("frames=%llu windowFps=%.1f skipped=%llu windowSkipped=%llu queueDropped=%llu windowQueueDropped=%llu totalDropped=%llu output=%ux%u",
                      static_cast<unsigned long long>(frameCount),
                      framesThisWindow / secs,
                      static_cast<unsigned long long>(skipCount),
                      static_cast<unsigned long long>(skipsThisWindow),
                      static_cast<unsigned long long>(queueDropCount),
                      static_cast<unsigned long long>(queueDropsThisWindow),
                      static_cast<unsigned long long>(g_framesDropped.load()),
                      g_outputWidth, g_outputHeight);
            lastLogTime = std::chrono::steady_clock::now();
            lastLogFrameCount = frameCount;
            lastLogSkipCount = skipCount;
            lastLogQueueDropCount = queueDropCount;
        }
    }

    VIDEO_LOG("Capture thread exiting (%llu frames, %llu skipped, %llu dropped)",
              static_cast<unsigned long long>(frameCount),
              static_cast<unsigned long long>(skipCount),
              static_cast<unsigned long long>(g_framesDropped.load()));
}

// ────────────────── N-API exports ──────────────────

Napi::Value game_video::RegisterVideoCallback(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "Expected callback function").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Release previous TSFN if any
    if (g_videoTsfn) {
        g_videoTsfn.Release();
    }

    g_videoTsfn = VideoTSFN::New(
        env,
        info[0].As<Napi::Function>(),
        "GameVideoCapture",
        2,
        1     // initial thread count
    );

    VIDEO_LOG("Video callback registered");
    return env.Undefined();
}

Napi::Value game_video::StartCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto result = Napi::Object::New(env);

    if (g_running.load()) {
        result.Set("success", Napi::Boolean::New(env, false));
        result.Set("reason",  Napi::String::New(env, "already-capturing"));
        return result;
    }

    g_framesDropped.store(0);
    g_maxWidth = 0;
    g_maxHeight = 0;

    // Optional: { fps, maxWidth, maxHeight }
    if (info.Length() > 0 && info[0].IsObject()) {
        auto opts = info[0].As<Napi::Object>();
        if (opts.Has("fps") && opts.Get("fps").IsNumber()) {
            int requestedFps = opts.Get("fps").As<Napi::Number>().Int32Value();
            if (requestedFps < 15) requestedFps = 15;
            if (requestedFps > 60) requestedFps = 60;
            g_targetFps.store(requestedFps);
        }
        if (opts.Has("maxWidth") && opts.Get("maxWidth").IsNumber()) {
            g_maxWidth = static_cast<uint32_t>(opts.Get("maxWidth").As<Napi::Number>().Uint32Value());
        }
        if (opts.Has("maxHeight") && opts.Get("maxHeight").IsNumber()) {
            g_maxHeight = static_cast<uint32_t>(opts.Get("maxHeight").As<Napi::Number>().Uint32Value());
        }
    }

    if (!initDXGI()) {
        result.Set("success", Napi::Boolean::New(env, false));
        result.Set("reason",  Napi::String::New(env, "dxgi-init-failed"));
        return result;
    }

    g_running.store(true);
    g_captureThread = std::thread(captureLoop);

    result.Set("success", Napi::Boolean::New(env, true));
    result.Set("width",   Napi::Number::New(env, g_outputWidth));
    result.Set("height",  Napi::Number::New(env, g_outputHeight));
    result.Set("format",  Napi::String::New(env, "BGRA"));
    VIDEO_LOG("Capture started: capture=%ux%u output=%ux%u @ %d fps target",
        g_captureWidth, g_captureHeight, g_outputWidth, g_outputHeight, g_targetFps.load());
    return result;
}

Napi::Value game_video::StopCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!g_running.load()) {
        return Napi::Boolean::New(env, false);
    }

    VIDEO_LOG("Stopping capture...");
    g_running.store(false);

    if (g_captureThread.joinable()) {
        g_captureThread.join();
    }

    releaseDXGI();

    if (g_videoTsfn) {
        g_videoTsfn.Release();
        g_videoTsfn = {};
    }

    VIDEO_LOG("Capture stopped and resources released");
    return Napi::Boolean::New(env, true);
}

Napi::Value game_video::IsCapturing(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), g_running.load());
}
