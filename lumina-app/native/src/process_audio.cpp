#include "process_audio.h"
#include "native_log.h"

#include <windows.h>
#include <Audioclient.h>
#include <audioclientactivationparams.h>
#include <Mmdeviceapi.h>
#include <ksmedia.h>
#include <wrl.h>
#include <wrl/implements.h>

#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <cstdio>
#include <mutex>
#include <thread>
#include <vector>

#define AUDIO_LOG(fmt, ...) do { \
    fprintf(stderr, "[PROCESS-AUDIO] " fmt "\n", ##__VA_ARGS__); \
    native_log::writef("PROCESS-AUDIO", fmt, ##__VA_ARGS__); \
} while (0)
#define AUDIO_LOG_HR(label, hr) do { \
    fprintf(stderr, "[PROCESS-AUDIO] %s hr=0x%08lx\n", label, static_cast<unsigned long>(hr)); \
    native_log::writef("PROCESS-AUDIO", "%s hr=0x%08lx", label, static_cast<unsigned long>(hr)); \
} while (0)

using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::ComPtr;

#ifndef VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
#endif

struct AudioChunkData {
    uint8_t* samples;
    uint32_t dataSize;
    uint32_t sampleRate;
    uint16_t channels;
    uint32_t frameCount;
};

static void onAudioDelivery(Napi::Env env, Napi::Function fn, std::nullptr_t*, AudioChunkData* data) {
    if (!data) return;
    if (env != nullptr && fn != nullptr) {
        try {
            // Use a regular (non-external) ArrayBuffer and copy data into it.
            // External ArrayBuffers backed by malloc'd memory fail Electron's
            // structured-clone IPC serialization, causing N-API uncaught exceptions.
            auto ab = Napi::ArrayBuffer::New(env, data->dataSize);
            memcpy(ab.Data(), data->samples, data->dataSize);
            free(data->samples);
            auto view = Napi::Uint8Array::New(env, data->dataSize, ab, 0);

            auto meta = Napi::Object::New(env);
            meta.Set("sampleRate", Napi::Number::New(env, data->sampleRate));
            meta.Set("channels", Napi::Number::New(env, data->channels));
            meta.Set("frameCount", Napi::Number::New(env, data->frameCount));
            meta.Set("format", Napi::String::New(env, "f32"));

            fn.Call({ view, meta });
        } catch (...) {
            // Prevent N-API uncaught exception warnings from flooding logs
        }
    } else {
        free(data->samples);
    }
    delete data;
}

using AudioTSFN = Napi::TypedThreadSafeFunction<std::nullptr_t, AudioChunkData, onAudioDelivery>;

