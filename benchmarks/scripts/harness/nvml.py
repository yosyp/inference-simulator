"""Read-only GPU queries through NVML (nvidia-ml-py).

NVML is the management library behind `nvidia-smi`. It never creates a CUDA context, so
sampling it does not disturb the benchmark. pynvml is imported lazily: the dry run and the
unit tests never load it.
"""

from __future__ import annotations

import threading
from pathlib import Path

from .checks import decode_clock_events

_lock = threading.Lock()
_nv = None


def nv():
    global _nv
    with _lock:
        if _nv is None:
            import pynvml

            pynvml.nvmlInit()
            _nv = pynvml
    return _nv


def shutdown() -> None:
    global _nv
    with _lock:
        if _nv is not None:
            try:
                _nv.nvmlShutdown()
            finally:
                _nv = None


def _try(fn, *args):
    try:
        return fn(*args)
    except Exception:
        return None


def _s(v):
    return v.decode() if isinstance(v, bytes) else v


def device_count() -> int:
    return nv().nvmlDeviceGetCount()


def sample(gpu: int) -> dict:
    """One NVML sample for a GPU (index in PCI bus order, same as CUDA with CUDA_DEVICE_ORDER=PCI_BUS_ID)."""
    n = nv()
    h = n.nvmlDeviceGetHandleByIndex(gpu)
    power_mw = _try(n.nvmlDeviceGetPowerUsage, h)
    energy_mj = _try(n.nvmlDeviceGetTotalEnergyConsumption, h)
    util = _try(n.nvmlDeviceGetUtilizationRates, h)
    mem = _try(n.nvmlDeviceGetMemoryInfo, h)
    reasons_fn = getattr(n, "nvmlDeviceGetCurrentClocksEventReasons", None) or getattr(
        n, "nvmlDeviceGetCurrentClocksThrottleReasons"
    )
    mask = _try(reasons_fn, h)
    return {
        "gpu": gpu,
        "power_w": round(power_mw / 1000.0, 2) if power_mw is not None else None,
        "energy_j": round(energy_mj / 1000.0, 3) if energy_mj is not None else None,
        "sm_clock_mhz": _try(n.nvmlDeviceGetClockInfo, h, n.NVML_CLOCK_SM),
        "mem_clock_mhz": _try(n.nvmlDeviceGetClockInfo, h, n.NVML_CLOCK_MEM),
        "util_gpu_pct": util.gpu if util is not None else None,
        "util_mem_pct": util.memory if util is not None else None,
        "mem_used_mib": round(mem.used / 2**20, 1) if mem is not None else None,
        "temp_c": _try(n.nvmlDeviceGetTemperature, h, n.NVML_TEMPERATURE_GPU),
        "pstate": _try(n.nvmlDeviceGetPerformanceState, h),
        "clock_event_mask": mask,
        "clock_events": decode_clock_events(mask),
    }


def pci_numa_node(bus_id: str) -> int | None:
    """NUMA node of a PCI device from sysfs. NVML ids look like 00000000:31:00.0."""
    try:
        dom, rest = bus_id.lower().split(":", 1)
        path = Path(f"/sys/bus/pci/devices/{int(dom, 16):04x}:{rest}/numa_node")
        node = int(path.read_text().strip())
        return node if node >= 0 else None
    except Exception:
        return None


def inventory() -> list[dict]:
    """Static facts per GPU for the manifest. No UUIDs or serials (they identify hardware)."""
    n = nv()
    out = []
    for i in range(n.nvmlDeviceGetCount()):
        h = n.nvmlDeviceGetHandleByIndex(i)
        pci = _try(n.nvmlDeviceGetPciInfo, h)
        bus = _s(pci.busId) if pci is not None else None
        mem = _try(n.nvmlDeviceGetMemoryInfo, h)
        ecc = _try(n.nvmlDeviceGetEccMode, h)
        mig = _try(n.nvmlDeviceGetMigMode, h)
        limit = _try(n.nvmlDeviceGetEnforcedPowerLimit, h)
        link_gen = _try(n.nvmlDeviceGetCurrPcieLinkGeneration, h)
        link_w = _try(n.nvmlDeviceGetCurrPcieLinkWidth, h)
        out.append(
            {
                "index": i,
                "name": _s(_try(n.nvmlDeviceGetName, h)),
                "pci_bus_id": bus,
                "numa_node": pci_numa_node(bus) if bus else None,
                "memory_total_mib": round(mem.total / 2**20) if mem is not None else None,
                "power_limit_w": round(limit / 1000.0, 1) if limit is not None else None,
                "ecc_enabled": bool(ecc[0]) if ecc else None,
                "mig_enabled": bool(mig[0]) if mig else None,
                "max_sm_clock_mhz": _try(n.nvmlDeviceGetMaxClockInfo, h, n.NVML_CLOCK_SM),
                "max_mem_clock_mhz": _try(n.nvmlDeviceGetMaxClockInfo, h, n.NVML_CLOCK_MEM),
                "pcie_link": f"gen{link_gen} x{link_w}" if link_gen and link_w else None,
            }
        )
    return out


def driver_versions() -> dict:
    n = nv()
    cuda = _try(n.nvmlSystemGetCudaDriverVersion)
    return {
        "driver": _s(_try(n.nvmlSystemGetDriverVersion)),
        "cuda_driver_api": f"{cuda // 1000}.{(cuda % 1000) // 10}" if cuda else None,
        "nvml": _s(_try(n.nvmlSystemGetNVMLVersion)),
    }


def processes(gpu: int) -> list[dict]:
    n = nv()
    h = n.nvmlDeviceGetHandleByIndex(gpu)
    procs = _try(n.nvmlDeviceGetComputeRunningProcesses, h) or []
    return [
        {"pid": p.pid, "used_mib": round(p.usedGpuMemory / 2**20) if getattr(p, "usedGpuMemory", None) else None}
        for p in procs
    ]


def memory_used_mib(gpu: int) -> float | None:
    mem = _try(nv().nvmlDeviceGetMemoryInfo, nv().nvmlDeviceGetHandleByIndex(gpu))
    return mem.used / 2**20 if mem is not None else None
