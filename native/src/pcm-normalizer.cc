#include "pcm-normalizer.h"

#include <cmath>
#include <cstring>

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <mmreg.h>

namespace {

constexpr std::uint32_t kMinRate = 8000;
constexpr std::uint32_t kMaxRate = 192000;
constexpr std::uint32_t kMaxFrames = 192000;

void Fail(std::string* error, const char* code) {
  if (error) *error = code;
}

bool RateOk(std::uint32_t rate) {
  return rate >= kMinRate && rate <= kMaxRate;
}

std::uint16_t ReadU16(const std::uint8_t* data) {
  return static_cast<std::uint16_t>(data[0] | (data[1] << 8));
}

std::uint32_t ReadU32(const std::uint8_t* data) {
  return static_cast<std::uint32_t>(data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24));
}

bool SameGuid(const GUID& left, const GUID& right) {
  return IsEqualGUID(left, right) == TRUE;
}

bool KindFor(bool isFloat, std::uint16_t containerBits, std::uint16_t validBits, PcmFormat::Kind* kind) {
  const std::uint16_t valid = validBits == 0 ? containerBits : validBits;
  if (isFloat) {
    if (containerBits == 32 && valid == 32) {
      *kind = PcmFormat::Kind::Float32;
      return true;
    }
    return false;
  }
  if (containerBits == 16 && valid == 16) {
    *kind = PcmFormat::Kind::Pcm16;
    return true;
  }
  if (containerBits == 24 && valid == 24) {
    *kind = PcmFormat::Kind::Pcm24In24;
    return true;
  }
  if (containerBits == 32 && valid == 24) {
    *kind = PcmFormat::Kind::Pcm24In32;
    return true;
  }
  if (containerBits == 32 && valid == 32) {
    *kind = PcmFormat::Kind::Pcm32;
    return true;
  }
  return false;
}

float ClampUnit(float sample) {
  if (!std::isfinite(sample)) return 0.0f;
  if (sample > 1.0f) return 1.0f;
  if (sample < -1.0f) return -1.0f;
  return sample;
}

float Decode(PcmFormat::Kind kind, const std::uint8_t* data) {
  if (kind == PcmFormat::Kind::Float32) {
    float sample = 0.0f;
    std::memcpy(&sample, data, sizeof(sample));
    return ClampUnit(sample);
  }
  if (kind == PcmFormat::Kind::Pcm16) {
    std::int16_t sample = 0;
    std::memcpy(&sample, data, sizeof(sample));
    return ClampUnit(static_cast<float>(sample) / 32768.0f);
  }
  if (kind == PcmFormat::Kind::Pcm32) {
    std::int32_t sample = 0;
    std::memcpy(&sample, data, sizeof(sample));
    return ClampUnit(static_cast<float>(sample) / 2147483648.0f);
  }
  std::int32_t value = 0;
  if (kind == PcmFormat::Kind::Pcm24In24) {
    value = data[0] | (data[1] << 8) | (data[2] << 16);
  } else {
    std::int32_t raw = 0;
    std::memcpy(&raw, data, sizeof(raw));
    value = raw & 0xFFFFFF;
  }
  if (value & 0x800000) value |= ~0xFFFFFF;
  return ClampUnit(static_cast<float>(value) / 8388608.0f);
}

}  // namespace

bool DescribeWaveFormat(const void* format, std::size_t bytes, PcmFormat* out, std::string* error) {
  if (!out) {
    Fail(error, "invalid_wave_format");
    return false;
  }
  if (!format || bytes < 18) {
    Fail(error, "invalid_wave_format");
    return false;
  }
  const auto* raw = static_cast<const std::uint8_t*>(format);
  const std::uint16_t tag = ReadU16(raw);
  const std::uint16_t channels = ReadU16(raw + 2);
  const std::uint32_t sampleRate = ReadU32(raw + 4);
  const std::uint32_t avgBytes = ReadU32(raw + 8);
  const std::uint16_t blockAlign = ReadU16(raw + 12);
  const std::uint16_t bits = ReadU16(raw + 14);
  const std::uint16_t extra = ReadU16(raw + 16);
  if (channels == 0 || channels > 32 || !RateOk(sampleRate) || bits == 0 || bits % 8 != 0) {
    Fail(error, "unsupported_format");
    return false;
  }
  const std::uint16_t containerBytes = static_cast<std::uint16_t>(bits / 8);
  if (blockAlign != containerBytes * channels || avgBytes != sampleRate * blockAlign) {
    Fail(error, "invalid_wave_format");
    return false;
  }

  bool isFloat = false;
  std::uint16_t validBits = bits;
  if (tag == WAVE_FORMAT_IEEE_FLOAT) {
    isFloat = true;
  } else if (tag == WAVE_FORMAT_PCM) {
    isFloat = false;
  } else if (tag == WAVE_FORMAT_EXTENSIBLE) {
    if (extra < 22 || bytes < 40) {
      Fail(error, "invalid_wave_format");
      return false;
    }
    validBits = ReadU16(raw + 18);
    GUID subFormat{};
    std::memcpy(&subFormat, raw + 24, sizeof(subFormat));
    if (SameGuid(subFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT)) {
      isFloat = true;
    } else if (SameGuid(subFormat, KSDATAFORMAT_SUBTYPE_PCM)) {
      isFloat = false;
    } else {
      Fail(error, "unsupported_format");
      return false;
    }
  } else {
    Fail(error, "unsupported_format");
    return false;
  }

  PcmFormat::Kind kind = PcmFormat::Kind::Float32;
  if (!KindFor(isFloat, bits, validBits, &kind)) {
    Fail(error, "unsupported_format");
    return false;
  }
  out->kind = kind;
  out->channels = channels;
  out->sampleRate = sampleRate;
  out->containerBits = bits;
  out->validBits = validBits == 0 ? bits : validBits;
  if (error) error->clear();
  return true;
}

bool NormalizeToMono(const PcmFormat& format,
                     const std::uint8_t* data,
                     std::uint32_t frames,
                     const PacketFlags& flags,
                     std::vector<float>* mono,
                     std::string* error) {
  if (!mono || format.channels == 0 || format.containerBits % 8 != 0) {
    Fail(error, "unsupported_format");
    return false;
  }
  if (frames > kMaxFrames) {
    Fail(error, "packet_too_large");
    return false;
  }
  mono->assign(frames, 0.0f);
  if (frames == 0 || flags.silent) return true;
  if (!data) {
    mono->clear();
    Fail(error, "null_packet_data");
    return false;
  }
  const std::size_t sampleBytes = format.containerBits / 8;
  for (std::uint32_t frame = 0; frame < frames; ++frame) {
    const std::uint8_t* frameData = data + static_cast<std::size_t>(frame) * format.channels * sampleBytes;
    float sum = 0.0f;
    for (std::uint16_t channel = 0; channel < format.channels; ++channel) {
      sum += Decode(format.kind, frameData + static_cast<std::size_t>(channel) * sampleBytes);
    }
    (*mono)[frame] = ClampUnit(sum / static_cast<float>(format.channels));
  }
  return true;
}
