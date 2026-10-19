#ifndef NAPI_VERSION
#define NAPI_VERSION 8
#endif

#include "device-catalog.h"
#include "wasapi-source.h"

#include <cmath>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <node_api.h>

namespace {

struct CallbackSlot {
  std::mutex mu;
  napi_threadsafe_function fn = nullptr;
  napi_ref callback = nullptr;
  WasapiSource* source = nullptr;

  void Invoke() {
    std::lock_guard<std::mutex> lock(mu);
    if (!fn || !source) return;
    napi_call_threadsafe_function(fn, source, napi_tsfn_nonblocking);
  }

  void Release() {
    napi_threadsafe_function local = nullptr;
    {
      std::lock_guard<std::mutex> lock(mu);
      local = fn;
      fn = nullptr;
      source = nullptr;
    }
    if (local) napi_release_threadsafe_function(local, napi_tsfn_abort);
  }
};

struct AddonState {
  std::mutex mu;
  std::unordered_map<std::uint64_t, std::shared_ptr<WasapiSource>> sources;
  std::unordered_map<std::uint64_t, std::shared_ptr<CallbackSlot>> slots;
  std::uint64_t nextHandle = 1;
  bool disposed = false;

  void Shutdown() {
    std::vector<std::shared_ptr<WasapiSource>> localSources;
    std::vector<std::shared_ptr<CallbackSlot>> localSlots;
    {
      std::lock_guard<std::mutex> lock(mu);
      disposed = true;
      for (auto& entry : sources) localSources.push_back(entry.second);
      sources.clear();
      for (auto& entry : slots) localSlots.push_back(entry.second);
      slots.clear();
    }
    for (const auto& source : localSources) source->Stop();
    for (const auto& slot : localSlots) slot->Release();
  }
};

void EnvCleanup(void* arg) {
  // Join capture threads and abort callbacks. Keep the state object: Node
  // still holds it as instance data for the rest of environment teardown.
  auto* state = static_cast<AddonState*>(arg);
  if (!state) return;
  state->Shutdown();
}

AddonState* GetState(napi_env env) {
  void* data = nullptr;
  if (napi_get_instance_data(env, &data) != napi_ok) return nullptr;
  return static_cast<AddonState*>(data);
}

bool SetString(napi_env env, napi_value object, const char* name, const std::string& value) {
  napi_value out = nullptr;
  if (napi_create_string_utf8(env, value.c_str(), value.size(), &out) != napi_ok) return false;
  return napi_set_named_property(env, object, name, out) == napi_ok;
}

bool SetBool(napi_env env, napi_value object, const char* name, bool value) {
  napi_value out = nullptr;
  if (napi_get_boolean(env, value, &out) != napi_ok) return false;
  return napi_set_named_property(env, object, name, out) == napi_ok;
}

bool SetNumber(napi_env env, napi_value object, const char* name, double value) {
  napi_value out = nullptr;
  if (napi_create_double(env, value, &out) != napi_ok) return false;
  return napi_set_named_property(env, object, name, out) == napi_ok;
}

void Reject(napi_env env, napi_deferred deferred, const std::string& code) {
  napi_value message = nullptr;
  napi_value error = nullptr;
  if (napi_create_string_utf8(env, code.c_str(), code.size(), &message) != napi_ok) return;
  if (napi_create_error(env, nullptr, message, &error) != napi_ok) return;
  napi_reject_deferred(env, deferred, error);
}

std::string ReadString(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return {};
  std::string out(length, '\0');
  if (napi_get_value_string_utf8(env, value, out.data(), length + 1, &length) != napi_ok) return {};
  return out;
}

bool ReadNamedString(napi_env env, napi_value object, const char* name, std::string* out) {
  napi_value value = nullptr;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return false;
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  *out = ReadString(env, value);
  return true;
}

bool ReadUint53(napi_env env, napi_value value, std::uint64_t* out) {
  double number = 0;
  if (napi_get_value_double(env, value, &number) != napi_ok) return false;
  if (!std::isfinite(number) || number < 0 || number > 9007199254740991.0 || std::floor(number) != number) {
    return false;
  }
  *out = static_cast<std::uint64_t>(number);
  return true;
}

napi_value DeviceToJs(napi_env env, const CatalogDevice& device) {
  napi_value object = nullptr;
  if (napi_create_object(env, &object) != napi_ok) return nullptr;
  if (!SetString(env, object, "id", device.id) || !SetString(env, object, "name", device.name) ||
      !SetString(env, object, "source", device.source) || !SetString(env, object, "type", device.type) ||
      !SetBool(env, object, "isDefault", device.isDefault) || !SetNumber(env, object, "channels", device.channels) ||
      !SetNumber(env, object, "sampleRate", device.sampleRate) || !SetString(env, object, "state", device.state)) {
    return nullptr;
  }
  napi_value roles = nullptr;
  if (napi_create_array_with_length(env, device.defaultRoles.size(), &roles) != napi_ok) return nullptr;
  for (std::size_t index = 0; index < device.defaultRoles.size(); ++index) {
    napi_value role = nullptr;
    if (napi_create_string_utf8(env, device.defaultRoles[index].c_str(), device.defaultRoles[index].size(), &role) != napi_ok) {
      return nullptr;
    }
    if (napi_set_element(env, roles, static_cast<uint32_t>(index), role) != napi_ok) return nullptr;
  }
  if (napi_set_named_property(env, object, "defaultRoles", roles) != napi_ok) return nullptr;
  return object;
}

bool EmitControl(napi_env env, napi_value callback, const ControlEvent& event) {
  napi_value object = nullptr;
  napi_value global = nullptr;
  if (napi_create_object(env, &object) != napi_ok) return false;
  if (!SetString(env, object, "type", event.type) || !SetString(env, object, "source", event.source) ||
      !SetNumber(env, object, "generation", static_cast<double>(event.generation)) ||
      !SetString(env, object, "endpointId", event.endpointId) || !SetString(env, object, "code", event.code) ||
      !SetString(env, object, "message", event.message) || !SetString(env, object, "reason", event.reason) ||
      !SetBool(env, object, "terminal", event.terminal)) {
    return false;
  }
  if (napi_get_global(env, &global) != napi_ok) return false;
  napi_value argv[] = {object};
  napi_value ignored = nullptr;
  return napi_call_function(env, global, callback, 1, argv, &ignored) == napi_ok;
}

bool EmitAudio(napi_env env, napi_value callback, const AudioBatch& batch) {
  napi_value object = nullptr;
  napi_value global = nullptr;
  if (napi_create_object(env, &object) != napi_ok) return false;
  void* bytes = nullptr;
  napi_value buffer = nullptr;
  const size_t byteLength = batch.samples.size() * sizeof(float);
  if (napi_create_arraybuffer(env, byteLength, &bytes, &buffer) != napi_ok) return false;
  if (!batch.samples.empty()) {
    std::memcpy(bytes, batch.samples.data(), byteLength);
  }
  napi_value pcm = nullptr;
  if (napi_create_typedarray(env, napi_float32_array, batch.samples.size(), buffer, 0, &pcm) != napi_ok) return false;
  napi_value flags = nullptr;
  if (napi_create_object(env, &flags) != napi_ok) return false;
  if (!SetBool(env, flags, "silent", batch.silent) || !SetBool(env, flags, "discontinuity", batch.discontinuity) ||
      !SetBool(env, flags, "timestampError", batch.timestampError) ||
      !SetBool(env, flags, "syntheticIdleSilence", batch.syntheticIdleSilence)) {
    return false;
  }
  if (!SetString(env, object, "type", "audio") || !SetString(env, object, "source", batch.source) ||
      !SetNumber(env, object, "generation", static_cast<double>(batch.generation)) ||
      !SetString(env, object, "endpointId", batch.endpointId) ||
      !SetNumber(env, object, "sampleRate", batch.sampleRate) ||
      !SetNumber(env, object, "sampleIndex", static_cast<double>(batch.sampleIndex)) ||
      !SetNumber(env, object, "qpcTimestamp100ns", static_cast<double>(batch.qpcTimestamp100ns)) ||
      !SetNumber(env, object, "sequence", static_cast<double>(batch.sequence))) {
    return false;
  }
  if (napi_set_named_property(env, object, "pcm", pcm) != napi_ok) return false;
  if (napi_set_named_property(env, object, "flags", flags) != napi_ok) return false;
  if (napi_get_global(env, &global) != napi_ok) return false;
  napi_value argv[] = {object};
  napi_value ignored = nullptr;
  return napi_call_function(env, global, callback, 1, argv, &ignored) == napi_ok;
}

void DrainToJs(napi_env env, napi_value callback, WasapiSource* source) {
  if (!env || !callback || !source) return;
  for (;;) {
    Drained drained;
    if (!source->TakePending(&drained)) return;
    for (const auto& event : drained.control) {
      if (!EmitControl(env, callback, event)) return;
    }
    if (drained.terminal && !EmitControl(env, callback, *drained.terminal)) return;
    for (const auto& batch : drained.audio) {
      if (!EmitAudio(env, callback, batch)) return;
    }
  }
}

void CallJs(napi_env env, napi_value callback, void*, void* data) {
  if (!env || !callback || !data) return;
  DrainToJs(env, callback, static_cast<WasapiSource*>(data));
}

napi_value GetCapabilities(napi_env env, napi_callback_info) {
  napi_value object = nullptr;
  if (napi_create_object(env, &object) != napi_ok) return nullptr;
  const char* arch = "unknown";
#if defined(_M_X64) || defined(__x86_64__)
  arch = "x64";
#endif
  if (!SetNumber(env, object, "apiVersion", 1) || !SetString(env, object, "backend", "wasapi-loopback") ||
      !SetNumber(env, object, "napiVersion", 8) || !SetString(env, object, "arch", arch) ||
      !SetBool(env, object, "supportsMicrophone", true) || !SetBool(env, object, "supportsSystemAudio", true) ||
      !SetBool(env, object, "supportsInputDeviceSelection", true) ||
      !SetBool(env, object, "supportsOutputDeviceSelection", true) || !SetBool(env, object, "supportsAec", false)) {
    return nullptr;
  }
  return object;
}

struct ListWork {
  napi_deferred deferred = nullptr;
  napi_async_work work = nullptr;
  std::string source;
  ListOutcome outcome;
};

void ListExecute(napi_env, void* data) {
  auto* work = static_cast<ListWork*>(data);
  try {
    work->outcome = ListActiveDevices(work->source);
  } catch (...) {
    work->outcome.ok = false;
    work->outcome.code = "internal_error";
  }
}

void ListComplete(napi_env env, napi_status, void* data) {
  std::unique_ptr<ListWork> work(static_cast<ListWork*>(data));
  if (!work->outcome.ok) {
    Reject(env, work->deferred, work->outcome.code.empty() ? "list_devices" : work->outcome.code);
  } else {
    napi_value array = nullptr;
    if (napi_create_array_with_length(env, work->outcome.devices.size(), &array) != napi_ok) {
      Reject(env, work->deferred, "list_devices");
    } else {
      bool built = true;
      for (std::size_t index = 0; index < work->outcome.devices.size(); ++index) {
        napi_value device = DeviceToJs(env, work->outcome.devices[index]);
        if (!device || napi_set_element(env, array, static_cast<uint32_t>(index), device) != napi_ok) {
          built = false;
          break;
        }
      }
      if (!built) Reject(env, work->deferred, "list_devices");
      else napi_resolve_deferred(env, work->deferred, array);
    }
  }
  napi_delete_async_work(env, work->work);
}

napi_value ListDevices(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_deferred deferred = nullptr;
  napi_value promise = nullptr;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok) return nullptr;
  if (argc < 1) {
    Reject(env, deferred, "invalid_source");
    return promise;
  }
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_string) {
    Reject(env, deferred, "invalid_source");
    return promise;
  }
  auto work = std::make_unique<ListWork>();
  work->deferred = deferred;
  work->source = ReadString(env, argv[0]);
  ListWork* raw = work.get();
  napi_value name = nullptr;
  napi_create_string_utf8(env, "listDevices", NAPI_AUTO_LENGTH, &name);
  if (napi_create_async_work(env, nullptr, name, ListExecute, ListComplete, raw, &raw->work) != napi_ok ||
      napi_queue_async_work(env, raw->work) != napi_ok) {
    Reject(env, deferred, "list_devices");
    return promise;
  }
  work.release();
  return promise;
}

