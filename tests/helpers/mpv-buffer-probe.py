"""Read back buffer options from real libmpv, without a window or media."""
import ctypes
import json
import sys

mpv = ctypes.CDLL(sys.argv[1])
mpv.mpv_create.restype = ctypes.c_void_p
mpv.mpv_initialize.argtypes = [ctypes.c_void_p]
mpv.mpv_set_option_string.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
mpv.mpv_set_property_string.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
mpv.mpv_get_property.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p]
mpv.mpv_terminate_destroy.argtypes = [ctypes.c_void_p]

results = []
for options in json.load(sys.stdin):
    ctx = mpv.mpv_create()
    assert ctx, "mpv_create failed"
    try:
        for key, value in [(b"config", b"no"), (b"vo", b"null"), (b"ao", b"null")]:
            assert mpv.mpv_set_option_string(ctx, key, value) >= 0
        assert mpv.mpv_initialize(ctx) >= 0, "mpv_initialize failed"
        # Match apply_extra_mpv_options: string properties, after initialization.
        for line in options.splitlines():
            key, value = line.split("=", 1)
            rc = mpv.mpv_set_property_string(ctx, key.encode(), value.encode())
            assert rc >= 0, f"rejected {line}: {rc}"
        actual = {}
        for key in ["demuxer-max-bytes", "demuxer-max-back-bytes", "demuxer-readahead-secs", "stream-buffer-size", "cache-secs"]:
            value = ctypes.c_double()
            rc = mpv.mpv_get_property(ctx, key.encode(), 5, ctypes.byref(value))
            assert rc >= 0, f"cannot read {key}: {rc}"
            actual[key] = value.value
        results.append(actual)
    finally:
        mpv.mpv_terminate_destroy(ctx)
print(json.dumps(results))
