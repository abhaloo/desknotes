#pragma once

#include <string>
#include <vector>

struct CatalogDevice {
  std::string id;
  std::string name;
  std::string source;
  std::string type;
  bool isDefault = false;
  int channels = 0;
  int sampleRate = 0;
  std::string state;
  std::vector<std::string> defaultRoles;
};

struct DeviceChoice {
  std::string kind;
  std::string id;
  std::string role;
};

struct ChoiceResolution {
  bool ok = false;
  std::string code;
  CatalogDevice device;
};

struct ListOutcome {
  bool ok = false;
  std::string code;
  std::vector<CatalogDevice> devices;
};

// Accepts "microphone"/"input" and "system"/"output".
bool CanonicalSource(const std::string& input, std::string* canonical, std::string* error);

// Resolves a choice against a caller-supplied snapshot. Identity is the
// endpoint id. Friendly names are not unique and are not used as keys.
ChoiceResolution ResolveChoice(const std::vector<CatalogDevice>& catalog,
                               const std::string& source,
                               const DeviceChoice& choice);

// Lists active endpoints on a thread this function owns. It does not call
// IAudioClient::Initialize or IAudioClient::Start.
ListOutcome ListActiveDevices(const std::string& sourceOrAlias);

// Requires the caller to have initialized COM on the current thread.
ListOutcome EnumerateActive(const std::string& sourceOrAlias);
ChoiceResolution ResolveOnCurrentThread(const std::string& source, const DeviceChoice& choice);