struct StartWork {
  napi_deferred deferred = nullptr;
  napi_async_work work = nullptr;
  AddonState* state = nullptr;
  std::shared_ptr<WasapiSource> source;
  std::shared_ptr<CallbackSlot> slot;
  WasapiSource::Config config;
  WasapiSource::Started started;
  std::uint64_t handle = 0;
  std::string code;
};

void StartExecute(napi_env, void* data) {
  auto* work = static_cast<StartWork*>(data);
  try {
    work->started = work->source->Start(work->config);
  } catch (...) {
    work->started.ok = false;
    work->started.code = "internal_error";
  }
}

napi_value StartedToJs(napi_env env, const WasapiSource::Started& started) {
  napi_value object = nullptr;
  if (napi_create_object(env, &object) != napi_ok) return nullptr;
  if (!SetNumber(env, object, "handle", static_cast<double>(started.handle)) ||
      !SetNumber(env, object, "generation", static_cast<double>(started.generation)) ||
      !SetString(env, object, "endpointId", started.endpointId) ||
      !SetString(env, object, "endpointName", started.endpointName) ||
      !SetNumber(env, object, "sampleRate", started.sampleRate) ||
      !SetNumber(env, object, "nativeChannels", started.nativeChannels) ||
      !SetString(env, object, "encoding", started.encoding) ||
      !SetNumber(env, object, "clockOriginQpc100ns", static_cast<double>(started.clockOriginQpc100ns))) {
    return nullptr;
  }
  return object;
}

