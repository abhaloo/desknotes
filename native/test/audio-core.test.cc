#include "bounded-ring.h"
#include "device-catalog.h"
#include "pcm-normalizer.h"
#include "wasapi-source.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {

int g_failed = 0;

void Check(bool condition, const char* expression, int line) {
  if (condition) return;
  std::cerr << "FAIL " << line << " " << expression << "\n";
  g_failed += 1;
}

#define CHECK(condition) Check(static_cast<bool>(condition), #condition, __LINE__)

void PutU16(std::vector<std::uint8_t>& bytes, std::size_t at, std::uint16_t value) {
  bytes[at] = static_cast<std::uint8_t>(value & 0xff);
  bytes[at + 1] = static_cast<std::uint8_t>((value >> 8) & 0xff);
}

void PutU32(std::vector<std::uint8_t>& bytes, std::size_t at, std::uint32_t value) {
  bytes[at] = static_cast<std::uint8_t>(value & 0xff);
  bytes[at + 1] = static_cast<std::uint8_t>((value >> 8) & 0xff);
  bytes[at + 2] = static_cast<std::uint8_t>((value >> 16) & 0xff);
  bytes[at + 3] = static_cast<std::uint8_t>((value >> 24) & 0xff);
}

std::vector<std::uint8_t> WaveFormat(std::uint16_t tag, std::uint16_t channels, std::uint32_t rate, std::uint16_t bits) {
  std::vector<std::uint8_t> bytes(18, 0);
  const std::uint16_t align = static_cast<std::uint16_t>(channels * (bits / 8));
  PutU16(bytes, 0, tag);
  PutU16(bytes, 2, channels);
  PutU32(bytes, 4, rate);
  PutU32(bytes, 8, rate * align);
  PutU16(bytes, 12, align);
  PutU16(bytes, 14, bits);
  return bytes;
}

std::vector<std::uint8_t> ExtensiblePcm(std::uint16_t channels, std::uint32_t rate, std::uint16_t containerBits,
                                       std::uint16_t validBits) {
  std::vector<std::uint8_t> bytes(40, 0);
  const std::uint16_t align = static_cast<std::uint16_t>(channels * (containerBits / 8));
  PutU16(bytes, 0, 0xFFFE);
  PutU16(bytes, 2, channels);
  PutU32(bytes, 4, rate);
  PutU32(bytes, 8, rate * align);
  PutU16(bytes, 12, align);
  PutU16(bytes, 14, containerBits);
  PutU16(bytes, 16, 22);
  PutU16(bytes, 18, validBits);
  const std::uint8_t guid[] = {0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
                               0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71};
  std::memcpy(bytes.data() + 24, guid, sizeof(guid));
  return bytes;
}

PcmFormat MustFormat(const std::vector<std::uint8_t>& bytes) {
  PcmFormat format;
  std::string error;
  CHECK(DescribeWaveFormat(bytes.data(), bytes.size(), &format, &error));
  return format;
}

void TestPcm() {
  const PcmFormat pcm16 = MustFormat(WaveFormat(1, 1, 48000, 16));
  const std::uint8_t extrema[] = {0x00, 0x80, 0xFF, 0x7F};
  std::vector<float> mono;
  std::string error;
  PacketFlags flags;
  CHECK(NormalizeToMono(pcm16, extrema, 2, flags, &mono, &error));
  CHECK(mono.size() == 2);
  CHECK(mono[0] == -1.0f);
  CHECK(mono[1] == 32767.0f / 32768.0f);

  const PcmFormat pcm24 = MustFormat(WaveFormat(1, 1, 48000, 24));
  const std::uint8_t packed[] = {0x00, 0x00, 0x80, 0x01, 0x00, 0x00, 0xFF, 0xFF, 0xFF};
  CHECK(NormalizeToMono(pcm24, packed, 3, flags, &mono, &error));
  CHECK(mono.size() == 3);
  CHECK(mono[0] == -1.0f);
  CHECK(mono[1] == 1.0f / 8388608.0f);
  CHECK(mono[2] == -1.0f / 8388608.0f);

  const PcmFormat pcm24in32 = MustFormat(ExtensiblePcm(1, 48000, 32, 24));
  CHECK(pcm24in32.kind == PcmFormat::Kind::Pcm24In32);
  const std::uint8_t container[] = {0x00, 0x00, 0x80, 0xFF, 0xFF, 0xFF, 0xFF, 0x00};
  CHECK(NormalizeToMono(pcm24in32, container, 2, flags, &mono, &error));
  CHECK(mono[0] == -1.0f);
  CHECK(mono[1] == -1.0f / 8388608.0f);

  const PcmFormat stereo = MustFormat(WaveFormat(3, 2, 48000, 32));
  float interleaved[4] = {1.0f, -1.0f, 0.5f, 0.25f};
  std::uint8_t floatBytes[sizeof(interleaved)];
  std::memcpy(floatBytes, interleaved, sizeof(interleaved));
  CHECK(NormalizeToMono(stereo, floatBytes, 2, flags, &mono, &error));
  CHECK(mono.size() == 2);
  CHECK(mono[0] == 0.0f);
  CHECK(mono[1] == 0.375f);

  PacketFlags silent;
  silent.silent = true;
  silent.discontinuity = true;
  silent.timestampError = true;
  CHECK(NormalizeToMono(pcm16, nullptr, 4, silent, &mono, &error));
  CHECK(mono.size() == 4);
  for (float sample : mono) {
    CHECK(sample == 0.0f);
    CHECK(!std::signbit(sample));
  }
  CHECK(silent.silent && silent.discontinuity && silent.timestampError);

  flags.discontinuity = true;
  flags.timestampError = true;
  const std::uint8_t zeroFrame[] = {0x00, 0x00};
  CHECK(NormalizeToMono(pcm16, zeroFrame, 1, flags, &mono, &error));
  CHECK(flags.discontinuity && flags.timestampError);
  CHECK(mono.size() == 1);
  CHECK(mono[0] == 0.0f);

  std::string rejected;
  const auto eightBit = WaveFormat(1, 1, 48000, 8);
  PcmFormat unused;
  CHECK(!DescribeWaveFormat(eightBit.data(), eightBit.size(), &unused, &rejected));
  CHECK(rejected == "unsupported_format");
  const std::uint8_t truncated[] = {0x01, 0x00, 0x01, 0x00};
  CHECK(!DescribeWaveFormat(truncated, sizeof(truncated), &unused, &rejected));
  CHECK(rejected == "invalid_wave_format");
}

