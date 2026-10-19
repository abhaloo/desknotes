#include "wasapi-source.h"

#include <cstring>
#include <utility>

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <audioclient.h>
#include <avrt.h>
#include <mmdeviceapi.h>

static_assert(kBufferSilent == AUDCLNT_BUFFERFLAGS_SILENT, "silent flag must match WASAPI");
static_assert(kBufferDiscontinuity == AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY, "discontinuity flag must match WASAPI");
static_assert(kBufferTimestampError == AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR, "timestamp flag must match WASAPI");
static_assert(kStreamLoopback == AUDCLNT_STREAMFLAGS_LOOPBACK, "loopback flag must match WASAPI");
static_assert(kStreamEvent == AUDCLNT_STREAMFLAGS_EVENTCALLBACK, "event flag must match WASAPI");

namespace {

template <typename T>
class ComPtr {
 public:
  ComPtr() = default;
  ~ComPtr() { Reset(); }
  ComPtr(const ComPtr&) = delete;
  ComPtr& operator=(const ComPtr&) = delete;
  ComPtr(ComPtr&& other) noexcept : p_(other.p_) { other.p_ = nullptr; }
  ComPtr& operator=(ComPtr&& other) noexcept {
    if (this != &other) {
      Reset();
      p_ = other.p_;
      other.p_ = nullptr;
    }
    return *this;
  }

  T* Get() const { return p_; }
  T* operator->() const { return p_; }
  explicit operator bool() const { return p_ != nullptr; }
  void Adopt(T* p) {
    Reset();
    p_ = p;
  }
  void Reset() {
    if (p_) p_->Release();
    p_ = nullptr;
  }

 private:
  T* p_ = nullptr;
};

class ComApartment {
 public:
  ComApartment() {
    hr_ = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    uninit_ = hr_ == S_OK || hr_ == S_FALSE;
  }
  ~ComApartment() {
    if (uninit_) CoUninitialize();
  }
  bool ok() const { return SUCCEEDED(hr_) || hr_ == RPC_E_CHANGED_MODE; }

 private:
  HRESULT hr_ = E_FAIL;
  bool uninit_ = false;
};

class WasapiPacketSource final : public CapturePacketSource {
 public:
  explicit WasapiPacketSource(IAudioCaptureClient* client) : client_(client) {}

  std::int32_t Acquire(const std::uint8_t** data, std::uint32_t* frames, std::uint32_t* flags,
                       std::uint64_t* devicePosition, std::uint64_t* qpc100ns) override {
    BYTE* buffer = nullptr;
    UINT32 got = 0;
    DWORD bufferFlags = 0;
    UINT64 position = 0;
    UINT64 qpc = 0;
    const HRESULT hr = client_->GetBuffer(&buffer, &got, &bufferFlags, &position, &qpc);
    if (hr == AUDCLNT_S_BUFFER_EMPTY) return 1;
    if (FAILED(hr)) return -1;
    *data = buffer;
    *frames = got;
    *flags = bufferFlags;
    *devicePosition = position;
    *qpc100ns = qpc;
    return 0;
  }

  void Release(std::uint32_t frames) override { client_->ReleaseBuffer(frames); }

 private:
  IAudioCaptureClient* client_;
};

class EndpointNotifications final : public IMMNotificationClient {
 public:
  EndpointNotifications(std::wstring endpointId, bool watchDefault, EDataFlow flow, ERole role,
                        std::atomic<int>* invalidated, std::atomic<int>* defaultChanged)
      : endpointId_(std::move(endpointId)),
        watchDefault_(watchDefault),
        flow_(flow),
        role_(role),
        invalidated_(invalidated),
        defaultChanged_(defaultChanged) {}

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** object) override {
    if (!object) return E_POINTER;
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IMMNotificationClient)) {
      *object = static_cast<IMMNotificationClient*>(this);
      AddRef();
      return S_OK;
    }
    *object = nullptr;
    return E_NOINTERFACE;
  }

  ULONG STDMETHODCALLTYPE AddRef() override { return refs_.fetch_add(1) + 1; }

  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG value = refs_.fetch_sub(1) - 1;
    if (value == 0) delete this;
    return value;
  }

  HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR id, DWORD newState) override {
    if (Matches(id) && newState != DEVICE_STATE_ACTIVE) invalidated_->store(1);
    return S_OK;
  }

  HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) override { return S_OK; }

  HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR id) override {
    if (Matches(id)) invalidated_->store(1);
    return S_OK;
  }

  HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow flow, ERole role, LPCWSTR) override {
    const bool roleMatches = role == role_ || (role_ == eMultimedia && role == eConsole);
    if (watchDefault_ && flow == flow_ && roleMatches) defaultChanged_->store(1);
    return S_OK;
  }

  HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) override { return S_OK; }

 private:
  bool Matches(LPCWSTR id) const {
    return id && _wcsicmp(id, endpointId_.c_str()) == 0;
  }

  std::wstring endpointId_;
  bool watchDefault_;
  EDataFlow flow_;
  ERole role_;
  std::atomic<int>* invalidated_;
  std::atomic<int>* defaultChanged_;
  std::atomic<ULONG> refs_{1};
};