class ActivateAudioCompletionHandler
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase, IActivateAudioInterfaceCompletionHandler> {
public:
    explicit ActivateAudioCompletionHandler(HANDLE doneEvent) : doneEvent_(doneEvent) {}

    // This runs on an MTA thread — all IAudioClient calls MUST happen here,
    // because the process loopback virtual device doesn't marshal to STA.
    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation) override {
        HRESULT hr = S_OK;
        HRESULT activateResult = E_FAIL;
        IUnknown* activatedInterface = nullptr;

        AUDIO_LOG("ActivateCompleted callback fired (MTA thread)");

        if (!operation) {
            AUDIO_LOG("ActivateCompleted called with null operation!");
            hr_ = E_FAIL;
            SetEvent(doneEvent_);
            return S_OK;
        }

        hr = operation->GetActivateResult(&activateResult, &activatedInterface);
        AUDIO_LOG("GetActivateResult: outer hr=0x%08lx, activateResult=0x%08lx, interface=%p",
                  (unsigned long)hr, (unsigned long)activateResult, activatedInterface);

        if (FAILED(hr) || FAILED(activateResult) || !activatedInterface) {
            hr_ = FAILED(hr) ? hr : activateResult;
            if (activatedInterface) activatedInterface->Release();
            SetEvent(doneEvent_);
            return S_OK;
        }

        HRESULT qiHr = activatedInterface->QueryInterface(IID_PPV_ARGS(&audioClient_));
        activatedInterface->Release();
        AUDIO_LOG("QueryInterface IAudioClient: hr=0x%08lx, client=%p", (unsigned long)qiHr, audioClient_.Get());

        if (FAILED(qiHr) || !audioClient_) {
            hr_ = qiHr;
            SetEvent(doneEvent_);
            return S_OK;
        }

        // --- All IAudioClient calls must happen here on MTA ---

        // 1. GetMixFormat
        WAVEFORMATEX* mixFormat = nullptr;
        hr = audioClient_->GetMixFormat(&mixFormat);
        AUDIO_LOG("GetMixFormat: hr=0x%08lx, format=%p", (unsigned long)hr, mixFormat);

        WAVEFORMATEX* formatToUse = nullptr;
        bool freeMixFormat = false;

        if (SUCCEEDED(hr) && mixFormat) {
            AUDIO_LOG("MixFormat: rate=%u ch=%u bits=%u tag=%u",
                      mixFormat->nSamplesPerSec, mixFormat->nChannels,
                      mixFormat->wBitsPerSample, mixFormat->wFormatTag);
            formatToUse = mixFormat;
            freeMixFormat = true;
        } else {
            AUDIO_LOG("GetMixFormat failed/unavailable, building default EXTENSIBLE 48kHz/f32/2ch");
            static WAVEFORMATEXTENSIBLE defaultFmt = {};
            defaultFmt.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
            defaultFmt.Format.nChannels = 2;
            defaultFmt.Format.nSamplesPerSec = 48000;
            defaultFmt.Format.wBitsPerSample = 32;
            defaultFmt.Format.nBlockAlign = defaultFmt.Format.nChannels * (defaultFmt.Format.wBitsPerSample / 8);
            defaultFmt.Format.nAvgBytesPerSec = defaultFmt.Format.nSamplesPerSec * defaultFmt.Format.nBlockAlign;
            defaultFmt.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
            defaultFmt.Samples.wValidBitsPerSample = 32;
            defaultFmt.dwChannelMask = SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT;
            defaultFmt.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
            formatToUse = &defaultFmt.Format;
        }

        // 2. Initialize — AUDCLNT_STREAMFLAGS_LOOPBACK is required for process loopback
        DWORD streamFlags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
        AUDIO_LOG("Initializing AudioClient: %uHz, %uch, %ubit, tag=%u, flags=0x%lx",
                  formatToUse->nSamplesPerSec, formatToUse->nChannels,
                  formatToUse->wBitsPerSample, formatToUse->wFormatTag, streamFlags);

        hr = audioClient_->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            streamFlags,
            200000,   // 20ms buffer in 100-ns units
            0,
            formatToUse,
            nullptr);

        if (FAILED(hr)) {
            AUDIO_LOG_HR("Initialize with LOOPBACK|EVENTCALLBACK FAILED", hr);
            // Retry with LOOPBACK only (polling mode)
            streamFlags = AUDCLNT_STREAMFLAGS_LOOPBACK;
            AUDIO_LOG("Retrying Initialize with LOOPBACK only, flags=0x%lx", streamFlags);
            hr = audioClient_->Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                streamFlags,
                200000,
                0,
                formatToUse,
                nullptr);
            if (FAILED(hr)) {
                AUDIO_LOG_HR("Initialize with LOOPBACK only ALSO FAILED", hr);
                if (freeMixFormat) CoTaskMemFree(mixFormat);
                hr_ = hr;
                SetEvent(doneEvent_);
                return S_OK;
            }
            usePolling_ = true;
        }
        AUDIO_LOG("AudioClient::Initialize OK (polling=%d)", usePolling_);

        // Store format info
        sampleRate_ = formatToUse->nSamplesPerSec;
        channels_ = static_cast<uint16_t>(formatToUse->nChannels);
        bitsPerSample_ = formatToUse->wBitsPerSample;
        isFloat_ = (formatToUse->wFormatTag == WAVE_FORMAT_IEEE_FLOAT);
        if (formatToUse->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
            auto* ext = reinterpret_cast<WAVEFORMATEXTENSIBLE*>(formatToUse);
            isFloat_ = (ext->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
        }
        AUDIO_LOG("Capture format: rate=%u ch=%u bits=%u isFloat=%d",
                  sampleRate_, channels_, bitsPerSample_, isFloat_);

        if (freeMixFormat) CoTaskMemFree(mixFormat);

        // 3. Set event handle if using EVENTCALLBACK
        if (!usePolling_) {
            captureEvent_ = CreateEvent(nullptr, FALSE, FALSE, nullptr);
            if (!captureEvent_) {
                AUDIO_LOG("Failed to create capture event");
                hr_ = E_FAIL;
                SetEvent(doneEvent_);
                return S_OK;
            }
            hr = audioClient_->SetEventHandle(captureEvent_);
            if (FAILED(hr)) {
                AUDIO_LOG_HR("SetEventHandle FAILED", hr);
                CloseHandle(captureEvent_);
                captureEvent_ = nullptr;
                hr_ = hr;
                SetEvent(doneEvent_);
                return S_OK;
            }
            AUDIO_LOG("SetEventHandle OK");
        }

        // 4. GetService for IAudioCaptureClient
        hr = audioClient_->GetService(IID_PPV_ARGS(&captureClient_));
        if (FAILED(hr) || !captureClient_) {
            AUDIO_LOG_HR("GetService(IAudioCaptureClient) FAILED", hr);
            if (captureEvent_) { CloseHandle(captureEvent_); captureEvent_ = nullptr; }
            hr_ = hr;
            SetEvent(doneEvent_);
            return S_OK;
        }
        AUDIO_LOG("GetService(IAudioCaptureClient) OK — full init done on MTA");

        hr_ = S_OK;
        SetEvent(doneEvent_);
        return S_OK;
    }

    HRESULT Result() const { return hr_; }
    IAudioClient* AudioClient() const { return audioClient_.Get(); }
    IAudioCaptureClient* CaptureClient() const { return captureClient_.Get(); }
    HANDLE CaptureEvent() const { return captureEvent_; }
    bool UsePolling() const { return usePolling_; }
    uint32_t SampleRate() const { return sampleRate_; }
    uint16_t Channels() const { return channels_; }
    uint16_t BitsPerSample() const { return bitsPerSample_; }
    bool IsFloat() const { return isFloat_; }

