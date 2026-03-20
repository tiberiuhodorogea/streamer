/**
 * Windows Graphics Capture (WGC) implementation with frame delivery.
 *
 * Captures game windows via WinRT WGC API and delivers BGRA pixel buffers
 * to Node.js through a ThreadSafeFunction callback. Bypasses DWM compositing
 * for lower latency and true vsync-aligned frame delivery.
 *
 * Requirements:
 *   - Windows 10 version 1903 (build 18362) or later
 *   - Windows SDK 10.0.18362.0+
 *   - C++/WinRT headers (included in Windows SDK)
 *   - Link with windowsapp.lib, d3d11.lib, dxgi.lib
 */

#include "wgc_capture.h"
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <cstdio>
#include <mutex>
#include <atomic>
#include <cstdlib>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <windows.graphics.capture.interop.h>
#include <winrt/base.h>

struct __declspec(uuid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1"))
IDirect3DDxgiInterfaceAccess : ::IUnknown {
    virtual HRESULT __stdcall GetInterface(REFIID riid, void** ppv) = 0;
};

extern "C" HRESULT __stdcall CreateDirect3D11DeviceFromDXGIDevice(
    IDXGIDevice* dxgiDevice, IInspectable** graphicsDevice);

namespace wrt = winrt;
namespace wgc = winrt::Windows::Graphics::Capture;
namespace wdx = winrt::Windows::Graphics::DirectX;
namespace wd3d = winrt::Windows::Graphics::DirectX::Direct3D11;

static std::atomic<bool> g_framePending{false};

// ────────────────────────────────────────────────────────────
// Frame data passed through the ThreadSafeFunction
// ────────────────────────────────────────────────────────────
struct FrameData {
    uint8_t* pixels;      // heap-allocated BGRA, ownership transferred
    uint32_t dataSize;
    uint32_t width;
    uint32_t height;
    uint64_t frameIndex;
};

// TSFN callback — runs on Node.js main thread
static void onFrameDelivery(Napi::Env env, Napi::Function fn, std::nullptr_t*, FrameData* data) {
    if (!data) return;
    if (env != nullptr && fn != nullptr) {
        // Create ArrayBuffer that takes ownership of the pixel data
        auto ab = Napi::ArrayBuffer::New(env, data->pixels, data->dataSize,
            [](Napi::Env, void* p) { free(p); });
        auto view = Napi::Uint8Array::New(env, data->dataSize, ab, 0);

        auto meta = Napi::Object::New(env);
        meta.Set("width", Napi::Number::New(env, data->width));
        meta.Set("height", Napi::Number::New(env, data->height));
        meta.Set("frameIndex", Napi::Number::New(env, static_cast<double>(data->frameIndex)));

        fn.Call({view, meta});
    } else {
        free(data->pixels);
    }
    g_framePending.store(false, std::memory_order_release);
    delete data;
}

using FrameTSFN = Napi::TypedThreadSafeFunction<std::nullptr_t, FrameData, onFrameDelivery>;

// ────────────────────────────────────────────────────────────
// Capture session state (singleton — one capture at a time)
// ────────────────────────────────────────────────────────────
static struct CaptureState {
    std::mutex mtx;
    std::atomic<bool> active{false};

    // WGC objects
    wgc::GraphicsCaptureItem         item{nullptr};
    wgc::Direct3D11CaptureFramePool  pool{nullptr};
    wgc::GraphicsCaptureSession      session{nullptr};
    wrt::event_token                 frameToken{};

    // D3D11 resources
    wrt::com_ptr<ID3D11Device>        d3dDevice;
    wrt::com_ptr<ID3D11DeviceContext>  d3dContext;
    wd3d::IDirect3DDevice             winrtDevice{nullptr};
    wrt::com_ptr<ID3D11Texture2D>     stagingTexture;

    // Frame dimensions
    uint32_t width  = 0;
    uint32_t height = 0;
    uint64_t frameCount = 0;

    // Frame delivery via TSFN
    FrameTSFN tsfn;
    std::atomic<bool> tsfnActive{false};
} g_capture;

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

static bool isWgcSupported() {
    return wrt::Windows::Foundation::Metadata::ApiInformation::IsTypePresent(
        L"Windows.Graphics.Capture.GraphicsCaptureSession");
}

static bool createD3DDevice() {
    D3D_FEATURE_LEVEL levels[] = {
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
    };

    ID3D11Device* raw = nullptr;
    ID3D11DeviceContext* ctx = nullptr;
    HRESULT hr = D3D11CreateDevice(
        nullptr,
        D3D_DRIVER_TYPE_HARDWARE,
        nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        levels, ARRAYSIZE(levels),
        D3D11_SDK_VERSION,
        &raw, nullptr, &ctx);

    if (FAILED(hr)) return false;

    g_capture.d3dDevice.attach(raw);
    g_capture.d3dContext.attach(ctx);

    wrt::com_ptr<IDXGIDevice> dxgiDevice;
    hr = raw->QueryInterface(__uuidof(IDXGIDevice), dxgiDevice.put_void());
    if (FAILED(hr)) return false;

    wrt::com_ptr<::IInspectable> inspectable;
    hr = CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.get(), inspectable.put());
    if (FAILED(hr)) return false;

    g_capture.winrtDevice = inspectable.as<wd3d::IDirect3DDevice>();
    return true;
}