void EraseSource(AddonState* state, std::uint64_t handle) {
  std::lock_guard<std::mutex> lock(state->mu);
  state->sources.erase(handle);
  state->slots.erase(handle);
}

napi_ref TakeCallback(const std::shared_ptr<CallbackSlot>& slot) {
  if (!slot) return nullptr;
  std::lock_guard<std::mutex> lock(slot->mu);
  napi_ref ref = slot->callback;
  slot->callback = nullptr;
  return ref;
}

void CloseSlot(napi_env env, const std::shared_ptr<CallbackSlot>& slot, WasapiSource* source, bool drain) {
  napi_ref ref = TakeCallback(slot);
  if (ref) {
    if (drain && source) {
      napi_value callback = nullptr;
      if (napi_get_reference_value(env, ref, &callback) == napi_ok) DrainToJs(env, callback, source);
    }
    napi_delete_reference(env, ref);
  }
  if (slot) slot->Release();
}

void StartComplete(napi_env env, napi_status, void* data) {
  std::unique_ptr<StartWork> work(static_cast<StartWork*>(data));
  if (!work->started.ok) {
    work->source->Stop();
    CloseSlot(env, work->slot, work->source.get(), false);
    EraseSource(work->state, work->handle);
    Reject(env, work->deferred, work->started.code.empty() ? "start_source" : work->started.code);
  } else {
    napi_value value = StartedToJs(env, work->started);
    if (!value) Reject(env, work->deferred, "start_source");
    else napi_resolve_deferred(env, work->deferred, value);
  }
  napi_delete_async_work(env, work->work);
}

