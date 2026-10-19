{
  "variables": {
    "napi_build_version": 8
  },
  "targets": [
    {
      "target_name": "audio_capture",
      "win_delay_load_hook": "true",
      "sources": [
        "src/addon.cc",
        "src/device-catalog.cc",
        "src/wasapi-source.cc",
        "src/pcm-normalizer.cc"
      ],
      "include_dirs": [
        "src"
      ],
      "defines": [
        "NAPI_VERSION=8",
        "WIN32_LEAN_AND_MEAN",
        "NOMINMAX",
        "UNICODE",
        "_UNICODE"
      ],
      "libraries": [
        "-lole32",
        "-luuid",
        "-lpropsys",
        "-lavrt",
        "-lmmdevapi"
      ],
      "configurations": {
        "Release": {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "RuntimeLibrary": 0,
              "AdditionalOptions": [
                "/std:c++17",
                "/EHsc",
                "/Zc:__cplusplus"
              ]
            }
          }
        },
        "Debug": {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "RuntimeLibrary": 1,
              "AdditionalOptions": [
                "/std:c++17",
                "/EHsc",
                "/Zc:__cplusplus"
              ]
            }
          }
        }
      }
    },
    {
      "target_name": "audio_core_test",
      "type": "executable",
      "win_delay_load_hook": "false",
      "sources": [
        "test/audio-core.test.cc",
        "src/device-catalog.cc",
        "src/wasapi-source.cc",
        "src/pcm-normalizer.cc"
      ],
      "include_dirs": [
        "src"
      ],
      "defines": [
        "WIN32_LEAN_AND_MEAN",
        "NOMINMAX",
        "UNICODE",
        "_UNICODE"
      ],
      "libraries": [
        "-lole32",
        "-luuid",
        "-lpropsys",
        "-lavrt",
        "-lmmdevapi"
      ],
      "configurations": {
        "Release": {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "RuntimeLibrary": 0,
              "AdditionalOptions": [
                "/std:c++17",
                "/EHsc",
                "/Zc:__cplusplus"
              ]
            }
          }
        },
        "Debug": {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "RuntimeLibrary": 1,
              "AdditionalOptions": [
                "/std:c++17",
                "/EHsc",
                "/Zc:__cplusplus"
              ]
            }
          }
        }
      }
    }
  ]
}
