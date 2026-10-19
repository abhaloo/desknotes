#pragma once

#include "bounded-ring.h"
#include "device-catalog.h"
#include "pcm-normalizer.h"

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// These match AUDCLNT_BUFFERFLAGS_* and AUDCLNT_STREAMFLAGS_*.
inline constexpr std::uint32_t kBufferDiscontinuity = 0x1;
inline constexpr std::uint32_t kBufferSilent = 0x2;
inline constexpr std::uint32_t kBufferTimestampError = 0x4;
inline constexpr std::uint32_t kStreamLoopback = 0x00020000;
inline constexpr std::uint32_t kStreamEvent = 0x00040000;

struct IdleDecision {
  bool emitSynthetic = false;
  std::uint32_t frames = 0;
  bool discontinuity = false;
};

inline IdleDecision DecideIdleGap(std::uint64_t gap100ns, std::uint32_t sampleRate) {
  IdleDecision decision;
  if (sampleRate < 8000 || sampleRate > 192000) return decision;
  constexpr std::uint64_t k32ms = 320000ULL;
  if (gap100ns > kMaxPacketAge100ns) {
    decision.discontinuity = true;
    return decision;
  }
  if (gap100ns >= k32ms) {
    decision.emitSynthetic = true;
    std::uint64_t frames = (static_cast<std::uint64_t>(sampleRate) * kTargetBatchMs) / 1000ULL;
    if (frames > kMaxSamplesPerBatch) frames = kMaxSamplesPerBatch;
    if (frames == 0) frames = 1;
    decision.frames = static_cast<std::uint32_t>(frames);
  }
  return decision;
}

inline std::uint32_t StreamFlagsForSource(const std::string& source) {
  std::uint32_t flags = kStreamEvent;
  if (source == "system") flags |= kStreamLoopback;
  return flags;
}

class CapturePacketSource {
 public:
  virtual ~CapturePacketSource() = default;
  // 0 = one packet, 1 = empty, negative = failure.
  virtual std::int32_t Acquire(const std::uint8_t** data, std::uint32_t* frames, std::uint32_t* flags,
                               std::uint64_t* devicePosition, std::uint64_t* qpc100ns) = 0;
  virtual void Release(std::uint32_t frames) = 0;
};

struct DrainResult {
  int acquires = 0;
  int published = 0;
  bool failed = false;
  std::string code;
};

using PacketHandler = std::function<void(const std::vector<float>&, const PacketFlags&, std::uint64_t, std::uint64_t)>;

// Copies each packet before releasing it. Release still runs when conversion
// or the packet handler fails.
bool DrainPackets(CapturePacketSource& source, const PcmFormat& format, PacketHandler onPacket, DrainResult* result);

enum class EnginePhase { Idle, Activating, Running, Stopped, Failed };

class SourceActivation {
 public:
  bool Begin(std::uint64_t generation) {
    std::lock_guard<std::mutex> lock(mu_);
    if (phase_ == EnginePhase::Activating || phase_ == EnginePhase::Running) return false;
    phase_ = EnginePhase::Activating;
    generation_ = generation;
    stopRequested_ = false;
    return true;
  }

  void RequestStop() {
    std::lock_guard<std::mutex> lock(mu_);
    stopRequested_ = true;
    if (phase_ == EnginePhase::Idle || phase_ == EnginePhase::Activating || phase_ == EnginePhase::Running) {
      phase_ = EnginePhase::Stopped;
    }
  }

  bool TryPublish(std::uint64_t generation) {
    std::lock_guard<std::mutex> lock(mu_);
    if (stopRequested_ || phase_ != EnginePhase::Activating || generation_ != generation) {
      if (phase_ == EnginePhase::Activating) phase_ = EnginePhase::Stopped;
      return false;
    }
    phase_ = EnginePhase::Running;
    return true;
  }

  void Fail() {
    std::lock_guard<std::mutex> lock(mu_);
    phase_ = EnginePhase::Failed;
    stopRequested_ = true;
  }

  bool running() const {
    std::lock_guard<std::mutex> lock(mu_);
    return phase_ == EnginePhase::Running && !stopRequested_;
  }

  EnginePhase phase() const {
    std::lock_guard<std::mutex> lock(mu_);
    return phase_;
  }

  std::uint64_t generation() const {
    std::lock_guard<std::mutex> lock(mu_);
    return generation_;
  }

 private:
  mutable std::mutex mu_;
  EnginePhase phase_ = EnginePhase::Idle;
  std::uint64_t generation_ = 0;
  bool stopRequested_ = false;
};

class SourcePair {
 public:
  SourceActivation* Slot(const std::string& source) {
    if (source == "microphone") return &microphone_;
    if (source == "system") return &system_;
    return nullptr;
  }

  bool FailOne(const std::string& source) {
    SourceActivation* slot = Slot(source);
    if (!slot) return false;
    slot->Fail();
    return true;
  }

 private:
  SourceActivation microphone_;
  SourceActivation system_;
};

class WasapiSource {
 public:
  struct Config {
    std::string source;
    DeviceChoice choice;
    std::uint64_t generation = 0;
  };

  struct Started {
    bool ok = false;
    std::string code;
    std::uint64_t handle = 0;
    std::uint64_t generation = 0;
    std::string endpointId;
    std::string endpointName;
    std::uint32_t sampleRate = 0;
    int nativeChannels = 0;
    std::string encoding = "float32";
    std::uint64_t clockOriginQpc100ns = 0;
  };

  struct Stopped {
    bool stopped = false;
    std::uint64_t droppedSamples = 0;
    std::uint64_t flushedSamples = 0;
  };

  explicit WasapiSource(std::uint64_t handle);
  ~WasapiSource();

  void SetWake(std::function<void()> wake);
  void Reserve(std::string source) { sourceName_ = std::move(source); }
  Started Start(const Config& config);
  Stopped Stop();
  bool TakePending(Drained* out);
  std::string source() const;
  bool running() const;

 private:
  void ThreadMain(Config config);
  void JoinThread();
  void FireWake();

  std::uint64_t handle_;
  SourceActivation activation_;
  BoundedRing ring_;
  std::function<void()> wake_;
  std::mutex joinMu_;
  std::mutex resultMu_;
  std::thread thread_;
  bool joined_ = true;
  void* stopEvent_ = nullptr;
  void* readyEvent_ = nullptr;
  Started sharedResult_;
  std::atomic<std::uint64_t> flushed_{0};
  std::string sourceName_;
};