std::string HresultCode(HRESULT hr) {
  char buf[48];
  sprintf_s(buf, "hresult_0x%08lX", static_cast<unsigned long>(hr));
  return buf;
}

std::uint64_t QpcNow() {
  LARGE_INTEGER frequency{};
  LARGE_INTEGER now{};
  if (!QueryPerformanceFrequency(&frequency) || !QueryPerformanceCounter(&now) || frequency.QuadPart <= 0) {
    return 0;
  }
  return static_cast<std::uint64_t>((static_cast<unsigned long long>(now.QuadPart) * 10000000ull) /
                                    static_cast<unsigned long long>(frequency.QuadPart));
}

std::wstring Utf8ToWide(const std::string& text) {
  if (text.empty()) return L"";
  const int chars = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
  if (chars <= 0) return L"";
  std::wstring out(static_cast<std::size_t>(chars), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), chars);
  return out;
}

ERole RoleFromChoice(const DeviceChoice& choice) {
  if (choice.role == "communications") return eCommunications;
  return eMultimedia;
}

}  // namespace

bool DrainPackets(CapturePacketSource& source, const PcmFormat& format, PacketHandler onPacket, DrainResult* result) {
  if (!result) return false;
  *result = DrainResult{};
  for (;;) {
    const std::uint8_t* data = nullptr;
    std::uint32_t frames = 0;
    std::uint32_t flags = 0;
    std::uint64_t devicePosition = 0;
    std::uint64_t qpc = 0;
    const std::int32_t rc = source.Acquire(&data, &frames, &flags, &devicePosition, &qpc);
    if (rc == 1) return true;
    if (rc != 0) {
      result->failed = true;
      result->code = "capture_buffer";
      return false;
    }
    result->acquires += 1;
    struct Guard {
      CapturePacketSource* source;
      std::uint32_t frames;
      bool armed = true;
      ~Guard() {
        if (armed && source) source->Release(frames);
      }
    } guard{&source, frames};

    PacketFlags packetFlags;
    packetFlags.silent = (flags & kBufferSilent) != 0;
    packetFlags.discontinuity = (flags & kBufferDiscontinuity) != 0;
    packetFlags.timestampError = (flags & kBufferTimestampError) != 0;
    std::vector<float> mono;
    std::string error;
    if (!NormalizeToMono(format, packetFlags.silent ? nullptr : data, frames, packetFlags, &mono, &error)) {
      result->failed = true;
      result->code = error.empty() ? "unsupported_format" : error;
      return false;
    }
    try {
      if (onPacket) onPacket(mono, packetFlags, qpc, devicePosition);
      result->published += 1;
    } catch (...) {
      result->failed = true;
      result->code = "callback_error";
      return false;
    }
  }
}

WasapiSource::WasapiSource(std::uint64_t handle) : handle_(handle) {}

WasapiSource::~WasapiSource() { Stop(); }

void WasapiSource::SetWake(std::function<void()> wake) { wake_ = std::move(wake); }

void WasapiSource::FireWake() {
  if (!wake_) return;
  try {
    wake_();
  } catch (...) {
  }
}

void WasapiSource::JoinThread() {
  std::thread local;
  {
    std::lock_guard<std::mutex> lock(joinMu_);
    if (joined_) return;
    joined_ = true;
    local = std::move(thread_);
  }
  if (local.joinable()) local.join();
}

bool WasapiSource::TakePending(Drained* out) { return ring_.TakePending(out); }

std::string WasapiSource::source() const { return sourceName_; }

bool WasapiSource::running() const { return activation_.running(); }

