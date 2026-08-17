{
  "targets": [
    {
      "target_name": "afpacket",
      "sources": ["src/afpacket.c"],
      "comment": "Pure-C N-API addon: uses <node_api.h> from the Node headers node-gyp provides. No node-addon-api C++ wrapper, so no include_dirs/exception flags to resolve — keeps the build self-contained (only node-gyp + a C toolchain).",
      "conditions": [
        [
          "OS=='linux'",
          {
            "cflags": ["-Wall", "-Wextra", "-O2"]
          }
        ],
        [
          "OS=='mac'",
          {
            "xcode_settings": {
              "OTHER_CFLAGS": ["-Wall", "-Wextra", "-O2"]
            }
          }
        ],
        [
          "OS!='linux' and OS!='mac'",
          {
            "sources": [],
            "type": "none"
          }
        ]
      ]
    }
  ]
}
