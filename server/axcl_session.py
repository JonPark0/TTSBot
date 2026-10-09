"""(Copied from ax8850_win/tools/axcl_py.) Minimal ctypes runner for one AXModel on an LLM-8850 / AXCL card (Windows or Linux host).

Shared by tools/laya_axcl, tools/yolo_axcl and tools/embeddinggemma2. Group 0 only, one device
buffer per tensor, synchronous Execute. Outputs are returned as float32.

Runtime library: libaxcl_rt.dll from the AXCL Windows package, or libaxcl_rt.so from the AXCL
Linux package (/usr/lib/axcl). Set AXCL_LIB_DIR to override the directory.
"""

import ctypes as C
import os
import sys
import threading
import time
from pathlib import Path

import numpy as np

if sys.platform == "win32":
    AXCL_BIN = Path(os.environ.get("AXCL_LIB_DIR", r"C:\AXCL\axcl\out\axcl_win_x64\bin"))
    AXCL_LIB = "libaxcl_rt.dll"
else:
    AXCL_BIN = Path(os.environ.get("AXCL_LIB_DIR", "/usr/lib/axcl"))
    AXCL_LIB = "libaxcl_rt.so"


def _load_runtime():
    if sys.platform == "win32":
        os.add_dll_directory(str(AXCL_BIN))
    path = AXCL_BIN / AXCL_LIB
    # Fall back to the loader search path (LD_LIBRARY_PATH / ld.so.conf) if the default dir is absent.
    return C.CDLL(str(path) if path.exists() else AXCL_LIB)


class _DeviceList(C.Structure):
    _fields_ = [("num", C.c_uint32), ("devices", C.c_int32 * 256)]  # AXCL_MAX_DEVICE_COUNT


class _IODims(C.Structure):
    _fields_ = [("count", C.c_int32), ("dims", C.c_int32 * 32)]  # AXCLRT_ENGINE_MAX_DIM_CNT


