#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

struct PacketFlags {
  bool silent = false;
  bool discontinuity = false;
  bool timestampError = false;
};

struct PcmFormat {
  enum class Kind { Float32, Pcm16, Pcm24In24, Pcm24In32, Pcm32 };
  Kind kind = Kind::Float32;
  std::uint16_t channels = 0;
  std::uint32_t sampleRate = 0;
  std::uint16_t validBits = 0;
  std::uint16_t containerBits = 0;
};

// Accepts IEEE Float32, PCM16, packed PCM24, PCM24-in-32, and PCM32.
// Rejects every other WAVEFORMATEX / WAVEFORMATEXTENSIBLE layout.
bool DescribeWaveFormat(const void* format, std::size_t bytes, PcmFormat* out, std::string* error);

// Writes one mono float per frame in [-1, 1]. A silent flag yields exact
// zeros and does not read `data`, including when `data` is null.
bool NormalizeToMono(const PcmFormat& format,
                     const std::uint8_t* data,
                     std::uint32_t frames,
                     const PacketFlags& flags,
                     std::vector<float>* mono,
                     std::string* error);