static bool createStagingTexture(uint32_t w, uint32_t h) {
    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width            = w;
    desc.Height           = h;
    desc.MipLevels        = 1;
    desc.ArraySize        = 1;
    desc.Format           = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage            = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags   = D3D11_CPU_ACCESS_READ;

    ID3D11Texture2D* tex = nullptr;
    HRESULT hr = g_capture.d3dDevice->CreateTexture2D(&desc, nullptr, &tex);
    if (FAILED(hr)) return false;

    g_capture.stagingTexture.attach(tex);
    return true;
}

/**
 * Frame-arrived callback. Runs on a WGC thread-pool thread.
 * Copies pixels to a heap buffer and delivers via TSFN to Node.js.
 */
static void onFrameArrived(
    wgc::Direct3D11CaptureFramePool const& sender,
    wrt::Windows::Foundation::IInspectable const&)
{
    if (!g_capture.active.load(std::memory_order_relaxed)) return;

    // Skip if previous frame hasn't been consumed yet (back-pressure)
    if (g_framePending.load(std::memory_order_relaxed)) {
        // Still drain the pool to avoid stalling WGC
        auto frame = sender.TryGetNextFrame();
        if (frame) frame.Close();
        return;
    }

    auto frame = sender.TryGetNextFrame();
    if (!frame) return;

    g_capture.frameCount++;

    auto surface = frame.Surface();
    wrt::com_ptr<IDirect3DDxgiInterfaceAccess> access;
    HRESULT hr = wrt::get_unknown(surface)->QueryInterface(
        __uuidof(IDirect3DDxgiInterfaceAccess), access.put_void());
    if (FAILED(hr)) { frame.Close(); return; }

    wrt::com_ptr<ID3D11Texture2D> frameTex;
    hr = access->GetInterface(__uuidof(ID3D11Texture2D), frameTex.put_void());
    if (FAILED(hr)) { frame.Close(); return; }

    // Copy GPU texture to CPU-readable staging texture
    g_capture.d3dContext->CopyResource(g_capture.stagingTexture.get(), frameTex.get());

    // Map staging texture and copy pixels to a heap buffer
    D3D11_MAPPED_SUBRESOURCE mapped = {};
    hr = g_capture.d3dContext->Map(g_capture.stagingTexture.get(), 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED(hr)) { frame.Close(); return; }

    const uint32_t w = g_capture.width;
    const uint32_t h = g_capture.height;
    const uint32_t rowBytes = w * 4; // BGRA = 4 bytes/pixel
    const uint32_t dataSize = rowBytes * h;

    auto* pixels = static_cast<uint8_t*>(malloc(dataSize));
    if (pixels) {
        // Copy row-by-row to handle stride mismatch
        const uint8_t* src = static_cast<const uint8_t*>(mapped.pData);
        for (uint32_t y = 0; y < h; y++) {
            memcpy(pixels + y * rowBytes, src + y * mapped.RowPitch, rowBytes);
        }
    }

    g_capture.d3dContext->Unmap(g_capture.stagingTexture.get(), 0);
    frame.Close();

    // Deliver to Node.js via TSFN
    if (pixels && g_capture.tsfnActive.load(std::memory_order_relaxed)) {
        auto* fd = new FrameData{pixels, dataSize, w, h, g_capture.frameCount};
        g_framePending.store(true, std::memory_order_release);
        auto status = g_capture.tsfn.NonBlockingCall(fd);
        if (status != napi_ok) {
            // TSFN rejected (shutting down or queue full)
            g_framePending.store(false, std::memory_order_release);
            free(fd->pixels);
            delete fd;
        }
    } else {
        free(pixels);
    }
}

// ────────────────────────────────────────────────────────────
// N-API exports
// ────────────────────────────────────────────────────────────

Napi::Value wgc_capture::IsSupported(const Napi::CallbackInfo& info) {
    bool supported = false;
    try { supported = isWgcSupported(); } catch (...) {}
    return Napi::Boolean::New(info.Env(), supported);
}