private:
    HANDLE doneEvent_ = nullptr;
    HRESULT hr_ = E_FAIL;
    ComPtr<IAudioClient> audioClient_;
    ComPtr<IAudioCaptureClient> captureClient_;
    HANDLE captureEvent_ = nullptr;
    bool usePolling_ = false;
    uint32_t sampleRate_ = 0;
    uint16_t channels_ = 0;
    uint16_t bitsPerSample_ = 0;
    bool isFloat_ = false;
};

static struct AudioCaptureState {
    std::mutex mtx;
    std::atomic<bool> active{ false };
    DWORD pid = 0;
    uint32_t sampleRate = 0;
    uint16_t channels = 0;
    uint16_t bitsPerSample = 0;
    bool isFloat = false;
    bool usePolling = false;

    ComPtr<IAudioClient> audioClient;
    ComPtr<IAudioCaptureClient> captureClient;

    HANDLE stopEvent = nullptr;
    HANDLE captureEvent = nullptr;   // for event-based capture (EVENTCALLBACK)
    std::thread captureThread;

    AudioTSFN tsfn;
    std::atomic<bool> tsfnActive{ false };
} g_audio;

static void cleanupAudioState() {
    if (g_audio.audioClient) {
        g_audio.audioClient->Stop();
    }

    if (g_audio.captureThread.joinable()) {
        g_audio.captureThread.join();
    }

    if (g_audio.stopEvent) {
        CloseHandle(g_audio.stopEvent);
        g_audio.stopEvent = nullptr;
    }

    if (g_audio.captureEvent) {
        CloseHandle(g_audio.captureEvent);
        g_audio.captureEvent = nullptr;
    }

    g_audio.captureClient.Reset();
    g_audio.audioClient.Reset();

    // Do NOT release TSFN here — it's registered separately via RegisterAudioCallback
    // and must survive across StartCapture/StopCapture cycles.

    g_audio.active.store(false);
    g_audio.pid = 0;
    g_audio.sampleRate = 0;
    g_audio.channels = 0;
    g_audio.bitsPerSample = 0;
    g_audio.isFloat = false;
    g_audio.usePolling = false;
}

static bool copyPacketAsFloat32(BYTE* packetData, UINT32 frameCount, DWORD flags, AudioChunkData*& outChunk) {
    if (frameCount == 0 || g_audio.channels == 0) return false;

    const uint16_t channels = g_audio.channels;
    const uint32_t sampleRate = g_audio.sampleRate;
    const uint32_t totalSamples = frameCount * channels;
    const uint32_t dataSize = totalSamples * sizeof(float);

    auto* out = static_cast<float*>(malloc(dataSize));
    if (!out) return false;

    if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) || packetData == nullptr) {
      memset(out, 0, dataSize);
    } else if (g_audio.isFloat && g_audio.bitsPerSample == 32) {
      memcpy(out, packetData, dataSize);
    } else if (!g_audio.isFloat && g_audio.bitsPerSample == 16) {
      auto* in = reinterpret_cast<int16_t*>(packetData);
      for (uint32_t i = 0; i < totalSamples; ++i) {
        out[i] = static_cast<float>(in[i]) / 32768.0f;
      }
    } else {
      free(out);
      return false;
    }

    outChunk = new AudioChunkData{
      reinterpret_cast<uint8_t*>(out),
      dataSize,
      sampleRate,
      channels,
      frameCount,
    };
    return true;
}

