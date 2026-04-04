{
  "targets": [{
    "target_name": "game_capture",
    "cflags!": ["-fno-exceptions"],
    "cflags_cc!": ["-fno-exceptions"],
    "sources": [
      "src/addon.cpp",
      "src/game_detect.cpp",
      "src/process_audio.cpp"
    ],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")"
    ],
    "defines": [
      "NAPI_DISABLE_CPP_EXCEPTIONS",
      "UNICODE",
      "_UNICODE",
      "WIN32_LEAN_AND_MEAN",
      "NOMINMAX"
    ],
    "conditions": [
      ["OS=='win'", {
        "msvs_settings": {
          "VCCLCompilerTool": {
            "AdditionalOptions": ["/std:c++17", "/EHsc"],
            "ExceptionHandling": 1
          }
        },
        "libraries": [
          "-lavrt.lib",
          "-lole32.lib",
          "-lpsapi.lib",
          "-lpropsys.lib",
          "-lmmdevapi.lib"
        ]
      }]
    ]
  }]
}