WasapiSource::Stopped WasapiSource::Stop() {
  activation_.RequestStop();
  if (stopEvent_) SetEvent(static_cast<HANDLE>(stopEvent_));
  JoinThread();
  if (stopEvent_) {
    CloseHandle(static_cast<HANDLE>(stopEvent_));
    stopEvent_ = nullptr;
  }
  if (readyEvent_) {
    CloseHandle(static_cast<HANDLE>(readyEvent_));
    readyEvent_ = nullptr;
  }
  Stopped stopped;
  stopped.stopped = true;
  stopped.droppedSamples = ring_.droppedSamples();
  stopped.flushedSamples = flushed_.load();
  return stopped;
}

WasapiSource::Started WasapiSource::Start(const Config& config) {
  Started rejected;
  rejected.handle = handle_;
  rejected.generation = config.generation;
  rejected.encoding = "float32";
  if (config.source != "microphone" && config.source != "system") {
    rejected.code = "invalid_source";
    return rejected;
  }
  if (!activation_.Begin(config.generation)) {
    rejected.code = "busy";
    return rejected;
  }
  sourceName_ = config.source;
  stopEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  readyEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!stopEvent_ || !readyEvent_) {
    activation_.Fail();
    rejected.code = "event_create";
    if (stopEvent_) CloseHandle(static_cast<HANDLE>(stopEvent_));
    if (readyEvent_) CloseHandle(static_cast<HANDLE>(readyEvent_));
    stopEvent_ = nullptr;
    readyEvent_ = nullptr;
    return rejected;
  }
  {
    std::lock_guard<std::mutex> lock(joinMu_);
    joined_ = false;
    try {
      thread_ = std::thread([this, config] { ThreadMain(config); });
    } catch (...) {
      joined_ = true;
      activation_.Fail();
      rejected.code = "thread_create";
    }
  }
  if (rejected.code == "thread_create") {
    CloseHandle(static_cast<HANDLE>(stopEvent_));
    CloseHandle(static_cast<HANDLE>(readyEvent_));
    stopEvent_ = nullptr;
    readyEvent_ = nullptr;
    return rejected;
  }
  const DWORD wait = WaitForSingleObject(static_cast<HANDLE>(readyEvent_), 8000);
  if (wait != WAIT_OBJECT_0) {
    activation_.RequestStop();
    SetEvent(static_cast<HANDLE>(stopEvent_));
    JoinThread();
    rejected.code = "activation_timeout";
    return rejected;
  }
  Started started;
  {
    std::lock_guard<std::mutex> lock(resultMu_);
    started = sharedResult_;
  }
  if (!started.ok) JoinThread();
  return started;
}