AudioBatch BatchOf(std::size_t count, std::uint64_t qpc, float value) {
  AudioBatch batch;
  batch.samples.assign(count, value);
  batch.qpcTimestamp100ns = qpc;
  return batch;
}

void TestRing() {
  BoundedRing ring;
  for (int index = 0; index < 8; ++index) {
    CHECK(ring.PushAudio(BatchOf(100, 1000, 0.2f), 1000).stored);
  }
  CHECK(ring.audioSize() == kMaxAudioBatches);
  CHECK(ring.droppedSamples() == 200);

  BoundedRing aged;
  CHECK(!aged.PushAudio(BatchOf(4, 1000, 0.2f), 1000 + kMaxPacketAge100ns + 1).stored);
  CHECK(aged.droppedSamples() == 4);
  CHECK(aged.audioSize() == 0);
  CHECK(aged.PushAudio(BatchOf(2, 5000, 0.2f), 5000).stored);
  Drained agedDrain;
  CHECK(aged.TakePending(&agedDrain));
  CHECK(agedDrain.audio.size() == 1);
  CHECK(agedDrain.audio[0].discontinuity);
  CHECK(agedDrain.audio[0].samples.size() == 2);

  BoundedRing oversized;
  CHECK(!oversized.PushAudio(BatchOf(kMaxSamplesPerBatch + 1, 10, 0.2f), 10).stored);
  CHECK(oversized.droppedSamples() == kMaxSamplesPerBatch + 1);

  BoundedRing wake;
  CHECK(wake.PushAudio(BatchOf(1, 10, 0.2f), 10).wake);
  CHECK(!wake.PushAudio(BatchOf(1, 10, 0.2f), 10).wake);
  Drained wakeDrain;
  CHECK(wake.TakePending(&wakeDrain));
  CHECK(wake.PushAudio(BatchOf(1, 10, 0.2f), 10).wake);

  BoundedRing early;
  CHECK(early.PushAudio(BatchOf(1, 10, 1.0f), 10).stored);
  CHECK(early.WaitUntilWoken(200));
  Drained earlyDrain;
  CHECK(early.TakePending(&earlyDrain));
  CHECK(earlyDrain.audio.size() == 1);

  BoundedRing late;
  std::atomic<bool> entered{false};
  std::atomic<bool> woke{false};
  std::thread waiter([&] {
    entered.store(true);
    woke.store(late.WaitUntilWoken(2000));
  });
  while (!entered.load()) std::this_thread::yield();
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  CHECK(late.PushAudio(BatchOf(1, 10, 1.0f), 10).wake);
  waiter.join();
  CHECK(woke.load());

  BoundedRing controls;
  for (int index = 0; index < 10; ++index) {
    ControlEvent event;
    event.type = "state";
    event.message = "c" + std::to_string(index);
    CHECK(controls.PushControl(event).stored);
  }
  CHECK(controls.controlSize() == kMaxControlEntries);
  ControlEvent terminal;
  terminal.type = "error";
  terminal.message = "done";
  terminal.terminal = true;
  CHECK(controls.PushControl(terminal).stored);
  for (int index = 0; index < 20; ++index) {
    controls.PushAudio(BatchOf(10, 1000, 0.1f), 1000);
  }
  CHECK(controls.controlSize() == kMaxControlEntries);
  CHECK(controls.hasTerminal());
  CHECK(controls.audioSize() == kMaxAudioBatches);
  Drained mixed;
  CHECK(controls.TakePending(&mixed));
  CHECK(mixed.control.size() == kMaxControlEntries);
  CHECK(mixed.control.front().message == "c2");
  CHECK(mixed.control.back().message == "c9");
  CHECK(mixed.terminal.has_value());
  CHECK(mixed.terminal->message == "done");
  CHECK(mixed.audio.size() == kMaxAudioBatches);

  BoundedRing stress;
  constexpr int kProducers = 4;
  constexpr int kEach = 200;
  std::atomic<int> sent{0};
  std::atomic<int> got{0};
  std::atomic<bool> done{false};
  std::thread consumer([&] {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < deadline) {
      Drained drained;
      if (stress.TakePending(&drained)) {
        for (const auto& batch : drained.audio) got += static_cast<int>(batch.samples.size());
        continue;
      }
      if (done.load()) {
        stress.WaitUntilWoken(100);
        if (!stress.TakePending(&drained)) break;
        for (const auto& batch : drained.audio) got += static_cast<int>(batch.samples.size());
        continue;
      }
      stress.WaitUntilWoken(20);
    }
  });
  std::vector<std::thread> producers;
  for (int producer = 0; producer < kProducers; ++producer) {
    producers.emplace_back([&] {
      for (int index = 0; index < kEach; ++index) {
        stress.PushAudio(BatchOf(1, 1000, 0.1f), 1000);
        sent.fetch_add(1);
      }
    });
  }
  for (auto& producer : producers) producer.join();
  done.store(true);
  consumer.join();
  CHECK(got.load() + static_cast<int>(stress.droppedSamples()) == sent.load());
  CHECK(!stress.hasAudio());
}

