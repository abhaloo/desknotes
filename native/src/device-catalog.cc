#include "device-catalog.h"

#include <algorithm>
#include <cstring>
#include <thread>

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
// No SDK library exports PKEY_AudioEngine_DeviceFormat, so this file defines it.
#include <initguid.h>
#include <mmdeviceapi.h>
#include <mmreg.h>
#include <functiondiscoverykeys_devpkey.h>
#include <propvarutil.h>

namespace {

template <typename T>
class ComPtr {
 public:
  ComPtr() = default;
  ~ComPtr() { Reset(); }
  ComPtr(const ComPtr&) = delete;
  ComPtr& operator=(const ComPtr&) = delete;

  T* Get() const { return p_; }
  T* operator->() const { return p_; }
  explicit operator bool() const { return p_ != nullptr; }
  T** Out() {
    Reset();
    return &p_;
  }
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
  HRESULT hr() const { return hr_; }

 private:
  HRESULT hr_ = E_FAIL;
  bool uninit_ = false;
};

std::string WideToUtf8(const wchar_t* text) {
  if (!text || !*text) return {};
  const int chars = static_cast<int>(wcslen(text));
  const int bytes = WideCharToMultiByte(CP_UTF8, 0, text, chars, nullptr, 0, nullptr, nullptr);
  if (bytes <= 0) return {};
  std::string out(static_cast<std::size_t>(bytes), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text, chars, out.data(), bytes, nullptr, nullptr);
  return out;
}

std::string HresultCode(HRESULT hr) {
  char buf[48];
  sprintf_s(buf, "hresult_0x%08lX", static_cast<unsigned long>(hr));
  return buf;
}

const char* StateName(DWORD state) {
  switch (state) {
    case DEVICE_STATE_ACTIVE:
      return "active";
    case DEVICE_STATE_DISABLED:
      return "disabled";
    case DEVICE_STATE_NOTPRESENT:
      return "not_present";
    case DEVICE_STATE_UNPLUGGED:
      return "unplugged";
    default:
      return "unknown";
  }
}

bool HasRole(const CatalogDevice& device, const char* role) {
  return std::find(device.defaultRoles.begin(), device.defaultRoles.end(), role) != device.defaultRoles.end();
}

void AddRole(CatalogDevice& device, const char* role) {
  if (!HasRole(device, role)) device.defaultRoles.emplace_back(role);
}

void ReadFormat(IPropertyStore* store, int* channels, int* sampleRate) {
  *channels = 0;
  *sampleRate = 0;
  PROPVARIANT value;
  PropVariantInit(&value);
  const HRESULT hr = store->GetValue(PKEY_AudioEngine_DeviceFormat, &value);
  if (SUCCEEDED(hr) && value.vt == VT_BLOB && value.blob.pBlobData &&
      value.blob.cbSize >= sizeof(WAVEFORMATEX)) {
    WAVEFORMATEX format{};
    std::memcpy(&format, value.blob.pBlobData, sizeof(format));
    *channels = format.nChannels;
    *sampleRate = static_cast<int>(format.nSamplesPerSec);
  }
  PropVariantClear(&value);
}

void MarkRole(IMMDeviceEnumerator* enumerator, EDataFlow flow, ERole role, const char* name,
              bool makesDefault, std::vector<CatalogDevice>& devices) {
  ComPtr<IMMDevice> device;
  if (FAILED(enumerator->GetDefaultAudioEndpoint(flow, role, device.Out())) || !device) return;
  LPWSTR rawId = nullptr;
  if (FAILED(device->GetId(&rawId)) || !rawId) return;
  const std::string id = WideToUtf8(rawId);
  CoTaskMemFree(rawId);
  for (auto& item : devices) {
    if (item.id != id) continue;
    AddRole(item, name);
    if (makesDefault) item.isDefault = true;
  }
}

ListOutcome Enumerate(DWORD stateMask, const std::string& sourceFilter) {
  ListOutcome outcome;
  ComPtr<IMMDeviceEnumerator> enumerator;
  const HRESULT created = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                           __uuidof(IMMDeviceEnumerator),
                                           reinterpret_cast<void**>(enumerator.Out()));
  if (FAILED(created) || !enumerator) {
    outcome.code = HresultCode(created);
    return outcome;
  }