napi_value StartSource(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_deferred deferred = nullptr;
  napi_value promise = nullptr;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok) return nullptr;
  AddonState* state = GetState(env);
  if (!state) {
    Reject(env, deferred, "disposed");
    return promise;
  }
  if (argc < 2) {
    Reject(env, deferred, "invalid_choice");
    return promise;
  }
  napi_valuetype optionsType = napi_undefined;
  napi_valuetype callbackType = napi_undefined;
  if (napi_typeof(env, argv[0], &optionsType) != napi_ok || optionsType != napi_object ||
      napi_typeof(env, argv[1], &callbackType) != napi_ok || callbackType != napi_function) {
    Reject(env, deferred, "invalid_choice");
    return promise;
  }
  std::string requested;
  std::string canonical;
  std::string error;
  if (!ReadNamedString(env, argv[0], "source", &requested) || !CanonicalSource(requested, &canonical, &error)) {
    Reject(env, deferred, "invalid_source");
    return promise;
  }
  napi_value generationValue = nullptr;
  std::uint64_t generation = 0;
  if (napi_get_named_property(env, argv[0], "generation", &generationValue) != napi_ok ||
      !ReadUint53(env, generationValue, &generation)) {
    Reject(env, deferred, "invalid_generation");
    return promise;
  }
  napi_value choiceValue = nullptr;
  if (napi_get_named_property(env, argv[0], "choice", &choiceValue) != napi_ok) {
    Reject(env, deferred, "invalid_choice");
    return promise;
  }
  DeviceChoice choice;
  if (!ReadNamedString(env, choiceValue, "kind", &choice.kind)) {
    Reject(env, deferred, "invalid_choice");
    return promise;
  }
  if (choice.kind == "endpoint") {
    if (!ReadNamedString(env, choiceValue, "id", &choice.id) || choice.id.empty()) {
      Reject(env, deferred, "invalid_choice");
      return promise;
    }
  } else if (choice.kind == "default") {
    if (!ReadNamedString(env, choiceValue, "role", &choice.role) ||
        (choice.role != "multimedia" && choice.role != "communications")) {
      Reject(env, deferred, "invalid_choice");
      return promise;
    }
  } else {
    Reject(env, deferred, "invalid_choice");
    return promise;
  }

  auto slot = std::make_shared<CallbackSlot>();
  std::uint64_t handle = 0;
  {
    std::lock_guard<std::mutex> lock(state->mu);
    if (state->disposed) {
      Reject(env, deferred, "disposed");
      return promise;
    }
    handle = state->nextHandle++;
  }
  auto source = std::make_shared<WasapiSource>(handle);
  slot->source = source.get();
  if (napi_create_reference(env, argv[1], 1, &slot->callback) != napi_ok) {
    Reject(env, deferred, "callback");
    return promise;
  }
  napi_value resource = nullptr;
  napi_create_string_utf8(env, "wasapi-source", NAPI_AUTO_LENGTH, &resource);
  if (napi_create_threadsafe_function(env, argv[1], nullptr, resource, 0, 1, nullptr, nullptr, nullptr, CallJs,
                                      &slot->fn) != napi_ok) {
    CloseSlot(env, slot, nullptr, false);
    Reject(env, deferred, "callback");
    return promise;
  }
  source->Reserve(canonical);
  source->SetWake([slot] { slot->Invoke(); });
  bool rejected = false;
  std::string rejectCode;
  {
    std::lock_guard<std::mutex> lock(state->mu);
    if (state->disposed) {
      rejected = true;
      rejectCode = "disposed";
    } else {
      for (const auto& entry : state->sources) {
        if (entry.second && entry.second->source() == canonical) rejected = true;
      }
      if (rejected) rejectCode = "source_busy";
    }
    if (!rejected) {
      state->sources.emplace(handle, source);
      state->slots.emplace(handle, slot);
    }
  }
  if (rejected) {
    CloseSlot(env, slot, nullptr, false);
    Reject(env, deferred, rejectCode);
    return promise;
  }

  auto work = std::make_unique<StartWork>();
  work->deferred = deferred;
  work->state = state;
  work->source = source;
  work->slot = slot;
  work->handle = handle;
  work->config.source = canonical;
  work->config.choice = choice;
  work->config.generation = generation;
  StartWork* raw = work.get();
  napi_value name = nullptr;
  napi_create_string_utf8(env, "startSource", NAPI_AUTO_LENGTH, &name);
  if (napi_create_async_work(env, nullptr, name, StartExecute, StartComplete, raw, &raw->work) != napi_ok ||
      napi_queue_async_work(env, raw->work) != napi_ok) {
    EraseSource(state, handle);
    CloseSlot(env, slot, nullptr, false);
    Reject(env, deferred, "start_source");
    return promise;
  }
  work.release();
  return promise;
}