class FakePackets final : public CapturePacketSource {
 public:
  int remaining = 2;
  int acquires = 0;
  int releases = 0;
  bool nullData = false;
  std::thread::id acquireThread{};
  std::thread::id releaseThread{};

  std::int32_t Acquire(const std::uint8_t** data, std::uint32_t* frames, std::uint32_t* flags,
                       std::uint64_t* devicePosition, std::uint64_t* qpc100ns) override {
    acquireThread = std::this_thread::get_id();
    if (remaining == 0) return 1;
    remaining -= 1;
    acquires += 1;
    static const std::uint8_t kSilence[4] = {0, 0, 0, 0};
    *data = nullData ? nullptr : kSilence;
    *frames = 1;
    *flags = 0;
    *devicePosition = 0;
    *qpc100ns = 10;
    return 0;
  }

  void Release(std::uint32_t) override {
    releaseThread = std::this_thread::get_id();
    releases += 1;
  }
};

void TestDrainAndLifecycle() {
  const PcmFormat format = MustFormat(WaveFormat(3, 1, 48000, 32));
  FakePackets packets;
  DrainResult result;
  int seen = 0;
  const bool threw = !DrainPackets(
      packets, format,
      [&](const std::vector<float>&, const PacketFlags&, std::uint64_t, std::uint64_t) {
        seen += 1;
        if (seen == 2) throw std::runtime_error("callback");
      },
      &result);
  CHECK(threw);
  CHECK(result.code == "callback_error");
  CHECK(packets.acquires == packets.releases);
  CHECK(packets.acquires == 2);
  CHECK(result.published == 1);
  CHECK(packets.acquireThread == packets.releaseThread);
  CHECK(packets.acquireThread == std::this_thread::get_id());

  FakePackets nulls;
  nulls.nullData = true;
  nulls.remaining = 1;
  DrainResult nullResult;
  CHECK(!DrainPackets(nulls, format, PacketHandler{}, &nullResult));
  CHECK(nullResult.code == "null_packet_data");
  CHECK(nulls.acquires == 1);
  CHECK(nulls.releases == 1);

  SourceActivation activation;
  CHECK(activation.Begin(7));
  activation.RequestStop();
  CHECK(!activation.TryPublish(7));
  CHECK(!activation.running());
  CHECK(activation.phase() == EnginePhase::Stopped);

  SourceActivation mismatch;
  CHECK(mismatch.Begin(4));
  CHECK(!mismatch.TryPublish(5));
  CHECK(!mismatch.running());

  SourcePair pair;
  CHECK(pair.Slot("microphone")->Begin(1));
  CHECK(pair.Slot("system")->Begin(2));
  CHECK(pair.Slot("microphone")->TryPublish(1));
  CHECK(pair.Slot("system")->TryPublish(2));
  CHECK(pair.FailOne("microphone"));
  CHECK(pair.Slot("microphone")->phase() == EnginePhase::Failed);
  CHECK(!pair.Slot("microphone")->running());
  CHECK(pair.Slot("system")->running());

  CHECK((StreamFlagsForSource("microphone") & kStreamLoopback) == 0);
  CHECK((StreamFlagsForSource("system") & kStreamLoopback) == kStreamLoopback);
  CHECK((StreamFlagsForSource("microphone") & kStreamEvent) == kStreamEvent);

  const IdleDecision shortGap = DecideIdleGap(100000, 48000);
  CHECK(!shortGap.emitSynthetic);
  CHECK(!shortGap.discontinuity);
  const IdleDecision batchGap = DecideIdleGap(320000, 48000);
  CHECK(batchGap.emitSynthetic);
  CHECK(batchGap.frames == 1536);
  const IdleDecision longGap = DecideIdleGap(kMaxPacketAge100ns + 1, 48000);
  CHECK(!longGap.emitSynthetic);
  CHECK(longGap.discontinuity);
}