  struct FlowSpec {
    EDataFlow flow;
    const char* source;
    const char* type;
  };
  const FlowSpec flows[] = {
      {eCapture, "microphone", "input"},
      {eRender, "system", "output"},
  };
  for (const FlowSpec& flow : flows) {
    if (!sourceFilter.empty() && sourceFilter != flow.source) continue;
    ComPtr<IMMDeviceCollection> collection;
    const HRESULT listed = enumerator->EnumAudioEndpoints(flow.flow, stateMask, collection.Out());
    if (FAILED(listed) || !collection) {
      outcome.code = HresultCode(listed);
      return outcome;
    }
    UINT count = 0;
    collection->GetCount(&count);
    for (UINT index = 0; index < count; ++index) {
      ComPtr<IMMDevice> device;
      if (FAILED(collection->Item(index, device.Out())) || !device) continue;
      LPWSTR rawId = nullptr;
      if (FAILED(device->GetId(&rawId)) || !rawId) continue;
      CatalogDevice record;
      record.id = WideToUtf8(rawId);
      CoTaskMemFree(rawId);
      record.source = flow.source;
      record.type = flow.type;
      DWORD state = 0;
      if (SUCCEEDED(device->GetState(&state))) record.state = StateName(state);
      ComPtr<IPropertyStore> store;
      if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, store.Out())) && store) {
        PROPVARIANT name;
        PropVariantInit(&name);
        if (SUCCEEDED(store->GetValue(PKEY_Device_FriendlyName, &name)) && name.vt == VT_LPWSTR) {
          record.name = WideToUtf8(name.pwszVal);
        }
        PropVariantClear(&name);
        ReadFormat(store.Get(), &record.channels, &record.sampleRate);
      }
      outcome.devices.push_back(std::move(record));
    }
    MarkRole(enumerator.Get(), flow.flow, eMultimedia, "multimedia", true, outcome.devices);
    MarkRole(enumerator.Get(), flow.flow, eCommunications, "communications", false, outcome.devices);
    MarkRole(enumerator.Get(), flow.flow, eConsole, "console", false, outcome.devices);
    bool hasMultimedia = false;
    for (const auto& device : outcome.devices) {
      if (device.source == flow.source && HasRole(device, "multimedia")) hasMultimedia = true;
    }
    if (!hasMultimedia) {
      for (auto& device : outcome.devices) {
        if (device.source == flow.source && HasRole(device, "console")) {
          AddRole(device, "multimedia");
          device.isDefault = true;
        }
      }
    }
  }
  outcome.ok = true;
  outcome.code = "ok";
  return outcome;
}

}  // namespace

bool CanonicalSource(const std::string& input, std::string* canonical, std::string* error) {
  if (input == "microphone" || input == "input") {
    if (canonical) *canonical = "microphone";
    return true;
  }
  if (input == "system" || input == "output") {
    if (canonical) *canonical = "system";
    return true;
  }
  if (error) *error = "invalid_source";
  return false;
}

ChoiceResolution ResolveChoice(const std::vector<CatalogDevice>& catalog,
                               const std::string& sourceInput,
                               const DeviceChoice& choice) {
  ChoiceResolution result;
  std::string source;
  std::string error;
  if (!CanonicalSource(sourceInput, &source, &error)) {
    result.code = error;
    return result;
  }
  if (choice.kind == "endpoint") {
    if (choice.id.empty()) {
      result.code = "invalid_choice";
      return result;
    }
    const CatalogDevice* found = nullptr;
    for (const auto& device : catalog) {
      if (device.id == choice.id) {
        found = &device;
        break;
      }
    }
    if (!found) {
      result.code = "missing_endpoint";
      return result;
    }
    if (found->source != source) {
      result.code = "wrong_direction";
      return result;
    }
    if (found->state != "active") {
      result.code = "disabled_endpoint";
      return result;
    }
    result.ok = true;
    result.code = "ok";
    result.device = *found;
    return result;
  }
  if (choice.kind == "default") {
    if (choice.role != "multimedia" && choice.role != "communications") {
      result.code = "invalid_choice";
      return result;
    }
    const CatalogDevice* disabled = nullptr;
    for (const auto& device : catalog) {
      if (device.source != source || !HasRole(device, choice.role.c_str())) continue;
      if (device.state != "active") {
        disabled = &device;
        continue;
      }
      result.ok = true;
      result.code = "ok";
      result.device = device;
      return result;
    }
    result.code = disabled ? "disabled_endpoint" : "no_default";
    return result;
  }
  result.code = "invalid_choice";
  return result;
}

ListOutcome EnumerateActive(const std::string& sourceOrAlias) {
  std::string source;
  std::string error;
  if (!CanonicalSource(sourceOrAlias, &source, &error)) {
    ListOutcome outcome;
    outcome.code = error;
    return outcome;
  }
  return Enumerate(DEVICE_STATE_ACTIVE, source);
}

ChoiceResolution ResolveOnCurrentThread(const std::string& source, const DeviceChoice& choice) {
  std::string canonical;
  std::string error;
  if (!CanonicalSource(source, &canonical, &error)) {
    ChoiceResolution result;
    result.code = error;
    return result;
  }
  const ListOutcome all = Enumerate(DEVICE_STATEMASK_ALL, "");
  if (!all.ok) {
    ChoiceResolution result;
    result.code = all.code;
    return result;
  }
  return ResolveChoice(all.devices, canonical, choice);
}

ListOutcome ListActiveDevices(const std::string& sourceOrAlias) {
  ListOutcome outcome;
  std::thread worker([&] {
    ComApartment apartment;
    if (!apartment.ok()) {
      outcome.code = "com_init";
      return;
    }
    outcome = EnumerateActive(sourceOrAlias);
  });
  worker.join();
  return outcome;
}