struct StopWork {
  napi_deferred deferred = nullptr;
  napi_async_work work = nullptr;
  AddonState* state = nullptr;
  std::shared_ptr<WasapiSource> source;
  std::shared_ptr<CallbackSlot> slot;
  std::uint64_t handle = 0;
  WasapiSource::Stopped stopped;
  std::string code;
};

void StopExecute(napi_env, void* data) {
  auto* work = static_cast<StopWork*>(data);
  try {
    work->stopped = work->source->Stop();
  } catch (...) {
    work->code = "internal_error";
  }
}

void StopComplete(napi_env env, napi_status, void* data) {
  std::unique_ptr<StopWork> work(static_cast<StopWork*>(data));
  CloseSlot(env, work->slot, work->source.get(), true);
  EraseSource(work->state, work->handle);
  if (!work->code.empty()) {
    Reject(env, work->deferred, work->code);
  } else {
    napi_value object = nullptr;
    napi_create_object(env, &object);
    SetBool(env, object, "stopped", true);
    SetNumber(env, object, "droppedSamples", static_cast<double>(work->stopped.droppedSamples));
    SetNumber(env, object, "flushedSamples", static_cast<double>(work->stopped.flushedSamples));
    napi_resolve_deferred(env, work->deferred, object);
  }
  napi_delete_async_work(env, work->work);
}