class AxclSession:
    """Minimal one-model AXCL runner: group 0, device buffers per tensor, sync Execute."""

    MEMCPY_H2D, MEMCPY_D2H = 1, 2
    MALLOC_NORMAL_ONLY = 2

    def __init__(self, model_path: Path, shared_runtime=None):
        """shared_runtime: another open AxclSession whose runtime and device this one reuses
        (several models in one process); only that owner initialises and finalises AXCL."""
        vp, u32, u64 = C.c_void_p, C.c_uint32, C.c_uint64
        self.owner = shared_runtime is None
        self._threads = {threading.get_ident()}
        if not self.owner:
            self.rt, self.device, self.rt_context = shared_runtime.rt, shared_runtime.device, shared_runtime.rt_context
            self._load(model_path)
            return
        rt = _load_runtime()
        self.rt = rt
        rt.axclrtEngineGetNumInputs.restype = u32
        rt.axclrtEngineGetNumOutputs.restype = u32
        rt.axclrtEngineGetInputSizeByIndex.restype = u64
        rt.axclrtEngineGetOutputSizeByIndex.restype = u64
        rt.axclrtEngineGetInputNameByIndex.restype = C.c_char_p
        rt.axclrtEngineGetOutputNameByIndex.restype = C.c_char_p
        for fn in ("axclrtEngineGetNumInputs", "axclrtEngineGetNumOutputs"):
            getattr(rt, fn).argtypes = [vp]
        for fn in ("axclrtEngineGetInputSizeByIndex", "axclrtEngineGetOutputSizeByIndex"):
            getattr(rt, fn).argtypes = [vp, u32, u32]
        for fn in ("axclrtEngineGetInputNameByIndex", "axclrtEngineGetOutputNameByIndex"):
            getattr(rt, fn).argtypes = [vp, u32]
        rt.axclrtEngineSetInputBufferByIndex.argtypes = [vp, u32, vp, u64]
        rt.axclrtEngineSetOutputBufferByIndex.argtypes = [vp, u32, vp, u64]
        rt.axclrtEngineExecute.argtypes = [u64, u64, u32, vp]
        rt.axclrtMemcpy.argtypes = [vp, vp, C.c_size_t, C.c_int]
        rt.axclrtMalloc.argtypes = [C.POINTER(vp), C.c_size_t, C.c_int]
        rt.axclrtFree.argtypes = [vp]
        for fn in ("axclrtEngineGetInputDims", "axclrtEngineGetOutputDims"):
            getattr(rt, fn).argtypes = [vp, u32, u32, C.POINTER(_IODims)]

        config = os.environ.get("AXCL_CONFIG")  # optional axcl.json; NULL = built-in defaults (as axllm does)
        self._check(rt.axclInit(config.encode() if config else None), "axclInit")
        devices = _DeviceList()
        self._check(rt.axclrtGetDeviceList(C.byref(devices)), "axclrtGetDeviceList")
        if devices.num == 0:
            raise RuntimeError("no AXCL device")
        self.device = devices.devices[0]
        self._check(rt.axclrtSetDevice(self.device), "axclrtSetDevice")
        # AXCL contexts are per thread (like CUDA): remember this one so other threads can bind it.
        rt.axclrtGetCurrentContext.argtypes = [C.POINTER(vp)]
        rt.axclrtSetCurrentContext.argtypes = [vp]
        self.rt_context = vp()
        self._check(rt.axclrtGetCurrentContext(C.byref(self.rt_context)), "axclrtGetCurrentContext")
        self._check(rt.axclrtEngineInit(0), "axclrtEngineInit")
        self._load(model_path)

    def _bind_thread(self):
        """Make the runtime context current in the calling thread (e.g. an HTTP worker thread)."""
        tid = threading.get_ident()
        if tid not in self._threads:
            self._check(self.rt.axclrtSetCurrentContext(self.rt_context), "axclrtSetCurrentContext")
            self._threads.add(tid)

    def _load(self, model_path):
        rt, vp, u64 = self.rt, C.c_void_p, C.c_uint64
        self.model, self.context = u64(), u64()
        self._check(rt.axclrtEngineLoadFromFile(str(model_path).encode(), C.byref(self.model)), "LoadFromFile")
        self._check(rt.axclrtEngineCreateContext(self.model, C.byref(self.context)), "CreateContext")
        self.info, self.io = vp(), vp()
        self._check(rt.axclrtEngineGetIOInfo(self.model, C.byref(self.info)), "GetIOInfo")
        self._check(rt.axclrtEngineCreateIO(self.info, C.byref(self.io)), "CreateIO")

        self.inputs, self.outputs = {}, []  # name -> (index, devptr, size)
        for i in range(rt.axclrtEngineGetNumInputs(self.info)):
            name = rt.axclrtEngineGetInputNameByIndex(self.info, i).decode()
            size = rt.axclrtEngineGetInputSizeByIndex(self.info, 0, i)
            ptr = self._malloc(size)
            self._check(rt.axclrtEngineSetInputBufferByIndex(self.io, i, ptr, size), f"SetInput {name}")
            self.inputs[name] = (i, ptr, size)
        for i in range(rt.axclrtEngineGetNumOutputs(self.info)):
            name = rt.axclrtEngineGetOutputNameByIndex(self.info, i).decode()
            size = rt.axclrtEngineGetOutputSizeByIndex(self.info, 0, i)
            ptr = self._malloc(size)
            self._check(rt.axclrtEngineSetOutputBufferByIndex(self.io, i, ptr, size), f"SetOutput {name}")
            self.outputs.append((name, ptr, size))
        self.output_shapes = [self._dims(rt.axclrtEngineGetOutputDims, i) for i in range(len(self.outputs))]

    def _dims(self, getter, index):
        dims = _IODims()
        self._check(getter(self.info, 0, index, C.byref(dims)), "GetDims")
        return tuple(dims.dims[:dims.count])

    @staticmethod
    def _check(ret, what):
        if ret != 0:
            raise RuntimeError(f"{what} failed: 0x{ret & 0xFFFFFFFF:08x}")

    def _malloc(self, size):
        ptr = C.c_void_p()
        self._check(self.rt.axclrtMalloc(C.byref(ptr), size, self.MALLOC_NORMAL_ONLY), "axclrtMalloc")
        return ptr

    def run(self, feeds):
        """feeds: name -> np.ndarray. Returns (outputs by name as float32 arrays, NPU+IO ms)."""
        self._bind_thread()
        started = time.perf_counter()
        for name, array in feeds.items():
            _, ptr, size = self.inputs[name]
            data = np.ascontiguousarray(array)
            if data.nbytes != size:
                raise ValueError(f"{name}: {data.nbytes} bytes, model expects {size}")
            self._check(self.rt.axclrtMemcpy(ptr, data.ctypes.data, size, self.MEMCPY_H2D), f"H2D {name}")
        self._check(self.rt.axclrtEngineExecute(self.model, self.context, 0, self.io), "Execute")
        results = {}
        for name, ptr, size in self.outputs:
            host = np.empty(size // 4, dtype=np.float32)
            self._check(self.rt.axclrtMemcpy(host.ctypes.data, ptr, size, self.MEMCPY_D2H), f"D2H {name}")
            results[name] = host
        return results, (time.perf_counter() - started) * 1000.0

    def time_execute(self, repeat):
        """Re-run Execute on the inputs already on the device; returns ms per run."""
        self._bind_thread()
        times = []
        for _ in range(repeat):
            started = time.perf_counter()
            self._check(self.rt.axclrtEngineExecute(self.model, self.context, 0, self.io), "Execute")
            times.append((time.perf_counter() - started) * 1000.0)
        return times

    def close(self):
        rt = self.rt
        for _, ptr, _ in list(self.inputs.values()) + [(None, p, None) for _, p, _ in self.outputs]:
            rt.axclrtFree(ptr)
        rt.axclrtEngineDestroyIO(self.io)
        rt.axclrtEngineDestroyIOInfo(self.info)
        rt.axclrtEngineUnload(self.model)
        if not self.owner:
            return
        rt.axclrtEngineFinalize()
        rt.axclrtResetDevice(self.device)
        rt.axclFinalize()