static void captureThreadMain() {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool comInitialized = SUCCEEDED(hr) || hr == RPC_E_CHANGED_MODE;

    AUDIO_LOG("Capture thread started (pid=%lu, polling=%d)", g_audio.pid, g_audio.usePolling);

    hr = g_audio.audioClient->Start();
    if (FAILED(hr)) {
        AUDIO_LOG_HR("AudioClient::Start FAILED", hr);
        if (comInitialized) CoUninitialize();
        return;
    }
    AUDIO_LOG("AudioClient::Start OK");

    uint64_t totalFrames = 0;
    uint64_t totalPackets = 0;
    uint64_t silentPackets = 0;
    bool firstPacketLogged = false;

    // Build wait handles: [stopEvent, captureEvent (if event-based)]
    HANDLE waitHandles[2] = { g_audio.stopEvent, nullptr };
    DWORD handleCount = 1;
    if (!g_audio.usePolling && g_audio.captureEvent) {
        waitHandles[1] = g_audio.captureEvent;
        handleCount = 2;
    }

    while (g_audio.active.load()) {
        DWORD waitMs = g_audio.usePolling ? 10 : 100;
        DWORD waitResult = WaitForMultipleObjects(handleCount, waitHandles, FALSE, waitMs);

        if (waitResult == WAIT_OBJECT_0) {
            // stopEvent signaled
            AUDIO_LOG("Capture thread: stop event signaled");
            break;
        }

        // Drain all available packets
        UINT32 packetFrames = 0;
        while (g_audio.captureClient && SUCCEEDED(g_audio.captureClient->GetNextPacketSize(&packetFrames)) && packetFrames > 0) {
            BYTE* packetData = nullptr;
            UINT32 framesAvailable = 0;
            DWORD flags = 0;

            hr = g_audio.captureClient->GetBuffer(&packetData, &framesAvailable, &flags, nullptr, nullptr);
            if (FAILED(hr)) {
                AUDIO_LOG_HR("GetBuffer FAILED", hr);
                break;
            }

            totalPackets++;
            totalFrames += framesAvailable;
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) silentPackets++;

            if (!firstPacketLogged) {
                AUDIO_LOG("First audio packet: frames=%u, flags=0x%lx, data=%p",
                          framesAvailable, flags, packetData);
                firstPacketLogged = true;
            }

            AudioChunkData* chunk = nullptr;
            if (copyPacketAsFloat32(packetData, framesAvailable, flags, chunk) && g_audio.tsfnActive.load()) {
                if (g_audio.tsfn.NonBlockingCall(chunk) != napi_ok) {
                    free(chunk->samples);
                    delete chunk;
                }
            }

            g_audio.captureClient->ReleaseBuffer(framesAvailable);
        }

        // Periodic stats every ~5 seconds
        if (totalPackets > 0 && totalPackets % 500 == 0) {
            AUDIO_LOG("Capture stats: packets=%llu frames=%llu silent=%llu",
                      totalPackets, totalFrames, silentPackets);
        }
    }

    AUDIO_LOG("Capture thread exiting: totalPackets=%llu, totalFrames=%llu, silentPackets=%llu",
              totalPackets, totalFrames, silentPackets);

    if (g_audio.audioClient) {
        g_audio.audioClient->Stop();
    }

    if (comInitialized) {
        CoUninitialize();
    }
}

Napi::Value process_audio::IsSupported(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), true);
}

Napi::Value process_audio::RegisterAudioCallback(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "Expected callback function").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (g_audio.tsfnActive.load()) {
        g_audio.tsfnActive.store(false);
        g_audio.tsfn.Release();
    }

    g_audio.tsfn = AudioTSFN::New(env, info[0].As<Napi::Function>(), "ProcessAudioCallback", 0, 1);
    g_audio.tsfnActive.store(true);
    return env.Undefined();
}