CatalogDevice Device(const char* id, const char* name, const char* source, const char* type, bool isDefault,
                     int rate, const char* state, std::vector<std::string> roles) {
  CatalogDevice device;
  device.id = id;
  device.name = name;
  device.source = source;
  device.type = type;
  device.isDefault = isDefault;
  device.channels = source[0] == 'm' ? 1 : 2;
  device.sampleRate = rate;
  device.state = state;
  device.defaultRoles = std::move(roles);
  return device;
}

void TestCatalog() {
  std::string canonical;
  std::string error;
  CHECK(CanonicalSource("input", &canonical, &error));
  CHECK(canonical == "microphone");
  CHECK(CanonicalSource("output", &canonical, &error));
  CHECK(canonical == "system");
  CHECK(!CanonicalSource("speaker", &canonical, &error));
  CHECK(error == "invalid_source");

  const std::vector<CatalogDevice> catalog = {
      Device("mic-1", "Headset", "microphone", "input", true, 48000, "active", {"multimedia"}),
      Device("spk-a", "Speakers", "system", "output", false, 48000, "active", {}),
      Device("spk-b", "Speakers", "system", "output", true, 44100, "active", {"multimedia"}),
      Device("spk-off", "Old Speakers", "system", "output", false, 48000, "disabled", {"communications"}),
  };

  DeviceChoice explicitA;
  explicitA.kind = "endpoint";
  explicitA.id = "spk-a";
  const ChoiceResolution resolvedA = ResolveChoice(catalog, "system", explicitA);
  CHECK(resolvedA.ok);
  CHECK(resolvedA.device.id == "spk-a");
  CHECK(resolvedA.device.sampleRate == 48000);
  CHECK(!resolvedA.device.isDefault);

  DeviceChoice explicitB;
  explicitB.kind = "endpoint";
  explicitB.id = "spk-b";
  const ChoiceResolution resolvedB = ResolveChoice(catalog, "system", explicitB);
  CHECK(resolvedB.ok);
  CHECK(resolvedB.device.id == "spk-b");
  CHECK(resolvedB.device.name == "Speakers");
  CHECK(resolvedB.device.sampleRate == 44100);

  DeviceChoice micAsSystem;
  micAsSystem.kind = "endpoint";
  micAsSystem.id = "mic-1";
  const ChoiceResolution wrong = ResolveChoice(catalog, "system", micAsSystem);
  CHECK(!wrong.ok);
  CHECK(wrong.code == "wrong_direction");

  DeviceChoice missing;
  missing.kind = "endpoint";
  missing.id = "gone";
  const ChoiceResolution missingResult = ResolveChoice(catalog, "system", missing);
  CHECK(!missingResult.ok);
  CHECK(missingResult.code == "missing_endpoint");

  DeviceChoice disabled;
  disabled.kind = "endpoint";
  disabled.id = "spk-off";
  const ChoiceResolution disabledResult = ResolveChoice(catalog, "system", disabled);
  CHECK(!disabledResult.ok);
  CHECK(disabledResult.code == "disabled_endpoint");

  DeviceChoice multimedia;
  multimedia.kind = "default";
  multimedia.role = "multimedia";
  const ChoiceResolution role = ResolveChoice(catalog, "system", multimedia);
  CHECK(role.ok);
  CHECK(role.device.id == "spk-b");
}

}  // namespace

int main() {
  TestPcm();
  TestRing();
  TestDrainAndLifecycle();
  TestCatalog();
  if (g_failed != 0) {
    std::cerr << g_failed << " failed\n";
    return 1;
  }
  std::cout << "ok\n";
  return 0;
}
