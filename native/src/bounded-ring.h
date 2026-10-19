#pragma once

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

// Six recent audio batches per source. Control events use a separate
// eight-slot queue plus one terminal slot so overload cannot drop them.

inline constexpr std::size_t kMaxAudioBatches = 6;
inline constexpr std::size_t kMaxSamplesPerBatch = 8192;
inline constexpr std::uint32_t kTargetBatchMs = 32;
inline constexpr std::uint64_t kMaxPacketAge100ns = 2000000ULL;
inline constexpr std::size_t kMaxControlEntries = 8;

struct AudioBatch {
  std::vector<float> samples;
  std::string source;
  std::uint64_t generation = 0;
  std::string endpointId;
  std::uint32_t sampleRate = 0;
  std::uint64_t sampleIndex = 0;
  std::uint64_t qpcTimestamp100ns = 0;
  bool silent = false;
  bool discontinuity = false;
  bool timestampError = false;
  bool syntheticIdleSilence = false;
  std::uint64_t sequence = 0;
};

struct ControlEvent {
  std::string type;
  std::string source;
  std::uint64_t generation = 0;
  std::string endpointId;
  std::string code;
  std::string message;
  std::string reason;
  bool terminal = false;
};

struct PushResult {
  bool wake = false;
  bool stored = false;
};

struct Drained {
  std::vector<AudioBatch> audio;
  std::vector<ControlEvent> control;
  std::optional<ControlEvent> terminal;
};

class BoundedRing {
 public:
  PushResult PushAudio(AudioBatch batch, std::uint64_t now100ns) {
    std::lock_guard<std::mutex> lock(mu_);
    const std::size_t count = batch.samples.size();
    if (batch.qpcTimestamp100ns != 0 && now100ns >= batch.qpcTimestamp100ns &&
        now100ns - batch.qpcTimestamp100ns > kMaxPacketAge100ns) {
      dropped_ += count;
      forceDiscontinuity_ = true;
      return {};
    }
    if (count > kMaxSamplesPerBatch) {
      dropped_ += count;
      forceDiscontinuity_ = true;
      return {};
    }
    while (audio_.size() >= kMaxAudioBatches) {
      dropped_ += audio_.front().samples.size();
      audio_.pop_front();
      forceDiscontinuity_ = true;
    }
    if (forceDiscontinuity_) {
      batch.discontinuity = true;
      forceDiscontinuity_ = false;
    }
    audio_.push_back(std::move(batch));
    PushResult result;
    result.stored = true;
    result.wake = SignalLocked();
    return result;
  }

  PushResult PushControl(ControlEvent event) {
    std::lock_guard<std::mutex> lock(mu_);
    if (event.terminal) {
      terminal_ = std::move(event);
    } else {
      while (control_.size() >= kMaxControlEntries) control_.pop_front();
      control_.push_back(std::move(event));
    }
    PushResult result;
    result.stored = true;
    result.wake = SignalLocked();
    return result;
  }

  // Takes the current queues and clears the wake bit under one lock.
  // A producer that arrives after this returns sets the wake bit again.
  bool TakePending(Drained* out) {
    std::lock_guard<std::mutex> lock(mu_);
    if (!wake_ && audio_.empty() && control_.empty() && !terminal_) return false;
    wake_ = false;
    out->audio.clear();
    out->audio.insert(out->audio.end(), std::make_move_iterator(audio_.begin()),
                      std::make_move_iterator(audio_.end()));
    audio_.clear();
    out->control.clear();
    out->control.insert(out->control.end(), std::make_move_iterator(control_.begin()),
                        std::make_move_iterator(control_.end()));
    control_.clear();
    out->terminal = std::move(terminal_);
    terminal_.reset();
    return true;
  }

  bool WaitUntilWoken(std::uint32_t timeoutMs) {
    std::unique_lock<std::mutex> lock(mu_);
    return cv_.wait_for(lock, std::chrono::milliseconds(timeoutMs), [&] {
      return wake_ || closed_;
    });
  }

  void Close() {
    std::lock_guard<std::mutex> lock(mu_);
    closed_ = true;
    wake_ = true;
    cv_.notify_all();
  }

  std::uint64_t droppedSamples() const {
    std::lock_guard<std::mutex> lock(mu_);
    return dropped_;
  }

  std::size_t audioSize() const {
    std::lock_guard<std::mutex> lock(mu_);
    return audio_.size();
  }

  std::size_t controlSize() const {
    std::lock_guard<std::mutex> lock(mu_);
    return control_.size();
  }

  bool hasTerminal() const {
    std::lock_guard<std::mutex> lock(mu_);
    return terminal_.has_value();
  }

  bool hasAudio() const {
    std::lock_guard<std::mutex> lock(mu_);
    return !audio_.empty();
  }

  bool wakePending() const {
    std::lock_guard<std::mutex> lock(mu_);
    return wake_;
  }

 private:
  bool SignalLocked() {
    const bool edge = !wake_;
    wake_ = true;
    cv_.notify_one();
    return edge;
  }

  mutable std::mutex mu_;
  std::condition_variable cv_;
  std::deque<AudioBatch> audio_;
  std::deque<ControlEvent> control_;
  std::optional<ControlEvent> terminal_;
  std::uint64_t dropped_ = 0;
  bool forceDiscontinuity_ = false;
  bool wake_ = false;
  bool closed_ = false;
};