void WasapiSource::ThreadMain(Config config) {
  Started started;
  started.handle = handle_;
  started.generation = config.generation;
  started.encoding = "float32";
  bool readyFired = false;
  const auto publish = [&](Started value) {
    {
      std::lock_guard<std::mutex> lock(resultMu_);
      sharedResult_ = value;
    }
    if (!readyFired && readyEvent_) {
      SetEvent(static_cast<HANDLE>(readyEvent_));
      readyFired = true;
    }
  };

  try {
    ComApartment apartment;
    if (!apartment.ok()) {
      activation_.Fail();
      started.code = "com_init";
      publish(started);
      return;
    }
    DWORD taskIndex = 0;
    const HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
    struct MmcssGuard {
      HANDLE handle;
      ~MmcssGuard() {
        if (handle) AvRevertMmThreadCharacteristics(handle);
      }
    } mmcssGuard{mmcss};

    if (activation_.phase() == EnginePhase::Stopped) {
      started.code = "cancelled";
      publish(started);
      return;
    }

    const ChoiceResolution resolved = ResolveOnCurrentThread(config.source, config.choice);
    if (!resolved.ok) {
      activation_.Fail();
      started.code = resolved.code.empty() ? "missing_endpoint" : resolved.code;
      publish(started);
      return;
    }

    ComPtr<IMMDeviceEnumerator> enumerator;
    void* enumeratorRaw = nullptr;
    const HRESULT created = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                             __uuidof(IMMDeviceEnumerator), &enumeratorRaw);
    if (FAILED(created) || !enumeratorRaw) {
      activation_.Fail();
      started.code = HresultCode(created);
      publish(started);
      return;
    }
    enumerator.Adopt(static_cast<IMMDeviceEnumerator*>(enumeratorRaw));

    const std::wstring endpointId = Utf8ToWide(resolved.device.id);
    ComPtr<IMMDevice> device;
    void* deviceRaw = nullptr;
    const HRESULT got = enumerator->GetDevice(endpointId.c_str(), reinterpret_cast<IMMDevice**>(&deviceRaw));
    if (FAILED(got) || !deviceRaw) {
      activation_.Fail();
      started.code = "missing_endpoint";
      publish(started);
      return;
    }
    device.Adopt(static_cast<IMMDevice*>(deviceRaw));

    void* endpointRaw = nullptr;
    if (FAILED(device->QueryInterface(__uuidof(IMMEndpoint), &endpointRaw)) || !endpointRaw) {
      activation_.Fail();
      started.code = "wrong_direction";
      publish(started);
      return;
    }
    ComPtr<IMMEndpoint> endpoint;
    endpoint.Adopt(static_cast<IMMEndpoint*>(endpointRaw));
    EDataFlow flow = eCapture;
    endpoint->GetDataFlow(&flow);
    const EDataFlow expected = config.source == "system" ? eRender : eCapture;
    if (flow != expected) {
      activation_.Fail();
      started.code = "wrong_direction";
      publish(started);
      return;
    }
    DWORD state = 0;
    device->GetState(&state);
    if (state != DEVICE_STATE_ACTIVE) {
      activation_.Fail();
      started.code = "disabled_endpoint";
      publish(started);
      return;
    }

    void* clientRaw = nullptr;
    if (FAILED(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &clientRaw)) || !clientRaw) {
      activation_.Fail();
      started.code = "activate_client";
      publish(started);
      return;
    }
    ComPtr<IAudioClient> audio;
    audio.Adopt(static_cast<IAudioClient*>(clientRaw));
    WAVEFORMATEX* mix = nullptr;
    if (FAILED(audio->GetMixFormat(&mix)) || !mix) {
      activation_.Fail();
      started.code = "mix_format";
      publish(started);
      return;
    }
    struct MixGuard {
      WAVEFORMATEX* format;
      ~MixGuard() {
        if (format) CoTaskMemFree(format);
      }
    } mixGuard{mix};

    PcmFormat pcmFormat;
    std::string formatError;
    const std::size_t formatBytes = sizeof(WAVEFORMATEX) + mix->cbSize;
    if (!DescribeWaveFormat(mix, formatBytes, &pcmFormat, &formatError)) {
      activation_.Fail();
      started.code = formatError.empty() ? "unsupported_format" : formatError;
      publish(started);
      return;
    }

    REFERENCE_TIME defaultPeriod = 0;
    REFERENCE_TIME minimumPeriod = 0;
    audio->GetDevicePeriod(&defaultPeriod, &minimumPeriod);
    const REFERENCE_TIME duration = defaultPeriod > 10000000 ? defaultPeriod : 10000000;
    HANDLE captureEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    struct EventGuard {
      HANDLE handle;
      ~EventGuard() {
        if (handle) CloseHandle(handle);
      }
    } eventGuard{captureEvent};

    DWORD streamFlags = StreamFlagsForSource(config.source);
    HRESULT initialized = audio->Initialize(AUDCLNT_SHAREMODE_SHARED, streamFlags, duration, 0, mix, nullptr);
    bool eventDriven = SUCCEEDED(initialized);
    if (FAILED(initialized) && (streamFlags & kStreamEvent) != 0) {
      streamFlags &= ~static_cast<DWORD>(kStreamEvent);
      initialized = audio->Initialize(AUDCLNT_SHAREMODE_SHARED, streamFlags, duration, 0, mix, nullptr);
      eventDriven = false;
    }
    if (FAILED(initialized)) {
      activation_.Fail();
      started.code = HresultCode(initialized);
      publish(started);
      return;
    }
    if (eventDriven && FAILED(audio->SetEventHandle(captureEvent))) {
      activation_.Fail();
      started.code = "event_handle";
      publish(started);
      return;
    }

    void* captureRaw = nullptr;
    if (FAILED(audio->GetService(__uuidof(IAudioCaptureClient), &captureRaw)) || !captureRaw) {
      activation_.Fail();
      started.code = "capture_client";
      publish(started);
      return;
    }
    ComPtr<IAudioCaptureClient> capture;
    capture.Adopt(static_cast<IAudioCaptureClient*>(captureRaw));

    std::atomic<int> invalidated{0};
    std::atomic<int> defaultChanged{0};
    const bool watchDefault = config.choice.kind == "default";
    auto* notifications = new EndpointNotifications(endpointId, watchDefault, expected, RoleFromChoice(config.choice),
                                                    &invalidated, &defaultChanged);
    const HRESULT registered = enumerator->RegisterEndpointNotificationCallback(notifications);
    if (FAILED(registered)) {
      notifications->Release();
      activation_.Fail();
      started.code = HresultCode(registered);
      publish(started);
      return;
    }
    struct NotificationGuard {
      IMMDeviceEnumerator* enumerator;
      EndpointNotifications* notifications;
      ~NotificationGuard() {
        if (enumerator && notifications) enumerator->UnregisterEndpointNotificationCallback(notifications);
        if (notifications) notifications->Release();
      }
    } notificationGuard{enumerator.Get(), notifications};

    if (!activation_.TryPublish(config.generation)) {
      started.code = "cancelled";
      publish(started);
      return;
    }
    const HRESULT running = audio->Start();
    if (FAILED(running)) {
      activation_.Fail();
      started.code = HresultCode(running);
      publish(started);
      return;
    }
    struct ClientStop {
      IAudioClient* client;
      ~ClientStop() {
        if (client) client->Stop();
      }
    } clientStop{audio.Get()};

    started.ok = true;
    started.endpointId = resolved.device.id;
    started.endpointName = resolved.device.name;
    started.sampleRate = pcmFormat.sampleRate;
    started.nativeChannels = pcmFormat.channels;
    started.clockOriginQpc100ns = QpcNow();
    const std::uint64_t startQpc = started.clockOriginQpc100ns;
    publish(std::move(started));

    ControlEvent ready;
    ready.type = "ready";
    ready.source = config.source;
    ready.generation = config.generation;
    ready.endpointId = resolved.device.id;
    if (ring_.PushControl(ready).wake) FireWake();

    std::vector<float> pending;
    std::uint64_t pendingQpc = 0;
    std::uint64_t sampleIndex = 0;
    std::uint64_t sequence = 0;
    std::uint64_t lastPacketQpc = 0;
    bool idlePadded = false;
    bool stickyDiscontinuity = false;
    // Hardware packet flags must survive batching: each AudioBatch field is
    // assigned directly from PacketFlags.
    bool pendingSilent = false;
    bool pendingTimestampError = false;
    // A loopback can be silent from the first packet: anchor the idle-gap
    // clock at Start, not at the first captured packet, so a silent-from-start
    // system source still synthesises bounded idle silence.
    std::uint32_t target = static_cast<std::uint32_t>((static_cast<std::uint64_t>(pcmFormat.sampleRate) * kTargetBatchMs) / 1000ULL);
    if (target == 0) target = 1;
    if (target > kMaxSamplesPerBatch) target = static_cast<std::uint32_t>(kMaxSamplesPerBatch);

    const auto flushPending = [&](bool synthetic, bool countAsFlush) {
      if (pending.empty()) return;
      AudioBatch batch;
      batch.samples = std::move(pending);
      pending.clear();
      const std::uint64_t count = batch.samples.size();
      batch.source = config.source;
      batch.generation = config.generation;
      batch.endpointId = resolved.device.id;
      batch.sampleRate = pcmFormat.sampleRate;
      batch.sampleIndex = sampleIndex;
      batch.qpcTimestamp100ns = pendingQpc ? pendingQpc : QpcNow();
      batch.discontinuity = stickyDiscontinuity;
      batch.silent = pendingSilent;
      batch.timestampError = pendingTimestampError;
      batch.syntheticIdleSilence = synthetic;
      batch.sequence = sequence++;
      stickyDiscontinuity = false;
      pendingSilent = false;
      pendingTimestampError = false;
      sampleIndex += count;
      const PushResult pushed = ring_.PushAudio(std::move(batch), QpcNow());
      if (countAsFlush && pushed.stored) flushed_ += count;
      if (pushed.wake) FireWake();
    };

    WasapiPacketSource packets(capture.Get());
    const HANDLE stopHandle = static_cast<HANDLE>(stopEvent_);
    while (activation_.phase() == EnginePhase::Running) {
      DWORD wait = WAIT_TIMEOUT;
      if (eventDriven) {
        HANDLE handles[2] = {captureEvent, stopHandle};
        wait = WaitForMultipleObjects(2, handles, FALSE, 50);
        if (wait == WAIT_OBJECT_0 + 1) break;
      } else {
        wait = WaitForSingleObject(stopHandle, 10);
        if (wait == WAIT_OBJECT_0) break;
      }
      if (invalidated.load() != 0) {
        ControlEvent event;
        event.type = "device-change";
        event.source = config.source;
        event.generation = config.generation;
        event.endpointId = resolved.device.id;
        event.reason = "invalidated";
        event.code = "endpoint_invalidated";
        event.terminal = true;
        if (ring_.PushControl(event).wake) FireWake();
        break;
      }
      if (defaultChanged.load() != 0 && watchDefault) {
        ControlEvent event;
        event.type = "device-change";
        event.source = config.source;
        event.generation = config.generation;
        event.endpointId = resolved.device.id;
        event.reason = "default-role";
        event.code = "default_role_changed";
        event.terminal = true;
        if (ring_.PushControl(event).wake) FireWake();
        break;
      }

      const std::uint64_t idleBase = lastPacketQpc != 0 ? lastPacketQpc : startQpc;
      if (wait == WAIT_TIMEOUT && config.source == "system" && idleBase != 0) {
        const std::uint64_t now = QpcNow();
        const std::uint64_t gap = now > idleBase ? now - idleBase : 0;
        const IdleDecision decision = DecideIdleGap(gap, pcmFormat.sampleRate);
        if (decision.discontinuity) {
          stickyDiscontinuity = true;
        } else if (decision.emitSynthetic && !idlePadded && pending.empty()) {
          AudioBatch batch;
          batch.samples.assign(decision.frames, 0.0f);
          batch.source = config.source;
          batch.generation = config.generation;
          batch.endpointId = resolved.device.id;
          batch.sampleRate = pcmFormat.sampleRate;
          batch.sampleIndex = sampleIndex;
          batch.qpcTimestamp100ns = now;
          batch.syntheticIdleSilence = true;
          batch.sequence = sequence++;
          sampleIndex += batch.samples.size();
          idlePadded = true;
          const PushResult pushed = ring_.PushAudio(std::move(batch), now);
          if (pushed.wake) FireWake();
        }
      }

      DrainResult drained;
      const bool drainedOk = DrainPackets(
          packets, pcmFormat,
          [&](const std::vector<float>& mono, const PacketFlags& flags, std::uint64_t qpc, std::uint64_t) {
            if (flags.silent) pendingSilent = true;
            if (flags.timestampError) pendingTimestampError = true;
            if (flags.discontinuity || flags.timestampError) stickyDiscontinuity = true;
            const std::uint64_t packetQpc = qpc ? qpc : QpcNow();
            if (qpc) lastPacketQpc = qpc;
            idlePadded = false;
            std::size_t offset = 0;
            while (offset < mono.size()) {
              if (pending.size() >= target) flushPending(false, false);
              // A batch is stamped with its first sample's time. After a flush
              // inside this packet, that sample sits `offset` frames in.
              if (pending.empty()) {
                pendingQpc = packetQpc + (static_cast<std::uint64_t>(offset) * 10000000ULL) / pcmFormat.sampleRate;
              }
              const std::size_t room = target - pending.size();
              const std::size_t take = room < mono.size() - offset ? room : mono.size() - offset;
              pending.insert(pending.end(), mono.begin() + static_cast<std::ptrdiff_t>(offset),
                             mono.begin() + static_cast<std::ptrdiff_t>(offset + take));
              offset += take;
            }
            if (pending.size() >= target) flushPending(false, false);
          },
          &drained);
      if (!drainedOk) {
        ControlEvent event;
        event.type = "error";
        event.source = config.source;
        event.generation = config.generation;
        event.endpointId = resolved.device.id;
        event.code = drained.code.empty() ? "capture_buffer" : drained.code;
        event.terminal = true;
        if (ring_.PushControl(event).wake) FireWake();
        break;
      }
    }
    flushPending(false, true);
  } catch (...) {
    activation_.Fail();
    if (!readyFired) {
      started.code = "internal_error";
      publish(started);
    }
    ControlEvent event;
    event.type = "error";
    event.source = config.source;
    event.generation = config.generation;
    event.code = "internal_error";
    event.terminal = true;
    if (ring_.PushControl(event).wake) FireWake();
  }
}