Napi::Value process_audio::StartCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected target process pid").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::lock_guard<std::mutex> lock(g_audio.mtx);
    cleanupAudioState();

    g_audio.pid = static_cast<DWORD>(info[0].As<Napi::Number>().Uint32Value());
    AUDIO_LOG("StartCapture called for pid=%lu", g_audio.pid);

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool comInitialized = SUCCEEDED(hr) || hr == RPC_E_CHANGED_MODE;
    AUDIO_LOG("CoInitializeEx: hr=0x%08lx, initialized=%d", (unsigned long)hr, comInitialized);

    HANDLE activationEvent = CreateEvent(nullptr, TRUE, FALSE, nullptr);
    g_audio.stopEvent = CreateEvent(nullptr, TRUE, FALSE, nullptr);
    if (!activationEvent || !g_audio.stopEvent) {
        AUDIO_LOG("FAILED to create events: activation=%p stop=%p",
                  activationEvent, g_audio.stopEvent);
        if (activationEvent) CloseHandle(activationEvent);
        if (comInitialized) CoUninitialize();
        Napi::Error::New(env, "Failed to create audio capture events").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    AUDIOCLIENT_ACTIVATION_PARAMS activationParams = {};
    activationParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    activationParams.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    activationParams.ProcessLoopbackParams.TargetProcessId = g_audio.pid;

    PROPVARIANT activateVariant = {};
    activateVariant.vt = VT_BLOB;
    activateVariant.blob.cbSize = sizeof(activationParams);
    activateVariant.blob.pBlobData = reinterpret_cast<BYTE*>(&activationParams);

    ComPtr<ActivateAudioCompletionHandler> completionHandler = Microsoft::WRL::Make<ActivateAudioCompletionHandler>(activationEvent);
    ComPtr<IActivateAudioInterfaceAsyncOperation> asyncOp;

    AUDIO_LOG("Calling ActivateAudioInterfaceAsync for pid=%lu...", g_audio.pid);
    hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        &activateVariant,
        completionHandler.Get(),
        &asyncOp);

    if (FAILED(hr)) {
        AUDIO_LOG_HR("ActivateAudioInterfaceAsync FAILED", hr);
        CloseHandle(activationEvent);
        cleanupAudioState();
        if (comInitialized) CoUninitialize();
        Napi::Error::New(env, "Process loopback activation failed").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    AUDIO_LOG("ActivateAudioInterfaceAsync returned OK, waiting for completion...");

    DWORD waitResult = WaitForSingleObject(activationEvent, 5000);
    CloseHandle(activationEvent);

    HRESULT completionHr = completionHandler->Result();
    AUDIO_LOG("Activation+Init wait: waitResult=%lu, completionHr=0x%08lx",
              waitResult, (unsigned long)completionHr);

    if (waitResult != WAIT_OBJECT_0 || FAILED(completionHr)) {
        char errMsg[256];
        sprintf_s(errMsg, "Process audio init failed (wait=%lu, hr=0x%08lx)",
                  waitResult, static_cast<unsigned long>(completionHr));
        AUDIO_LOG("%s", errMsg);
        cleanupAudioState();
        if (comInitialized) CoUninitialize();
        Napi::Error::New(env, errMsg).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // All init was done on the MTA thread — just copy results
    g_audio.audioClient = completionHandler->AudioClient();
    g_audio.captureClient = completionHandler->CaptureClient();
    g_audio.captureEvent = completionHandler->CaptureEvent();
    g_audio.usePolling = completionHandler->UsePolling();
    g_audio.sampleRate = completionHandler->SampleRate();
    g_audio.channels = completionHandler->Channels();
    g_audio.bitsPerSample = completionHandler->BitsPerSample();
    g_audio.isFloat = completionHandler->IsFloat();

    AUDIO_LOG("Audio init complete: rate=%u ch=%u bits=%u isFloat=%d polling=%d",
              g_audio.sampleRate, g_audio.channels, g_audio.bitsPerSample,
              g_audio.isFloat, g_audio.usePolling);

    g_audio.active.store(true);
    g_audio.captureThread = std::thread(captureThreadMain);
    AUDIO_LOG("Capture thread launched");

    if (comInitialized) CoUninitialize();

    Napi::Object result = Napi::Object::New(env);
    result.Set("sampleRate", Napi::Number::New(env, g_audio.sampleRate));
    result.Set("channels", Napi::Number::New(env, g_audio.channels));
    return result;
}

Napi::Value process_audio::StopCapture(const Napi::CallbackInfo& info) {
    AUDIO_LOG("StopCapture called (pid=%lu)", g_audio.pid);
    std::lock_guard<std::mutex> lock(g_audio.mtx);
    if (g_audio.stopEvent) {
        SetEvent(g_audio.stopEvent);
    }
    cleanupAudioState();

    // Release the TSFN on full stop (not in cleanupAudioState, which is also called by StartCapture)
    if (g_audio.tsfnActive.load()) {
        g_audio.tsfnActive.store(false);
        g_audio.tsfn.Release();
    }

    AUDIO_LOG("StopCapture complete");
    return Napi::Boolean::New(info.Env(), true);
}