Napi::Value wgc_capture::RegisterFrameCallback(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "Expected callback function").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Release previous TSFN if any
    if (g_capture.tsfnActive.load()) {
        g_capture.tsfnActive.store(false);
        g_capture.tsfn.Release();
    }

    g_capture.tsfn = FrameTSFN::New(
        env,
        info[0].As<Napi::Function>(),
        "WgcFrameCallback",
        0,    // unlimited queue
        1     // initial thread count
    );
    g_capture.tsfnActive.store(true);
    g_framePending.store(false);

    return env.Undefined();
}

Napi::Value wgc_capture::StartCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 4) {
        Napi::TypeError::New(env, "Expected (hwnd, width, height, fps)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Stop any existing capture
    if (g_capture.active.load()) {
        wgc_capture::StopCapture(info);
    }

    std::lock_guard<std::mutex> lock(g_capture.mtx);

    auto hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
    uint32_t width  = info[1].As<Napi::Number>().Uint32Value();
    uint32_t height = info[2].As<Napi::Number>().Uint32Value();
    (void)info[3]; // fps reserved

    if (!IsWindow(hwnd)) {
        Napi::Error::New(env, "Invalid HWND").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    try {
        wrt::init_apartment(wrt::apartment_type::multi_threaded);
    } catch (...) {}

    if (!isWgcSupported()) {
        Napi::Error::New(env, "WGC not supported (requires Win10 1903+)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (!createD3DDevice()) {
        Napi::Error::New(env, "Failed to create D3D11 device").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Create GraphicsCaptureItem from HWND
    try {
        auto interop = wrt::get_activation_factory<wgc::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
        wgc::GraphicsCaptureItem item{nullptr};
        HRESULT hr = interop->CreateForWindow(
            hwnd,
            wrt::guid_of<wgc::IGraphicsCaptureItem>(),
            wrt::put_abi(item));
        if (FAILED(hr) || !item) {
            Napi::Error::New(env, "Could not create capture item for HWND").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        g_capture.item = item;

        auto size = item.Size();
        if (width == 0)  width  = static_cast<uint32_t>(size.Width);
        if (height == 0) height = static_cast<uint32_t>(size.Height);
    } catch (wrt::hresult_error const& e) {
        std::string msg = "WGC CreateForWindow failed: ";
        msg += wrt::to_string(e.message());
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    g_capture.width  = width;
    g_capture.height = height;

    if (!createStagingTexture(width, height)) {
        Napi::Error::New(env, "Failed to create staging texture").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Create frame pool (FreeThreaded — fires on thread pool, no UI thread needed)
    try {
        g_capture.pool = wgc::Direct3D11CaptureFramePool::CreateFreeThreaded(
            g_capture.winrtDevice,
            wdx::DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,  // 2 buffers for smoother pipelining
            { static_cast<int32_t>(width), static_cast<int32_t>(height) });

        g_capture.frameToken = g_capture.pool.FrameArrived(onFrameArrived);
    } catch (wrt::hresult_error const& e) {
        std::string msg = "WGC frame pool creation failed: ";
        msg += wrt::to_string(e.message());
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    try {
        g_capture.session = g_capture.pool.CreateCaptureSession(g_capture.item);
        g_capture.session.IsBorderRequired(false);
        // Exclude the OS cursor from captured frames (Win10 2004+ / build 19041+)
        try { g_capture.session.IsCursorCaptureEnabled(false); } catch (...) {}
    } catch (...) {}

    try {
        g_capture.session.StartCapture();
        g_capture.active.store(true);
        g_capture.frameCount = 0;
        g_framePending.store(false);
    } catch (wrt::hresult_error const& e) {
        std::string msg = "WGC StartCapture failed: ";
        msg += wrt::to_string(e.message());
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    return Napi::Boolean::New(env, true);
}

Napi::Value wgc_capture::StopCapture(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> lock(g_capture.mtx);

    g_capture.active.store(false);

    // Release TSFN
    if (g_capture.tsfnActive.load()) {
        g_capture.tsfnActive.store(false);
        g_capture.tsfn.Release();
    }
    g_framePending.store(false);

    try {
        if (g_capture.session) {
            g_capture.session.Close();
            g_capture.session = nullptr;
        }
        if (g_capture.pool) {
            g_capture.pool.FrameArrived(g_capture.frameToken);
            g_capture.pool.Close();
            g_capture.pool = nullptr;
        }
        g_capture.item = nullptr;
    } catch (...) {}

    g_capture.stagingTexture = nullptr;
    g_capture.d3dContext = nullptr;
    g_capture.d3dDevice = nullptr;
    g_capture.winrtDevice = nullptr;

    return Napi::Boolean::New(info.Env(), true);
}