napi_value StopSource(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_deferred deferred = nullptr;
  napi_value promise = nullptr;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok) return nullptr;
  AddonState* state = GetState(env);
  if (!state) {
    Reject(env, deferred, "disposed");
    return promise;
  }
  std::uint64_t handle = 0;
  if (argc < 1 || !ReadUint53(env, argv[0], &handle)) {
    Reject(env, deferred, "unknown_handle");
    return promise;
  }
  auto work = std::make_unique<StopWork>();
  {
    std::lock_guard<std::mutex> lock(state->mu);
    if (state->disposed) {
      Reject(env, deferred, "disposed");
      return promise;
    }
    const auto source = state->sources.find(handle);
    const auto slot = state->slots.find(handle);
    if (source == state->sources.end() || slot == state->slots.end()) {
      Reject(env, deferred, "unknown_handle");
      return promise;
    }
    work->source = source->second;
    work->slot = slot->second;
  }
  work->deferred = deferred;
  work->state = state;
  work->handle = handle;
  StopWork* raw = work.get();
  napi_value name = nullptr;
  napi_create_string_utf8(env, "stopSource", NAPI_AUTO_LENGTH, &name);
  if (napi_create_async_work(env, nullptr, name, StopExecute, StopComplete, raw, &raw->work) != napi_ok ||
      napi_queue_async_work(env, raw->work) != napi_ok) {
    Reject(env, deferred, "stop_source");
    return promise;
  }
  work.release();
  return promise;
}

struct DisposeWork {
  napi_deferred deferred = nullptr;
  napi_async_work work = nullptr;
  AddonState* state = nullptr;
  std::vector<std::shared_ptr<WasapiSource>> sources;
  std::vector<std::shared_ptr<CallbackSlot>> slots;
};

void DisposeExecute(napi_env, void* data) {
  auto* work = static_cast<DisposeWork*>(data);
  for (const auto& source : work->sources) {
    try {
      source->Stop();
    } catch (...) {
    }
  }
}

void DisposeComplete(napi_env env, napi_status, void* data) {
  std::unique_ptr<DisposeWork> work(static_cast<DisposeWork*>(data));
  for (const auto& slot : work->slots) CloseSlot(env, slot, slot->source, true);
  napi_value undefined = nullptr;
  napi_get_undefined(env, &undefined);
  napi_resolve_deferred(env, work->deferred, undefined);
  napi_delete_async_work(env, work->work);
}

napi_value Dispose(napi_env env, napi_callback_info) {
  napi_deferred deferred = nullptr;
  napi_value promise = nullptr;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok) return nullptr;
  AddonState* state = GetState(env);
  if (!state) {
    napi_value undefined = nullptr;
    napi_get_undefined(env, &undefined);
    napi_resolve_deferred(env, deferred, undefined);
    return promise;
  }
  auto work = std::make_unique<DisposeWork>();
  {
    std::lock_guard<std::mutex> lock(state->mu);
    state->disposed = true;
    for (auto& entry : state->sources) work->sources.push_back(entry.second);
    for (auto& entry : state->slots) work->slots.push_back(entry.second);
    state->sources.clear();
    state->slots.clear();
  }
  work->deferred = deferred;
  work->state = state;
  DisposeWork* raw = work.get();
  napi_value name = nullptr;
  napi_create_string_utf8(env, "dispose", NAPI_AUTO_LENGTH, &name);
  if (napi_create_async_work(env, nullptr, name, DisposeExecute, DisposeComplete, raw, &raw->work) != napi_ok ||
      napi_queue_async_work(env, raw->work) != napi_ok) {
    Reject(env, deferred, "dispose");
    return promise;
  }
  work.release();
  return promise;
}

napi_value Init(napi_env env, napi_value exports) {
  auto* state = new AddonState();
  if (napi_set_instance_data(env, state, nullptr, nullptr) != napi_ok) {
    delete state;
    return nullptr;
  }
  napi_add_env_cleanup_hook(env, EnvCleanup, state);
  const napi_property_descriptor descriptors[] = {
      {"getCapabilities", nullptr, GetCapabilities, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"listDevices", nullptr, ListDevices, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"startSource", nullptr, StartSource, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stopSource", nullptr, StopSource, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"dispose", nullptr, Dispose, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports, 5, descriptors) != napi_ok) return nullptr;
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
